// Public-mode x402 gate for the Compass launcher (design §0.4). Pure functions plus an
// orchestrator that takes every side effect (fetch, clock, token, inference, slot, log)
// by injection. No SDK: the x402 v2 wire shapes follow src/adapters/inbound/x402.ts and
// providers/x402-workers/src/{requirements,receipt}.ts.
import {createHash} from 'node:crypto';

export const NETWORK='eip155:84532';
export const ASSET='0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const AMOUNT='10000';
export const MAX_TIMEOUT_SECONDS=60;
export const DEADLINE_MS=28000;      // D: inside the Router's 30 s paid timeout
export const RESERVE_MS=14000;       // R: settling 2 + settle 8 + settled 1.5 + response 1 + margin 1.5
export const STALE_MS=30000;
export const BUDGET={lookup:2000,verify:5000,record:2000,settle:8000,settled:1500,health:1500,infer:15000};
const EVM_ADDRESS=/^0x[0-9a-fA-F]{40}$/, BYTES32=/^0x[0-9a-fA-F]{64}$/, HEX=/^0x[0-9a-fA-F]+$/, DIGITS=/^(0|[1-9][0-9]*)$/, B64=/^[A-Za-z0-9+/]*={0,2}$/;
const MAX_HEADER=8192, MAX_JSON=65536, MAX_DEPTH=4;
export const STATES=['accepted','settling','settled','unknown','failed'];
const PAID={accepted:'no',failed:'no',settling:'possibly',unknown:'possibly',settled:'yes'};
const NOTE={accepted:'payment not settled; this nonce is spent for Compass, retry with a new credential',failed:'settle failed definitively; retry with a new credential',settling:'settle outcome unknown; no automatic retry; manual reconciliation',unknown:'settle outcome unknown; no automatic retry; manual reconciliation',settled:'already paid and delivered'};

export function stableJson(v,depth=0){
  if(depth>MAX_DEPTH)throw new RangeError('too deep');
  if(Array.isArray(v))return '['+v.map(x=>stableJson(x,depth+1)).join(',')+']';
  if(v!==null&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stableJson(v[k],depth+1)).join(',')+'}';
  return JSON.stringify(v);
}
export const b64encode=s=>Buffer.from(s,'utf8').toString('base64');
export function b64decodeJson(s,max=MAX_HEADER){
  if(typeof s!=='string'||s.length===0||s.length>max||!B64.test(s))throw new Error('base64');
  const bytes=Buffer.from(s,'base64');
  if(bytes.toString('base64')!==s)throw new Error('base64 canonical');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(text.length>MAX_JSON)throw new Error('size');
  const v=JSON.parse(text); stableJson(v); return v;
}
const isRecord=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);

