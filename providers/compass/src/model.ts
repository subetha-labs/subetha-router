import { createHash } from 'node:crypto';
import http from 'node:http';
import type { Catalog } from './catalog.js';
import { buildRequest } from './catalog.js';
import { ApiError, exactKeys, object, strictJson } from './contracts.js';
import type { Selection, ErrorCode } from './contracts.js';
export type PolicyProfile = 'default'|'diagnostic';
export interface DeadlinePolicy {readonly modelMs:number;readonly apiMs:number;readonly controllerMs:number;readonly modelReserveMs:number;readonly controllerReserveMs:number}
export interface PolicySnapshot {readonly policySha256:string;readonly profile:PolicyProfile;readonly selectedPolicy:DeadlinePolicy}
const validatedSnapshots=new WeakSet<object>();
export function parsePolicySnapshot(bytes:Uint8Array,profile:PolicyProfile='default'):PolicySnapshot {
  try {
    const policy=strictJson(bytes,{bytes:2048,depth:3,members:20,array:0});
    if(!object(policy)||!exactKeys(policy,['schema','profiles'])||policy.schema!=='compass.deadline-policy.v1'||
      !object(policy.profiles)||!exactKeys(policy.profiles,['default','diagnostic'])||!['default','diagnostic'].includes(profile))throw 0;
    for(const row of Object.values(policy.profiles)) {
      if(!object(row)||!exactKeys(row,['modelMs','apiMs','controllerMs','modelReserveMs','controllerReserveMs'])||
        !Object.values(row).every(v=>typeof v==='number'&&Number.isInteger(v)&&v>0&&v<=70000))throw 0;
      const p=row as unknown as DeadlinePolicy;
      if(p.modelMs+p.modelReserveMs>=p.apiMs||p.apiMs+p.controllerReserveMs>=p.controllerMs)throw 0;
      Object.freeze(row);
    }
    Object.freeze(policy.profiles);Object.freeze(policy);
    const snapshot=Object.freeze({policySha256:createHash('sha256').update(bytes).digest('hex'),profile,selectedPolicy:policy.profiles[profile] as unknown as DeadlinePolicy});
    validatedSnapshots.add(snapshot);return snapshot;
  } catch {throw new Error('invalid_policy');}
}
export type TransportResult = {kind:'completed';status:number;bytes:Uint8Array} | {kind:'notSent'} | {kind:'unknown';timeout?:boolean};
export interface Clock {now:()=>number;setTimer:(fn:()=>void,ms:number)=>ReturnType<typeof setTimeout>;clearTimer:(timer:ReturnType<typeof setTimeout>|undefined)=>void}
export const monotonicClock:Clock={now:()=>performance.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:timer=>clearTimeout(timer)};
export interface AttemptContext {readonly runId:string;readonly attemptId:string;readonly expectedBodySha256:string}
export interface RequestScope {readonly apiDeadlineMs:number;readonly attempt?:AttemptContext}
export type Detail=ErrorCode|'missing_attempt'|'binding_mismatch'|'insufficient_budget'|'persistence_failed'|'pre_dispatch_hook_timeout'|'pre_dispatch_disconnect'|'pre_dispatch_api_expired';
export interface Observation {
  readonly stage:'admission'|'transport'|'model'|'api';readonly event:'start'|'terminal'|'late'|'connect'|'write'|'headers'|'body'|'finish';
  readonly outcome:'started'|'completed'|'notSent'|'unknown'|'failed';readonly detail?:Detail;readonly deadlineCause?:'body'|'model'|'api'|'persistence';
}
export type Observer=(event:Observation&{readonly sequence:number;readonly utc:string;readonly elapsedMs:number;readonly runId?:string;readonly attemptId?:string})=>void;
export class ModelError extends ApiError {constructor(code:ErrorCode,readonly detail:Detail){super(code);}}

