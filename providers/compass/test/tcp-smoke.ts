// Controller-only. Never included in the socket-free Vitest suite.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createCompassServer } from '../src/server.js';
import type { Transport } from '../src/model.js';
const fixtures: {cases:{case_id:string;expected:string;raw_response:string}[]} = JSON.parse(readFileSync(new URL('./fixtures/recorded-responses.json',import.meta.url),'utf8'));
const body=JSON.stringify({schema:'compass.internal.select.v1',task:'TCP wiring replay, not a new model evaluation',catalogVersion:'directory-v1'});
const sockets=new Set<net.Socket>();
function track<T extends net.Socket>(socket:T):T {sockets.add(socket);socket.once('close',()=>sockets.delete(socket));return socket;}
function post(port:number,raw=body,headers:Record<string,string>={}) {
  return new Promise<{status:number;body:any}>((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:'/internal/v1/select',method:'POST',agent:false,
      headers:{'Content-Type':'application/json',...headers}},res=>{
      const chunks:Buffer[]=[];res.on('data',(b:Buffer)=>chunks.push(b));res.on('error',reject);
      res.on('end',()=>{try{resolve({status:res.statusCode??0,body:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});
    });
    req.on('socket',track);req.on('error',reject);req.setTimeout(17000,()=>req.destroy(new Error('tcp_client_deadline')));req.end(raw);
  });
}
function rawRequest(port:number,make:(port:number)=>string) {
  return new Promise<string>((resolve,reject)=>{
    const socket=track(net.connect({host:'127.0.0.1',port}));let text='';
    socket.setTimeout(17000,()=>socket.destroy(new Error('tcp_client_deadline')));
    socket.on('connect',()=>socket.write(make(port)));socket.on('data',b=>{text+=b.toString();});
    socket.on('error',reject);socket.on('end',()=>resolve(text));
  });
}
async function withServer(send:Transport,check:(port:number)=>Promise<void>) {
  const app=createCompassServer({port:0,backendPort:8000,transport:{source:'recorded-fixture',send}});
  try {const port=await app.listen();assert.equal((app.server.address() as net.AddressInfo).address,'127.0.0.1');await check(port);}
  finally {for(const socket of sockets)socket.destroy();app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));}
}
let caseId=fixtures.cases[0]!.case_id,calls=0;
const replay:Transport=async()=>{calls++;const f=fixtures.cases.find(c=>c.case_id===caseId)!;return {kind:'completed',status:200,bytes:Buffer.from(f.raw_response)};};
await withServer(replay,async port=>{
  for(const f of fixtures.cases){caseId=f.case_id;const r=await post(port);assert.equal(r.status,200);assert.equal(r.body.modelSource,'recorded-fixture');assert.equal(r.body.paid,false);assert.equal(r.body.purchaseEnabled,false);assert.deepEqual(r.body.selection,['none','needs_clarification'].includes(f.expected)?{kind:f.expected}:{kind:'chosen',entryId:f.expected});}
  const before=calls;
  assert.equal((await post(port,'{}')).status,400);
  assert.equal((await post(port,body,{Origin:'https://example.invalid'})).status,403);
  assert.equal((await post(port,body,{'Content-Type':'text/plain'})).status,415);
  const overflow=await rawRequest(port,p=>`POST /internal/v1/select HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2001\r\n${'x'.repeat(8193)}\r\n0\r\n\r\n`);
  assert.match(overflow,/^HTTP\/1.1 413 /);
  const slow=await rawRequest(port,p=>`POST /internal/v1/select HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  assert.match(slow,/^HTTP\/1.1 408 /);assert.equal(calls,before);
});
let started!:()=>void;
let start=new Promise<void>(resolve=>{started=resolve;});
let release!:(value:Awaited<ReturnType<Transport>>)=>void;
let observedSignal:AbortSignal|undefined;
calls=0;
await withServer((_body,signal)=>{calls++;observedSignal=signal;started();return new Promise(resolve=>{release=resolve;});},async port=>{
  const first=post(port);await start;assert.equal((await post(port)).body.error,'busy');
  release({kind:'unknown'});assert.equal((await first).body.error,'model_unavailable');
  assert.equal((await post(port)).body.error,'not_ready');assert.equal(calls,1);
});
start=new Promise<void>(resolve=>{started=resolve;});calls=0;
await withServer((_body,signal)=>{calls++;observedSignal=signal;started();return new Promise(()=>{});},async port=>{
  const socket=track(net.connect({host:'127.0.0.1',port}));
  socket.on('error',()=>{});
  socket.on('connect',()=>socket.write(`POST /internal/v1/select HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  await start;
  const aborted=new Promise<void>(resolve=>observedSignal!.addEventListener('abort',()=>resolve(),{once:true}));
  socket.destroy();await aborted;assert.equal((await post(port)).body.error,'not_ready');assert.equal(calls,1);
});
calls=0;
await withServer(()=>{calls++;return new Promise(()=>{});},async port=>{
  const response=await post(port);assert.equal(response.status,504);assert.equal(response.body.error,'model_timeout');
  assert.equal((await post(port)).body.error,'not_ready');assert.equal(calls,1);
});
console.log('TCP smoke passed: 8 recorded cases, rejection, overflow, read/model deadlines, busy, disconnect, unknown latch; no live model.');