export function requirements(config){
  return {scheme:'exact',network:NETWORK,asset:ASSET,amount:AMOUNT,payTo:config.payTo,maxTimeoutSeconds:MAX_TIMEOUT_SECONDS,extra:{name:'USDC',version:'2'}};
}
export function paymentRequired(config,error){
  const required={x402Version:2,accepts:[requirements(config)],resource:{url:config.publicUrl+'/select',description:'SubEtha Compass: choose one of four API candidates for a task (live DiffusionGemma)',mimeType:'application/json'}};
  return {status:402,headers:{'payment-required':b64encode(JSON.stringify(required))},body:error?{error:error}:{}};
}
export function nonceKey(network,from,nonce){
  return createHash('sha256').update(network.toLowerCase()+'|'+from.toLowerCase()+'|'+nonce.toLowerCase()).digest('hex');
}
/** Strict decode of PAYMENT-SIGNATURE: returns {ok,payload,key,auth} or {ok:false}. Calls nothing. */
export function decodeCredential(header,config){
  let v; try{v=b64decodeJson(header);}catch{return {ok:false};}
  if(!isRecord(v)||v.x402Version!==2||!isRecord(v.accepted)||!isRecord(v.payload))return {ok:false};
  let same; try{same=stableJson(v.accepted)===stableJson(requirements(config));}catch{return {ok:false};}
  if(!same)return {ok:false};
  const a=v.payload.authorization, sig=v.payload.signature;
  if(!isRecord(a)||typeof sig!=='string'||!HEX.test(sig)||Object.keys(v.payload).length!==2)return {ok:false};
  const f=['from','to','value','validAfter','validBefore','nonce'];
  if(Object.keys(a).length!==6||f.some(k=>typeof a[k]!=='string'))return {ok:false};
  if(!EVM_ADDRESS.test(a.from)||!EVM_ADDRESS.test(a.to)||a.to.toLowerCase()!==config.payTo.toLowerCase()||a.value!==AMOUNT||!DIGITS.test(a.validAfter)||!DIGITS.test(a.validBefore)||!BYTES32.test(a.nonce))return {ok:false};
  return {ok:true,payload:v,auth:a,key:nonceKey(NETWORK,a.from,a.nonce)};
}
/** Facilitator settle response -> {kind:'settled',receipt}|{kind:'failed'}|{kind:'unknown'} (design step 11). */
export function classifySettle(status,json,from){
  if(status!==200||!isRecord(json))return {kind:'unknown'};
  if(json.success===false){return json.errorReason==='settlement_pending'?{kind:'unknown'}:{kind:'failed'};}
  if(json.success!==true)return {kind:'unknown'};
  const tx=json.transaction, net=json.network, payer=json.payer;
  if(typeof tx!=='string'||!BYTES32.test(tx)||net!==NETWORK)return {kind:'unknown'};
  if(payer!==undefined&&(typeof payer!=='string'||!EVM_ADDRESS.test(payer)||payer.toLowerCase()!==from.toLowerCase()))return {kind:'unknown'};
  const receipt={success:true,transaction:tx,network:NETWORK,...(payer===undefined?{}:{payer})};
  return {kind:'settled',receipt,header:b64encode(JSON.stringify(receipt))};
}
export function classifyVerify(status,json){
  if(status!==200||!isRecord(json)||typeof json.isValid!=='boolean')return 'error';
  return json.isValid?'valid':'invalid';
}
export function conflictBody(record){
  const state=STATES.includes(record?.state)?record.state:'unknown';
  return {error:'duplicate',recorded:state,nonce:record?.nonce??null,paid:PAID[state],note:NOTE[state]};
}

/** Bounded fetch helper: JSON up to MAX_JSON, no redirects, absolute timeout. Returns {status,json,text}. */
async function call(fetchImpl,url,init,timeoutMs){
  const ac=new AbortController(); const t=setTimeout(()=>ac.abort(),Math.max(1,timeoutMs));
  try{
    const r=await fetchImpl(url,{...init,redirect:'manual',signal:ac.signal});
    let text='';
    if(r.body&&typeof r.body.getReader==='function'){
      const reader=r.body.getReader(); const dec=new TextDecoder(); let n=0;
      for(;;){const {done,value}=await reader.read(); if(done)break; n+=value.byteLength; if(n>MAX_JSON){reader.cancel().catch(()=>{}); return {status:r.status,json:undefined,text:''};} text+=dec.decode(value,{stream:true});}
      text+=dec.decode();
    } else { text=await r.text(); if(text.length>MAX_JSON)return {status:r.status,json:undefined,text:''}; }
    let json; try{json=text?JSON.parse(text):{};}catch{json=undefined;}
    return {status:r.status,json,text};
  } finally{clearTimeout(t);}
}

