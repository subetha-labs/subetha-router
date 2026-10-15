import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Injectable HTTP seam only; imports never start a process or bind a listener.
export function createIngress({bootId, request=http.request, healthy=()=>true, publicGate}) {
  return (req,res)=>{
    clearTimeout(req.socket?._compassHeaderTimer);
    res.setHeader('connection','close');
    res.setHeader('X-Compass-Boot-Id',bootId);
    res.setHeader('cache-control','no-store');
    let done=false, upstream, timer, readTimer;
    const started=performance.now();
    res.once('finish',()=>console.log(JSON.stringify({event:'compass_request',bootId,status:res.statusCode,elapsedMs:performance.now()-started})));
    if(Object.keys(req.headers).some(k=>k==='origin'||k==='referer'||k.startsWith('sec-fetch-'))){res.statusCode=403;res.end('{}');return;}
    const finish=(status,body)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(readTimer);upstream?.destroy();res.statusCode=status;res.setHeader('content-type','application/json');res.end(body);};
    const abort=()=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(readTimer);upstream?.destroy();res.destroy();};
    req.once('error',abort);req.once('aborted',abort);
    res.once('close',()=>{if(!res.writableFinished)abort();});
    if(req.method==='GET'&&req.url==='/health'){
      if(publicGate){publicGate.health(req,res,finish,upstreamRef=>{upstream=upstreamRef;});return;}
      if(!healthy()){finish(503,'{"status":"starting"}');return;}
      timer=setTimeout(()=>finish(503,'{"status":"starting"}'),1500);
      upstream=request({hostname:'127.0.0.1',port:8082,path:'/health',method:'GET',agent:false},r=>{let n=0;const parts=[];r.on('data',c=>{n+=c.length;if(n>1024){r.destroy();finish(503,'{}');}else parts.push(Buffer.from(c));});r.on('error',()=>finish(503,'{}'));r.on('end',()=>{let ok=false;try{const b=JSON.parse(Buffer.concat(parts));ok=r.statusCode===200&&b.status==='ok'&&b.mode==='inproc-vllm';}catch{}if(ok)console.log(JSON.stringify({event:'compass_ready',bootId,time:Date.now()}));finish(ok?200:503,ok?'{"status":"ok"}':'{"status":"starting"}');});});
      upstream.on('error',()=>finish(503,'{"status":"starting"}'));upstream.end();return;
    }
    // Public mode: only POST /select (paid) reaches inference; the internal path is closed (design §0.4).
    if(publicGate){
      if(req.method!=='POST'||req.url!=='/select'){finish(404,'{}');return;}
    } else if(req.method!=='POST'||req.url!=='/internal/v1/select'){finish(404,'{}');return;}
    if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||req.headers['content-encoding']||req.headers.expect){finish(415,'{}');return;}
    const length=req.headers['content-length'];
    const names=(req.rawHeaders||[]).filter((_,i)=>i%2===0).map(x=>x.toLowerCase());
    if(names.length>=100||['host','content-type','content-length','transfer-encoding'].some(k=>names.filter(n=>n===k).length>1)||(length!==undefined&&req.headers['transfer-encoding'])){finish(400,'{}');return;}
    if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>8192)){finish(413,'{}');return;}
    if(!publicGate&&!healthy()){finish(503,'{}');return;}
    timer=setTimeout(()=>finish(504,'{}'),70000);
    readTimer=setTimeout(()=>finish(408,'{}'),2000);
    let size=0;const chunks=[];
    req.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>8192){finish(413,'{}');return;}chunks.push(Buffer.from(chunk));});
    req.once('end',()=>{
      if(done)return;clearTimeout(readTimer);
      if(length!==undefined&&size!==Number(length)){finish(400,'{}');return;}
      if(publicGate){
        publicGate.select(Buffer.concat(chunks),req.headers['payment-signature'],(status,headers,bodyText)=>{if(done)return;for(const [k,v] of Object.entries(headers))res.setHeader(k,v);finish(status,bodyText);}).catch(()=>finish(503,'{"error":"internal"}'));
        return;
      }
      // Only these generated headers cross the boundary. No auth/cookie/forwarding.
      upstream=request({hostname:'127.0.0.1',port:8081,path:'/internal/v1/select',method:'POST',agent:false,headers:{'content-type':'application/json','content-length':size}},r=>{
        let n=0;const body=[];
        r.on('data',c=>{n+=c.length;if(n>8192){finish(502,'{}');r.destroy();}else body.push(Buffer.from(c));});
        r.on('end',()=>finish(r.statusCode??502,Buffer.concat(body)));
        r.on('error',()=>finish(502,'{}'));r.on('aborted',()=>finish(502,'{}'));
      });
      upstream.on('error',()=>finish(502,'{}'));upstream.end(Buffer.concat(chunks));
    });
  };
}

