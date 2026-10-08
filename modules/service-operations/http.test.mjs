// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createOperationsHandler,operationsCommands} from './http.mjs';

const origin='https://cms.example.test';
function fixture(options={}) {
  const calls=[];
  const service={list(...args){calls.push(['list',...args]);return [{id:1}];},get(...args){calls.push(['get',...args]);return {id:args[2]};},exportBookkeeping(){return []}};
  for (const name of ['createCustomer','transitionQuote','createWorkorderFromQuote','scheduleWorkorder']) service[name]=(...args)=>{calls.push([name,...args]);return {id:1};};
  const handler=createOperationsHandler({service,allowedOrigin:origin,resolveActor:async()=>({id:7,role:'admin'}),verifyCsrf:async()=>true,...options});
  async function request(method,url,data,headers={}) {
    const req=Readable.from(data===undefined?[]:[typeof data==='string'?data:JSON.stringify(data)]);
    Object.assign(req,{method,url,headers:{'content-type':'application/json',origin,'idempotency-key':'test-key-123',...headers}});
    const res={writeHead(status,values){this.status=status;this.headers=values;},end(value){this.body=JSON.parse(value);}};
    const handled=await handler(req,res);return {handled,...res};
  }
  return {calls,request};
}
test('unrelated app routes pass through without invoking operations',async()=>{
  const f=fixture();const r=await f.request('GET','/api/cms/pages');assert.equal(r.handled,false);assert.equal(f.calls.length,0);
});
test('trusted session identity supplies actor; role header cannot impersonate',async()=>{
  const f=fixture();const r=await f.request('GET','/api/operations/customers',undefined,{'x-role':'admin','x-user-id':'999'});assert.equal(r.status,200);assert.deepEqual(f.calls[0][1],{id:7,role:'admin'});
});
test('anonymous and invalid server identities cannot read ERP',async()=>{
  for (const actor of [null,{id:0,role:'admin'},{id:1,role:'owner'}]) {const f=fixture({resolveActor:()=>actor});assert.equal((await f.request('GET','/api/operations/customers')).status,401);assert.equal(f.calls.length,0);}
});
test('cross-origin reads and absolute URL trick rejected',async()=>{
  const f=fixture();assert.equal((await f.request('GET','/api/operations/customers',undefined,{origin:'https://evil.test'})).status,403);assert.equal((await f.request('GET','https://evil.test/api/operations/customers')).status,403);
});
test('writes require origin even when verifier succeeds',async()=>{
  const f=fixture();assert.equal((await f.request('POST','/api/operations/commands/create-customer',{name:'Demo'},{origin:undefined})).status,403);assert.equal(f.calls.length,0);
});
test('writes require boolean CSRF success, not truthy value',async()=>{
  for (const ok of [false,'true',1,null]) {const f=fixture({verifyCsrf:()=>ok});assert.equal((await f.request('POST','/api/operations/commands/create-customer',{})).status,403);assert.equal(f.calls.length,0);}
});
test('valid command passes body and stable idempotency key',async()=>{
  const f=fixture();const r=await f.request('POST','/api/operations/commands/create-customer',{name:'Demo'});assert.equal(r.status,200);assert.deepEqual(f.calls[0],['createCustomer',{id:7,role:'admin'},{name:'Demo'},'test-key-123']);assert.equal(r.headers['Cache-Control'],'no-store');assert.equal(r.headers['X-Content-Type-Options'],'nosniff');
});
test('handler awaits asynchronous service methods for future D1-backed adapters',async()=>{
  const calls=[];
  const service={
    async list(...args){calls.push(['list',...args]);return [{id:9}];},
    async get(...args){calls.push(['get',...args]);return {id:args[2]};},
    async exportBookkeeping(...args){calls.push(['exportBookkeeping',...args]);return [{id:10}];},
    async createCustomer(...args){calls.push(['createCustomer',...args]);return {id:11};},
  };
  const f=fixture({service});
  assert.deepEqual((await f.request('GET','/api/operations/customers')).body,{data:[{id:9}]});
  assert.deepEqual((await f.request('GET','/api/operations/customers/9')).body,{data:{id:9}});
  assert.deepEqual((await f.request('GET','/api/operations/bookkeeping')).body,{data:[{id:10}]});
  assert.deepEqual((await f.request('POST','/api/operations/commands/create-customer',{name:'Async'})).body,{data:{id:11}});
  assert.deepEqual(calls.map(([name])=>name),['list','get','exportBookkeeping','createCustomer']);
});
test('missing and malformed idempotency keys rejected before service',async()=>{
  for (const key of [undefined,'short','secret key',Array(2).fill('header')]) {const f=fixture();assert.equal((await f.request('POST','/api/operations/commands/create-customer',{}, {'idempotency-key':key})).status,400);assert.equal(f.calls.length,0);}
});
test('unknown command and dangerous reflected method cannot execute',async()=>{
  for (const name of ['close','constructor','__proto__','list']) {const f=fixture();assert.equal((await f.request('POST','/api/operations/commands/'+name,{})).status,404);assert.equal(f.calls.length,0);}
  assert.equal(operationsCommands.length,16);
});
test('unsupported methods and search query rejected',async()=>{
  const f=fixture();assert.equal((await f.request('DELETE','/api/operations/customers/1')).status,404);assert.equal((await f.request('GET','/api/operations/customers?all=true')).status,400);
});
test('numeric route IDs checked without permissive parseInt',async()=>{
  const f=fixture();assert.equal((await f.request('GET','/api/operations/customers/1')).status,200);assert.equal(f.calls[0][3],1);
  for (const id of ['0','1x','-1','1.5','9007199254740992']) assert.ok([400,404].includes((await f.request('GET','/api/operations/customers/'+id)).status));
});
test('status command enforces version/reference and unknown-field rejection',async()=>{
  const f=fixture();assert.equal((await f.request('POST','/api/operations/commands/quote-status',{id:1,status:'sent',version:1})).status,200);assert.deepEqual(f.calls[0].slice(2),[1,'sent',1,'test-key-123']);
  for (const body of [{id:null,status:'sent',version:1},{id:1,status:'sent',version:0},{id:1,status:'sent',version:1,role:'admin'}]) assert.equal((await f.request('POST','/api/operations/commands/quote-status',body)).status,400);
});
test('quote conversion and schedule wrappers map to service signatures',async()=>{
  const f=fixture();const schedule={resourceId:3,startAt:'2026-10-08T08:00:00Z',endAt:'2026-10-08T09:00:00Z'};
  await f.request('POST','/api/operations/commands/workorder-from-quote',{quoteId:2,schedule});assert.deepEqual(f.calls[0].slice(2),[2,schedule,'test-key-123']);
  await f.request('POST','/api/operations/commands/schedule-workorder',{id:4,version:2,schedule});assert.deepEqual(f.calls[1].slice(2),[4,schedule,2,'test-key-123']);
});
test('JSON content type and object payload enforced',async()=>{
  const f=fixture();assert.equal((await f.request('POST','/api/operations/commands/create-customer',{}, {'content-type':'text/plain'})).status,415);
  for (const body of ['{','null','[]','1']) assert.equal((await f.request('POST','/api/operations/commands/create-customer',body)).status,400);
});
test('declared and actual byte limits enforced',async()=>{
  const f=fixture({maxBytes:32});assert.equal((await f.request('POST','/api/operations/commands/create-customer',{}, {'content-length':'33'})).status,413);assert.equal((await f.request('POST','/api/operations/commands/create-customer',{name:'x'.repeat(33)})).status,413);assert.equal(f.calls.length,0);
});
test('per-actor request limiter prevents excess service calls',async()=>{
  const f=fixture({requestsPerMinute:1});assert.equal((await f.request('GET','/api/operations/customers')).status,200);assert.equal((await f.request('GET','/api/operations/customers')).status,429);assert.equal(f.calls.length,1);
});
test('unexpected service error hides internal details and logs only safe request metadata',async()=>{
  const logged=[];const f=fixture({service:{list(){throw new Error('password=private, SQL db path');}},onError:data=>logged.push(data)});const r=await f.request('GET','/api/operations/customers');assert.equal(r.status,500);assert.equal(r.body.error,'INTERNAL_ERROR');assert.ok(!JSON.stringify(r).includes('password'));assert.deepEqual(Object.keys(logged[0]).sort(),['code','requestId']);
});
test('known domain status returned but arbitrary error text not exposed',async()=>{
  const f=fixture({service:{list(){throw Object.assign(new Error('SQL debug'),{status:409,code:'STALE_VERSION'});}}});const r=await f.request('GET','/api/operations/customers');assert.equal(r.status,409);assert.equal(r.body.error,'STALE_VERSION');
});
test('configuration rejects unsafe origins and invalid limits',()=>{
  for(const allowedOrigin of ['http://cms.example.test','https://cms.example.test/','https://user:pass@cms.example.test']) assert.throws(()=>fixture({allowedOrigin}));
  assert.throws(()=>fixture({maxBytes:0}));assert.throws(()=>fixture({bodyTimeoutMs:0}));assert.throws(()=>fixture({requestsPerMinute:0}));
});