/** GCS JSON API client for the nonce bucket (create-only and generation-checked transitions). */
export function createNonceStore({bucket,fetch:fetchImpl,token}){
  const obj=key=>'nonce%2F'+key;
  // Every failure (transport, abort, token, shape) is {error:true}; nothing throws out of the store.
  async function withToken(timeoutMs,fn){
    const start=Date.now();
    try{ const t=await Promise.race([token(),new Promise((_,rej)=>setTimeout(()=>rej(new Error('token timeout')),Math.max(1,timeoutMs/2)))]);
      const left=timeoutMs-(Date.now()-start); if(left<=0)return {error:true};
      return await fn({authorization:'Bearer '+t,'content-type':'application/json'},left);
    }catch{return {error:true};}
  }
  return {
    lookup(key,timeoutMs){ return withToken(timeoutMs,async(h,left)=>{
      const r=await call(fetchImpl,`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${obj(key)}?alt=media`,{method:'GET',headers:h},left);
      if(r.status===404)return {found:false};
      if(r.status===200&&isRecord(r.json))return {found:true,record:r.json};
      return {error:true};}); },
    write(key,generation,record,timeoutMs){ return withToken(timeoutMs,async(h,left)=>{
      const r=await call(fetchImpl,`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${obj(key)}&ifGenerationMatch=${generation}`,{method:'POST',headers:h,body:JSON.stringify(record)},left);
      if(r.status===412)return {conflict:true};
      if(r.status>=200&&r.status<300&&isRecord(r.json)&&typeof r.json.generation==='string')return {ok:true,generation:r.json.generation};
      return {error:true};}); },
  };
}
export function facilitatorBody(payload,config){const req=requirements(config); return {x402Version:2,paymentPayload:{x402Version:2,scheme:req.scheme,network:req.network,accepted:payload.accepted,payload:payload.payload},paymentRequirements:req};}
export function createFacilitator({url,fetch:fetchImpl}){
  const base=url.replace(/\/$/,'');
  // The real facilitator needs top-level scheme/network on paymentPayload (src/adapters/inbound/x402.ts payloadOf).
  const body=(payload,config)=>JSON.stringify(facilitatorBody(payload,config));
  return {
    async verify(payload,config,timeoutMs){ try{const r=await call(fetchImpl,base+'/verify',{method:'POST',headers:{'content-type':'application/json'},body:body(payload,config)},timeoutMs); return classifyVerify(r.status,r.json);}catch{return 'error';} },
    async settle(payload,config,timeoutMs){ try{const r=await call(fetchImpl,base+'/settle',{method:'POST',headers:{'content-type':'application/json'},body:body(payload,config)},timeoutMs); return classifySettle(r.status,r.json,payload.payload.authorization.from);}catch{return {kind:'unknown'};} },
  };
}
/** Cloud Run metadata-server token (runtime identity; no key file). */
export function metadataToken(fetchImpl,timeoutMs=2000){
  let cached, expiresAt=0;
  return async()=>{
    if(cached&&Date.now()<expiresAt-60000)return cached;
    const r=await call(fetchImpl,'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{method:'GET',headers:{'metadata-flavor':'Google'}},timeoutMs);
    if(r.status!==200||!isRecord(r.json)||typeof r.json.access_token!=='string')throw new Error('token');
    cached=r.json.access_token; expiresAt=Date.now()+Math.max(0,(Number(r.json.expires_in)||0)*1000); return cached;
  };
}

/**
 * Orchestrator for POST /select in public mode (design steps 1-12). `ctx` provides:
 *  now(), draining(), ready(ms)->Promise<boolean>, acquire()->release|null, infer(body,ms)->Promise<{status,body}>,
 *  store, facilitator, log(fields), bootId. Returns {status, headers?, body, stage, outcome}.
 */
export async function handleSelect({config,ctx,header,body}){
  const start=ctx.now(); const D=start+DEADLINE_MS; const left=()=>D-ctx.now();
  const out=(status,b,stage,outcome,headers={})=>{ctx.log({stage,outcome,httpStatus:status,elapsedMs:ctx.now()-start}); return {status,headers,body:b,stage,outcome};};
  const retry=s=>({'retry-after':String(s)});
  // 1. admission before any 402 (requirement (a)).
  if(ctx.draining())return out(503,{error:'draining'},'admission','draining',retry(60));
  if(!(await ctx.ready(BUDGET.health)))return out(503,{error:'not_ready'},'admission','not_ready',retry(60));
  if(ctx.busy())return out(503,{error:'busy'},'admission','busy',retry(15));
  // 2. challenge.
  if(header===undefined||header===null||header===''){const p=paymentRequired(config); return out(p.status,p.body,'challenge','unpaid',p.headers);}
  // 3. strict decode and key.
  const c=decodeCredential(header,config);
  if(!c.ok){const p=paymentRequired(config,'payment_invalid'); return out(p.status,p.body,'decode','invalid',p.headers);}
  const key=c.key, auth=c.auth; const logKey={key};
  // 4. durable lookup before stale/verify.
  const found=await ctx.store.lookup(key,Math.min(BUDGET.lookup,left()));
  if(found.error)return out(503,{error:'record_unavailable'},'lookup','error',retry(30));
  if(found.found)return out(409,conflictBody(found.record),'lookup','duplicate');
  // 5. stale and input (the existing product validation; a bad body never spends the nonce).
  if(Number(auth.validBefore)*1000<ctx.now()+STALE_MS){const p=paymentRequired(config,'payment_invalid'); return out(p.status,p.body,'stale','invalid',p.headers);}
  if(!ctx.validateInput(body))return out(400,{error:'invalid_input'},'input','invalid');
  // 6. slot (acquire re-checks draining/readiness atomically in the launcher).
  const release=ctx.acquire(); if(!release)return out(503,{error:'busy'},'slot','busy',retry(15));
  let released=false; const done=()=>{if(!released){released=true;release();}};
  try{
    // 7. verify.
    const v=await ctx.facilitator.verify(c.payload,config,Math.min(BUDGET.verify,left()));
    if(v==='invalid'){const p=paymentRequired(config,'payment_invalid'); return out(p.status,p.body,'verify','invalid',p.headers);}
    if(v!=='valid')return out(503,{error:'facilitator_unavailable'},'verify','error',retry(30));
    // 8. accepted record (create-only).
    const base={network:NETWORK,from:auth.from,nonce:auth.nonce,validBefore:auth.validBefore,value:auth.value,payTo:config.payTo,bootId:ctx.bootId};
    const rec=await ctx.store.write(key,'0',{...base,state:'accepted',at:ctx.now()},Math.min(BUDGET.record,left()));
    if(rec.conflict){const again=await ctx.store.lookup(key,Math.min(BUDGET.lookup,left())); return out(409,conflictBody(again.found?again.record:{state:'unknown',nonce:auth.nonce}),'record','duplicate');}
    if(!rec.ok)return out(503,{error:'record_unavailable'},'record','error',retry(30));
    let generation=rec.generation;
    // 9. inference bounded by the post-settle reserve.
    const inferMs=Math.min(BUDGET.infer,left()-RESERVE_MS);
    if(inferMs<=0)return out(503,{error:'deadline'},'infer','no_time',retry(15));
    const inf=await ctx.infer(body,inferMs).catch(()=>({status:502,body:null}));
    done();
    if(inf.status!==200||!inf.body)return out(503,{error:'inference_unavailable'},'infer','error',retry(30));
    // 10. pre-settle gate, settling transition, re-check.
    const gate=()=>!ctx.draining()&&left()>=RESERVE_MS&&Number(auth.validBefore)*1000>=ctx.now()+RESERVE_MS;
    if(!gate())return out(503,{error:'deadline'},'gate','no_time',retry(15));
    const st=await ctx.store.write(key,generation,{...base,state:'settling',at:ctx.now()},Math.min(BUDGET.record,left()));
    if(!st.ok)return out(503,{error:'record_unavailable'},'settling','error',retry(30));
    generation=st.generation;
    if(!gate()){ctx.log({...logKey,stage:'settling',outcome:'nonce_not_settled'}); return out(503,{error:'deadline'},'gate','not_settled',retry(15));}
    // 11. settle once. The in-flight registration lets drain force a durable `unknown` if we never return.
    // The registration lives until the launcher has delivered the response (phase 'settle' -> 'outcome').
    const inflight={key,generation,base,phase:'settle'}; ctx.settleStarted?.(inflight);
    const s=await ctx.facilitator.settle(c.payload,config,Math.min(BUDGET.settle,left()));
    inflight.phase='outcome';
    if(s.kind==='settled'){
      const w=await ctx.store.write(key,generation,{...base,state:'settled',at:ctx.now(),transaction:s.receipt.transaction},BUDGET.settled);
      if(!w.ok)ctx.log({...logKey,stage:'settled',outcome:'nonce_write_failed'});
      return out(200,inf.body,'settle','delivered',{'payment-response':s.header});
    }
    if(s.kind==='failed'){
      const w=await ctx.store.write(key,generation,{...base,state:'failed',at:ctx.now()},BUDGET.settled);
      if(!w.ok)ctx.log({...logKey,stage:'failed',outcome:'nonce_write_failed'});
      const p=paymentRequired(config,'payment_invalid'); return out(p.status,p.body,'settle','failed',p.headers);
    }
    const w=await ctx.store.write(key,generation,{...base,state:'unknown',at:ctx.now()},BUDGET.record);
    if(!w.ok)ctx.log({...logKey,stage:'unknown',outcome:'nonce_write_failed'});
    return out(502,{status:'unknown',nonce:auth.nonce},'settle','unknown');
  } finally{done();}
}