// Public mode (PROVIDER_MODE=public): design §0.4. Everything here is behind the env switch.
export function createPublicGate({bootId, config, request=http.request, healthy, fetch:fetchImpl=globalThis.fetch, store, facilitator, now=Date.now, validateInput, log=f=>console.log(JSON.stringify({event:'compass_pay',bootId,...f}))}) {
  const {handleSelect,BUDGET}=config.gateModule;
  let slot=false, draining=false, current=null; const inflight=new Set();
  const disclosure=config.disclosure;
  function modelHealth(ms){
    return new Promise(resolve=>{
      let settled=false; const end=(v)=>{if(!settled){settled=true;resolve(v);}};
      const t=setTimeout(()=>{end(false);up.destroy();},ms);
      const up=request({hostname:'127.0.0.1',port:8082,path:'/health',method:'GET',agent:false},r=>{let n=0;const parts=[];r.on('data',c=>{n+=c.length;if(n>1024){r.destroy();end(false);}else parts.push(Buffer.from(c));});r.on('error',()=>end(false));r.on('end',()=>{clearTimeout(t);let ok=false;try{const b=JSON.parse(Buffer.concat(parts));ok=r.statusCode===200&&b.status==='ok'&&b.mode==='inproc-vllm';}catch{}end(ok);});});
      up.on('error',()=>{clearTimeout(t);end(false);}); up.end();
    });
  }
  // Resolves only when the internal socket has closed (slot release follows actual closure, design step 6).
  function infer(body,ms){
    return new Promise(resolve=>{
      let result=null, closed=false, finished=false;
      const finish=()=>{if(finished)return;finished=true;current=null;resolve(result??{status:502,body:null});};
      const t=setTimeout(()=>{result={status:504,body:null};up.destroy();},ms);
      const up=request({hostname:'127.0.0.1',port:8081,path:'/internal/v1/select',method:'POST',agent:false,headers:{'content-type':'application/json','content-length':body.length}},r=>{let n=0;const parts=[];r.on('data',c=>{n+=c.length;if(n>8192){result={status:502,body:null};r.destroy();}else parts.push(Buffer.from(c));});r.on('error',()=>{result=result??{status:502,body:null};});r.on('end',()=>{clearTimeout(t);if(!result){const text=Buffer.concat(parts).toString();let json=null;try{json=JSON.parse(text);}catch{}result={status:r.statusCode??502,body:json&&typeof json==='object'?json:null};}});});
      up.on('error',()=>{clearTimeout(t);result=result??{status:502,body:null};});
      up.on('close',()=>{clearTimeout(t);closed=true;finish();});
      current=up; up.end(body);
    });
  }
  const ctx={
    now, bootId, log,
    draining:()=>draining,
    ready:async ms=>healthy()&&!draining&&await modelHealth(ms),
    busy:()=>slot,
    // Atomic re-check in the same tick: draining or an unhealthy child after the async lookup refuses the slot.
    acquire:()=>{if(slot||draining||!healthy())return null;slot=true;return ()=>{slot=false;};},
    infer, store, facilitator, validateInput,
  };
  return {
    health(req,res,finish){
      if(draining||!healthy()){finish(503,JSON.stringify({status:'starting',ready:false,bootId,disclosure}));return;}
      modelHealth(BUDGET.health).then(ok=>{if(ok)console.log(JSON.stringify({event:'compass_ready',bootId,time:Date.now()}));finish(ok?200:503,JSON.stringify({status:ok?'ok':'starting',ready:ok,bootId,disclosure}));});
    },
    async select(body,header,respond){
      // Per-request registration: removed only after the response has been handed to the socket.
      const mine=[]; const rctx={...ctx,settleStarted:i=>{mine.push(i);inflight.add(i);}};
      try{
        const r=await handleSelect({config,ctx:rctx,header,body});
        respond(r.status,{'content-type':'application/json',...(r.headers||{})},JSON.stringify(r.body));
      } finally{ for(const i of mine)inflight.delete(i); }
    },
    // Drain (design step 12): refuse new work, abort a pre-settle inference (503 upstream), wait for an
    // in-flight settle up to `waitMs`, then force a durable `unknown` for any settle still unanswered.
    // One shared deadline: waitMs for in-flight settles/deliveries, then forced `unknown` writes (in parallel) for
    // registrations still waiting on the facilitator, bounded by `forceMs`. Total <= waitMs + forceMs.
    drain(waitMs,forceMs=2000){
      draining=true;
      if(current){try{current.destroy();}catch{}}
      const start=Date.now(), end=start+waitMs+forceMs;
      return new Promise(resolve=>{const tick=()=>{
        if(inflight.size===0){resolve();return;}
        if(Date.now()-start<waitMs){setTimeout(tick,50);return;}
        // Still waiting on the facilitator: force a durable `unknown`. Already past settle (writing the outcome or
        // delivering): let it finish. Either way, nothing outlives the shared deadline.
        const forced=new Set(), writes=[];
        const force=i=>{forced.add(i);writes.push(store.write(i.key,i.generation,{...i.base,state:'unknown',at:Date.now()},Math.max(1,end-Date.now())).then(w=>log({key:i.key,stage:'unknown',outcome:w.ok?'drain_forced':'nonce_write_failed'}),()=>log({key:i.key,stage:'unknown',outcome:'nonce_write_failed'})));};
        // Re-checked on every poll until the shared deadline: a settle that returns during a forced write moves to
        // 'outcome' and is then waited for; done only when every remaining registration is a forced, still-unanswered settle.
        let writesDone=false;
        const finished=()=>[...inflight].every(i=>i.phase==='settle'&&forced.has(i));
        const poll=()=>{
          for(const i of inflight)if(i.phase==='settle'&&!forced.has(i))force(i);
          Promise.all(writes).then(()=>{writesDone=true;});
          if((writesDone&&finished())||Date.now()>=end){resolve();return;}
          setTimeout(poll,20);
        };
        poll();
      };tick();});
    },
    get draining(){return draining;},
  };
}

