import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Injectable HTTP seam only; imports never start a process or bind a listener.
export function createIngress({bootId, request=http.request, healthy=()=>true}) {
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
      if(!healthy()){finish(503,'{"status":"starting"}');return;}
      timer=setTimeout(()=>finish(503,'{"status":"starting"}'),1500);
      upstream=request({hostname:'127.0.0.1',port:8082,path:'/health',method:'GET',agent:false},r=>{let n=0;const parts=[];r.on('data',c=>{n+=c.length;if(n>1024){r.destroy();finish(503,'{}');}else parts.push(Buffer.from(c));});r.on('error',()=>finish(503,'{}'));r.on('end',()=>{let ok=false;try{const b=JSON.parse(Buffer.concat(parts));ok=r.statusCode===200&&b.status==='ok'&&b.mode==='inproc-vllm';}catch{}if(ok)console.log(JSON.stringify({event:'compass_ready',bootId,time:Date.now()}));finish(ok?200:503,ok?'{"status":"ok"}':'{"status":"starting"}');});});
      upstream.on('error',()=>finish(503,'{"status":"starting"}'));upstream.end();return;
    }
    if(req.method!=='POST'||req.url!=='/internal/v1/select'){finish(404,'{}');return;}
    if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||req.headers['content-encoding']||req.headers.expect){finish(415,'{}');return;}
    const length=req.headers['content-length'];
    const names=(req.rawHeaders||[]).filter((_,i)=>i%2===0).map(x=>x.toLowerCase());
    if(names.length>=100||['host','content-type','content-length','transfer-encoding'].some(k=>names.filter(n=>n===k).length>1)||(length!==undefined&&req.headers['transfer-encoding'])){finish(400,'{}');return;}
    if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>8192)){finish(413,'{}');return;}
    if(!healthy()){finish(503,'{}');return;}
    timer=setTimeout(()=>finish(504,'{}'),70000);
    readTimer=setTimeout(()=>finish(408,'{}'),2000);
    let size=0;const chunks=[];
    req.on('data',chunk=>{if(done)return;size+=chunk.length;if(size>8192){finish(413,'{}');return;}chunks.push(Buffer.from(chunk));});
    req.once('end',()=>{
      if(done)return;clearTimeout(readTimer);
      if(length!==undefined&&size!==Number(length)){finish(400,'{}');return;}
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

export async function main() {
  const {createCompassServer}=await import('./src/server.js');
  const bootId=randomUUID();
  console.log(JSON.stringify({event:'compass_boot',bootId,pid:process.pid,time:Date.now()}));
  const api=createCompassServer({port:8081,backendPort:8082,profile:'diagnostic',observer:event=>console.log(JSON.stringify({event:'compass_stage',bootId,time:Date.now(),...event})),catalogPath:new URL('./catalog/demo-selection.json',import.meta.url),policyPath:new URL('./config/deadline-policy.json',import.meta.url)});
  const child=spawn('/bin/bash',['/opt/compass/model-entrypoint.sh'],{env:{...process.env,PORT:'8082'},stdio:['ignore','inherit','inherit'],detached:true});
  let stopping=false;
  const ingress=http.createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:70000,connectionsCheckingInterval:250},createIngress({bootId,healthy:()=>!stopping&&child.exitCode===null}));
  ingress.maxHeadersCount=100;
  ingress.on('connection',socket=>{const t=setTimeout(()=>socket.destroy(),5000);socket.once('close',()=>clearTimeout(t));socket._compassHeaderTimer=t;});
  ingress.on('checkContinue',(req,res)=>{res.writeHead(417);res.end();});
  ingress.on('checkExpectation',(req,res)=>{res.writeHead(417);res.end();});
  const stop=()=>{if(stopping)return;stopping=true;ingress.close();ingress.closeAllConnections();api.server.close();api.server.closeAllConnections();try{process.kill(-child.pid,'SIGTERM');}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}process.exit(1);},4000);};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);child.once('error',stop);child.once('exit',stop);ingress.on('error',stop);
  try {await api.listen();const port=Number(process.env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw Error('port');ingress.listen(port,'0.0.0.0');}catch{stop();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{process.exitCode=1;});
