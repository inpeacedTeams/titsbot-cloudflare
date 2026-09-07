import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {one} from '../src/service.mjs';
import {ChatService as Service} from '../src/chat-service.mjs';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required. Use a disposable database.');
const db=new pg.Client({connectionString:url});await db.connect();
// Refuse to overwrite an existing schema: these tests are not a reset utility.
if(await one(db,"SELECT 1 FROM pg_namespace WHERE nspname='titsbot'")){await db.end();throw new Error('Database already contains titsbot. Use a NEW disposable database.');}
await db.query(await readFile(new URL('../supabase/migrations/001_initial.sql',import.meta.url),'utf8'));
await db.query(await readFile(new URL('../supabase/migrations/002_chat_v2.sql',import.meta.url),'utf8'));
let clock=1000,chat=-100;
async function tx(fn,chatId=chat){await db.query('BEGIN');try{await db.query('SELECT pg_advisory_xact_lock($1::bigint)',[chatId]);const result=await fn(new Service(db,chatId,clock));await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}}
async function chatTest(user=42){const id=await tx(s=>s.reserveChat(user));await tx(s=>s.activateChat(id,{date:clock,message_id:1}));for(const [i,text]of ['сегодня мы обсуждаем новую задачу','потом я предложу своё решение','надеюсь всё получится очень хорошо'].entries())await tx(s=>s.ingest({message_id:i+2,chat:{id:chat},from:{id:user},date:clock+5*(i+1),text}));clock+=66;await tx(s=>s.freeze());await tx(s=>s.completeChat(id,{accuracy:90,quality:90,context_relevance:90,reasoning:'fixture',provider:'fixture',model:'fixture',prompt_version:'test',input_hash:'test',raw_response:'{}'}));return id;}
async function mt(user=42,n=5){const a=await tx(s=>s.start(user,'request_identifier_'+clock+'_'+n));clock=a.started_at+1;await tx(s=>s.append(user,a.attempt_id,0,[...a.prompt.slice(0,n)].map((char,i)=>({t:100+i*10,kind:'insert',char}))));clock=a.ended_at+.1;return tx(s=>s.finish(user,a.attempt_id));}
try {
  await test('full calibration, immutable score, no retake',async()=>{await chatTest();await tx(s=>s.launch(42));for(const n of [3,8,5])await mt(42,n);const status=await tx(s=>s.status(42));assert.equal(status.status,'CALIBRATION_COMPLETED');assert.equal(status.mt_score,Math.max(...status.attempts.map(a=>a.score)));await assert.rejects(tx(s=>s.reserveChat(42)));await assert.rejects(tx(s=>s.launch(42)));await assert.rejects(tx(s=>s.start(42,'fourth_request_123')));await assert.rejects(db.query('UPDATE titsbot.users SET initial_chat_d=10 WHERE chat_id=-100 AND user_id=42'));await assert.rejects(db.query('DELETE FROM titsbot.users WHERE user_id=42'));});
  await test('MT first, then chat',async()=>{await tx(s=>s.launch(43));for(const n of [3,4,5])await mt(43,n);assert.equal((await tx(s=>s.status(43))).status,'MT_COMPLETED');await chatTest(43);assert.equal((await tx(s=>s.status(43))).status,'CALIBRATION_COMPLETED');});
  await test('launch owner and expiry',async()=>{const token=await tx(s=>s.launch(44));await tx(s=>s.authorize(44,token));await assert.rejects(tx(s=>s.authorize(45,token)));clock+=3601;await assert.rejects(tx(s=>s.authorize(44,token)));});
  await test('start and batch replay are idempotent',async()=>{const a=await tx(s=>s.start(44,'request_identifier_replay'));assert.equal((await tx(s=>s.start(44,'request_identifier_replay'))).attempt_id,a.attempt_id);clock=a.started_at+1;const events=[{t:100,kind:'insert',char:a.prompt[0]}];await tx(s=>s.append(44,a.attempt_id,0,events));await tx(s=>s.append(44,a.attempt_id,0,events));await assert.rejects(tx(s=>s.append(45,a.attempt_id,0,events)));await assert.rejects(tx(s=>s.append(44,a.attempt_id,0,[{t:101,kind:'delete'}])));assert.equal(Number((await one(db,'SELECT count(*) FROM titsbot.mt_batches WHERE attempt_id=$1',[a.attempt_id])).count),1);});
  await test('invalid events commit consumed attempt',async()=>{await tx(s=>s.launch(45));const a=await tx(s=>s.start(45,'invalid_request_identifier'));clock=a.started_at+1;const r=await tx(s=>s.append(45,a.attempt_id,0,[{t:10000,kind:'insert',char:'a'}]));assert.equal(r.httpStatus,409);const saved=await one(db,'SELECT * FROM titsbot.mt_attempts WHERE attempt_id=$1',[a.attempt_id]);assert.equal(saved.status,'INVALID');assert.equal(saved.score,0);});
  await test('three expired attempts remain consumed',async()=>{await tx(s=>s.launch(46));for(let i=0;i<3;i++){const a=await tx(s=>s.start(46,'timeout_request_'+i));clock=a.ended_at+6;await tx(s=>s.expire());}assert.equal((await tx(s=>s.status(46))).mt_d,1);await assert.rejects(tx(s=>s.start(46,'fourth_request_identifier')));});
  await test('group identity isolation',async()=>{await tx(s=>s.launch(42),-200);assert.equal((await tx(s=>s.status(42),-200)).status,'NOT_STARTED');});
  await test('concurrent start serialized by postgres lock',async()=>{await tx(s=>s.launch(47));const start=async i=>{const c=new pg.Client({connectionString:url});await c.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(-100::bigint)');const a=await new Service(c,-100,clock).start(47,'concurrent_request_'+i);await c.query('COMMIT');return a;}catch{await c.query('ROLLBACK');return null;}finally{await c.end();}};const all=await Promise.all(Array.from({length:5},(_,i)=>start(i)));assert.equal(all.filter(Boolean).length,1);});
  await test('chat busy timer, cancelled start retry and analysis deadline',async()=>{
    const id=await tx(s=>s.reserveChat(60),-300);
    await assert.rejects(tx(s=>s.reserveChat(61),-300),/30 с/);
    clock+=31;await tx(s=>s.recoverChat(),-300);
    assert.equal((await one(db,'SELECT status FROM titsbot.chat_tests WHERE test_id=$1',[id])).status,'CANCELLED');
    assert.equal(await tx(s=>s.reserveChat(60),-300),id);
    await tx(s=>s.activateChat(id,{date:clock,message_id:100}),-300);
    await tx(s=>s.ingest({message_id:101,from:{id:60},date:clock+1,text:'да да! 🙂'}),-300);
    await assert.rejects(tx(s=>s.reserveChat(61),-300),/65 с/);
    clock+=66;await tx(s=>s.freeze(),-300);
    const saved=await one(db,'SELECT * FROM titsbot.chat_tests WHERE test_id=$1',[id]);assert.equal(saved.metrics.chat_wpm,1.6);
    await tx(s=>s.reserveChat(61),-300);
    clock+=121;await tx(s=>s.recoverChat(),-300);
    assert.equal((await one(db,'SELECT status FROM titsbot.chat_tests WHERE test_id=$1',[id])).status,'ANALYSIS_FAILED');
    assert.equal((await one(db,'SELECT initial_chat_d FROM titsbot.users WHERE chat_id=-300 AND user_id=60')).initial_chat_d,null);
    assert.equal(await tx(s=>s.reserveChat(60),-300),id);
    assert.equal((await one(db,'SELECT metrics FROM titsbot.chat_tests WHERE test_id=$1',[id])).metrics.chat_wpm,saved.metrics.chat_wpm);
  });
  await test('tables have RLS enabled',async()=>{const r=await one(db,"SELECT bool_and(relrowsecurity) AS enabled FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='titsbot' AND c.relkind='r'");assert.equal(r.enabled,true);});
}finally{await db.end();}
