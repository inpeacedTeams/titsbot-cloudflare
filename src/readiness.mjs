// Only fixed diagnostic labels are returned. Never expose raw errors or secret values.
const required=['BOT_TOKEN','BOT_USERNAME','WEBHOOK_SECRET','PUBLIC_URL','ALLOWED_CHAT_IDS','LLM_BASE_URL','LLM_API_KEY','LLM_MODEL'];
const fail=(stage,reason,hint,extra={})=>({status:503,body:{ok:false,stage,reason,hint,...extra}});
export function configurationIssue(env) {
  for(const field of required) {
    const value=env[field];
    if(typeof value!=='string'||!value.trim())return fail('configuration','MISSING_SETTING','Добавьте настройку или секрет в Cloudflare и повторите deploy.',{field});
    if(value.includes('REPLACE')||value.includes('YOUR-SUBDOMAIN'))return fail('configuration','PLACEHOLDER_SETTING','Замените заглушку в настройке и повторите deploy.',{field});
  }
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN))return fail('configuration','INVALID_BOT_TOKEN','Проверьте формат токена: без кавычек, пробелов и префикса bot.',{field:'BOT_TOKEN'});
  if(!/^\w+$/.test(env.BOT_USERNAME))return fail('configuration','INVALID_BOT_USERNAME','Укажите username без @ и пробелов.',{field:'BOT_USERNAME'});
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET))return fail('configuration','INVALID_WEBHOOK_SECRET','Нужны 32–256 символов: латинские буквы, цифры, _ или -. Без кавычек и пробелов.',{field:'WEBHOOK_SECRET'});
  try {
    const u=new URL(env.PUBLIC_URL);
    if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw new Error();
  }catch{return fail('configuration','INVALID_PUBLIC_URL','Укажите полный HTTPS-адрес Worker без пути, query и fragment.',{field:'PUBLIC_URL'});}
  const chats=env.ALLOWED_CHAT_IDS.split(',').map(s=>s.trim());
  if(chats.length>32||chats.some(s=>!/^-[1-9]\d*$/.test(s)||!Number.isSafeInteger(Number(s))))return fail('configuration','INVALID_CHAT_IDS','Укажите 1–32 отрицательных ID групп через запятую.',{field:'ALLOWED_CHAT_IDS'});
  if(!env.DATABASE_URL&&!env.HYPERDRIVE?.connectionString)return fail('database_binding','MISSING_DATABASE_BINDING','Подключите Hyperdrive с именем HYPERDRIVE и повторите deploy.');
  return null;
}
export async function readiness(env,connect) {
  const issue=configurationIssue(env);if(issue)return issue;
  let stage='database_connection';
  try {
    return await connect(env,async db=>{
      stage='schema_check';
      const result=await db.query("SELECT value FROM titsbot.runtime WHERE key='schema_version'");
      if(result.rows[0]?.value!==1)return fail(stage,'SCHEMA_NOT_INSTALLED','Проверьте, что миграция полностью выполнена именно в базе, подключённой к Hyperdrive.');
      await db.query('SELECT window_start FROM titsbot.rate_limits LIMIT 0');
      await db.query('SELECT reserved_until,analysis_deadline FROM titsbot.chat_tests LIMIT 0');
      return {status:200,body:{ok:true,database:true}};
    });
  }catch(e) {
    const reasons={
      '28P01':['DB_AUTH_FAILED','Проверьте пароль роли PostgreSQL в настройке Hyperdrive.'],
      '28000':['DB_AUTH_FAILED','Проверьте роль PostgreSQL и её право LOGIN в Hyperdrive.'],
      '42501':['DB_PERMISSION_DENIED','Проверьте GRANT и RLS-политики из scripts/create-db-role.sql.'],
      '42P01':['DB_TABLE_MISSING','В подключённой базе отсутствует нужная таблица. Проверьте выполнение миграции.'],
      '3F000':['DB_SCHEMA_MISSING','В подключённой базе отсутствует схема titsbot. Проверьте миграцию.'],
      '42703':['DB_COLUMN_MISSING','Выполните миграцию 002_chat_v2.sql; также проверьте rate_limits.window_start.'],
      '3D000':['DB_DATABASE_MISSING','Проверьте имя базы в Hyperdrive; обычно это postgres.'],
      '53300':['DB_TOO_MANY_CONNECTIONS','Достигнут лимит соединений PostgreSQL. Проверьте нагрузку и пул.'],
      '57014':['DB_QUERY_TIMEOUT','Запрос к базе превысил допустимое время.'],
      'ENOTFOUND':['DB_DNS_ERROR','Проверьте hostname базы в Hyperdrive.'],
      'ECONNREFUSED':['DB_CONNECTION_REFUSED','Проверьте host, port и доступность базы.'],
      'ETIMEDOUT':['DB_CONNECTION_TIMEOUT','Проверьте доступность Supabase и сетевые ограничения.'],
      'ECONNRESET':['DB_CONNECTION_RESET','Соединение сброшено. Проверьте Hyperdrive, Supabase и TLS.']
    };
    let pair=reasons[e?.code];
    if(!pair&&/timeout|timed out/i.test(String(e?.message)))pair=['DB_TIMEOUT','Истекло время ожидания. Проверьте Hyperdrive и доступность Supabase.'];
    if(!pair&&/connection terminated/i.test(String(e?.message)))pair=['DB_CONNECTION_TERMINATED','Соединение закрыто. Проверьте настройки Hyperdrive, TLS и Supabase.'];
    if(!pair&&/certificate|\bTLS\b|\bSSL\b/i.test(String(e?.message)))pair=['DB_TLS_ERROR','Проверьте защищённое подключение Hyperdrive к PostgreSQL. Не отключайте проверку сертификатов.'];
    pair ||= ['DB_ERROR','Проверьте подключение Hyperdrive к нужной базе Supabase.'];
    return fail(stage,pair[0],pair[1],reasons[e?.code]?{code:e.code}:{});
  }
}
