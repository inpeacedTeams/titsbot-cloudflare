import {rules,now,uid,json,sha,Conflict,prompt,mtMetrics,chatMetrics,chatScore,tier,finalTag} from './core.mjs';
export const rows=async(db,q,args=[]) => (await db.query(q,args)).rows;
export const one=async(db,q,args=[]) => (await rows(db,q,args))[0];
export async function enqueue(db,chat,key,kind,payload,next=0) {await db.query('INSERT INTO titsbot.outbox(job_key,chat_id,kind,payload,next_run) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[key,chat,kind,json(payload),next]);}
export class Service {
  constructor(db,chat,time=now()) {this.db=db;this.chat=chat;this.time=time;}
  async user(user,create=false) {
    if(create)await this.db.query('INSERT INTO titsbot.users(chat_id,user_id,config) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[this.chat,user,json(rules)]);
    const u=await one(this.db,'SELECT * FROM titsbot.users WHERE chat_id=$1 AND user_id=$2',[this.chat,user]);
    if(!u)throw new Conflict('Сначала вызовите /getDmt или /getDchat в группе.');return u;
  }
  async reply(key,text,extra={}) {await enqueue(this.db,this.chat,key,'message',{chat_id:this.chat,text,...extra});}
  async rate(user) {
    const key=`api:${this.chat}:${user}`,win=Math.floor(this.time/60);
    const r=await one(this.db,'INSERT INTO titsbot.rate_limits(key,window_start,hits) VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET window_start=EXCLUDED.window_start,hits=CASE WHEN titsbot.rate_limits.window_start=EXCLUDED.window_start THEN titsbot.rate_limits.hits+1 ELSE 1 END RETURNING hits',[key,win]);
    if(r.hits>240)throw new Conflict('Слишком много запросов. Подождите минуту.',429);
  }
  async status(user) {
    await this.expire();const u=await this.user(user);
    const attempts=await rows(this.db,'SELECT attempt_id,ordinal,status,score,metrics,started_at,ended_at,invalid_reason FROM titsbot.mt_attempts WHERE chat_id=$1 AND user_id=$2 ORDER BY ordinal',[this.chat,user]);
    return {mt_wpm_weight:u.config.mt.weights.wpm,status:u.calibration_status,chat_d:u.initial_chat_d,mt_d:u.initial_mt_d,final_d:u.initial_final_d,chat_score:u.initial_chat_score,mt_score:u.initial_mt_score,tag:u.tag,tag_status:u.tag_status,attempts:attempts.map(a=>({...a,metrics:a.metrics||{}})),server_now:this.time};
  }
  async launch(user) {
    const u=await this.user(user,true);if(u.initial_mt_d!==null||u.calibration_completed_at!==null)throw new Conflict('MT Test уже пройден. Повторная калибровка запрещена.');
    const token=uid().replaceAll('-','')+uid().replaceAll('-','');
    await this.db.query('INSERT INTO titsbot.launch_tokens VALUES($1,$2,$3,$4)',[await sha(token),this.chat,user,this.time+3600]);return token;
  }
  async authorize(user,token) {
    const r=await one(this.db,'SELECT 1 FROM titsbot.launch_tokens WHERE token_hash=$1 AND chat_id=$2 AND user_id=$3 AND expires_at>$4',[await sha(token),this.chat,user,this.time]);
    if(!r)throw new Conflict('Ссылка истекла или принадлежит другому участнику. Вызовите /getDmt в группе.',401);
  }
  async reserveChat(user) {
    const u=await this.user(user,true);
    if(u.calibration_completed_at!==null||await one(this.db,'SELECT 1 FROM titsbot.chat_tests WHERE chat_id=$1 AND user_id=$2',[this.chat,user]))throw new Conflict('Chat Test уже запущен или пройден. Повторная попытка запрещена.');
    if(await one(this.db,"SELECT 1 FROM titsbot.chat_tests WHERE chat_id=$1 AND status IN ('RESERVED','RUNNING')",[this.chat]))throw new Conflict('В группе уже идёт Chat Test. Дождитесь окончания; ваша попытка не потрачена.');
    const id=uid();await this.db.query('INSERT INTO titsbot.chat_tests(test_id,chat_id,user_id,created_at) VALUES($1,$2,$3,$4)',[id,this.chat,user,this.time]);
    await enqueue(this.db,this.chat,`go:${id}`,'go',{test_id:id,user_id:user});return id;
  }
  async activateChat(id,message) {
    const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE test_id=$1 AND chat_id=$2 AND status='RESERVED'",[id,this.chat]);
    if(!t)return;const u=await this.user(t.user_id);
    await this.db.query("UPDATE titsbot.chat_tests SET status='RUNNING',started_at=$1,ended_at=$2,go_message_id=$3 WHERE test_id=$4",[message.date,message.date+u.config.chat.duration,message.message_id,id]);
  }
  async ingest(m,edited=false) {
    if(typeof m.text!=='string'||!m.from?.id||m.from.is_bot||m.sender_chat)return;
    if(edited) {await this.db.query('UPDATE titsbot.chat_messages m SET edited_seen=true FROM titsbot.chat_tests t WHERE m.test_id=t.test_id AND t.chat_id=$1 AND t.user_id=$2 AND m.message_id=$3 AND t.status IN (\'RESERVED\',\'RUNNING\')',[this.chat,m.from.id,m.message_id]);return;}
    const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE chat_id=$1 AND status IN ('RESERVED','RUNNING')",[this.chat]);
    if(!t||String(t.user_id)!==String(m.from.id))return;
    if(t.status==='RUNNING'&&(!(m.date>=t.started_at&&m.date<t.ended_at)||m.message_id<=Number(t.go_message_id)))return;
    if(t.status==='RESERVED'&&m.date<t.created_at-1)return;
    const u=await this.user(t.user_id),c=u.config.chat;
    const count=await one(this.db,'SELECT count(*)::int AS n FROM titsbot.chat_messages WHERE test_id=$1',[t.test_id]);
    if(count.n>=c.max_messages*2)return;
    const exclusion=m.text.startsWith('/')?'command':m.forward_origin||m.is_automatic_forward?'forward':[...m.text].length>c.max_message_chars?'too_long':null;
    await this.db.query('INSERT INTO titsbot.chat_messages(test_id,message_id,timestamp,received_at,text,exclusion) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[t.test_id,m.message_id,m.date,this.time,[...m.text].slice(0,4096).join(''),exclusion]);
  }
  async freeze() {
    for(const t of await rows(this.db,"SELECT * FROM titsbot.chat_tests WHERE chat_id=$1 AND status='RUNNING' AND ended_at<=$2",[this.chat,this.time])) {
      const u=await this.user(t.user_id);if(this.time<t.ended_at+u.config.chat.ingest_grace)continue;
      const messages=await rows(this.db,'SELECT * FROM titsbot.chat_messages WHERE test_id=$1 ORDER BY timestamp,message_id',[t.test_id]);
      for(const m of messages)if(m.timestamp<t.started_at||m.timestamp>=t.ended_at||Number(m.message_id)<=Number(t.go_message_id))m.exclusion='before_start';
      const [metrics,enriched]=chatMetrics(messages,t.started_at,u.config);
      for(const m of enriched)await this.db.query('UPDATE titsbot.chat_messages SET exclusion=$1 WHERE test_id=$2 AND message_id=$3',[m.exclusion,t.test_id,m.message_id]);
      await this.db.query("UPDATE titsbot.chat_tests SET status='ANALYZING',metrics=$1 WHERE test_id=$2",[json(metrics),t.test_id]);
      await enqueue(this.db,this.chat,`analyze:${t.test_id}`,'analyze',{test_id:t.test_id});
      await this.reply(`wait:${t.test_id}`,`Chat Test · ${t.user_id} завершён. Анализирую текст; повторный тест не нужен.`);
    }
  }
  async analysisInput(id) {
    const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE test_id=$1 AND chat_id=$2 AND status='ANALYZING'",[id,this.chat]);if(!t)return null;
    let budget=24000;const messages=[];
    for(const m of await rows(this.db,'SELECT timestamp,text,exclusion FROM titsbot.chat_messages WHERE test_id=$1 ORDER BY timestamp,message_id',[id])) {
      if(m.exclusion==='before_start'||budget<=0)continue;const text=m.text.slice(0,Math.min(budget,m.exclusion?200:800));budget-=text.length;messages.push({...m,text,truncated:text.length<m.text.length});
    }
    return {messages,group_context:[],metrics:t.metrics};
  }
  async assignTier(user,score,component,r) {
    const field=component==='chat'?'initial_chat_score':'initial_mt_score';
    const pool=await rows(this.db,`SELECT user_id,${field} AS score FROM titsbot.users WHERE chat_id=$1 AND user_id<>$2 AND calibration_status='CALIBRATION_COMPLETED' ORDER BY user_id`,[this.chat,user]);
    const [d,snapshot]=tier(score,pool.map(p=>p.score),r);Object.assign(snapshot,{pool,config_version:r.version,assigned_at:this.time});return [d,snapshot];
  }
  async completeChat(id,analysis) {
    const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE test_id=$1 AND chat_id=$2 AND status='ANALYZING'",[id,this.chat]);if(!t)return;
    const u=await this.user(t.user_id),[score,parts]=chatScore(t.metrics,analysis.accuracy,u.config),[d,snapshot]=await this.assignTier(t.user_id,score,'chat',u.config);
    await this.db.query('INSERT INTO titsbot.analysis VALUES($1,$2,$3)',[id,json(analysis),this.time]);
    await this.db.query("UPDATE titsbot.chat_tests SET status='DONE',score=$1,components=$2 WHERE test_id=$3",[score,json(parts),id]);
    await this.db.query('UPDATE titsbot.users SET initial_chat_score=$1,initial_chat_d=$2,chat_snapshot=$3 WHERE chat_id=$4 AND user_id=$5',[score,d,json(snapshot),this.chat,t.user_id]);
    const m=t.metrics;await this.reply(`chat-result:${id}`,`CHAT TEST COMPLETE · ${t.user_id}\nСообщений: ${m.total_messages} · Слов: ${m.total_words}\nChat WPM (median): ${m.median_chat_wpm.toFixed(2)}\nAccuracy: ${analysis.accuracy.toFixed(2)}\nConsistency: ${m.wpm_consistency.toFixed(2)} · Diversity: ${m.word_diversity.toFixed(2)}\nChat Score: ${score.toFixed(2)}\nChat Tier: D-${d}${m.insufficient_data?'\nНедостаточно данных: Score = 0.':''}`);
    await this.finalize(t.user_id);
  }
  async finalize(user) {
    const u=await this.user(user);if(u.calibration_completed_at!==null)return;
    if(u.initial_chat_d!==null&&u.initial_mt_d!==null) {
      const [d,tag]=finalTag(u.initial_chat_d,u.initial_mt_d);
      await this.db.query("UPDATE titsbot.users SET initial_final_d=$1,initial_score=$2,tag=$3,calibration_completed_at=$4,calibration_status='CALIBRATION_COMPLETED',tag_status='PENDING' WHERE chat_id=$5 AND user_id=$6",[d,(u.initial_chat_score+u.initial_mt_score)/2,tag,this.time,this.chat,user]);
      await enqueue(this.db,this.chat,`tag:${this.chat}:${user}`,'tag',{chat_id:this.chat,user_id:user,tag});
      await this.reply(`final:${this.chat}:${user}`,`🎉 D-CALIBRATION COMPLETE · ${user}\nChat: D-${u.initial_chat_d}\nMT: D-${u.initial_mt_d}\nFinal Tier: ${tag}\nD зафиксирован навсегда. Тег поставлен в очередь.`);
    } else await this.db.query('UPDATE titsbot.users SET calibration_status=$1 WHERE chat_id=$2 AND user_id=$3',[u.initial_chat_d!==null?'CHAT_COMPLETED':u.initial_mt_d!==null?'MT_COMPLETED':'NOT_STARTED',this.chat,user]);
  }
  async attempt(user,id) {const a=await one(this.db,'SELECT * FROM titsbot.mt_attempts WHERE attempt_id=$1 AND chat_id=$2 AND user_id=$3',[id,this.chat,user]);if(!a)throw new Conflict('Попытка не найдена.');return a;}
  async start(user,request) {
    if(typeof request!=='string'||request.length<16||request.length>80)throw new Conflict('Invalid request ID');
    await this.expire();const u=await this.user(user);
    const existing=await one(this.db,'SELECT * FROM titsbot.mt_attempts WHERE chat_id=$1 AND user_id=$2 AND request_id=$3',[this.chat,user,request]);if(existing)return existing;
    if(u.initial_mt_d!==null||u.calibration_completed_at!==null)throw new Conflict('MT калибровка уже завершена.');
    const all=await rows(this.db,'SELECT * FROM titsbot.mt_attempts WHERE chat_id=$1 AND user_id=$2 ORDER BY ordinal',[this.chat,user]);
    if(all.some(a=>a.status==='RUNNING'))throw new Conflict('Предыдущая попытка ещё активна. Перезагрузка не даёт новую попытку.');
    if(all.length>=3)throw new Conflict('Все 3 попытки использованы.');
    const start=this.time+u.config.mt.countdown;
    return one(this.db,'INSERT INTO titsbot.mt_attempts(attempt_id,chat_id,user_id,ordinal,request_id,prompt,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[uid(),this.chat,user,all.length+1,request,prompt(u.config.mt.language),start,start+u.config.mt.duration]);
  }
  async events(id) {return (await rows(this.db,'SELECT events FROM titsbot.mt_batches WHERE attempt_id=$1 ORDER BY seq',[id])).flatMap(r=>r.events);}
  async append(user,id,seq,events) {
    if(!Number.isInteger(seq)||seq<0||!Array.isArray(events))throw new Conflict('Invalid batch');
    const a=await this.attempt(user,id),u=await this.user(user),c=u.config.mt,digest=await sha(json(events));
    const old=await one(this.db,'SELECT payload_hash FROM titsbot.mt_batches WHERE attempt_id=$1 AND seq=$2',[id,seq]);
    if(old){if(old.payload_hash!==digest)throw new Conflict('Повтор batch с другим содержимым запрещён.');return {accepted:true,seq};}
    if(a.status!=='RUNNING')throw new Conflict('Попытка закрыта.');
    if(seq!==a.last_seq+1)throw new Conflict('Неверный порядок batch. Повторите неподтверждённый batch.');
    const elapsed=(this.time-a.started_at)*1000,prior=await this.events(id);
    try {
      if(!events.length||events.length>c.max_batch_events||prior.length+events.length>c.max_events)throw new Conflict('Event limit exceeded');
      for(const e of events)if(!e||typeof e.t!=='number'||!Number.isFinite(e.t)||e.t>elapsed+250||elapsed-e.t>c.max_event_lag_ms)throw new Conflict('Events must be streamed live');
      if(this.time>a.ended_at+c.grace)throw new Conflict('Attempt deadline passed');
      mtMetrics([...prior,...events],a.prompt,u.config);
    } catch(e) {
      if(!(e instanceof Conflict))throw e;await this.close(a,u.config,'INVALID',e.message);
      return {error:'Попытка засчитана с нулём: '+e.message,httpStatus:409};
    }
    await this.db.query('INSERT INTO titsbot.mt_batches VALUES($1,$2,$3,$4,$5)',[id,seq,digest,json(events),this.time]);
    await this.db.query('UPDATE titsbot.mt_attempts SET last_seq=$1 WHERE attempt_id=$2',[seq,id]);return {accepted:true,seq};
  }
  async finish(user,id,abort=false) {
    const a=await this.attempt(user,id),u=await this.user(user);if(a.status!=='RUNNING')return a.metrics||{};
    if(abort)return this.close(a,u.config,'INVALID','Client aborted / unsupported input');
    if(this.time<a.ended_at)throw new Conflict('30 секунд ещё не истекли.');
    return this.close(a,u.config,this.time>a.ended_at+u.config.mt.grace?'EXPIRED':'DONE',this.time>a.ended_at+u.config.mt.grace?'Result was not submitted before deadline':null);
  }
  async close(a,r,status,reason) {
    const metrics=mtMetrics(await this.events(a.attempt_id),a.prompt,r);if(status!=='DONE')metrics.score=0;
    await this.db.query('UPDATE titsbot.mt_attempts SET status=$1,metrics=$2,score=$3,invalid_reason=$4 WHERE attempt_id=$5',[status,json(metrics),metrics.score,reason,a.attempt_id]);
    const all=await rows(this.db,'SELECT * FROM titsbot.mt_attempts WHERE chat_id=$1 AND user_id=$2 ORDER BY ordinal',[this.chat,a.user_id]);
    if(all.length===3&&all.every(x=>x.status!=='RUNNING')) {
      const best=all.reduce((b,x)=>x.score>b.score?x:b),[d,snapshot]=await this.assignTier(a.user_id,best.score,'mt',r);snapshot.best_attempt_id=best.attempt_id;
      await this.db.query('UPDATE titsbot.users SET initial_mt_score=$1,initial_mt_d=$2,mt_snapshot=$3 WHERE chat_id=$4 AND user_id=$5',[best.score,d,json(snapshot),this.chat,a.user_id]);
      await this.reply(`mt-result:${this.chat}:${a.user_id}`,`MT TEST COMPLETE · ${a.user_id}\nBest Score: ${best.score.toFixed(2)}\nMT Tier: D-${d}`);await this.finalize(a.user_id);
    }
    return metrics;
  }
  async expire() {
    for(const a of await rows(this.db,"SELECT * FROM titsbot.mt_attempts WHERE chat_id=$1 AND status='RUNNING' AND ended_at<$2",[this.chat,this.time])) {
      const u=await this.user(a.user_id);if(this.time>a.ended_at+u.config.mt.grace)await this.close(a,u.config,'EXPIRED','Disconnected or no finish before deadline');
    }
  }
  async restoreTag(user) {
    const u=await one(this.db,'SELECT tag FROM titsbot.users WHERE chat_id=$1 AND user_id=$2',[this.chat,user]);if(!u?.tag)return;
    await this.db.query("UPDATE titsbot.outbox SET status='PENDING',next_run=0 WHERE job_key=$1",[`tag:${this.chat}:${user}`]);
    await this.db.query("UPDATE titsbot.users SET tag_status='PENDING' WHERE chat_id=$1 AND user_id=$2",[this.chat,user]);
  }
}