test('body timeout terminates reader and removes listeners without service invocation',async()=>{
  const f=fixture({bodyTimeoutMs:10});
  const req=new Readable({read(){}});
  Object.assign(req,{method:'POST',url:'/api/operations/commands/create-customer',headers:{'content-type':'application/json',origin,'idempotency-key':'test-key-123'}});
  let result;
  const handler=createOperationsHandler({service:{createCustomer(){throw new Error('must not run')}},allowedOrigin:origin,resolveActor:()=>({id:7,role:'admin'}),verifyCsrf:()=>true,bodyTimeoutMs:10});
  await handler(req,{writeHead(status){this.status=status},end(body){result=JSON.parse(body)}});
  assert.equal(result.error,'BODY_TIMEOUT');assert.equal(req.destroyed,true);assert.equal(req.listenerCount('data'),0);assert.equal(req.listenerCount('end'),0);
});

test('bounded pagination reaches service; malformed duplicates and unknown params cannot expand access',async()=>{
  const f=fixture();assert.equal((await f.request('GET','/api/operations/customers?limit=2&offset=4')).status,200);assert.deepEqual(f.calls[0][3],{limit:2,offset:4});
  for(const query of ['limit=101','limit=0','limit=2&limit=3','offset=-1','offset=1000001','limit=1.5','limit=2x','offset=9007199254740992','all=true']) assert.equal((await f.request('GET','/api/operations/customers?'+query)).status,400);
  assert.equal((await f.request('GET','/api/operations/reservations/1')).status,404);
});
