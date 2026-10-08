// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter for the owning application. It neither starts a server nor creates users.
import { randomUUID } from 'node:crypto';

const prefix = '/api/operations';
const entities = new Set(['resources','customers','products','quotes','workorders','hours','reservations','movements','invoices','payments','credits','outbox','audit']);
const commands = Object.freeze({
  'create-resource': ['createResource'], 'create-customer': ['createCustomer'], 'create-product': ['createProduct'],
  'adjust-stock': ['adjustStock'], 'create-quote': ['createQuote'],
  'quote-status': ['transitionQuote','status'],
  'workorder-from-quote': ['createWorkorderFromQuote','from-quote'],
  'schedule-workorder': ['scheduleWorkorder','schedule'],
  'workorder-status': ['transitionWorkorder','status'],
  'record-hours': ['recordHours'], 'reserve-inventory': ['reserveInventory'],
  'consume-inventory': ['consumeInventory'], 'release-inventory': ['releaseInventory'], 'issue-invoice': ['issueInvoice'],
  'record-payment': ['recordPayment'], 'issue-credit-note': ['issueCreditNote']
});
const statuses = new Set([400,401,403,404,409,413,415,422,429,503]);
class HttpError extends Error { constructor(status,code) { super(code); this.status=status; this.code=code; } }
function shape(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k=>!fields.includes(k))) throw new HttpError(400,'INVALID_COMMAND');
}
function validActorId(value) {
  return (Number.isSafeInteger(value) && value>0 && value<=1000000000000) || (typeof value==='string' && value.trim().length>0 && value.length<=128 && !/[\u0000-\u001f\u007f]/u.test(value));
}
function integer(value) { if (!Number.isSafeInteger(value) || value<1) throw new HttpError(400,'INVALID_REFERENCE'); return value; }
function listOptions(params) {
  const options={};
  for(const [key,value] of params) {
    if(!['limit','offset'].includes(key) || Object.hasOwn(options,key) || !/^(0|[1-9]\d*)$/.test(value)) throw new HttpError(400,'INVALID_PAGINATION');
    const number=Number(value);
    if(!Number.isSafeInteger(number) || (key==='limit' && (number<1 || number>100)) || (key==='offset' && number>1000000)) throw new HttpError(400,'INVALID_PAGINATION');
    options[key]=number;
  }
  return options;
}
function reply(res,status,payload,id) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Request-ID':id});
  res.end(JSON.stringify(payload));
}
async function readJson(req,maxBytes,timeoutMs) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']??'')) throw new HttpError(415,'JSON_REQUIRED');
  const length=req.headers['content-length'];
  if (length!==undefined && (!/^\d+$/.test(length) || Number(length)>maxBytes)) throw new HttpError(413,'BODY_TOO_LARGE');
  return await new Promise((resolve,reject)=>{
    let bytes=0,settled=false; const chunks=[];
    const cleanup=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);req.off('close',closed);};
    const fail=(problem)=>{if(settled)return;settled=true;cleanup();req.pause();problem.closeConnection=true;reject(problem);};
    const data=(chunk)=>{const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>maxBytes)return fail(new HttpError(413,'BODY_TOO_LARGE'));chunks.push(buffer);};
    const end=()=>{
      if(settled)return;
      let value;
      try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
      catch {return fail(new HttpError(400,'INVALID_JSON'));}
      if (!value || typeof value!=='object' || Array.isArray(value)) return fail(new HttpError(400,'OBJECT_REQUIRED'));
      settled=true;cleanup();resolve(value);
    };
    const error=()=>fail(new HttpError(400,'BODY_READ_FAILED'));
    const aborted=()=>fail(new HttpError(400,'BODY_ABORTED'));
    const closed=()=>{if(!settled)fail(new HttpError(400,'BODY_ABORTED'));};
    const timer=setTimeout(()=>fail(new HttpError(400,'BODY_TIMEOUT')),timeoutMs);
    req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);req.once('close',closed);
  });
}

