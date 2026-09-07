import pg from 'pg';
import {now} from './core.mjs';
import {one} from './service.mjs';
import {ChatService as Service} from './chat-service.mjs';
export async function database(env,fn) {
  const connectionString=env.DATABASE_URL||env.HYPERDRIVE?.connectionString;
  if(!connectionString)throw new Error('Database binding missing');
  const db=new pg.Client({connectionString,connectionTimeoutMillis:8000,query_timeout:12000});
  try {await db.connect();return await fn(db);} finally {await db.end().catch(()=>{});}
}
export async function transaction(env,chat,fn) {
  return database(env,async db=>{
    await db.query('BEGIN');
    try {
      await db.query("SET LOCAL statement_timeout='10s'");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query('SELECT pg_advisory_xact_lock($1::bigint)',[chat]);
      const t=await one(db,'SELECT extract(epoch from clock_timestamp())::float8 AS t');
      const result=await fn(new Service(db,chat,t.t));await db.query('COMMIT');return result;
    } catch(e) {await db.query('ROLLBACK').catch(()=>{});throw e;}
  });
}
