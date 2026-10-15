import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Catalog } from './catalog.js';
import { ModelError } from './model.js';
import type { AttemptContext, Detail, createModel } from './model.js';
import { ApiError, errorBody, errorStatus, parseInput } from './contracts.js';
import type { ErrorCode } from './contracts.js';
interface HandlerOptions {catalog:Catalog;model:ReturnType<typeof createModel>;port:()=>number;evidence?:{currentAttempt:()=>AttemptContext|null}}
function checkHeaders(req:IncomingMessage,port:number):number|undefined {
  const headers=new Map<string,string[]>();let size=0;
  for(let i=0;i<req.rawHeaders.length;i+=2){
    const name=req.rawHeaders[i]!,value=req.rawHeaders[i+1]!;size+=Buffer.byteLength(name)+Buffer.byteLength(value)+4;
    const key=name.toLowerCase();headers.set(key,[...headers.get(key)??[],value]);
  }
  if(size>8192||req.rawHeaders.length>=200)throw new ApiError('invalid_input');
  if(headers.get('host')?.length!==1||headers.get('host')![0]!==`127.0.0.1:${port}`||[...headers.keys()].some(k=>k==='origin'||k==='referer'||k==='forwarded'||k.startsWith('x-forwarded-')||k.startsWith('sec-fetch-')))throw new ApiError('forbidden_origin');
  if(req.url!=='/internal/v1/select')throw new ApiError('not_found');
  if(req.method!=='POST')throw new ApiError('method_not_allowed');
  const media=headers.get('content-type');
  if(media?.length!==1||!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(media[0]!)||headers.has('content-encoding'))throw new ApiError('unsupported_media_type');
  const length=headers.get('content-length'),transfer=headers.get('transfer-encoding');
  if((length&&transfer)||(length&&(length.length!==1||!/^(0|[1-9][0-9]*)$/.test(length[0]!)))||(transfer&&(transfer.length!==1||transfer[0]!.toLowerCase()!=='chunked')))throw new ApiError('invalid_input');
  if(length){const n=Number(length[0]);if(!Number.isSafeInteger(n)||n>8192)throw new ApiError('payload_too_large');return n;}
  return undefined;
}
export function createHandler({catalog,model,port,evidence}:HandlerOptions) {
  const clock=model.clock;
  let busy=false;
  let previous:{key:string;abort:AbortController;active:boolean}|undefined;
  return (req:IncomingMessage,res:ServerResponse):void=>{
    const apiDeadlineMs=clock.now()+model.policySnapshot.selectedPolicy.apiMs;
    let attempt:AttemptContext|undefined;
    try {const current=evidence?.currentAttempt();if(current)attempt=Object.freeze({runId:current.runId,attemptId:current.attemptId,expectedBodySha256:current.expectedBodySha256});}catch { /* Missing evidence fails after input validation. */ }
    const invalidAttempt=!!attempt&&(!/^[a-f0-9]{32}$/.test(attempt.runId)||!/^[a-f0-9]{32}$/.test(attempt.attemptId)||!/^[a-f0-9]{64}$/.test(attempt.expectedBodySha256));
    if(invalidAttempt)attempt=undefined;
    const key=attempt?attempt.runId+attempt.attemptId:undefined;
    const duplicate=!!key&&!!previous&&(previous.key===key||previous.active);
    const original=duplicate?previous:undefined;
    let duplicateReported=false;
    const reportDuplicate=()=>{if(!duplicate||duplicateReported)return;duplicateReported=true;model.observe({stage:'admission',event:'late',outcome:'failed',detail:'binding_mismatch'},attempt);original?.abort.abort();};
    let modelEntered=false,admissionRejected=false,finishSeen=false;
    let bodyDeadlineMs=0,apiTerminal=false,apiLate=false;
    const terminal=(finished:boolean)=>{
      if(apiTerminal){if(!apiLate&&finished){apiLate=true;model.observe({stage:'api',event:'late',outcome:'failed'},attempt);}return;}
      apiTerminal=true;
      const expired=clock.now()>=apiDeadlineMs;
      model.observe({stage:'api',event:'terminal',outcome:finished&&!expired?'completed':'failed',...(expired?{deadlineCause:'api' as const}:{})},attempt);
    };
    model.observe({stage:'admission',event:'start',outcome:'started'},attempt);
    let ownsLease=false,done=false,responded=false,reading=false,size=0;
    let readTimer:ReturnType<typeof setTimeout>|undefined;
    const abort=new AbortController(),chunks:Buffer[]=[];
    const owned=key&&!duplicate?{key,abort,active:true}:undefined;
    if(owned)previous=owned;
    const cleanup=()=>{
      if(done)return;done=true;clock.clearTimer(deadline);clock.clearTimer(readTimer);
      req.removeListener('data',data);req.removeListener('end',end);
      if(owned)owned.active=false;
      if(ownsLease){busy=false;ownsLease=false;}
    };
    const disconnect=()=>{
      if(!modelEntered&&!admissionRejected){admissionRejected=true;model.observe({stage:'admission',event:'terminal',outcome:'notSent',detail:clock.now()>=apiDeadlineMs?'pre_dispatch_api_expired':'pre_dispatch_disconnect'},attempt);}
      terminal(false);abort.abort();req.pause();cleanup();if(!res.destroyed)res.destroy();};
    const deadline=clock.setTimer(disconnect,Math.max(0,apiDeadlineMs-clock.now()));
    res.on('finish',()=>{terminal(true);if(!finishSeen){finishSeen=true;model.observe({stage:'api',event:'finish',outcome:'completed'},attempt);}cleanup();});
    res.once('close',()=>{if(!res.writableFinished)disconnect();else cleanup();});
    req.once('aborted',disconnect);req.once('error',disconnect);
    const respond=(status:number,payload:unknown)=>{
      if(done||responded||res.destroyed)return;
      if(clock.now()>=apiDeadlineMs){disconnect();return;}
      responded=true;reading=false;clock.clearTimer(readTimer);req.pause();
      let bytes=Buffer.from(JSON.stringify(payload));
      if(bytes.length>8192){status=500;bytes=Buffer.from(JSON.stringify(errorBody('internal_error')));}
      res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');
      res.setHeader('cache-control','no-store');res.setHeader('connection','close');res.setHeader('content-length',bytes.length);
      if(clock.now()>=apiDeadlineMs){disconnect();return;}
      res.end(bytes);
    };
    const fail=(code:ErrorCode,detail:Detail=code)=>{if(!modelEntered&&!admissionRejected){admissionRejected=true;model.observe({stage:'admission',event:'terminal',outcome:'notSent',detail,...(code==='read_timeout'?{deadlineCause:'body' as const}:{})},attempt);}respond(errorStatus[code],errorBody(code));reportDuplicate();};
    let expectedLength:number|undefined;
    function data(chunk:Buffer){
      if(!reading)return;
      if(clock.now()>=bodyDeadlineMs){fail('read_timeout');return;}
      size+=chunk.byteLength;
      if(size>8192){fail('payload_too_large');return;}
      chunks.push(Buffer.from(chunk));
    }
    function end(){
      if(!reading||done)return;
      if(clock.now()>=bodyDeadlineMs){fail('read_timeout');return;}
      reading=false;clock.clearTimer(readTimer);
      if(expectedLength!==undefined&&expectedLength!==size){fail('invalid_input');return;}
      void (async()=>{
        try {
          const input=parseInput(Buffer.concat(chunks),catalog.version);
          if(invalidAttempt||duplicate)throw new ModelError('model_unavailable','binding_mismatch');
          if(evidence&&!attempt)throw new ModelError('not_ready','missing_attempt');
          modelEntered=true;
          const result=await model.select(catalog,input.task,abort.signal,{apiDeadlineMs,...(attempt?{attempt}:{})});
          respond(200,{schema:'compass.internal.result.v1',catalogVersion:catalog.version,catalogSha256:catalog.sha256,...result,purchaseEnabled:false,paid:false});
        } catch(error){fail(error instanceof ApiError?error.code:'internal_error',error instanceof ModelError?error.detail:error instanceof ApiError?error.code:'internal_error');}
      })();
    }
    try {
      // The unknown latch takes precedence over an outstanding response's lease.
      if(!model.ready)throw new ApiError('not_ready');
      if(busy)throw new ApiError('busy');
      expectedLength=checkHeaders(req,port());
      busy=true;ownsLease=true;reading=true;
      bodyDeadlineMs=clock.now()+2000;
      readTimer=clock.setTimer(()=>fail('read_timeout'),2000);
      req.on('data',data);req.once('end',end);
    } catch(error){fail(error instanceof ApiError?error.code:'internal_error',error instanceof ModelError?error.detail:error instanceof ApiError?error.code:'internal_error');}
  };
}