export async function main() {
  const {createCompassServer}=await import('./src/server.js');
  const bootId=randomUUID();
  console.log(JSON.stringify({event:'compass_boot',bootId,pid:process.pid,time:Date.now()}));
  const api=createCompassServer({port:8081,backendPort:8082,profile:'diagnostic',observer:event=>console.log(JSON.stringify({event:'compass_stage',bootId,time:Date.now(),...event})),catalogPath:new URL('./catalog/demo-selection.json',import.meta.url),policyPath:new URL('./config/deadline-policy.json',import.meta.url)});
  const child=spawn('/bin/bash',['/opt/compass/model-entrypoint.sh'],{env:{...process.env,PORT:'8082'},stdio:['ignore','inherit','inherit'],detached:true});
  let stopping=false;
  const healthy=()=>!stopping&&child.exitCode===null;
  let publicGate;
  if(process.env.PROVIDER_MODE==='public'){
    const gate=await import('./x402-gate.mjs');
    const required=['PUBLIC_URL','PAY_TO','FACILITATOR_URL','NONCE_BUCKET'];
    if(required.some(k=>!process.env[k]))throw Error('public mode env');
    if(!/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(process.env.PUBLIC_URL)||!/^0x[0-9a-fA-F]{40}$/.test(process.env.PAY_TO))throw Error('public mode env shape');
    const token=gate.metadataToken(globalThis.fetch);
    if(!process.env.DISCLOSURE||process.env.DISCLOSURE.length<80)throw Error('public mode disclosure');
    const {parseInput}=await import('./src/contracts.js');
    const validateInput=body=>{try{parseInput(body,'existing-resources-v1');return true;}catch{return false;}};
    const config={publicUrl:process.env.PUBLIC_URL,payTo:process.env.PAY_TO,gateModule:gate,disclosure:process.env.DISCLOSURE};
    publicGate=createPublicGate({bootId,config,healthy,validateInput,store:gate.createNonceStore({bucket:process.env.NONCE_BUCKET,fetch:globalThis.fetch,token}),facilitator:gate.createFacilitator({url:process.env.FACILITATOR_URL,fetch:globalThis.fetch})});
  }
  const ingress=http.createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:70000,connectionsCheckingInterval:250},createIngress({bootId,healthy,publicGate}));
  ingress.maxHeadersCount=100;
  ingress.on('connection',socket=>{const t=setTimeout(()=>socket.destroy(),5000);socket.once('close',()=>clearTimeout(t));socket._compassHeaderTimer=t;});
  ingress.on('checkContinue',(req,res)=>{res.writeHead(417);res.end();});
  ingress.on('checkExpectation',(req,res)=>{res.writeHead(417);res.end();});
  const stopNow=()=>{ingress.close();ingress.closeAllConnections();api.server.close();api.server.closeAllConnections();try{process.kill(-child.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}process.exit(1);},4000);};
  // Public mode drain (design step 12): refuse new work, let an in-flight settle finish for up to 6 s, then stop (<= 9.5 s total).
  // Public mode: drain <= 6 s (+ forced unknown writes <= 2 s), then stop and exit within 1 s: <= 9 s inside the 10 s grace.
  const stop=()=>{if(stopping)return;stopping=true;if(publicGate){ingress.close();publicGate.drain(6000,2000).then(()=>{stopNow();setTimeout(()=>process.exit(1),1000);});}else stopNow();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);child.once('error',stop);child.once('exit',stop);ingress.on('error',stop);
  try {await api.listen();const port=Number(process.env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('port');ingress.listen(port,'0.0.0.0');}catch{stop();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.exitCode=1;});
