import { it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { loadCatalog } from '../src/catalog.js';
import { createModel, validateResponse, httpTransport, parsePolicySnapshot, monotonicClock } from '../src/model.js';
const fixtures:{cases:{case_id:string;expected:string;raw_response:string;sha256:string}[]}=JSON.parse(readFileSync(new URL('./fixtures/recorded-responses.json',import.meta.url),'utf8'));
const policySnapshot=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)));
const catalog=loadCatalog(readFileSync(new URL('../catalog/selection.json',import.meta.url)));
const ids=[...catalog.entries.map(e=>e.id),'needs_clarification','none'];
const raw=()=>JSON.parse(fixtures.cases[0]!.raw_response);
const bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));
const deadlineContext=()=>({clock:monotonicClock,deadlineMs:monotonicClock.now()+policySnapshot.selectedPolicy.modelMs});
const completed=(v=raw())=>({kind:'completed' as const,status:200,bytes:bytes(v)});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it.each(fixtures.cases)('replays original response by case ID $case_id',async(f:any)=>{
 expect(createHash('sha256').update(f.raw_response).digest('hex')).toBe(f.sha256);
 const transport=vi.fn(async(_body:Uint8Array,_signal:AbortSignal)=>({kind:'completed' as const,status:200,bytes:Buffer.from(f.raw_response)}));
 const model=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send:transport}});
 const result=await model.select(catalog,'A new prompt is not being evaluated');
 expect(result).toEqual({modelSource:'recorded-fixture',selection:ids.slice(0,3).includes(f.expected)?{kind:'chosen',entryId:f.expected}:{kind:f.expected}});
 expect(transport).toHaveBeenCalledTimes(1);
 const wire=JSON.parse(transport.mock.calls[0]![0] as unknown as string);
 expect(Object.keys(wire.questions.selection.criteria)).toEqual(ids);
});
it.each(['model','type','confidence-missing','confidence-nan','confidence-range','confidence-delta','missing-label','extra-label','negative','sum','tie','argmax','answers'])('rejects invalid wire %s',kind=>{
 const r=raw(), s=r.answers.selection;
 if(kind==='model') r.model='other'; if(kind==='type') delete s.type;
 if(kind==='confidence-missing') delete s.confidence;
 if(kind==='confidence-nan') s.confidence=null;
 if(kind==='confidence-range') s.confidence=2;
 if(kind==='confidence-delta') s.confidence+=2e-6;
 if(kind==='missing-label') delete s.probabilities.none;
 if(kind==='extra-label') s.probabilities.other=0;
 if(kind==='negative') s.probabilities.none=-0.1;
 if(kind==='sum') s.probabilities.none+=2e-6;
 if(kind==='tie') {s.probabilities=Object.fromEntries(ids.map(id=>[id,0.2]));s.confidence=0.2;}
 if(kind==='argmax') s.choice='none'; if(kind==='answers') r.answers.other={};
 expect(()=>validateResponse(bytes(r),ids)).toThrow('model_invalid');
});
it('accepts tolerance inside and rejects outside without correction',()=>{
 const r=raw();r.answers.selection.confidence+=0.9e-6;r.answers.selection.probabilities.none+=0.9e-6;
 expect(validateResponse(bytes(r),ids)).toEqual({kind:'chosen',entryId:'openweather_current'});
 r.answers.selection.probabilities.none+=0.2e-6;expect(()=>validateResponse(bytes(r),ids)).toThrow('model_invalid');
});
it.each(['{','{"model":"dgemma","model":"dgemma"}','[1,2]','{"x":"\\ud800"}', '['.repeat(9)+'0'+']'.repeat(9), JSON.stringify(Array(65).fill(0)),JSON.stringify(Object.fromEntries(Array.from({length:257},(_,i)=>[i,0])))])('rejects bounded invalid JSON %s',text=>expect(()=>validateResponse(Buffer.from(text),ids)).toThrow('model_invalid'));
it.each([undefined,0,65536,1.5,'http://example.com',NaN])('unconfigured/invalid port %s sends nothing',async port=>{
 const send=vi.fn();const m=createModel({policySnapshot,backendPort:port as number,transport:{source:'recorded-fixture',send}});
 await expect(m.select(catalog,'x')).rejects.toThrow('not_ready');expect(send).not.toHaveBeenCalled();expect(m.latched).toBe(false);
});
it.each(['notSent','non200','invalid'])('does not latch completed failure or proven notSent: %s',async kind=>{
 const send=vi.fn(async()=>kind==='notSent'?{kind:'notSent' as const}:kind==='non200'?{...completed(),status:302}:{...completed(),bytes:Buffer.from('{}')});
 const m=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send}});
 await expect(m.select(catalog,'x')).rejects.toThrow(kind==='invalid'?'model_invalid':'model_unavailable');expect(m.latched).toBe(false);
 await expect(m.select(catalog,'x')).rejects.toThrow();expect(send).toHaveBeenCalledTimes(2);
});
it.each(['unknown','throw','oversize'])('latches unknown and refuses retries: %s',async kind=>{
 const send=vi.fn(async()=>{if(kind==='throw')throw Error('private diagnostics');return kind==='oversize'?{...completed(),bytes:Buffer.alloc(65537)}:{kind:'unknown' as const};});
 const m=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send}});
 await expect(m.select(catalog,'x')).rejects.toThrow('model_unavailable');expect(m.latched).toBe(true);
 await expect(m.select(catalog,'x')).rejects.toThrow('not_ready');expect(send).toHaveBeenCalledTimes(1);
});
it('10-second total deadline aborts, latches, and ignores late completion',async()=>{
 vi.useFakeTimers();let finish!:(v:any)=>void;let signal!:AbortSignal;
 const send=vi.fn((_b:Uint8Array,s:AbortSignal)=>{signal=s;return new Promise<any>(resolve=>{finish=resolve;});});
 const m=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send}});
 const p=expect(m.select(catalog,'x')).rejects.toThrow('model_timeout');await vi.advanceTimersByTimeAsync(10000);await p;
 expect(signal.aborted).toBe(true);finish(completed());await Promise.resolve();expect(m.latched).toBe(true);
});
it('client abort latches an in-flight attempt',async()=>{
 const send=vi.fn(()=>new Promise<any>(()=>{}));const m=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send}});
 const abort=new AbortController();const p=expect(m.select(catalog,'x',abort.signal)).rejects.toThrow('model_unavailable');abort.abort();await p;expect(m.latched).toBe(true);
});
it('request exceeding 32KiB is internal_error before send, without latch',async()=>{
 const send=vi.fn();const m=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send}});
 await expect(m.select(catalog,'x'.repeat(32768))).rejects.toThrow('internal_error');expect(send).not.toHaveBeenCalled();expect(m.latched).toBe(false);
});
// node:http is replaced at its request boundary: these tests open no socket.
function mockHttp() {
 const req=Object.assign(new EventEmitter(),{end:vi.fn(),destroy:vi.fn()});
 let callback!:(r:any)=>void;
 const spy=vi.spyOn(http,'request').mockImplementation(((options:any,cb:any)=>{callback=cb;return req;}) as any);
 const response=Object.assign(new EventEmitter(),{statusCode:200,complete:true,destroy:vi.fn()});
 return {req,spy,response,headers:()=>callback(response)};
}
it('direct HTTP fixes destination, agent:false, and waits for body',async()=>{
 const h=mockHttp();const send=httpTransport(8000);let done=false;
 const p=send(Buffer.from('{}'),new AbortController().signal,deadlineContext()).then((r:any)=>{done=true;return r;});
 expect(h.spy.mock.calls[0]![0]).toMatchObject({hostname:'127.0.0.1',port:8000,path:'/v1/systemone',method:'POST',agent:false});
 h.headers();await Promise.resolve();expect(done).toBe(false);
 h.response.emit('data',Buffer.from('ok'));h.response.emit('end');expect(await p).toEqual({kind:'completed',status:200,bytes:Buffer.from('ok')});
});
it.each(['overflow','error','aborted','close','request-error','abort','timeout'])('default HTTP classifies %s as unknown',async kind=>{
 vi.useFakeTimers();const h=mockHttp();const a=new AbortController();const p=httpTransport(8000)(Buffer.from('{}'),a.signal,deadlineContext());
 h.headers();
 if(kind==='overflow')h.response.emit('data',Buffer.alloc(65537));
 if(kind==='error')h.response.emit('error',Error('private'));
 if(kind==='aborted')h.response.emit('aborted');
 if(kind==='close'){h.response.complete=false;h.response.emit('close');}
 if(kind==='request-error')h.req.emit('error',Error('private'));
 if(kind==='abort')a.abort();if(kind==='timeout')await vi.advanceTimersByTimeAsync(10000);
 expect((await p).kind).toBe('unknown');expect(h.req.destroy).toHaveBeenCalled();
});
it('request close before headers is unknown, even without an error event',async()=>{
 const h=mockHttp();const p=httpTransport(8000)(Buffer.from('{}'),new AbortController().signal,deadlineContext());
 h.req.emit('close');expect(await p).toEqual({kind:'unknown'});
});
it('accepts exactly 64KiB upstream bytes, without returning diagnostics',()=>{
 const r=raw();r.padding='';const extra=65536-bytes(r).length;r.padding='x'.repeat(extra);
 expect(bytes(r)).toHaveLength(65536);expect(validateResponse(bytes(r),ids)).toEqual({kind:'chosen',entryId:'openweather_current'});
});
it('accepts exactly 32KiB outbound bytes',async()=>{
 const {buildRequest}=await import('../src/catalog.js');
 const task='x'.repeat(32768-Buffer.byteLength(JSON.stringify(buildRequest(catalog,''))));
 const send=vi.fn(async(b:Uint8Array)=>{expect(b.byteLength).toBe(32768);return completed();});
 const m=createModel({policySnapshot,backendPort:8000,transport:{source:'recorded-fixture',send}});
 await expect(m.select(catalog,task)).resolves.toHaveProperty('modelSource','recorded-fixture');expect(send).toHaveBeenCalledTimes(1);
});
it('default response exactly 64KiB completes, and incomplete end remains unknown',async()=>{
 const h=mockHttp();const p=httpTransport(8000)(Buffer.from('{}'),new AbortController().signal,deadlineContext());h.headers();h.response.emit('data',Buffer.alloc(65536));h.response.emit('end');expect((await p).kind).toBe('completed');
 h.spy.mockRestore();const h2=mockHttp();const p2=httpTransport(8000)(Buffer.from('{}'),new AbortController().signal,deadlineContext());h2.headers();h2.response.complete=false;h2.response.emit('end');expect((await p2).kind).toBe('unknown');
});
it('synchronous default request exception is unknown',async()=>{
 vi.spyOn(http,'request').mockImplementation(()=>{throw Error('private');});
 expect(await httpTransport(8000)(Buffer.from('{}'),new AbortController().signal,deadlineContext())).toEqual({kind:'unknown'});
});
it('C1 strict policy rejects malformed schema types bounds and reserve equalities',()=>{
 const source=readFileSync(new URL('../config/deadline-policy.json',import.meta.url));
 const mutations=[
  (p:any)=>{p.extra=1;},(p:any)=>{p.schema='other';},(p:any)=>{delete p.profiles.diagnostic;},
  (p:any)=>{p.profiles.other=p.profiles.default;},(p:any)=>{p.profiles.default.extra=1;},
  ...[null,true,'10000',0,-1,1.5,70001].map(v=>(p:any)=>{p.profiles.default.modelMs=v;}),
  (p:any)=>{p.profiles.default.apiMs=p.profiles.default.modelMs+p.profiles.default.modelReserveMs;},
  (p:any)=>{p.profiles.default.controllerMs=p.profiles.default.apiMs+p.profiles.default.controllerReserveMs;},
 ];
 for(const mutate of mutations){const p=JSON.parse(source.toString());mutate(p);expect(()=>parsePolicySnapshot(bytes(p))).toThrow('invalid_policy');}
 for(const bad of [Buffer.alloc(2049,32),Buffer.from('{"schema":1,"schema":2}'),Buffer.from([0xff])])expect(()=>parsePolicySnapshot(bad)).toThrow('invalid_policy');
 expect(()=>parsePolicySnapshot(source,'other' as any)).toThrow('invalid_policy');
 const p=parsePolicySnapshot(source,'diagnostic');expect(p.selectedPolicy.controllerMs).toBe(70000);
 expect(p.policySha256).toBe(createHash('sha256').update(source).digest('hex'));
 const padded=Buffer.concat([source,Buffer.alloc(2048-source.length,32)]);expect(parsePolicySnapshot(padded).policySha256).toBe(createHash('sha256').update(padded).digest('hex'));
});
it('C1 model requires an authentic validated snapshot without fallback',()=>{
 expect(()=>createModel({} as any)).toThrow('invalid_policy');
 const valid=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)));
 expect(()=>createModel({policySnapshot:{...valid}} as any)).toThrow('invalid_policy');
 expect(()=>createModel({policySnapshot:valid} as any)).not.toThrow();
});
it('C1 MUST1 parser accepts valid padded 2048 bytes and rejects valid padded 2049 bytes',()=>{
 const raw=readFileSync(new URL('../config/deadline-policy.json',import.meta.url));
 const padded=(size:number)=>Buffer.concat([raw,Buffer.alloc(size-raw.length,32)]);
 const accepted=padded(2048),rejected=padded(2049);
 expect(accepted.byteLength).toBe(2048);expect(rejected.byteLength).toBe(2049);
 expect(JSON.parse(rejected.toString())).toEqual(JSON.parse(raw.toString()));
 expect(parsePolicySnapshot(accepted).policySha256).toBe(createHash('sha256').update(accepted).digest('hex'));
 expect(()=>parsePolicySnapshot(rejected)).toThrow('invalid_policy');
});
function manualClock(start=0){let time=start;return {now:()=>time,set:(n:number)=>{time=n;},setTimer:(fn:()=>void,ms:number)=>setTimeout(fn,ms),clearTimer:(timer:ReturnType<typeof setTimeout>|undefined)=>clearTimeout(timer)};}
it('C2 MUST2 model hook-free construction reaches API deadline before dispatch',async()=>{
 const clock=manualClock(),send=vi.fn(async()=>completed());
 const apiDeadlineMs=policySnapshot.selectedPolicy.apiMs;
 const entries=vi.fn(()=>{clock.set(apiDeadlineMs);return catalog.entries;});
 const delayed={...catalog,get entries(){return entries();}};
 const model=createModel({policySnapshot,clock,backendPort:8000,transport:{source:'recorded-fixture',send}});
 await expect(model.select(delayed,'x',undefined,{apiDeadlineMs})).rejects.toMatchObject({code:'model_unavailable',detail:'pre_dispatch_api_expired'});
 expect(entries).toHaveBeenCalled();expect(clock.now()).toBe(apiDeadlineMs);
 expect(send).not.toHaveBeenCalled();expect(model.latched).toBe(false);
});
it.each(['default','diagnostic'] as const)('C2 model adopts only before shared absolute deadline %s',async profile=>{
 const snapshot=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)),profile);
 const clock=manualClock(100);let resolve!:(v:any)=>void;
 const send=vi.fn((_b:any,_s:any,_c:any)=>new Promise<any>(r=>{resolve=r;}));
 const m=createModel({policySnapshot:snapshot,backendPort:8000,clock,transport:{source:'recorded-fixture',send}} as any);
 const p=m.select(catalog,'x');await Promise.resolve();
 expect(send.mock.calls[0]![2]).toMatchObject({clock,deadlineMs:100+snapshot.selectedPolicy.modelMs});
 clock.set(100+snapshot.selectedPolicy.modelMs);resolve(completed());
 await expect(p).rejects.toThrow('model_timeout');expect(m.latched).toBe(true);
});
it('C2 HTTP shares deadline rejects missing expired context and checks end equality',async()=>{
 const h=mockHttp(),clock=manualClock(100),signal=new AbortController().signal,send=httpTransport(8000);
 const missing=send(bytes({}),signal,undefined as any);expect(h.spy).not.toHaveBeenCalled();expect(await missing).toEqual({kind:'notSent'});
 expect(await send(bytes({}),signal,{clock,deadlineMs:100})).toEqual({kind:'notSent'});expect(h.spy).not.toHaveBeenCalled();
 const p=send(bytes({}),signal,{clock,deadlineMs:200});h.headers();h.response.emit('data',Buffer.from('ok'));
 clock.set(200);h.response.emit('end');expect(await p).toEqual({kind:'unknown',timeout:true});
});
it.each(['default','diagnostic'] as const)('C2 reserve requires strictly more than model plus reserve %s',async profile=>{
 const snapshot=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)),profile);
 for(const elapsed of [3999,4000,4001]){
  const clock=manualClock(elapsed),send=vi.fn(async()=>completed());
  const m=createModel({policySnapshot:snapshot,clock,backendPort:8000,transport:{source:'recorded-fixture',send}});
  const p=(m.select as any)(catalog,'x',undefined,{apiDeadlineMs:snapshot.selectedPolicy.apiMs});
  if(elapsed<4000){await expect(p).resolves.toHaveProperty('selection');expect(send).toHaveBeenCalledTimes(1);}
  else {await expect(p).rejects.toThrow('model_unavailable');expect(send).not.toHaveBeenCalled();}
  expect(m.latched).toBe(false);
 }
});
it('C2 hook is capped abortable and late success never dispatches',async()=>{
 vi.useFakeTimers();let resolve!:(v:any)=>void;let hookSignal!:AbortSignal;
 const send=vi.fn(async()=>completed()),preDispatch=vi.fn(({signal}:any)=>{hookSignal=signal;return new Promise<any>(r=>{resolve=r;});});
 const m=createModel({policySnapshot,backendPort:8000,preDispatch,transport:{source:'recorded-fixture',send}} as any);
 const p=m.select(catalog,'x');await Promise.resolve();expect(preDispatch).toHaveBeenCalledTimes(1);expect(send).not.toHaveBeenCalled();
 const rejection=expect(p).rejects.toThrow('model_unavailable');await vi.advanceTimersByTimeAsync(500);await rejection;
 expect(hookSignal.aborted).toBe(true);resolve({ok:true});await Promise.resolve();expect(send).not.toHaveBeenCalled();expect(m.latched).toBe(false);
});
it('C2 observer has independent model terminal and late event without raw data',async()=>{
 vi.useFakeTimers();const events:any[]=[];let resolve!:(v:any)=>void;
 const m=createModel({policySnapshot,backendPort:8000,observer:(e:any)=>{events.push(e);throw Error('PRIVATE');},transport:{source:'recorded-fixture',send:()=>new Promise<any>(r=>{resolve=r;})}} as any);
 const p=expect(m.select(catalog,'PRIVATE TASK')).rejects.toThrow('model_timeout');await vi.advanceTimersByTimeAsync(10000);await p;
 expect(events.filter(e=>e.stage==='model'&&e.event==='terminal')).toHaveLength(1);
 expect(events.find(e=>e.stage==='model'&&e.event==='terminal')).toMatchObject({outcome:'unknown',deadlineCause:'model'});
 resolve(completed());await Promise.resolve();await Promise.resolve();
 expect(events.filter(e=>e.stage==='model'&&e.event==='late')).toHaveLength(1);expect(m.latched).toBe(true);
 expect(JSON.stringify(events)).not.toMatch(/PRIVATE|probabilities|weather/);
 expect(events.map(e=>e.sequence)).toEqual(events.map((_,i)=>events[0].sequence+i));
});
it.each(['binding_mismatch','persistence_failed','pre_dispatch_hook_timeout','insufficient_budget'] as const)('C2 predispatch rejection records fixed detail %s',async detail=>{
 const clock=manualClock(),events:any[]=[],send=vi.fn(async()=>completed());
 const preDispatch=vi.fn(async()=>{if(detail==='pre_dispatch_hook_timeout'){clock.set(500);return {ok:true as const};}return {ok:false as const,reason:detail as 'binding_mismatch'|'persistence_failed'};});
 const m=createModel({policySnapshot,clock,observer:e=>events.push(e),preDispatch,backendPort:8000,transport:{source:'recorded-fixture',send}});
 if(detail==='insufficient_budget')clock.set(4000);
 await expect(m.select(catalog,'x',undefined,{apiDeadlineMs:15000})).rejects.toMatchObject({code:'model_unavailable',detail});
 expect(events).toContainEqual(expect.objectContaining({stage:'admission',event:'terminal',outcome:'notSent',detail}));expect(send).not.toHaveBeenCalled();expect(m.latched).toBe(false);
});
it('C2 transport progress is bounded and never exposes chunks or errors',async()=>{
 const h=mockHttp(),events:any[]=[],clock=manualClock();
 const p=httpTransport(8000)(bytes({}),new AbortController().signal,{clock,deadlineMs:1000,observe:(e:any)=>{events.push(e);}} as any);
 const socket=new EventEmitter();h.req.emit('socket',socket);socket.emit('connect');socket.emit('connect');h.req.emit('finish');h.req.emit('finish');
 h.headers();for(let i=0;i<10;i++)h.response.emit('data',Buffer.from('PRIVATE'));h.response.emit('end');await p;h.response.emit('end');h.response.emit('end');
 expect(events.map(e=>e.event)).toEqual(['connect','write','headers','body','terminal','late']);expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
it('C2 default transport receives diagnostic absolute context without a 10s timer',async()=>{
 vi.useFakeTimers();const h=mockHttp();const snapshot=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)),'diagnostic');
 const m=createModel({policySnapshot:snapshot,backendPort:8000});const p=m.select(catalog,'x');h.headers();await vi.advanceTimersByTimeAsync(20000);expect(h.req.destroy).not.toHaveBeenCalled();
 h.response.emit('data',completed().bytes);h.response.emit('end');await expect(p).resolves.toHaveProperty('selection');expect(m.latched).toBe(false);
});
it('C2 hook success rechecks reserve and cannot mutate dispatched bytes',async()=>{
 for(const elapsed of [3999,4000]){
  const clock=manualClock(3600),send=vi.fn(async()=>completed());
  const m=createModel({policySnapshot,clock,backendPort:8000,preDispatch:async({body})=>{body.fill(0);clock.set(elapsed);return {ok:true};},transport:{source:'recorded-fixture',send}});
  const p=m.select(catalog,'x',undefined,{apiDeadlineMs:15000});
  if(elapsed===3999){await p;expect(send).toHaveBeenCalledTimes(1);}
  else {await expect(p).rejects.toMatchObject({detail:'insufficient_budget'});expect(send).not.toHaveBeenCalled();}expect(m.latched).toBe(false);
 }
});
it('C2 continued chunks and wall clock changes never refill transport deadline',async()=>{
 vi.useFakeTimers();const h=mockHttp(),clock=manualClock();const p=httpTransport(8000)(bytes({}),new AbortController().signal,{clock,deadlineMs:100});h.headers();
 for(const n of [20,40,60,80]){clock.set(n);vi.setSystemTime(new Date(100000-n*100));h.response.emit('data',Buffer.from('x'));}
 clock.set(100);h.response.emit('data',Buffer.from('x'));expect(await p).toEqual({kind:'unknown',timeout:true});expect(h.req.destroy).toHaveBeenCalledTimes(1);
});
it('C1 model retains validated snapshot even if caller replaces options',()=>{
 const options={policySnapshot,backendPort:8000};const model=createModel(options);
 options.policySnapshot=parsePolicySnapshot(readFileSync(new URL('../config/deadline-policy.json',import.meta.url)),'diagnostic');
 expect(model.policySnapshot).toBe(policySnapshot);
});
it('C2 transport adopted completion stays terminal when observer consumes time',async()=>{
 const h=mockHttp(),clock=manualClock();const p=httpTransport(8000)(bytes({}),new AbortController().signal,{clock,deadlineMs:100,observe:e=>{if(e.event==='terminal')clock.set(100);}});
 h.headers();h.response.emit('data',Buffer.from('ok'));h.response.emit('end');expect((await p).kind).toBe('completed');expect(h.req.destroy).not.toHaveBeenCalled();
});
it('C2 expiry after model deadline creation is zero calls and non-latching',async()=>{
 const clock=manualClock(),send=vi.fn(async()=>completed()),events:any[]=[];
 const setTimer=clock.setTimer;clock.setTimer=(fn,ms)=>{clock.set(10000);return setTimer(fn,ms);};
 const m=createModel({policySnapshot,clock,observer:e=>events.push(e),backendPort:8000,transport:{source:'recorded-fixture',send}});
 await expect(m.select(catalog,'x')).rejects.toThrow('model_unavailable');expect(send).not.toHaveBeenCalled();expect(m.latched).toBe(false);expect(events.filter(e=>e.stage==='transport'&&e.event==='start')).toHaveLength(0);
});
it('C2 injected notSent counts one transport call without latching',async()=>{
 const events:any[]=[],send=vi.fn(async()=>({kind:'notSent' as const}));const m=createModel({policySnapshot,observer:e=>events.push(e),backendPort:8000,transport:{source:'recorded-fixture',send}});
 await expect(m.select(catalog,'x')).rejects.toThrow('model_unavailable');expect(send).toHaveBeenCalledTimes(1);expect(events.filter(e=>e.stage==='transport'&&e.event==='start')).toHaveLength(1);expect(m.latched).toBe(false);
});
it('C2 disconnect during hook prevents dispatch without latching',async()=>{
 const send=vi.fn(),abort=new AbortController();const m=createModel({policySnapshot,backendPort:8000,preDispatch:()=>new Promise(()=>{}),transport:{source:'recorded-fixture',send}});
 const p=m.select(catalog,'x',abort.signal);abort.abort();await expect(p).rejects.toMatchObject({detail:'pre_dispatch_disconnect'});expect(send).not.toHaveBeenCalled();expect(m.latched).toBe(false);
});
it('C2 transport does not write after request creation consumes deadline',async()=>{
 const clock=manualClock(),h=mockHttp();h.spy.mockImplementation(((_options:any,_cb:any)=>{clock.set(100);return h.req;}) as any);
 const p=httpTransport(8000)(bytes({}),new AbortController().signal,{clock,deadlineMs:100});expect(h.req.end).not.toHaveBeenCalled();expect(await p).toEqual({kind:'unknown',timeout:true});expect(h.req.destroy).toHaveBeenCalledTimes(1);
});
it('C2 observer sequence and elapsed remain continuous across factory models',async()=>{
 const clock=manualClock(),events:any[]=[];
 for(const time of [0,100]){clock.set(time);const m=createModel({policySnapshot,clock,observer:e=>events.push(e),backendPort:8000,transport:{source:'recorded-fixture',send:async()=>completed()}});await m.select(catalog,'x');}
 expect(events[2].sequence).toBe(events[1].sequence+1);expect(events[2].elapsedMs).toBe(100);
});