export function createOperationsHandler({service,resolveActor,verifyCsrf,authorizeCommand=async()=>true,allowedOrigin,maxBytes=262144,bodyTimeoutMs=5000,requestsPerMinute=120,onError=()=>{}}) {
  if (!service || typeof resolveActor!=='function' || typeof verifyCsrf!=='function' || typeof authorizeCommand!=='function') throw new TypeError('service, resolveActor, verifyCsrf and authorizeCommand are required');
  const origin=new URL(allowedOrigin);
  if (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname))) throw new TypeError('HTTPS origin required');
  if (origin.username || origin.password || origin.origin!==allowedOrigin) throw new TypeError('Use an exact origin without a path or credentials');
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>1048576 || !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs<1 || bodyTimeoutMs>30000 || !Number.isSafeInteger(requestsPerMinute) || requestsPerMinute<1) throw new TypeError('Invalid limits');
  const rates=new Map();
  return async function handleOperations(req,res) {
    let url;
    try { url=new URL(req.url,allowedOrigin); } catch { return false; }
    if (url.pathname!==prefix && !url.pathname.startsWith(prefix+'/')) return false;
    const requestId=randomUUID();
    try {
      if (url.origin!==allowedOrigin || (req.headers.origin!==undefined && req.headers.origin!==allowedOrigin)) throw new HttpError(403,'ORIGIN_REJECTED');
      const actor=await resolveActor(req);
      if (!actor || !validActorId(actor.id) || !['admin','planner','technician','finance','reader'].includes(actor.role)) throw new HttpError(401,'AUTH_REQUIRED');
      const rateKey=String(actor.id).trim();
      const now=Date.now();
      for (const [key,entry] of rates) if (now>=entry.expires) rates.delete(key);
      if (!rates.has(rateKey) && rates.size>=10000) throw new HttpError(503,'RATE_CAPACITY');
      const rate=rates.get(rateKey)??{expires:now+60000,count:0};rate.count++;rates.set(rateKey,rate);
      if (rate.count>requestsPerMinute) throw new HttpError(429,'RATE_LIMITED');
      const parts=url.pathname.slice(prefix.length).split('/').filter(Boolean);
      if (req.method==='GET') {
        const options=listOptions(url.searchParams);
        if (parts.length===1 && parts[0]==='bookkeeping') reply(res,200,{data:await service.exportBookkeeping(actor,options)},requestId);
        else if (entities.has(parts[0]) && parts.length===1) reply(res,200,{data:await service.list(actor,parts[0],options)},requestId);
        else if (entities.has(parts[0]) && parts[0]!=='reservations' && parts.length===2 && /^[1-9]\d*$/.test(parts[1]) && !url.search) reply(res,200,{data:await service.get(actor,parts[0],integer(Number(parts[1])))},requestId);
        else throw new HttpError(404,'ROUTE_NOT_FOUND');
        return true;
      }
      if (url.search) throw new HttpError(400,'QUERY_NOT_SUPPORTED');
      if (req.method!=='POST' || parts.length!==2 || parts[0]!=='commands' || !Object.hasOwn(commands,parts[1])) throw new HttpError(404,'ROUTE_NOT_FOUND');
      if (req.headers.origin!==allowedOrigin || await verifyCsrf(req,actor)!==true) throw new HttpError(403,'CSRF_REJECTED');
      const key=req.headers['idempotency-key'];
      if (typeof key!=='string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new HttpError(400,'IDEMPOTENCY_KEY_REQUIRED');
      const input=await readJson(req,maxBytes,bodyTimeoutMs);
      if (await authorizeCommand({req,actor,command:parts[1],input})!==true) throw new HttpError(403,'COMMAND_NOT_AUTHORIZED');
      const [method,kind]=commands[parts[1]];
      let result;
      if (kind==='status') {shape(input,['id','status','version']);result=await service[method](actor,integer(input.id),input.status,integer(input.version),key);}
      else if (kind==='from-quote') {shape(input,['quoteId','schedule']);result=await service[method](actor,integer(input.quoteId),input.schedule,key);}
      else if (kind==='schedule') {shape(input,['id','schedule','version']);result=await service[method](actor,integer(input.id),input.schedule,integer(input.version),key);}
      else result=await service[method](actor,input,key);
      reply(res,200,{data:result},requestId);
      return true;
    } catch (error) {
      const status=statuses.has(error.status)?error.status:500;
      const code=status===500?'INTERNAL_ERROR':(/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code??'')?error.code:'REQUEST_REJECTED');
      if (status===500) { try { onError({requestId,code:'INTERNAL_ERROR'}); } catch {} }
      if(error.closeConnection) {
        res.setHeader?.('Connection','close');
        if (typeof res.once==='function') res.once('finish',()=>req.destroy());
        else req.destroy();
      }
      reply(res,status,{error:code,requestId},requestId);
      return true;
    }
  };
}

export const operationsCommands=Object.keys(commands);
