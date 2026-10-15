import http from 'node:http';
import { openSync,readSync,closeSync } from 'node:fs';
import { loadCatalog } from './catalog.js';
import { createModel,validPort,parsePolicySnapshot } from './model.js';
import type { TransportConfig, PolicyProfile, Clock, Observer, AttemptContext, PreDispatch } from './model.js';
import { createHandler } from './http.js';
export interface ServerOptions {clock?:Clock;observer?:Observer;evidence?:{currentAttempt:()=>AttemptContext|null;preDispatch:PreDispatch};port:number;profile?:PolicyProfile;policyPath?:string|URL;backendPort?:number;catalogPath?:string|URL;transport?:TransportConfig}
export function createCompassServer(options:ServerOptions) {
  if(options.port!==0&&!validPort(options.port))throw new Error('invalid_listen_port');
  const policyFd=openSync(options.policyPath??new URL('../config/deadline-policy.json',import.meta.url),'r');
  const policyBytes=Buffer.alloc(2049);let policySize=0;
  try {while(policySize<policyBytes.length){const n=readSync(policyFd,policyBytes,policySize,policyBytes.length-policySize,null);if(n===0)break;policySize+=n;}}finally{closeSync(policyFd);}
  const policyIdentity=parsePolicySnapshot(policyBytes.subarray(0,policySize),options.profile);
  const fd=openSync(options.catalogPath??new URL('../catalog/selection.json',import.meta.url),'r');
  const buffer=Buffer.alloc(65537);let size=0;
  try {while(size<buffer.length){const n=readSync(fd,buffer,size,buffer.length-size,null);if(n===0)break;size+=n;}}finally{closeSync(fd);}
  const catalog=loadCatalog(buffer.subarray(0,size)),model=createModel({...options,policySnapshot:policyIdentity,...(options.evidence?{preDispatch:options.evidence.preDispatch}:{})});
  const server=http.createServer({maxHeaderSize:8192,headersTimeout:5000,requestTimeout:15000,connectionsCheckingInterval:250});
  server.maxHeadersCount=100;
  const headerTimers=new Map<import('node:net').Socket,{timer:ReturnType<typeof setTimeout>;deadlineMs:number}>();
  server.on('connection',socket=>{
    const deadlineMs=model.clock.now()+5000;
    const timer=model.clock.setTimer(()=>socket.destroy(),Math.max(0,deadlineMs-model.clock.now()));headerTimers.set(socket,{timer,deadlineMs});
    socket.once('close',()=>{model.clock.clearTimer(timer);headerTimers.delete(socket);});
  });
  const handler=createHandler({catalog,model,...(options.evidence?{evidence:options.evidence}:{}),port:()=>{const a=server.address();return a&&typeof a==='object'?a.port:options.port;}});
  const receive=(req:http.IncomingMessage,res:http.ServerResponse)=>{
    const header=headerTimers.get(req.socket);
    model.clock.clearTimer(header?.timer);headerTimers.delete(req.socket);
    if(header&&model.clock.now()>=header.deadlineMs){req.socket.destroy();res.destroy();return;}
    handler(req,res);
  };
  server.on('request',receive);
  // Never send an automatic 100-continue before validating the request.
  server.on('checkContinue',receive);server.on('checkExpectation',receive);
  server.on('clientError',(_error,socket)=>{
    if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');else socket.destroy();
  });
  return {
    server,
    get policyIdentity(){return policyIdentity;},
    listen:()=>new Promise<number>((resolve,reject)=>{
      const error=(e:Error)=>reject(e);server.once('error',error);
      server.listen(options.port,'127.0.0.1',()=>{server.removeListener('error',error);const a=server.address();if(a&&typeof a==='object')resolve(a.port);else reject(new Error('listen_failed'));});
    }),
  };
}
