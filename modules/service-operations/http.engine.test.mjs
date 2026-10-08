// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {OperationsService} from './engine.mjs';
import {createOperationsHandler} from './http.mjs';

test('real HTTP and real SQLite complete operational flow with numeric and string session IDs',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'cms-erp-http-engine-'));
  const service=new OperationsService(join(directory,'test.sqlite'),{now:()=> '2026-10-09T10:00:00.000Z'});
  let handler;
  const server=createServer(async(req,res)=>{if(await handler(req,res))return;res.writeHead(404);res.end()});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const actors={admin:{id:101,role:'admin'},planner:{id:'http-planner',role:'planner'},tech:{id:'http-technician',role:'technician'},finance:{id:'http-finance',role:'finance'}};
  handler=createOperationsHandler({service,allowedOrigin:origin,resolveActor:req=>actors[req.headers['x-synthetic-session']],verifyCsrf:req=>req.headers['x-synthetic-csrf']==='valid'});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();rmSync(directory,{recursive:true,force:true})});
  let count=0;
  async function command(name,input,role='admin',key='http-intent-'+(++count),expected=200) {
    const res=await fetch(origin+'/api/operations/commands/'+name,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Synthetic-Session':role,'X-Synthetic-CSRF':'valid','Idempotency-Key':key},body:JSON.stringify(input)});
    const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return data.data??data;
  }
  async function read(entity,id,role='admin',expected=200){const res=await fetch(origin+'/api/operations/'+entity+(id?'/'+id:''),{headers:{'X-Synthetic-Session':role}});const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));return data.data??data}
  const customer=await command('create-customer',{name:'HTTP synthetische klant',type:'b2c'});
  const replay=await command('create-customer',{name:'HTTP synthetische klant',type:'b2c'},'admin','http-intent-1');assert.deepEqual(replay,customer);
  await command('create-customer',{name:'Andere inhoud',type:'b2c'},'admin','http-intent-1',409);
  const product=await command('create-product',{name:'Demo koppeling',sku:'HTTP-DEMO-001',unitCents:2500,vatBasisPoints:2100,stock:8});
  const resource=await command('create-resource',{name:'Demo monteur',technicianId:actors.tech.id});
  let quote=await command('create-quote',{customerId:customer.id,lines:[{description:'Montage',unitCents:6000,quantityMilli:1500,vatBasisPoints:2100},{description:'Koppelingen',unitCents:2500,quantityMilli:2000,vatBasisPoints:2100,productId:product.id}]},'planner');
  quote=await command('quote-status',{id:quote.id,status:'sent',version:quote.version},'planner');
  quote=await command('quote-status',{id:quote.id,status:'accepted',version:quote.version},'planner');
  let workorder=await command('workorder-from-quote',{quoteId:quote.id,schedule:{resourceId:resource.id,startAt:'2026-10-08T08:00:00Z',endAt:'2026-10-08T10:00:00Z'}},'planner');
  await command('reserve-inventory',{workorderId:workorder.id,productId:product.id,quantity:4},'planner');
  workorder=await command('workorder-status',{id:workorder.id,status:'active',version:workorder.version},'planner');
  await command('record-hours',{workorderId:workorder.id,minutes:90,date:'2026-10-08'},'tech');
  await command('consume-inventory',{workorderId:workorder.id,productId:product.id,quantity:2},'tech');
  await command('release-inventory',{workorderId:workorder.id,productId:product.id,quantity:2},'planner');
  workorder=await command('workorder-status',{id:workorder.id,status:'done',version:workorder.version},'planner');
  const invoice=await command('issue-invoice',{quoteId:quote.id,dueDate:'2026-11-07'},'finance');assert.equal(invoice.totalCents,16940);assert.equal(invoice.workorderId,workorder.id);
  await command('record-payment',{invoiceId:invoice.id,amountCents:5000,reference:'HTTP-DEMO-PAYMENT'},'finance');
  await command('issue-credit-note',{invoiceId:invoice.id,amountCents:1940,reason:'Demo credit'},'finance');
  assert.equal((await read('invoices',invoice.id,'finance')).balanceCents,10000);
  assert.equal((await read('products',product.id)).stock,6);assert.equal((await read('products',product.id)).reserved,0);
  await read('invoices',invoice.id,'planner',403);
  assert.equal((await read('workorders',workorder.id,'tech')).status,'done');
  assert.ok((await read('bookkeeping',null,'finance')).entries.length>=3);
  await read('audit',null,'tech',403);
});

test('operations schema preserves pre-existing core tables and records',t=>{
  const directory=mkdtempSync(join(tmpdir(),'cms-erp-namespace-'));const path=join(directory,'test.sqlite');
  const existing=new DatabaseSync(path);existing.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO customers VALUES(1,'Core sentinel')");existing.close();
  const service=new OperationsService(path);t.after(()=>{service.close();rmSync(directory,{recursive:true,force:true})});
  service.createCustomer({id:1,role:'admin'},{name:'Module sentinel',type:'b2c'},'namespace-customer');
  const read=new DatabaseSync(path);assert.equal(read.prepare('SELECT name FROM customers WHERE id=1').get().name,'Core sentinel');assert.equal(read.prepare('SELECT count(*) AS n FROM ops_customers').get().n,1);read.close();
});
