import {Conflict,now,json,uid} from './core.mjs';
import {database,transaction} from './db.mjs';
import {one} from './service.mjs';
import {telegram,preflight,assignTag,settings} from './remote.mjs';
import {response,error} from './index.mjs';
import {analyzeChat as analyze} from './chat-analysis.mjs';
export class ChatCoordinator {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async arm(time=Date.now()+1000){const old=await this.ctx.storage.getAlarm();if(old===null||old>time)await this.ctx.storage.setAlarm(time);}
  async fetch(req) {
    try {
      const data=await req.json(),chat=String(data.chat);
      if(!settings(this.env).includes(chat))throw new Conflict('Group not allowed',403);
      await this.ctx.storage.put('chat',chat);await this.arm();
      if(data.kind==='kick')return response({ok:true});
      if(data.kind==='update'){await this.handleUpdate(chat,data.update);return response({ok:true});}
      if(data.kind!=='api')throw new Conflict('Invalid operation',400);
      const result=await transaction(this.env,chat,async s=>{
        await s.authorize(data.user,data.launch);await s.rate(data.user);const p=data.payload;
        switch(data.path) {
          case '/api/status':return s.status(data.user);
          case '/api/mt/start': {const a=await s.start(data.user,p.request_id);return Object.fromEntries([...['attempt_id','ordinal','status','prompt','started_at','ended_at'].map(k=>[k,a[k]]),['server_now',s.time]]);}
          case '/api/mt/events':return s.append(data.user,p.attempt_id,p.seq,p.events);
          case '/api/mt/finish':return s.finish(data.user,p.attempt_id);
          case '/api/mt/abort':return s.finish(data.user,p.attempt_id,true);
          default:throw new Conflict('Not found',404);
        }
      });return response(result,result.httpStatus||200);
    }catch(e){return error(e);}
  }
  async handleUpdate(chat,u) {
    if(await database(this.env,db=>one(db,'SELECT 1 FROM titsbot.processed_updates WHERE update_id=$1',[u.update_id])))return;
    const m=u.message||u.edited_message,edited=!!u.edited_message,user=m?.from?.id;
    const token=(m?.text||'').split(/\s/)[0].split('@'),cmd=token[0].toLowerCase();
    const isCommand=!edited&&Number.isSafeInteger(user)&&!m?.from?.is_bot&&!m?.sender_chat&&(!token[1]||token[1].toLowerCase()===this.env.BOT_USERNAME.toLowerCase())&&['/getdchat','/getdmt'].includes(cmd);
    let denied=null;
    if(isCommand) {
      if(now()-m.date>15||m.date>now()+30)denied='Команда пришла с задержкой. Повторите её; попытка не потрачена.';
      else try{await preflight(this.env,chat,user);}catch(e){if(e instanceof Conflict)denied=e.message;else throw e;}
    }
    await transaction(this.env,chat,async s=>{
      const inserted=await one(s.db,'INSERT INTO titsbot.processed_updates VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id',[u.update_id,s.time]);if(!inserted)return;
      if(u.chat_member){await s.restoreTag(u.chat_member.new_chat_member.user.id);return;}
      if(m)await s.ingest(m,edited);if(edited)return;
      for(const member of m?.new_chat_members||[])if(!member.is_bot)await s.restoreTag(member.id);
      if(!isCommand)return;const key=`update:${u.update_id}`;
      if(denied){await s.reply(key,denied);return;}
      try {
        if(cmd==='/getdchat')await s.reserveChat(user);
        else {const launch=await s.launch(user);await s.reply(key,`MT TEST · ${user}\n3 попытки × 30 секунд. Начатая попытка расходуется даже при закрытии окна. Только ручной посимвольный ввод. Ссылка персональная и действует час.`,{reply_markup:{inline_keyboard:[[{text:'Открыть D-MT',url:'https:'+'//t.me/'+this.env.BOT_USERNAME+'?startapp='+launch}]]}});}
      }catch(e){if(e instanceof Conflict)await s.reply(key,e.message);else throw e;}
    });
  }
  async alarm() {
    const chat=await this.ctx.storage.get('chat');if(!chat||!settings(this.env).includes(chat))return;
    await this.ctx.storage.setAlarm(Date.now()+120000);
    try {
      await transaction(this.env,chat,async s=>{await s.recoverChat();await s.expire();await s.freeze();});
      const job=await transaction(this.env,chat,async s=>{
        const pace=await one(s.db,'SELECT value FROM titsbot.runtime WHERE key=$1',[`send:${chat}`]);
        const j=await one(s.db,"SELECT * FROM titsbot.outbox WHERE chat_id=$1 AND status='PENDING' AND next_run<=$2 AND lease_until<=$2 ORDER BY next_run,job_key LIMIT 1 FOR UPDATE SKIP LOCKED",[chat,s.time]);if(!j)return null;
        if(['message','go'].includes(j.kind)&&Number(pace?.value||0)+3.2>s.time){await s.db.query('UPDATE titsbot.outbox SET next_run=$1 WHERE job_key=$2',[Number(pace.value)+3.2,j.job_key]);return null;}
        j.lease_token=uid();await s.db.query('UPDATE titsbot.outbox SET lease_token=$1,lease_until=$2 WHERE job_key=$3',[j.lease_token,s.time+120,j.job_key]);return j;
      });
      // External HTTP runs OUTSIDE the transaction. MT events are not blocked by LLM latency.
      if(job)await this.deliver(chat,job);
      const next=await database(this.env,db=>one(db,`SELECT min(t) AS t FROM (
        SELECT ended_at+5 AS t FROM titsbot.chat_tests WHERE chat_id=$1 AND status='RUNNING'
        UNION ALL SELECT reserved_until FROM titsbot.chat_tests WHERE chat_id=$1 AND status='RESERVED'
        UNION ALL SELECT analysis_deadline FROM titsbot.chat_tests WHERE chat_id=$1 AND status='ANALYZING'
        UNION ALL SELECT ended_at+5.1 FROM titsbot.mt_attempts WHERE chat_id=$1 AND status='RUNNING'
        UNION ALL SELECT greatest(next_run,lease_until) FROM titsbot.outbox WHERE chat_id=$1 AND status='PENDING'
      ) q`,[chat]));
      // Keep a bounded idle watchdog; cron is a second recovery layer.
      await this.ctx.storage.setAlarm(next?.t!=null?Math.max(Date.now()+500,Number(next.t)*1000):Date.now()+60000);
    }catch(e){console.error('alarm_failed',{chat,kind:e.name});await this.ctx.storage.setAlarm(Date.now()+15000);}
  }
  async deliver(chat,j) {
    const p=j.payload;let result;
    try {
      if(j.kind==='message')result=await telegram(this.env,'sendMessage',p);
      else if(j.kind==='go') {
        const active=await database(this.env,db=>one(db,"SELECT 1 FROM titsbot.chat_tests WHERE test_id=$1 AND status='RESERVED'",[p.test_id]));
        if(active)result=await telegram(this.env,'sendMessage',{chat_id:chat,text:`GO · ${p.user_id}\n60 секунд. Пишите естественно и осмысленно. Тексты теста сохраняются и отправляются настроенному LLM. Не отправляйте личные данные.\nНачало теста — это сообщение.`});
      }else if(j.kind==='analyze') {
        const input=await transaction(this.env,chat,s=>s.analysisInput(p.test_id));if(input)result=await analyze(this.env,input);
      }else if(j.kind==='tag')await assignTag(this.env,p);
      else throw new Error('Unknown job');
      await transaction(this.env,chat,async s=>{
        const lease=await one(s.db,'SELECT lease_token FROM titsbot.outbox WHERE job_key=$1',[j.job_key]);if(lease?.lease_token!==j.lease_token)return;
        if(j.kind==='go'&&result)await s.activateChat(p.test_id,result);
        if(j.kind==='analyze'&&result)await s.completeChat(p.test_id,result);
        if(j.kind==='tag') {await s.db.query("UPDATE titsbot.users SET tag_status='ASSIGNED' WHERE chat_id=$1 AND user_id=$2",[chat,p.user_id]);await s.reply(`tag-ok:${chat}:${p.user_id}`,`Тег ${p.tag} назначен участнику ${p.user_id}. Административные права не выдавались.`);}
        if(['message','go'].includes(j.kind))await s.db.query('INSERT INTO titsbot.runtime VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[`send:${chat}`,json(s.time)]);
        await s.db.query('UPDATE titsbot.outbox SET status=$1,next_run=$2,lease_token=NULL,lease_until=0,last_error=NULL,attempts=0 WHERE job_key=$3',[j.kind==='tag'?'PENDING':'SENT',s.time+3600,j.job_key]);
      });
    }catch(e) {
      await transaction(this.env,chat,async s=>{
        const delay=Math.max(Math.min(3600,5*2**Math.min(j.attempts+1,10)),e.retryAfter||0);
        await s.db.query('UPDATE titsbot.outbox SET attempts=attempts+1,next_run=$1,lease_token=NULL,lease_until=0,last_error=$2 WHERE job_key=$3 AND lease_token=$4',[s.time+delay,e instanceof Conflict?'PermissionOrMembership':e.name,j.job_key,j.lease_token]);
        if(j.kind==='tag')await s.db.query("UPDATE titsbot.users SET tag_status='PENDING' WHERE chat_id=$1 AND user_id=$2",[chat,p.user_id]);
        if(j.attempts===0&&['analyze','tag'].includes(j.kind))await s.reply(`delay:${j.job_key}`,j.kind==='analyze'?'Проверка опечаток временно недоступна. Текст и WPM сохранены; выполняю ограниченные повторы. Повторно писать тест не нужно.':`D участника ${p.user_id} сохранён, но тег не назначен. Проверьте членство и право бота управлять тегами. Повтор автоматический.`);
      });console.error('delivery_retry',{kind:j.kind,error:e.name});
    }
  }
}
