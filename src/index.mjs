import {Conflict,authenticate,sha,safeEqual,now,json} from './core.mjs';
import {database} from './db.mjs';
import {one} from './service.mjs';
import {telegram,settings,commands} from './remote.mjs';
export {ChatCoordinator} from './coordinator.mjs';
export const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'"};
export const response=(body,status=200)=>Response.json(body,{status,headers:security});
export function error(e) {if(e instanceof Conflict)return response({error:e.message},e.status);console.error('request_failed',{kind:e.name||'Error',code:/^[A-Z0-9]{5}$/.test(e.code||'')?e.code:undefined});return response({error:'Временная ошибка сервера. Повторите запрос.'},503);}
async function readJSON(req) {
  if(!(req.headers.get('content-type')||'').startsWith('application/json'))throw new Conflict('Use application/json',415);
  const reader=req.body?.getReader();if(!reader)throw new Conflict('Empty request',400);let size=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>131072){await reader.cancel();throw new Conflict('Request body limit exceeded',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw new Conflict('Invalid JSON',400);}
}
function dispatch(env,chat,data){const stub=env.CHAT_COORDINATOR.get(env.CHAT_COORDINATOR.idFromName(String(chat)));return stub.fetch('https:'+'//coordinator.internal/',{method:'POST',body:json({chat:String(chat),...data})});}
export async function synchronize(env,force=false) {
  const chats=settings(env),fingerprint=await sha(json([env.BOT_TOKEN,env.BOT_USERNAME,env.PUBLIC_URL,env.WEBHOOK_SECRET,chats,commands]));
  const old=await database(env,db=>one(db,"SELECT value FROM titsbot.runtime WHERE key='telegram_setup'"));
  if(!force&&old?.value?.fingerprint===fingerprint&&now()-old.value.at<86400)return {ok:true,cached:true};
  const me=await telegram(env,'getMe');if(me.username.toLowerCase()!==env.BOT_USERNAME.toLowerCase())throw new Error('BOT_USERNAME does not match token');
  await telegram(env,'setMyCommands',{commands});
  const url=new URL('/telegram/webhook',env.PUBLIC_URL).href;
  await telegram(env,'setWebhook',{url,secret_token:env.WEBHOOK_SECRET,allowed_updates:['message','edited_message','chat_member','my_chat_member'],max_connections:10,drop_pending_updates:false});
  const info=await telegram(env,'getWebhookInfo');if(info.url!==url)throw new Error('Webhook verification failed');
  await database(env,db=>db.query("INSERT INTO titsbot.runtime VALUES('telegram_setup',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[json({fingerprint,at:now(),username:me.username})]));
  return {ok:true,username:me.username,webhook:info.url,commands:commands.map(c=>c.command)};
}
export default {
  async fetch(req,env) {
    try {
      const path=new URL(req.url).pathname;
      if(path==='/healthz')return response({ok:true,service:'titsbot',version:'2.0.0'});
      if(path==='/readyz') {settings(env);const r=await database(env,db=>one(db,"SELECT value FROM titsbot.runtime WHERE key='schema_version'"));if(r?.value!==1)throw new Error('Schema not installed');return response({ok:true,database:true});}
      if(path==='/admin/setup') {
        if(req.method!=='POST')throw new Conflict('Use POST',405);
        if(!env.WEBHOOK_SECRET||!safeEqual(req.headers.get('authorization'),`Bearer ${env.WEBHOOK_SECRET}`))throw new Conflict('Unauthorized',401);
        return response(await synchronize(env,true));
      }
      if(path==='/telegram/webhook') {
        if(req.method!=='POST')throw new Conflict('Use POST',405);
        if(!env.WEBHOOK_SECRET||!safeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.WEBHOOK_SECRET))throw new Conflict('Unauthorized',401);
        const allowed=settings(env),u=await readJSON(req),chat=u.message?.chat?.id??u.edited_message?.chat?.id??u.chat_member?.chat?.id??u.my_chat_member?.chat?.id;
        if(!Number.isSafeInteger(u.update_id)||u.update_id<0)throw new Conflict('Invalid update',400);
        if(!allowed.includes(String(chat)))return response({ok:true});
        return await dispatch(env,chat,{kind:'update',update:u});
      }
      if(path.startsWith('/api/')) {
        if(req.method!=='POST')throw new Conflict('Use POST',405);
        if(!['/api/status','/api/mt/start','/api/mt/events','/api/mt/finish','/api/mt/abort'].includes(path))throw new Conflict('Not found',404);
        const allowed=settings(env),p=await readJSON(req),auth=await authenticate(p.init_data,env.BOT_TOKEN),hash=await sha(auth.launch);
        const launch=await database(env,db=>one(db,'SELECT chat_id FROM titsbot.launch_tokens WHERE token_hash=$1 AND user_id=$2 AND expires_at>extract(epoch from clock_timestamp())',[hash,auth.user]));
        if(!launch||!allowed.includes(String(launch.chat_id)))throw new Conflict('Ссылка истекла. Вызовите /getDmt в группе.',401);
        return await dispatch(env,launch.chat_id,{kind:'api',path,payload:p,user:auth.user,launch:auth.launch});
      }
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(path)) {const asset=await env.ASSETS.fetch(req),out=new Response(asset.body,asset);for(const [k,v]of Object.entries(security))out.headers.set(k,v);return out;}
      return response({error:'Not found'},404);
    }catch(e){return error(e);}
  },
  async scheduled(event,env) {
    try {
      const chats=settings(env);
      await Promise.allSettled([synchronize(env).catch(e=>console.error('telegram_setup_failed',{kind:e.name})),...chats.map(async chat=>{const r=await dispatch(env,chat,{kind:'kick'});if(!r.ok)console.error('coordinator_kick_failed',{chat});})]);
      await database(env,async db=>{
        await db.query('DELETE FROM titsbot.launch_tokens WHERE expires_at<extract(epoch from clock_timestamp())-86400');
        await db.query('DELETE FROM titsbot.processed_updates WHERE created_at<extract(epoch from clock_timestamp())-604800');
        await db.query('DELETE FROM titsbot.rate_limits WHERE window_start<floor(extract(epoch from clock_timestamp())/60)-5');
      });
    }catch(e){console.error('cron_failed',{kind:e.name});}
  }
};
