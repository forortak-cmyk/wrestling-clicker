const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
let db;
before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync('tests/fixtures.sql','utf8'));
  await db.exec(fs.readFileSync('supabase/migrations/20261107182421_protect_game_economy.sql','utf8'));
});
after(async()=>db?.close());
async function player() { return (await db.query('select to_jsonb(users) as player from users where telegram_id=123')).rows[0].player; }
async function commit(revision, changes, id, extra={}, withdrawal=null) {
  return (await db.query('select commit_game_operation($1,$2,$3,$4,$5,$6) as result', [123,revision,JSON.stringify(changes),id,JSON.stringify(extra),withdrawal && JSON.stringify(withdrawal)])).rows[0].result;
}
test('migration retains balances and existing progress',async()=>{
  const u=await player(); assert.equal(u.balance,500000000);assert.equal(u.bp_points,500);assert.equal(u.revision,0);
});
test('replayed operation credits once and preserves original response',async()=>{
  const u=await player();const changes={balance:u.balance+10};
  const first=await commit(u.revision,changes,'sync_operation_0001',{acceptedClicks:10});
  const second=await commit(u.revision,{balance:999999999},'sync_operation_0001',{acceptedClicks:999});
  assert.deepEqual(first,second);assert.equal((await player()).balance,u.balance+10);
});
test('stale request cannot overwrite another operation',async()=>{
  const stale=await player();await commit(stale.revision,{balance:stale.balance+5},'sync_operation_0002');
  await assert.rejects(commit(stale.revision,{balance:0},'sync_operation_0003'),{code:'40001'});
  assert.equal((await player()).balance,stale.balance+5);
});
test('withdrawal and debit commit once together',async()=>{
  const u=await player();const w={username:'Test',full_name:'Test User',card_last4:'1234',coins_amount:250000000,amd_amount:750};
  await commit(u.revision,{balance:u.balance-w.coins_amount},'withdrawal_op_0001',{amd:750},w);
  await commit(u.revision,{balance:0},'withdrawal_op_0001',{amd:750},w);
  assert.equal((await player()).balance,u.balance-w.coins_amount);
  assert.equal((await db.query('select count(*)::int as n from withdrawals')).rows[0].n,1);
});
test('failed withdrawal rolls back debit and operation receipt',async()=>{
  const u=await player();const w={full_name:null,card_last4:'1234',coins_amount:250000000,amd_amount:750};
  await assert.rejects(commit(u.revision,{balance:u.balance-1},'withdrawal_op_fail',{},w));
  assert.deepEqual(await player(),u);
  assert.equal((await db.query("select count(*)::int as n from game_operations where operation_id='withdrawal_op_fail'")).rows[0].n,0);
});
test('payment receipt and increment are atomic and idempotent',async()=>{
  const u=await player();const sql="select credit_telegram_payment('charge_1',123,'coins',50000000,100,10) as result";
  assert.equal((await db.query(sql)).rows[0].result.credited,true);
  assert.equal((await db.query(sql)).rows[0].result.credited,false);
  assert.equal((await player()).balance,u.balance+50000000);
  await assert.rejects(db.query("select credit_telegram_payment('charge_1',123,'coins',50000001,100,10)"));
});
test('premium purchased after rollover survives the next load',async()=>{
  await db.query("select credit_telegram_payment('charge_pass',123,'pass',0,450,10)");
  const u=await player();assert.equal(u.bp_season,10);assert.equal(u.bp_premium,true);assert.equal(u.bp_points,0);assert.deepEqual(u.bp_claimed_free,[]);
});
test('all updates increment revision, including legacy writers',async()=>{
  const u=await player();await db.query('update users set cap_notified=true where telegram_id=123');assert.equal((await player()).revision,u.revision+1);
});
test('public roles cannot execute privileged RPCs or read receipts',async()=>{
  await db.exec('set role anon');
  try {
    await assert.rejects(db.query("select credit_telegram_payment('fake',123,'coins',50,1,10)"),{code:'42501'});
    await assert.rejects(db.query('select * from game_operations'),{code:'42501'});
  } finally {await db.exec('reset role');}
});
test('service role can call game RPC without SECURITY DEFINER',async()=>{
  const u=await player();await db.exec('set role service_role');
  try {const result=await commit(u.revision,{balance:u.balance+1},'service_operation_01');assert.equal(result.user.balance,u.balance+1);}
  finally {await db.exec('reset role');}
});
test('ad reward cannot be claimed without a verified server receipt',async()=>{
  const u=await player();await assert.rejects(commit(u.revision,{balance:u.balance+30000,last_ad_reward_claim:Date.now()},'unverified_ad_001'));
  assert.deepEqual(await player(),u);
});
test('ad receipt is bound to player/track and can be consumed only once',async()=>{
  const id='12345678-1234-1234-1234-123456789abc';
  await db.query("insert into ad_reward_sessions(id,telegram_id,track,verified,provider_event_id) values($1,123,'ad',true,'event_1')",[id]);
  const u=await player();
  const invoke=(revision,changes,op)=>db.query('select commit_game_operation(123,$1,$2,$3,$4,null,$5) as result',[revision,JSON.stringify(changes),op,'{}',id]);
  await assert.rejects(invoke(u.revision,{last_popup_reward_claim:Date.now(),balance:u.balance+30000},'wrong_track_ad_01'));
  const {rows}=await invoke(u.revision,{last_ad_reward_claim:Date.now(),balance:u.balance+30000},'verified_ad_op_01');
  assert.equal(rows[0].result.user.balance,u.balance+30000);
  const current=await player();await assert.rejects(invoke(current.revision,{last_ad_reward_claim:Date.now(),balance:current.balance+30000},'reused_ad_reward_01'));
  assert.equal((await player()).balance,current.balance);
});
