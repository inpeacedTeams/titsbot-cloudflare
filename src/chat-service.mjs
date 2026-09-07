import {Service,one,rows,enqueue} from './service.mjs';
import {uid,json,Conflict,chatScore} from './core.mjs';
import {CHAT_METHOD,measureChat} from './chat-method.mjs';
export class ChatService extends Service {
  async stopJob(key){await this.db.query("UPDATE titsbot.outbox SET status='FAILED',lease_token=NULL,lease_until=0 WHERE job_key=$1 AND status='PENDING'",[key]);}
  async recoverChat(){
    for(const t of await rows(this.db,"SELECT * FROM titsbot.chat_tests WHERE chat_id=$1 AND status='RESERVED' AND coalesce(reserved_until,created_at+30)<=$2",[this.chat,this.time])){
      await this.db.query("UPDATE titsbot.chat_tests SET status='CANCELLED' WHERE test_id=$1",[t.test_id]);await this.stopJob(`go:${t.test_id}`);
      await this.reply(`start-timeout:${t.test_id}:${t.created_at}`,`Не удалось начать Chat Test участника ${t.user_id} за 30 секунд. Попытка не потрачена. Повторите /getdchat. Позднее сообщение GO для отменённого запуска не действует.`);
    }
    for(const t of await rows(this.db,"SELECT t.* FROM titsbot.chat_tests t LEFT JOIN titsbot.outbox o ON o.job_key='analyze:'||t.test_id WHERE t.chat_id=$1 AND t.status='ANALYZING' AND (t.analysis_deadline<=$2 OR o.attempts>=3)",[this.chat,this.time]))await this.failAnalysis(t.test_id);
  }
  async failAnalysis(id,reason='Сервис проверки не ответил вовремя.'){
    const t=await one(this.db,"UPDATE titsbot.chat_tests SET status='ANALYSIS_FAILED' WHERE test_id=$1 AND chat_id=$2 AND status='ANALYZING' RETURNING *",[id,this.chat]);if(!t)return;
    if(t.metrics?.methodology!==CHAT_METHOD&&t.started_at!=null&&t.ended_at!=null){t.metrics=await this.calculateChat(t);await this.db.query('UPDATE titsbot.chat_tests SET metrics=$1 WHERE test_id=$2',[json(t.metrics),id]);}
    await this.stopJob(`analyze:${id}`);
    await this.reply(`analysis-failed:${id}:${t.analysis_deadline}`,`Chat Test · ${t.user_id}\n${reason}\nWPM: ${Number(t.metrics?.chat_wpm||0).toFixed(2)}\nAccuracy: недоступна. Текст сохранён; D пока не назначен. /getdchat повторит только анализ, без новой минуты набора.`);
  }
  async reserveChat(user){
    await this.recoverChat();await this.freeze();const u=await this.user(user,true),old=await one(this.db,'SELECT * FROM titsbot.chat_tests WHERE chat_id=$1 AND user_id=$2',[this.chat,user]);
    if(u.initial_chat_d!==null||u.calibration_completed_at!==null||old?.status==='DONE')throw new Conflict('Chat Test уже пройден. Завершённый результат не изменяется.');
    if(old?.status==='ANALYSIS_FAILED'){
      await this.db.query("UPDATE titsbot.chat_tests SET status='ANALYZING',analysis_deadline=$1 WHERE test_id=$2",[this.time+120,old.test_id]);
      await this.db.query("UPDATE titsbot.outbox SET status='PENDING',attempts=0,next_run=$1,lease_until=0,lease_token=NULL,last_error=NULL WHERE job_key=$2",[this.time,`analyze:${old.test_id}`]);
      await this.reply(`analysis-restart:${old.test_id}:${this.time}`,'Повторяю проверку сохранённого текста. Заново писать минуту не нужно.');return old.test_id;
    }
    if(old?.status==='ANALYZING')throw new Conflict(`Твой текст уже проверяется. На эту серию запросов осталось до ${Math.max(1,Math.ceil(old.analysis_deadline-this.time))} с. Новая попытка не нужна.`);
    const busy=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE chat_id=$1 AND status IN ('RESERVED','RUNNING')",[this.chat]);
    if(busy){const text=busy.status==='RESERVED'?`Сейчас готовится другой Chat Test: ожидание старта — до ${Math.max(1,Math.ceil((busy.reserved_until||busy.created_at+30)-this.time))} с, затем 60 с теста и 5 с на доставку.`:`Chat Test занят. Повтори команду примерно через ${Math.max(1,Math.ceil(busy.ended_at+5-this.time))} с (включая доставку последних сообщений).`;throw new Conflict(text+' Твоя новая попытка не потрачена.');}
    const id=old?.test_id||uid();
    if(old){await this.db.query('DELETE FROM titsbot.chat_messages WHERE test_id=$1',[id]);await this.db.query("UPDATE titsbot.chat_tests SET status='RESERVED',created_at=$1,reserved_until=$2,started_at=NULL,ended_at=NULL,go_message_id=NULL,metrics=NULL,analysis_deadline=NULL WHERE test_id=$3",[this.time,this.time+30,id]);await this.db.query("UPDATE titsbot.outbox SET status='PENDING',attempts=0,next_run=$1,lease_until=0,lease_token=NULL,last_error=NULL WHERE job_key=$2",[this.time,`go:${id}`]);}
    else{await this.db.query('INSERT INTO titsbot.chat_tests(test_id,chat_id,user_id,created_at,reserved_until) VALUES($1,$2,$3,$4,$5)',[id,this.chat,user,this.time,this.time+30]);await enqueue(this.db,this.chat,`go:${id}`,'go',{test_id:id,user_id:user});}
    return id;
  }
  async activateChat(id,message){
    const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE test_id=$1 AND chat_id=$2 AND status='RESERVED'",[id,this.chat]);if(!t)return;
    if(message.date>t.reserved_until||this.time>t.reserved_until){await this.recoverChat();return;}
    await super.activateChat(id,message);
  }
  async ingest(m,edited=false){
    const text=typeof m.text==='string'?m.text:typeof m.caption==='string'?m.caption:null;
    if(text===null||!m.from?.id||m.from.is_bot||m.sender_chat)return;
    if(edited){await this.db.query("UPDATE titsbot.chat_messages m SET edited_seen=true FROM titsbot.chat_tests t WHERE m.test_id=t.test_id AND t.chat_id=$1 AND t.user_id=$2 AND m.message_id=$3 AND t.status IN ('RESERVED','RUNNING')",[this.chat,m.from.id,m.message_id]);return;}
    const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE chat_id=$1 AND status IN ('RESERVED','RUNNING')",[this.chat]);if(!t||String(t.user_id)!==String(m.from.id))return;
    if(t.status==='RUNNING'&&(!(m.date>=t.started_at&&m.date<t.ended_at)||m.message_id<=Number(t.go_message_id)))return;
    if(t.status==='RESERVED'&&m.date<t.created_at)return;
    await this.db.query('INSERT INTO titsbot.chat_messages(test_id,message_id,timestamp,received_at,text,exclusion) VALUES($1,$2,$3,$4,$5,NULL) ON CONFLICT DO NOTHING',[t.test_id,m.message_id,m.date,this.time,text]);
  }
  async calculateChat(t){
    const messages=await rows(this.db,'SELECT * FROM titsbot.chat_messages WHERE test_id=$1 ORDER BY timestamp,message_id',[t.test_id]);
    for(const m of messages)m.exclusion=m.timestamp<t.started_at||m.timestamp>=t.ended_at||Number(m.message_id)<=Number(t.go_message_id)?'before_start':null;
    const [metrics,enriched]=measureChat(messages,t.started_at,t.ended_at-t.started_at);
    for(const m of enriched)await this.db.query('UPDATE titsbot.chat_messages SET exclusion=$1 WHERE test_id=$2 AND message_id=$3',[m.exclusion,t.test_id,m.message_id]);
    return metrics;
  }
  async freeze(){
    for(const t of await rows(this.db,"SELECT * FROM titsbot.chat_tests WHERE chat_id=$1 AND status='RUNNING' AND ended_at+5<=$2",[this.chat,this.time])){
      const metrics=await this.calculateChat(t);
      await this.db.query("UPDATE titsbot.chat_tests SET status='ANALYZING',metrics=$1,analysis_deadline=$2 WHERE test_id=$3",[json(metrics),this.time+120,t.test_id]);
      await enqueue(this.db,this.chat,`analyze:${t.test_id}`,'analyze',{test_id:t.test_id});
      await this.reply(`wait:${t.test_id}`,`Chat Test · ${t.user_id} завершён. WPM: ${metrics.chat_wpm.toFixed(2)}. Проверяю только опечатки; место для следующего Chat Test свободно.`);
    }
  }
  async analysisInput(id){
    await this.recoverChat();const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE test_id=$1 AND chat_id=$2 AND status='ANALYZING'",[id,this.chat]);if(!t)return null;
    if(t.metrics?.methodology!==CHAT_METHOD){t.metrics=await this.calculateChat(t);await this.db.query('UPDATE titsbot.chat_tests SET metrics=$1 WHERE test_id=$2',[json(t.metrics),id]);}
    const messages=await rows(this.db,"SELECT message_id,text FROM titsbot.chat_messages WHERE test_id=$1 AND exclusion IS NULL ORDER BY timestamp,message_id",[id]);return {messages,metrics:t.metrics,methodology:CHAT_METHOD};
  }
  async completeChat(id,analysis){
    const t=await one(this.db,"SELECT * FROM titsbot.chat_tests WHERE test_id=$1 AND chat_id=$2 AND status='ANALYZING'",[id,this.chat]);if(!t)return;
    if(this.time>=t.analysis_deadline){await this.failAnalysis(id);return;}
    if(analysis.accuracy===null){await this.failAnalysis(id,'В сохранённом тексте нет букв: проверить опечатки невозможно.');return;}
    if(!Number.isFinite(analysis.accuracy)||analysis.accuracy<0||analysis.accuracy>100)throw new Error('InvalidChatAccuracy');
    const u=await this.user(t.user_id),config={...u.config,chat:{...u.config.chat,wpm_source:'chat_wpm'}},[score,parts]=chatScore(t.metrics,analysis.accuracy,config),[d,snapshot]=await this.assignTier(t.user_id,score,'chat',config);
    Object.assign(snapshot,{methodology:CHAT_METHOD,accuracy_kind:analysis.accuracy_kind,wpm_formula:'all graphemes / 5 / minutes',wpm_source:'chat_wpm'});
    await this.db.query('INSERT INTO titsbot.analysis VALUES($1,$2,$3)',[id,json(analysis),this.time]);
    await this.db.query("UPDATE titsbot.chat_tests SET status='DONE',score=$1,components=$2 WHERE test_id=$3",[score,json(parts),id]);
    await this.db.query('UPDATE titsbot.users SET initial_chat_score=$1,initial_chat_d=$2,chat_snapshot=$3 WHERE chat_id=$4 AND user_id=$5',[score,d,json(snapshot),this.chat,t.user_id]);
    const m=t.metrics,examples=(analysis.typos||[]).slice(0,5).map(t=>`${t.original} → ${t.correction}`).join('; ');
    await this.reply(`chat-result:${id}`,`CHAT TEST · ${t.user_id}\nWPM: ${m.chat_wpm.toFixed(2)}\nAccuracy (оценка опечаток): ${analysis.accuracy.toFixed(2)}%\nСимволов: ${m.total_characters} · Слов: ${m.total_words} · Сообщений: ${m.total_messages}\nПредполагаемых исправлений: ${analysis.typo_edits??0}\nРитм отправки: ${m.wpm_consistency.toFixed(2)}% · Разнообразие: ${m.word_diversity.toFixed(2)}%\nДлинных повторов: ${m.long_repeat_messages} (не вычитаются из WPM)\nScore: ${score.toFixed(2)} · Chat D-${d}${examples?'\nОпечатки: '+examples:''}\nМетодика: ${CHAT_METHOD}. Грамматика, пунктуация и смысл не штрафуются.`);
    await this.finalize(t.user_id);
  }
}
