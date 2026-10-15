import { it, expect, vi, afterEach } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/catalog.js';
import { createModel, parsePolicySnapshot } from '../src/model.js';
import { createHandler } from '../src/http.js';
import { createCompassServer } from '../src/server.js';
const policySnapshot=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)));
const catalog=loadCatalog(readFileSync(new URL('../catalog/selection.json',import.meta.url)));
const fixture=JSON.parse(readFileSync(new URL('./fixtures/recorded-responses.json',import.meta.url),'utf8')).cases;
const body=Buffer.from(JSON.stringify({schema:'compass.internal.select.v1',task:'Find current weather for Tokyo',catalogVersion:'directory-v1'}));
const completed=(id='weather')=>({kind:'completed' as const,status:200,bytes:Buffer.from(fixture.find((x:any)=>x.case_id===id).raw_response)});
class Response extends Writable {
 statusCode=200; headers:Record<string,string|number>={}; chunks:Buffer[]=[]; hold=false; pending:(()=>void)|undefined;
 setHeader(k:string,v:string|number){this.headers[k.toLowerCase()]=v;return this;}
 _write(chunk:Buffer,_encoding:string,cb:()=>void){this.chunks.push(Buffer.from(chunk));if(this.hold)this.pending=cb;else cb();}
 get json(){return JSON.parse(Buffer.concat(this.chunks).toString());}
}
function request(headers:string[]=['Host','127.0.0.1:9000','Content-Type','application/json'],url='/internal/v1/select',method='POST') {
 return Object.assign(new PassThrough(),{rawHeaders:headers,url,method});
}
function setup(send:any=vi.fn(async()=>completed()),port:number|undefined=8000){
 const model=createModel({policySnapshot,...port===undefined?{}:{backendPort:port},transport:{source:'recorded-fixture',send}});
 return {model,send,handle:createHandler({catalog,model,port:()=>9000})};
}
async function flush(){for(let i=0;i<3;i++){await new Promise<void>(resolve=>process.nextTick(resolve));for(let j=0;j<15;j++)await Promise.resolve();}}
async function call(s:ReturnType<typeof setup>,raw=body,headers?:string[],url?:string,method?:string){const req=request(headers,url,method),res=new Response();s.handle(req as any,res as any);req.end(raw);await flush();return {req,res};}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('returns chosen result with only approved fields and no-store',async()=>{
 const s=setup(),{res}=await call(s);
 expect(res.statusCode).toBe(200);expect(res.json).toEqual({schema:'compass.internal.result.v1',catalogVersion:catalog.version,catalogSha256:catalog.sha256,modelSource:'recorded-fixture',purchaseEnabled:false,paid:false,selection:{kind:'chosen',entryId:'openweather_current'}});
 expect(res.headers['cache-control']).toBe('no-store');expect(Buffer.concat(res.chunks).length).toBeLessThanOrEqual(8192);expect(s.send).toHaveBeenCalledTimes(1);
});
it('returns both sentinel selections from recorded fixtures',async()=>{
 for(const kind of ['none','needs_clarification']){const f=fixture.find((x:any)=>x.expected===kind);const {res}=await call(setup(async()=>({kind:'completed',status:200,bytes:Buffer.from(f.raw_response)})));expect(res.json.selection).toEqual({kind});}
});
it.each([
 ['Host','localhost:9000','Content-Type','application/json'],['Host','127.0.0.1:9000','Host','127.0.0.1:9000'],
 ...['Origin','Referer','Sec-Fetch-Site','Forwarded','X-Forwarded-For'].map(h=>['Host','127.0.0.1:9000',h,'x']),
])('rejects host/browser/forwarded headers %#',async(...headers)=>{const s=setup(),{res}=await call(s,body,headers);expect(res.statusCode).toBe(403);expect(res.json.error).toBe('forbidden_origin');expect(s.send).not.toHaveBeenCalled();});
it.each(['/internal/v1/select?x','/internal/v1/select/','/internal/v1/%73elect','/'])('rejects route %s',async url=>{const s=setup(),{res}=await call(s,body,undefined,url);expect(res.statusCode).toBe(404);expect(s.send).not.toHaveBeenCalled();});
it.each(['GET','OPTIONS','PUT'])('rejects method %s',async method=>{expect((await call(setup(),body,undefined,undefined,method)).res.statusCode).toBe(405);});
it.each(['text/plain','application/json; charset=latin1','application/json;foo=bar'])('rejects media %s',async media=>{expect((await call(setup(),body,['Host','127.0.0.1:9000','Content-Type',media])).res.statusCode).toBe(415);});
it('accepts utf8 charset and chunked body',async()=>{expect((await call(setup(),body,['Host','127.0.0.1:9000','Content-Type','application/json; charset=utf-8','Transfer-Encoding','chunked'])).res.statusCode).toBe(200);});
it.each([
 ['Content-Length','1','Content-Length','1'],['Content-Length','1','Transfer-Encoding','chunked'],['Transfer-Encoding','gzip'],['Content-Length','-1'],['Content-Length','01'],
])('rejects ambiguous framing %#',async(...extra)=>{const s=setup(),{res}=await call(s,body,['Host','127.0.0.1:9000','Content-Type','application/json',...extra]);expect(res.statusCode).toBe(400);expect(s.send).not.toHaveBeenCalled();});
it('rejects compressed input and header overflow',async()=>{
 expect((await call(setup(),body,['Host','127.0.0.1:9000','Content-Type','application/json','Content-Encoding','gzip'])).res.statusCode).toBe(415);
 expect((await call(setup(),body,['Host','127.0.0.1:9000','X-Large','x'.repeat(8192)])).res.statusCode).toBe(400);
});
it('input rejection, mismatch, length mismatch and streaming overflow never call model',async()=>{
 const s=setup();
 for(const [b,status] of [[Buffer.from('{}'),400],[Buffer.from(body.toString().replace('directory-v1','other')),409],[Buffer.alloc(8193,32),413]] as const){const {res}=await call(s,b);expect(res.statusCode).toBe(status);expect(res.json.paid).toBe(false);expect(res.json.purchaseEnabled).toBe(false);expect(res.json.selection).toBeUndefined();}
 expect((await call(s,body,['Host','127.0.0.1:9000','Content-Type','application/json','Content-Length','1'])).res.statusCode).toBe(400);expect(s.send).not.toHaveBeenCalled();
});
it('default backend is not_ready',async()=>{const s=setup(); const model=createModel({policySnapshot,});const handle=createHandler({catalog,model,port:()=>9000});const req=request(),res=new Response();handle(req as any,res as any);req.end(body);await flush();expect(res.json.error).toBe('not_ready');expect(s.send).not.toHaveBeenCalled();});
it('lease begins with body and ends on response finish, without queue',async()=>{
 const s=setup(),req=request(),res=new Response();res.hold=true;s.handle(req as any,res as any);
 expect((await call(s)).res.json.error).toBe('busy');expect(s.send).not.toHaveBeenCalled();
 req.end(body);await flush();expect(s.send).toHaveBeenCalledTimes(1);
 expect((await call(s)).res.json.error).toBe('busy');res.pending!();await flush();expect((await call(s)).res.statusCode).toBe(200);
});
it('unknown latch beats busy while response is held, including late completion',async()=>{
 vi.useFakeTimers();let resolve!:(v:any)=>void;const send=vi.fn(()=>new Promise<any>(r=>{resolve=r;}));const s=setup(send);
 const req=request(),res=new Response();res.hold=true;s.handle(req as any,res as any);req.end(body);await flush();
 await vi.advanceTimersByTimeAsync(10000);expect(res.statusCode).toBe(504);
 expect((await call(s)).res.json.error).toBe('not_ready');resolve(completed());await flush();res.pending!();await flush();
 expect((await call(s)).res.json.error).toBe('not_ready');expect(send).toHaveBeenCalledTimes(1);
});
it('read timeout is absolute and aborts body acceptance',async()=>{
 vi.useFakeTimers();const s=setup(),req=request(),res=new Response();s.handle(req as any,res as any);req.write(body.subarray(0,5));await vi.advanceTimersByTimeAsync(2000);expect(res.statusCode).toBe(408);expect(s.send).not.toHaveBeenCalled();
});
it('15s response deadline closes a slow writer and releases lease',async()=>{
 vi.useFakeTimers();const s=setup(),req=request(),res=new Response();res.hold=true;s.handle(req as any,res as any);req.end(body);await flush();await vi.advanceTimersByTimeAsync(15000);expect(res.destroyed).toBe(true);expect((await call(s)).res.statusCode).toBe(200);
});
it('response disconnect aborts the in-flight model and latches',async()=>{
 let signal!:AbortSignal;const s=setup(vi.fn((_b:any,a:AbortSignal)=>{signal=a;return new Promise(()=>{});}));
 const req=request(),res=new Response();s.handle(req as any,res as any);req.end(body);await flush();res.destroy();await flush();
 expect(signal.aborted).toBe(true);expect(s.model.latched).toBe(true);expect((await call(s)).res.json.error).toBe('not_ready');
});
it.each([['notSent',502,'model_unavailable'],['invalid',502,'model_invalid'],['throw',502,'model_unavailable'],['unknown',502,'model_unavailable']])('maps technical error %s without raw details',async(kind,status,error)=>{
 const s=setup(async()=>{if(kind==='throw')throw Error('SECRET diagnostic');return kind==='invalid'?{kind:'completed',status:200,bytes:Buffer.from('{}')}:{kind};});
 const {res}=await call(s);expect(res.statusCode).toBe(status);expect(res.json).toEqual({schema:'compass.internal.error.v1',error,purchaseEnabled:false,paid:false});
});
it('factory does not bind on import/create and configures parser limits',()=>{
 const app=createCompassServer({port:9000});expect(app.server.listening).toBe(false);expect(app.server.maxHeadersCount).toBe(100);expect(app.server.headersTimeout).toBe(5000);expect(app.server.requestTimeout).toBe(15000);app.server.close();
 expect(()=>createCompassServer({port:9000,catalogPath:new URL('../package.json',import.meta.url)})).toThrow();
});
it('rejects headers at parser truncation boundary instead of trusting an incomplete list',async()=>{
 const headers=['Host','127.0.0.1:9000','Content-Type','application/json'];for(let i=0;i<98;i++)headers.push(`X-${i}`,'a');
 const s=setup(),{res}=await call(s,body,headers);expect(res.statusCode).toBe(400);expect(s.send).not.toHaveBeenCalled();
});
it('oversized metadata-derived model request returns 500 before transport without latch',async()=>{
 const data=JSON.parse(readFileSync(new URL('../catalog/selection.json',import.meta.url),'utf8'));
 for(const e of data.entries){e.capabilities=Array(8).fill('😀'.repeat(300));e.requiredInputs=Array(8).fill('😀'.repeat(300));}
 const large=loadCatalog(Buffer.from(JSON.stringify(data)));const send=vi.fn();const model=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send}});
 const handle=createHandler({catalog:large,model,port:()=>9000});const req=request(),res=new Response();handle(req as any,res as any);req.end(body);await flush();
 expect(res.statusCode).toBe(500);expect(res.json.error).toBe('internal_error');expect(send).not.toHaveBeenCalled();expect(model.latched).toBe(false);
});
it('factory listen passes only fixed IPv4 host (mocked, no bind)',async()=>{
 const app=createCompassServer({port:9000});
 vi.spyOn(app.server,'address').mockReturnValue({address:'127.0.0.1',family:'IPv4',port:9000});
 const listen=vi.spyOn(app.server,'listen').mockImplementation(((port:number,host:string,cb:()=>void)=>{cb();return app.server;}) as any);
 expect(await app.listen()).toBe(9000);expect(listen.mock.calls[0]?.slice(0,2)).toEqual([9000,'127.0.0.1']);app.server.close();
});
it('body disconnect releases lease without model attempt or latch',async()=>{
 const s=setup(),req=request(),res=new Response();s.handle(req as any,res as any);req.write('{');req.emit('aborted');await flush();
 expect(s.send).not.toHaveBeenCalled();expect(s.model.latched).toBe(false);expect((await call(s)).res.statusCode).toBe(200);
});
it('header receipt has a 5s absolute deadline without opening a socket',async()=>{
 vi.useFakeTimers();const {EventEmitter}=await import('node:events');const app=createCompassServer({port:9000});
 const socket=Object.assign(new EventEmitter(),{destroy:vi.fn()});app.server.emit('connection',socket);
 await vi.advanceTimersByTimeAsync(4999);expect(socket.destroy).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(socket.destroy).toHaveBeenCalled();socket.emit('close');app.server.close();
});
it('C1 factory exposes frozen policy identity from actual source bytes',()=>{
 const app=createCompassServer({port:0});
 expect(app).toHaveProperty('policyIdentity');
 const identity=(app as any).policyIdentity;
 expect(identity.profile).toBe('default');
 expect(identity.selectedPolicy).toEqual({modelMs:10000,apiMs:15000,controllerMs:20000,modelReserveMs:1000,controllerReserveMs:1000});
 expect(Object.isFrozen(identity)).toBe(true);expect(Object.isFrozen(identity.selectedPolicy)).toBe(true);
 app.server.close();
});
it('C1 MUST1 factory accepts valid padded 2048 bytes and rejects valid padded 2049 bytes',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'cold-policy-limit-')),policyPath=join(dir,'policy.json');
 try {
  const raw=readFileSync(new URL('../config/deadline-policy.json',import.meta.url));
  const padded=(size:number)=>Buffer.concat([raw,Buffer.alloc(size-raw.length,32)]);
  const accepted=padded(2048),rejected=padded(2049);
  expect(accepted.byteLength).toBe(2048);expect(rejected.byteLength).toBe(2049);
  expect(JSON.parse(rejected.toString())).toEqual(JSON.parse(raw.toString()));
  writeFileSync(policyPath,accepted);
  const app=createCompassServer({port:0,policyPath});
  try {expect(app.server.listening).toBe(false);expect(app.policyIdentity).toEqual(parsePolicySnapshot(accepted));}finally{app.server.close();}
  writeFileSync(policyPath,rejected);
  expect(()=>createCompassServer({port:0,policyPath})).toThrow('invalid_policy');
 }finally{rmSync(dir,{recursive:true});}
});
function manualClock(){let time=0;return {now:()=>time,set:(n:number)=>{time=n;},setTimer:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimer:(timer:ReturnType<typeof setTimeout>|undefined)=>clearTimeout(timer)};}
it('C2 MUST2 HTTP abort at API deadline reports expiry and releases lease',async()=>{
 const clock=manualClock(),events:any[]=[],send=vi.fn(async()=>completed());
 const model=createModel({policySnapshot,clock,observer:e=>events.push(e),backendPort:8000,transport:{source:'recorded-fixture',send}});
 const handle=createHandler({catalog,model,port:()=>9000}),req=request(),res=new Response();
 handle(req as any,res as any);clock.set(15000);req.emit('aborted');await flush();
 expect(res.chunks).toHaveLength(0);expect(res.destroyed).toBe(true);expect(res.headers).toEqual({});
 expect(events.filter(e=>e.stage==='admission'&&e.event==='terminal')).toEqual([expect.objectContaining({outcome:'notSent',detail:'pre_dispatch_api_expired'})]);
 expect(send).not.toHaveBeenCalled();expect(model.latched).toBe(false);
 const freshReq=request(),freshRes=new Response();handle(freshReq as any,freshRes as any);freshReq.end(body);await flush();
 expect(freshRes.statusCode).toBe(200);expect(freshRes.json.selection).toEqual({kind:'chosen',entryId:'openweather_current'});
 expect(send).toHaveBeenCalledTimes(1);expect(model.latched).toBe(false);
});
it('C2 body equality expires even before timer callback',async()=>{
 const clock=manualClock(),send=vi.fn(async()=>completed());const model=createModel({policySnapshot,clock,backendPort:8000,transport:{source:'recorded-fixture',send}});
 const handle=createHandler({catalog,model,port:()=>9000}),req=request(),res=new Response();handle(req as any,res as any);
 clock.set(2000);req.end(body);await flush();expect(res.statusCode).toBe(408);expect(send).not.toHaveBeenCalled();expect(model.latched).toBe(false);
});
it('C2 API deadline forbids new response after adopted completed model',async()=>{
 const clock=manualClock(),model=createModel({policySnapshot,clock,backendPort:8000,transport:{source:'recorded-fixture',send:async()=>completed()}});
 const select=model.select.bind(model);vi.spyOn(model,'select').mockImplementation(async(...args)=>{const result=await select(...args);clock.set(15000);return result;});
 const handle=createHandler({catalog,model,port:()=>9000}),req=request(),res=new Response();handle(req as any,res as any);req.end(body);await flush();
 expect(res.destroyed).toBe(true);expect(res.chunks).toHaveLength(0);expect(model.latched).toBe(false);
});
it('C2 API finish equality is terminal failure independent of model completion',async()=>{
 const clock=manualClock(),events:any[]=[];
 const model=createModel({policySnapshot,clock,observer:e=>events.push(e),backendPort:8000,transport:{source:'recorded-fixture',send:async()=>completed()}});
 const handle=createHandler({catalog,model,port:()=>9000}),req=request(),res=new Response();res.hold=true;handle(req as any,res as any);req.end(body);await flush();
 clock.set(15000);res.pending!();await flush();
 expect(events.filter(e=>e.stage==='api'&&e.event==='terminal')).toEqual([expect.objectContaining({outcome:'failed',deadlineCause:'api'})]);
 expect(events.filter(e=>e.stage==='model'&&e.event==='terminal')).toEqual([expect.objectContaining({outcome:'completed'})]);expect(model.latched).toBe(false);
 res.emit('finish');expect(events.filter(e=>e.stage==='api'&&e.event==='terminal')).toHaveLength(1);
});
it('C2 missing attempt follows input priority and holds lease until finish',async()=>{
 const events:any[]=[],send=vi.fn(async()=>completed());const model=createModel({policySnapshot,backendPort:8000,observer:e=>events.push(e),transport:{source:'recorded-fixture',send}});
 const handle=createHandler({catalog,model,port:()=>9000,evidence:{currentAttempt:()=>null}} as any);
 const req=request(),res=new Response();res.hold=true;handle(req as any,res as any);req.end(body);await flush();
 expect(res.statusCode).toBe(503);expect(res.json.error).toBe('not_ready');expect(send).not.toHaveBeenCalled();
 expect(events).toContainEqual(expect.objectContaining({detail:'missing_attempt'}));
 const req2=request(),res2=new Response();handle(req2 as any,res2 as any);req2.end(body);await flush();expect(res2.json.error).toBe('busy');
 res.pending!();await flush();const req3=request(),res3=new Response();handle(req3 as any,res3 as any);req3.end('{}');await flush();expect(res3.json.error).toBe('invalid_input');expect(model.latched).toBe(false);
});
it('C2 duplicate handler preserves busy response then aborts original unknown',async()=>{
 const events:any[]=[],send=vi.fn(()=>new Promise<any>(()=>{}));const model=createModel({policySnapshot,backendPort:8000,observer:e=>events.push(e),transport:{source:'recorded-fixture',send}});
 const attempt=Object.freeze({runId:'a'.repeat(32),attemptId:'b'.repeat(32),expectedBodySha256:'c'.repeat(64)});
 const handle=createHandler({catalog,model,port:()=>9000,evidence:{currentAttempt:()=>attempt}} as any);
 const req=request(),res=new Response();handle(req as any,res as any);req.end(body);await flush();expect(send).toHaveBeenCalledTimes(1);
 const req2=request(),res2=new Response();handle(req2 as any,res2 as any);req2.end(body);await flush();
 expect(res2.json.error).toBe('busy');expect(model.latched).toBe(true);expect(send).toHaveBeenCalledTimes(1);
 expect(events).toContainEqual(expect.objectContaining({detail:'binding_mismatch'}));
});
it('C2 factory wires evidence hook and clock without listening',async()=>{
 const clock=manualClock(),events:any[]=[],send=vi.fn(async()=>completed());
 const preDispatch=vi.fn(async()=>({ok:false as const,reason:'persistence_failed' as const}));
 const app=createCompassServer({port:0,backendPort:8000,clock,observer:(e:any)=>events.push(e),evidence:{currentAttempt:()=>({runId:'a'.repeat(32),attemptId:'b'.repeat(32),expectedBodySha256:'c'.repeat(64)}),preDispatch},transport:{source:'recorded-fixture',send}} as any);
 const req=request(['Host','127.0.0.1:0','Content-Type','application/json']),res=new Response();app.server.emit('request',req,res);req.end(body);await flush();
 expect(preDispatch).toHaveBeenCalledTimes(1);expect(res.statusCode).toBe(502);expect(send).not.toHaveBeenCalled();expect(events).toContainEqual(expect.objectContaining({detail:'persistence_failed'}));expect(app.server.listening).toBe(false);app.server.close();
});
it.each(['request','checkContinue','checkExpectation'] as const)('C2 header timer clears on %s while diagnostic response exceeds 15 seconds',async event=>{
 vi.useFakeTimers();const {EventEmitter}=await import('node:events');let resolve!:(v:any)=>void;
 const app=createCompassServer({port:0,profile:'diagnostic',backendPort:8000,transport:{source:'recorded-fixture',send:()=>new Promise<any>(r=>{resolve=r;})}});
 const socket=Object.assign(new EventEmitter(),{destroy:vi.fn()});app.server.emit('connection',socket);
 const req=Object.assign(request(['Host','127.0.0.1:0','Content-Type','application/json']),{socket}),res=new Response();app.server.emit(event,req,res);req.end(body);await flush();
 await vi.advanceTimersByTimeAsync(20000);expect(socket.destroy).not.toHaveBeenCalled();expect(res.destroyed).toBe(false);
 resolve(completed());await flush();expect(res.statusCode).toBe(200);expect(res.json.selection).toBeDefined();socket.emit('close');app.server.close();
});
it.each(['default','diagnostic'] as const)('C2 handler entry reserve survives body completion and later parse delay %s',async profile=>{
 for(const elapsed of [3999,4000,4001]){
  const clock=manualClock(),snapshot=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)),profile),send=vi.fn(async()=>completed());
  const model=createModel({policySnapshot:snapshot,clock,backendPort:8000,transport:{source:'recorded-fixture',send}});
  const delayed={...catalog,get version(){clock.set(elapsed);return catalog.version;}};
  const handle=createHandler({catalog:delayed,model,port:()=>9000}),req=request(),res=new Response();handle(req as any,res as any);req.end(body);await flush();
  expect(res.statusCode).toBe(elapsed<4000?200:502);expect(send).toHaveBeenCalledTimes(elapsed<4000?1:0);expect(model.latched).toBe(false);
 }
});
it('C1 factory reads bounded source once and returns actual diagnostic identity',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'cold-policy-')),path=join(dir,'policy.json');
 try {
  const raw=readFileSync(new URL('../config/deadline-policy.json',import.meta.url));writeFileSync(path,raw);
  const app=createCompassServer({port:0,policyPath:path,profile:'diagnostic'});
  expect(app.policyIdentity.policySha256).toBe(createHash('sha256').update(raw).digest('hex'));expect(app.policyIdentity.selectedPolicy.modelMs).toBe(60000);expect(app.policyIdentity.selectedPolicy.controllerMs).toBe(70000);
  writeFileSync(path,'{}');expect(app.policyIdentity.selectedPolicy.modelMs).toBe(60000);app.server.close();expect(()=>createCompassServer({port:0,policyPath:path})).toThrow('invalid_policy');
  writeFileSync(path,Buffer.alloc(2049,32));expect(()=>createCompassServer({port:0,policyPath:path})).toThrow('invalid_policy');
  expect(()=>createCompassServer({port:0,policyPath:join(dir,'absent')})).toThrow();
 }finally{rmSync(dir,{recursive:true});}
});
it('C1 factory policy identity cannot be replaced independently of active policy',()=>{
 const app=createCompassServer({port:0});expect(()=>{(app as any).policyIdentity={};}).toThrow();app.server.close();
});
it.each(['request','checkContinue','checkExpectation'] as const)('C2 late header adoption rejects at equality before %s handler',async event=>{
 const {EventEmitter}=await import('node:events');const clock=manualClock(),send=vi.fn(async()=>completed());
 const app=createCompassServer({port:0,backendPort:8000,clock,transport:{source:'recorded-fixture',send}});
 const socket=Object.assign(new EventEmitter(),{destroy:vi.fn()});app.server.emit('connection',socket);clock.set(5000);
 const req=Object.assign(request(['Host','127.0.0.1:0','Content-Type','application/json']),{socket}),res=new Response();app.server.emit(event,req,res);req.end(body);await flush();
 expect(socket.destroy).toHaveBeenCalledTimes(1);expect(send).not.toHaveBeenCalled();expect(res.chunks).toHaveLength(0);socket.emit('close');app.server.close();
});
it('C2 predispatch disconnect reports notSent once and late finish stays failed',async()=>{
 const events:any[]=[],send=vi.fn();const model=createModel({policySnapshot,observer:e=>events.push(e),backendPort:8000,transport:{source:'recorded-fixture',send}});
 const handle=createHandler({catalog,model,port:()=>9000}),req=request(),res=new Response();handle(req as any,res as any);req.emit('aborted');req.emit('aborted');res.emit('finish');res.emit('finish');await flush();
 expect(events.filter(e=>e.stage==='admission'&&e.event==='terminal')).toEqual([expect.objectContaining({outcome:'notSent',detail:'pre_dispatch_disconnect'})]);
 expect(events.filter(e=>e.stage==='api'&&e.event==='terminal')).toEqual([expect.objectContaining({outcome:'failed'})]);
 expect(events.filter(e=>e.stage==='api'&&e.event==='finish')).toHaveLength(1);expect(send).not.toHaveBeenCalled();expect(model.latched).toBe(false);
});
it('C2 duplicate completed attempt rejects without changing adopted model result',async()=>{
 const events:any[]=[],send=vi.fn(async()=>completed()),model=createModel({policySnapshot,observer:e=>events.push(e),backendPort:8000,transport:{source:'recorded-fixture',send}});
 const attempt={runId:'a'.repeat(32),attemptId:'b'.repeat(32),expectedBodySha256:'c'.repeat(64)},handle=createHandler({catalog,model,port:()=>9000,evidence:{currentAttempt:()=>attempt}});
 for(const expected of [200,502]){const req=request(),res=new Response();handle(req as any,res as any);req.end(body);await flush();expect(res.statusCode).toBe(expected);}
 expect(send).toHaveBeenCalledTimes(1);expect(model.latched).toBe(false);expect(events.filter(e=>e.stage==='model'&&e.event==='terminal')).toEqual([expect.objectContaining({outcome:'completed'})]);
});
it.each(['binding_mismatch','persistence_failed'] as const)('C2 factory hook rejection %s retains lease and sends nothing',async reason=>{
 const send=vi.fn(),events:any[]=[];let attemptId='b'.repeat(32);
 const app=createCompassServer({port:0,backendPort:8000,observer:e=>events.push(e),evidence:{currentAttempt:()=>({runId:'a'.repeat(32),attemptId,expectedBodySha256:'c'.repeat(64)}),preDispatch:async()=>({ok:false,reason})},transport:{source:'recorded-fixture',send}});
 const req=request(['Host','127.0.0.1:0','Content-Type','application/json']),res=new Response();res.hold=true;app.server.emit('request',req,res);req.end(body);await flush();expect(res.statusCode).toBe(502);
 expect(events).toContainEqual(expect.objectContaining({detail:reason,outcome:'notSent'}));expect(send).not.toHaveBeenCalled();
 // A second handler is still rejected by the lease before context checks.
 attemptId='d'.repeat(32);const req2=request(['Host','127.0.0.1:0','Content-Type','application/json']),res2=new Response();app.server.emit('request',req2,res2);req2.end(body);await flush();expect(res2.json.error).toBe('busy');res.pending!();await flush();app.server.close();
});
it('C2 response checks deadline immediately before end after header preparation',async()=>{
 const clock=manualClock(),model=createModel({policySnapshot,clock,backendPort:8000,transport:{source:'recorded-fixture',send:async()=>completed()}});
 const handle=createHandler({catalog,model,port:()=>9000}),req=request(),res=new Response();
 const setHeader=res.setHeader.bind(res);res.setHeader=(k,v)=>{clock.set(15000);return setHeader(k,v);};
 handle(req as any,res as any);req.end(body);await flush();expect(res.chunks).toHaveLength(0);expect(res.destroyed).toBe(true);expect(model.latched).toBe(false);
});
