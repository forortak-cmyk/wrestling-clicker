const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const { verifyTelegramInitData } = require('../lib/telegram-auth');
const { createPaymentPayload, validatePayment } = require('../lib/payment-payload');
const { findVoucher } = require('../lib/vouchers');
const token='test_bot_token';
function signed(date=Math.floor(Date.now()/1000),id=123) {
 const p=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id,first_name:'Test'})});
 const check=[...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
 const key=crypto.createHmac('sha256','WebAppData').update(token).digest();
 p.set('hash',crypto.createHmac('sha256',key).update(check).digest('hex'));return p.toString();
}
test('Telegram authentication rejects forged, expired, future and duplicate fields',()=>{
 assert.equal(verifyTelegramInitData(signed(),token).id,123);
 assert.equal(verifyTelegramInitData(signed().replace('Test','Fake'),token),null);
 assert.equal(verifyTelegramInitData(signed(1),token),null);
 assert.equal(verifyTelegramInitData(signed(Math.floor(Date.now()/1000)+1000),token),null);
 assert.equal(verifyTelegramInitData(signed()+'&auth_date=1',token),null);
 assert.equal(verifyTelegramInitData(signed(Math.floor(Date.now()/1000),-1),token),null);
});
test('payment payload binds buyer, amount, product and coin quantity',()=>{
 const pack={id:'coins_ultra',coins:2000000000,stars:2000};
 const p=createPaymentPayload('coins',123,pack,token);
 assert(Buffer.byteLength(p)<=128);assert.equal(validatePayment(p,123,'XTR',2000,token).c,pack.coins);
 for(const [buyer,currency,amount] of [[124,'XTR',2000],[123,'USD',2000],[123,'XTR',1]])assert.equal(validatePayment(p,buyer,currency,amount,token),null);
 assert.equal(validatePayment(p.replace('2000000000','9000000000'),123,'XTR',2000,token),null);
 assert.equal(validatePayment(createPaymentPayload('pass',123,null,token),123,'XTR',450,token).t,'pass');
});
test('voucher price cannot come from client',()=>{
 process.env.VOUCHER_CATALOG_JSON=JSON.stringify([{id:'gym',sponsor:'Gym',prize:'Pass',cost:1000}]);
 assert.equal(findVoucher({voucherId:'gym',cost:-99999}).cost,1000);
 assert.equal(findVoucher({sponsor:'fake',prize:'anything',cost:-1}),null);
 delete process.env.VOUCHER_CATALOG_JSON;
});
function loadWebhook(db) {
 const filename=path.resolve('api/webhook.js');const realRequire=createRequire(filename);
 const ctx={module:{exports:{}},Buffer,console,process:{env:{BOT_TOKEN:token,TELEGRAM_WEBHOOK_SECRET:'secret',SUPABASE_SERVICE_ROLE_KEY:'fake'}},require:n=>n==='@supabase/supabase-js'?{createClient:()=>db}:realRequire(n),fetch:async()=>({json:async()=>({ok:true})})};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),ctx);return ctx.module.exports;
}
function response(){return {code:0,status(n){this.code=n;return this},send(v){this.body=v;return this}};}
const payment=()=>({message:{from:{id:123},chat:{id:123},successful_payment:{invoice_payload:createPaymentPayload('pass',123,null,token),currency:'XTR',total_amount:450,telegram_payment_charge_id:'charge'}}});
test('unsigned webhook cannot activate premium',async()=>{
 let called=false;const handler=loadWebhook({rpc:async()=>{called=true;return {data:{credited:true}}}});const res=response();
 await handler({method:'POST',headers:{},body:payment()},res);assert.equal(res.code,401);assert.equal(called,false);
});
test('valid payment uses atomic receipt RPC; storage failure requests Telegram retry',async()=>{
 let name,args;let fail=false;const handler=loadWebhook({rpc:async(n,a)=>{name=n;args=a;return fail?{error:{code:'DB_DOWN'}}:{data:{credited:true}}}});
 let res=response();await handler({method:'POST',headers:{'x-telegram-bot-api-secret-token':'secret'},body:payment()},res);
 assert.equal(res.code,200);assert.equal(name,'credit_telegram_payment');assert.equal(args.p_charge_id,'charge');
 fail=true;res=response();await handler({method:'POST',headers:{'x-telegram-bot-api-secret-token':'secret'},body:payment()},res);assert.equal(res.code,500);
});
test('authenticated webhook still rejects incorrect payment amount',async()=>{
 let called=false;const handler=loadWebhook({rpc:async()=>{called=true;return {data:{credited:true}}}});const body=payment();body.message.successful_payment.total_amount=0;
 const res=response();await handler({method:'POST',headers:{'x-telegram-bot-api-secret-token':'secret'},body},res);assert.equal(res.code,400);assert.equal(called,false);
});
test('all server and inline browser JavaScript parses',()=>{
 for(const dir of ['api','lib'])for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.js')))new vm.Script(fs.readFileSync(`${dir}/${file}`,'utf8'),{filename:file});
 for(const file of ['index.html','admin.html','support.html'])for(const m of fs.readFileSync(file,'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1],{filename:file});
});