export interface DeadlineContext {readonly clock:Clock;readonly deadlineMs:number;readonly observe?:(event:Observation)=>void}
export type Transport = (body:Uint8Array,signal:AbortSignal,context:DeadlineContext)=>Promise<TransportResult>;
export interface TransportConfig {source:'live'|'recorded-fixture';send:Transport}
export type PreDispatch=(input:{body:Uint8Array;scope:RequestScope;signal:AbortSignal})=>Promise<{ok:true}|{ok:false;reason:'binding_mismatch'|'persistence_failed'}>;
export interface ModelOptions {observer?:Observer;preDispatch?:PreDispatch;policySnapshot:PolicySnapshot;clock?:Clock;backendPort?:number;transport?:TransportConfig}
export function validPort(port:unknown):port is number {return typeof port==='number'&&Number.isInteger(port)&&port>=1&&port<=65535;}
export function validateResponse(bytes:Uint8Array,ids:readonly string[]):Selection {
  try {
    const r=strictJson(bytes,{bytes:65536,depth:8,members:256,array:64});
    if(!object(r)||r.model!=='dgemma'||!object(r.answers)||!exactKeys(r.answers,['selection'])) throw 0;
    const s=r.answers.selection;
    if(!object(s)||s.type!=='choice'||typeof s.choice!=='string'||!ids.includes(s.choice)||!object(s.probabilities)||!exactKeys(s.probabilities,ids)) throw 0;
    const probability=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1;
    const values=ids.map(id=>s.probabilities && (s.probabilities as Record<string,unknown>)[id]);
    if(!values.every(probability)||!probability(s.confidence)) throw 0;
    const sum=values.reduce((a,b)=>a+b,0),max=Math.max(...values);
    const selected=s.probabilities[s.choice];
    if(Math.abs(sum-1)>1e-6||values.filter(v=>v===max).length!==1||selected!==max||Math.abs(s.confidence-max)>1e-6) throw 0;
    return s.choice==='none'||s.choice==='needs_clarification'?{kind:s.choice}:{kind:'chosen',entryId:s.choice};
  } catch {throw new ApiError('model_invalid');}
}
// A fresh, non-global agent and explicit IPv4 destination avoid ambient proxy behavior.
export function httpTransport(port:number):Transport {
  return (body,signal,context)=>new Promise(resolve=>{
    if(!context||!context.clock||typeof context.clock.now!=='function'||typeof context.clock.setTimer!=='function'||typeof context.clock.clearTimer!=='function'||!Number.isFinite(context.deadlineMs)||!Number.isFinite(context.clock.now())||context.clock.now()>=context.deadlineMs||signal.aborted||!validPort(port)) {resolve({kind:'notSent'});return;}
    const {clock,deadlineMs}=context;
    const emitted=new Set<string>();
    const emit=(event:Observation['event'],outcome:Observation['outcome']='started')=>{
      if(emitted.has(event))return;emitted.add(event);
      try {context.observe?.({stage:'transport',event,outcome});}catch { /* No raw observer errors. */ }
    };
    let settled=false;
    let req:http.ClientRequest|undefined;
    let response:http.IncomingMessage|undefined;
    const finish=(result:TransportResult)=>{
      if(settled){emit('late','unknown');return;}
      if(result.kind==='completed'&&clock.now()>=deadlineMs)result={kind:'unknown',timeout:true};
      settled=true;clock.clearTimer(timer);signal.removeEventListener('abort',abort);
      emit('terminal',result.kind);resolve(result);
      if(result.kind==='unknown') {response?.destroy();req?.destroy();}
    };
    const abort=()=>finish({kind:'unknown'});
    const timer=clock.setTimer(()=>finish({kind:'unknown',timeout:true}),Math.max(0,deadlineMs-clock.now()));
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}
    try {
      if(clock.now()>=deadlineMs){finish({kind:'notSent'});return;}
      req=http.request({hostname:'127.0.0.1',port,path:'/v1/systemone',method:'POST',agent:false,
        headers:{'content-type':'application/json','content-length':body.byteLength}},res=>{
        response=res;emit('headers');
        let size=0;const chunks:Buffer[]=[];let ended=false;
        res.on('data',(chunk:Buffer)=>{
          if(settled)return;
          if(clock.now()>=deadlineMs){finish({kind:'unknown',timeout:true});return;}
          size+=chunk.byteLength;
          if(size>65536) {finish({kind:'unknown'});return;}
          chunks.push(Buffer.from(chunk));
        });
        res.on('end',()=>{ended=true;emit('body','completed');if(!res.complete){finish({kind:'unknown'});return;}finish({kind:'completed',status:res.statusCode??0,bytes:Buffer.concat(chunks)});});
        res.on('aborted',abort);res.on('error',abort);
        res.on('close',()=>{if(!ended)abort();});
      });
      req.once('socket',socket=>{socket.once('connect',()=>emit('connect'));});
      req.once('finish',()=>emit('write'));
      req.on('error',abort);
      req.on('close',()=>{if(!settled)abort();});
      if(clock.now()>=deadlineMs){finish({kind:'unknown',timeout:true});return;}
      if(signal.aborted){abort();return;}
      req.end(body);
    } catch {abort();}
  });
}
let observationSequence=0;
const observationOrigins=new WeakMap<Clock,number>();
export function createModel(options:ModelOptions) {
  if(!validatedSnapshots.has(options.policySnapshot))throw new Error('invalid_policy');
  const policySnapshot=options.policySnapshot,policy=policySnapshot.selectedPolicy;
  const clock=options.clock??monotonicClock;
  const origin=observationOrigins.get(clock)??clock.now();
  observationOrigins.set(clock,origin);
  const observe=(event:Observation,attempt?:AttemptContext)=>{
    try {options.observer?.(Object.freeze({...event,sequence:++observationSequence,utc:new Date().toISOString(),elapsedMs:clock.now()-origin,
      ...(attempt?{runId:attempt.runId,attemptId:attempt.attemptId}:{})}));} catch { /* Observer failures never expose raw data. */ }
  };
  let latched=false;
  const configured=validPort(options.backendPort);
  const transport=options.transport??{source:'live' as const,send:httpTransport(options.backendPort??0)};
  return {
    get policySnapshot(){return policySnapshot;},
    clock,observe,
    get latched(){return latched;},
    get ready(){return configured&&!latched;},
    async select(catalog:Catalog,task:string,signal?:AbortSignal,scope?:RequestScope):Promise<{modelSource:TransportConfig['source'];selection:Selection}> {
      const reject=(code:ErrorCode,detail:Detail=code):never=>{observe({stage:'admission',event:'terminal',outcome:'notSent',detail},scope?.attempt);throw new ModelError(code,detail);};
      if(!configured||latched)reject('not_ready');
      const apiDeadlineMs=scope?.apiDeadlineMs??clock.now()+policy.apiMs;
      if(!Number.isFinite(apiDeadlineMs)||apiDeadlineMs-clock.now()<=policy.modelMs+policy.modelReserveMs)reject('model_unavailable','insufficient_budget');
      const body=Buffer.from(JSON.stringify(buildRequest(catalog,task)));
      if(body.byteLength>32768)reject('internal_error');
      // Before sending, an already-aborted caller cannot have caused a model attempt.
      if(signal?.aborted)reject('model_unavailable','pre_dispatch_disconnect');
      if(options.preDispatch) {
        const hookAbort=new AbortController(),hookDeadline=Math.min(apiDeadlineMs,clock.now()+500);
        let hookTimer:ReturnType<typeof setTimeout>|undefined;
        let cancelHook=()=>{};
        const stop=new Promise<never>((_resolve,reject)=>{
          cancelHook=()=>{hookAbort.abort();reject(new ModelError('model_unavailable',signal?.aborted?'pre_dispatch_disconnect':'pre_dispatch_hook_timeout'));};
          hookTimer=clock.setTimer(cancelHook,Math.max(0,hookDeadline-clock.now()));
          signal?.addEventListener('abort',cancelHook,{once:true});
        });
        try {
          const result=await Promise.race([options.preDispatch({body:Buffer.from(body),scope:Object.freeze({...scope,apiDeadlineMs}),signal:hookAbort.signal}),stop]);
          if(clock.now()>=hookDeadline)throw new ModelError('model_unavailable','pre_dispatch_hook_timeout');
          if(!result.ok)throw new ModelError('model_unavailable',result.reason==='binding_mismatch'?'binding_mismatch':'persistence_failed');
        } catch(error) {hookAbort.abort();reject('model_unavailable',error instanceof ModelError?error.detail:'persistence_failed');}
        finally {clock.clearTimer(hookTimer);signal?.removeEventListener('abort',cancelHook);}
      }
      if(signal?.aborted)reject('model_unavailable','pre_dispatch_disconnect');
      if(clock.now()>=apiDeadlineMs)reject('model_unavailable','pre_dispatch_api_expired');
      if(apiDeadlineMs-clock.now()<=policy.modelMs+policy.modelReserveMs)reject('model_unavailable','insufficient_budget');
      const controller=new AbortController();
      const deadlineMs=clock.now()+policy.modelMs;
      const context={clock,deadlineMs,observe:(event:Observation)=>observe(event,scope?.attempt)};
      const result=await new Promise<TransportResult>(resolve=>{
        let terminal=false,late=false,dispatched=false;
        let timer:ReturnType<typeof setTimeout>|undefined;
        const finish=(candidate:TransportResult)=>{
          if(terminal){if(!late){late=true;observe({stage:'model',event:'late',outcome:'unknown'},scope?.attempt);}return;}
          let result=candidate;
          if(dispatched&&result.kind!=='notSent'&&clock.now()>=deadlineMs)result={kind:'unknown',timeout:true};
          if(result.kind==='completed'&&result.bytes.byteLength>65536)result={kind:'unknown'};
          terminal=true;clock.clearTimer(timer);signal?.removeEventListener('abort',cancel);
          if(result.kind==='unknown')latched=true;
          observe({stage:'model',event:'terminal',outcome:result.kind,...(result.kind==='unknown'&&result.timeout?{deadlineCause:'model' as const}:{})},scope?.attempt);
          resolve(result);
          if(result.kind==='unknown')controller.abort();
        };
        const cancel=()=>finish(dispatched?{kind:'unknown'}:{kind:'notSent'});
        timer=clock.setTimer(()=>finish(dispatched?{kind:'unknown',timeout:true}:{kind:'notSent'}),Math.max(0,deadlineMs-clock.now()));
        signal?.addEventListener('abort',cancel,{once:true});
        if(signal?.aborted||clock.now()>=deadlineMs){finish({kind:'notSent'});return;}
        dispatched=true;
        try {const sent=transport.send(body,controller.signal,context);observe({stage:'transport',event:'start',outcome:'started'},scope?.attempt);sent.then(finish,()=>finish({kind:'unknown'}));}
        catch {observe({stage:'transport',event:'start',outcome:'started'},scope?.attempt);finish({kind:'unknown'});}
      });
      if(result.kind==='unknown')throw new ApiError(result.timeout?'model_timeout':'model_unavailable');
      if(result.kind==='notSent')throw new ApiError('model_unavailable');
      if(result.status!==200)throw new ApiError('model_unavailable');
      return {modelSource:transport.source,selection:validateResponse(result.bytes,[...catalog.entries.map(e=>e.id),'needs_clarification','none'])};
    },
  };
}
