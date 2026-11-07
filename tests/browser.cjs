const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const { getCurrentSeason } = require('../api/battlepass-config');
(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync('tests/fixtures.sql','utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/20261107182421_protect_game_economy.sql','utf8'));
  await db.query('update users set bp_season=$1, last_sync=$2 where telegram_id=123',[getCurrentSeason(Date.now()).seasonNumber,Date.now()-60000]);
  const token='local_test_bot';
  const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:123,first_name:'Test'})});
  const check=[...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  p.set('hash',crypto.createHmac('sha256',crypto.createHmac('sha256','WebAppData').update(token).digest()).update(check).digest('hex'));
  let handler;let failSync=false;let loseResponse=false;let delaySync=false;const syncRequests=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{body={};}
    const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    if(url.pathname==='/api/game'){
      req.body=body;
      if(body.action==='sync'){
        syncRequests.push(body);
        if(failSync)return json(503,{ok:false,error:'temporary failure'});
        if(delaySync)await new Promise(r=>setTimeout(r,300));
        if(loseResponse){loseResponse=false;const original=res.end.bind(res);res.end=()=>{res.end=original;res.destroy();};}
      }
      res.status=function(n){this.statusCode=n;return this};res.json=function(v){this.setHeader('content-type','application/json');this.end(JSON.stringify(v));return this};res.send=function(v){this.end(v);return this};
      return handler(req,res);
    }
    if(url.pathname.startsWith('/rest/v1/')){
      try{
        if(url.pathname.startsWith('/rest/v1/rpc/')){
          const fn=url.pathname.split('/').pop();assert.equal(fn,'commit_game_operation');
          const names=['p_telegram_id','p_revision','p_changes','p_operation_id','p_extra','p_withdrawal','p_ad_session'];
          const values=names.map(n=>body[n]&&typeof body[n]==='object'?JSON.stringify(body[n]):body[n]);
          const result=await db.query('select commit_game_operation($1,$2,$3,$4,$5,$6,$7) as value',values);
          return json(200,result.rows[0].value);
        }
        const table=url.pathname.split('/').pop();assert(['users','game_operations','ad_reward_sessions'].includes(table));
        assert(['GET','HEAD'].includes(req.method));
        const values=[];const clauses=[];
        for(const [key,value] of url.searchParams){
          if(['select','order','limit','offset'].includes(key))continue;
          assert(/^[a-z_]+$/.test(key));const [op,...parts]=value.split('.');assert.equal(op,'eq');values.push(parts.join('.'));clauses.push(`${key}=$${values.length}`);
        }
        const where=clauses.length?' where '+clauses.join(' and '):'';
        const select=url.searchParams.get('select')||'*';assert(/^[a-z_*, ]+$/.test(select));
        const result=await db.query(`select ${select} from ${table}${where}`,values);
        if(req.method==='HEAD'){res.setHeader('content-range',`0-0/${result.rows.length}`);res.writeHead(200);return res.end();}
        if((req.headers.accept||'').includes('vnd.pgrst.object')){
          if(result.rows.length!==1)return json(406,{code:'PGRST116',message:'Expected one row'});
          return json(200,result.rows[0]);
        }
        return json(200,result.rows);
      }catch(e){return json(400,{code:e.code||'TEST_ADAPTER',message:e.message});}
    }
    if(req.url==='/favicon.ico'){res.writeHead(204);return res.end();}
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','admin.html','support.html'].includes(file)&&!/^stage[1-5]-[a-z]+\.png$/.test(file)){res.writeHead(404);return res.end();}
    res.setHeader('content-type',file.endsWith('.png')?'image/png':'text/html');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  process.env.BOT_TOKEN=token;process.env.SUPABASE_URL=base;process.env.SUPABASE_SERVICE_ROLE_KEY='test-service-key';
  handler=require('../api/game');
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.fulfill({status:200,body:'',contentType:'application/javascript'}));
    await page.addInitScript(initData=>{window.Telegram={WebApp:{initData,initDataUnsafe:{user:{id:123,first_name:'Test'}},expand(){},ready(){},showAlert(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};},p.toString());
    await page.goto(base);await page.waitForFunction(()=>app.dataLoaded);
    assert.equal(await page.locator('#score').innerText(),'500,000,000');
    await page.locator('#coinBtn').click();await page.evaluate(()=>app.forceSync());
    let user=(await db.query('select balance,revision from users where telegram_id=123')).rows[0];
    assert.equal(Number(user.balance),500000001);console.log('PASS browser → API → Supabase client → SQL RPC → balance rendering');
    failSync=true;await page.locator('#coinBtn').click();await page.evaluate(()=>app.forceSync());
    assert.equal(await page.evaluate(()=>app.syncBatch.clicks),1);const retained=await page.evaluate(()=>app.syncBatch.operationId);
    failSync=false;await page.evaluate(()=>app.forceSync());assert.equal(await page.evaluate(()=>app.syncBatch),null);
    assert.equal(syncRequests.at(-1).operationId,retained);console.log('PASS network failure retains click batch and operation ID');
    await page.waitForTimeout(200);loseResponse=true;await page.locator('#coinBtn').click();await page.evaluate(()=>app.forceSync());
    user=(await db.query('select balance from users where telegram_id=123')).rows[0];assert.equal(Number(user.balance),500000003);console.log('PASS lost response retries without double credit');
    await page.waitForTimeout(200);delaySync=true;await page.locator('#coinBtn').click();
    await page.evaluate(()=>{window.syncInFlight=app.forceSync();});
    await page.waitForTimeout(50);await page.locator('#coinBtn').click();await page.evaluate(()=>window.syncInFlight);
    assert.equal(await page.evaluate(()=>app.state.score),500000005);assert.equal(await page.evaluate(()=>app.pendingClicks),1);
    delaySync=false;await page.evaluate(()=>app.forceSync());console.log('PASS clicks during an in-flight save stay visible and persist');
    const n=syncRequests.length;await page.evaluate(()=>app.toggleAutoClicker());await page.waitForTimeout(2200);await page.evaluate(()=>app.toggleAutoClicker());
    assert(syncRequests.length>n);await page.evaluate(()=>app.forceSync());console.log('PASS auto-clicker saves while running');
    // Exercise the remaining money-changing game actions through the real handler.
    const action = async (name,payload) => page.evaluate(async ({name,payload})=>{
      const result=await app.callApi(name,payload);if(result.user)app.applyUserState(result.user);return result;
    },{name,payload});
    const upgrade=await action('buyUpgrade',{itemId:1,clicks:0});assert.equal(upgrade.ok,true);assert.equal(upgrade.user.click_power,2);
    const daily=await action('claimDailyBonus');assert.equal(daily.reward,10000);
    assert.equal((await action('claimDailyBonus')).ok,false);
    const biz=await action('buyBusiness',{businessId:1});assert.equal(biz.ok,true);assert.deepEqual(biz.user.businesses,[1]);
    await db.query('update users set last_business_collect=$1 where telegram_id=123',[Date.now()-4*3600000]);
    const collected=await action('collectBusinessIncome');assert.equal(collected.collected,12000);
    const spin=await action('spin');assert.equal(spin.ok,true);assert([1000,5000,10000,25000,50000,100000].includes(spin.prize));
    process.env.VOUCHER_CATALOG_JSON=JSON.stringify([{id:'test_voucher',sponsor:'Gym',prize:'Pass',cost:1000}]);
    const voucher=await action('buyVoucher',{voucherId:'test_voucher',cost:-999999});assert.equal(voucher.ok,true);assert.equal(voucher.user.balance,spin.user.balance-1000);
    const badVoucher=await action('buyVoucher',{sponsor:'Fake',prize:'Fake',cost:-1});assert.equal(badVoucher.ok,false);
    const withdrawal=await action('requestWithdrawal',{coins:250000000,fullName:'Test User',cardNumber:'1234567890123456',clicks:0});assert.equal(withdrawal.ok,true);assert.equal(withdrawal.amd,750);
    assert.equal((await db.query('select count(*)::int as n from withdrawals')).rows[0].n,1);
    assert.equal((await action('claimAdReward')).ok,false);
    console.log('PASS upgrades, daily cooldown, business income, roulette, voucher pricing and atomic withdrawal');
    // A zero-click sync consumes idle time; repeated requests do not mint a +5 allowance.
    await db.query('update users set last_sync=$1 where telegram_id=123',[Date.now()-3600000]);
    const post=(clicks)=>page.evaluate(async clicks=>await app.requestApi('sync',{clicks}),clicks);
    await post(0);const initialBalance=Number((await db.query('select balance from users where telegram_id=123')).rows[0].balance);const started=Date.now();
    for(let i=0;i<8;i++)assert.equal((await post(1000)).ok,true);
    const endBalance=Number((await db.query('select balance from users where telegram_id=123')).rows[0].balance);
    assert(endBalance-initialBalance <= (Math.floor((Date.now()-started)/150)+1)*2);
    console.log('PASS rapid sync cannot mint per-request click allowances or bank idle time');
    // Inspect hostile API values in the actual admin renderer.
    await page.route('**/api/admin-data',route=>route.fulfill({json:{ok:true,stats:{perSponsor:{'<img src=x onerror="window.xss=1">':1},totalUsers:1,totalBalance:0,totalEarned:0,totalVouchers:1},vouchers:[{username:'<img src=x onerror="window.xss=1">',telegram_id:123,sponsor:'<script>bad</script>',code:'ABC',date:Date.now()}],leaderboard:[],purchases:[]}}));
    await page.goto(base+'/admin.html');await page.waitForFunction(()=>document.querySelector('.stats-grid'));
    assert.equal(await page.locator('#content img').count(),0);assert.equal(await page.evaluate(()=>window.xss),undefined);console.log('PASS admin treats hostile names and sponsors as text');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();}
})().catch(e=>{console.error(e);process.exit(1);});
