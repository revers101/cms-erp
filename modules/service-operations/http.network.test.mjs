// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {createOperationsHandler} from './http.mjs';

async function host(t,options={}) {
  let handler,calls=0;
  const server=createServer(async(req,res)=>{
    if(await handler(req,res))return;
    res.writeHead(404);res.end();
  });
  server.requestTimeout=1000;server.headersTimeout=1000;
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  handler=createOperationsHandler({
    service:{createCustomer(actor,input,key){calls++;return {id:1,actor:actor.id,name:input.name,key}},list(){return []}},
    allowedOrigin:origin,
    resolveActor:req=>req.headers['x-test-session']==='valid'?{id:1,role:'admin'}:null,
    verifyCsrf:req=>req.headers['x-test-csrf']==='valid',
    ...options
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  return {origin,get calls(){return calls}};
}
function chunked(h,chunks,leaveOpen=false) {
  return new Promise((resolve,reject)=>{
    const req=httpRequest(h.origin+'/api/operations/commands/create-customer',{method:'POST',headers:{Origin:h.origin,'Content-Type':'application/json','Idempotency-Key':'network-test-123','X-Test-Session':'valid','X-Test-Csrf':'valid'}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(body)}));
    });
    req.on('error',reject);for(const part of chunks)req.write(part);if(!leaveOpen)req.end();
  });
}
test('native HTTP accepts authenticated CSRF-protected JSON and rejects anonymous request',async t=>{
  const h=await host(t);
  const denied=await fetch(h.origin+'/api/operations/customers');assert.equal(denied.status,401);
  const accepted=await chunked(h,['{"name":"Netwerkdemo"}']);assert.equal(accepted.status,200);assert.equal(accepted.body.data.name,'Netwerkdemo');assert.equal(accepted.headers['cache-control'],'no-store');assert.equal(h.calls,1);
});
test('chunked body exceeding cap receives error and never reaches service',async t=>{
  const h=await host(t,{maxBytes:32});const result=await chunked(h,['{"name":"','x'.repeat(100),'"}']);
  assert.equal(result.status,413);assert.equal(result.headers.connection,'close');assert.equal(h.calls,0);
});
test('unfinished native HTTP body times out, closes connection and never reaches service',async t=>{
  const h=await host(t,{bodyTimeoutMs:30});const result=await chunked(h,['{"name":"unfinished'],true);
  assert.equal(result.status,400);assert.equal(result.body.error,'BODY_TIMEOUT');assert.equal(result.headers.connection,'close');assert.equal(h.calls,0);
});
