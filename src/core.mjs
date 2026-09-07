import rules from '../config.json' with { type: 'json' };
export { rules };
export class Conflict extends Error { constructor(message, status = 409) { super(message); this.status = status; } }
export const now = () => Date.now() / 1000;
export const uid = () => crypto.randomUUID();
export const json = JSON.stringify;
export const clamp = (n, lo = 0, hi = 100) => { if (!Number.isFinite(n)) throw new Conflict('Non-finite metric'); return Math.max(lo, Math.min(hi, n)); };
export function validateRules(r) {
  for (const key of ['chat', 'mt']) {
    const w = Object.values(r[key].weights);
    if (w.some(x => typeof x !== 'number' || x < 0) || Math.abs(w.reduce((a,b)=>a+b,0)-1)>1e-9) throw new Error('Invalid weights');
  }
  if (r.mt.duration !== 30 || r.mt.attempts !== 3 || r.chat.duration !== 60 || r.chat.context_enabled) throw new Error('Unsupported protocol configuration');
  for(const key of ['absolute_lower_bounds','percentile_lower_bounds']) {
    const b=r.calibration[key]; if(b.length!==10 || b[0]!==0 || b.some((v,i)=>!Number.isFinite(v)||(i>0&&v<=b[i-1]))) throw new Error('Invalid tier bounds');
  }
  return r;
}
validateRules(rules);
export const words = text => text.normalize('NFKC').toLowerCase().replace(/ß/g,'ss').replace(/ς/g,'σ').match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || [];
export function consistency(values) {
  const mean = values.reduce((a,b)=>a+b,0)/values.length;
  return values.length < 2 || !(mean > 0) ? 0 : clamp(100*(1-Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/values.length)/mean));
}
export const weighted = (parts, weights) => clamp(Object.entries(weights).reduce((v,[k,w])=>v+clamp(parts[k])*w,0));
// Ratcliff/Obershelp matching blocks, like SequenceMatcher(autojunk=False).
export function similarity(left, right) {
  const a=[...left], b=[...right], queue=[[0,a.length,0,b.length]],positions=new Map(); let total=0;
  b.forEach((ch,j)=>{if(!positions.has(ch))positions.set(ch,[]);positions.get(ch).push(j);});
  while(queue.length) {
    const [al,ah,bl,bh]=queue.pop(); let ai=al,bi=bl,size=0,prev=new Map();
    for(let i=al;i<ah;i++) { const next=new Map(); for(const j of positions.get(a[i])||[]) {if(j<bl)continue;if(j>=bh)break;const n=(prev.get(j-1)||0)+1;next.set(j,n);if(n>size){ai=i-n+1;bi=j-n+1;size=n;}} prev=next; }
    if(size) {total+=size;if(al<ai&&bl<bi)queue.push([al,ai,bl,bi]);if(ai+size<ah&&bi+size<bh)queue.push([ai+size,ah,bi+size,bh]);}
  }
  return a.length+b.length ? 2*total/(a.length+b.length) : 1;
}
export function chatMetrics(rows, started, r=rules) {
  const c=r.chat, accepted=[], enriched=[], previous=[];let prev=started,burst=0,chars=0;
  for(const row of [...rows].sort((a,b)=>a.timestamp-b.timestamp||a.message_id-b.message_id)) {
    const x={...row}, tokens=words(x.text), norm=tokens.join(' '), actual=Math.max(0,x.timestamp-prev),effective=Math.max(c.interval_floor,Math.min(actual,c.interval_cap));
    let reason=x.exclusion;
    if(!reason) {
      if(!tokens.length)reason='no_words';
      else if([...x.text].length>c.max_message_chars)reason='too_long';
      else if(accepted.length>=c.max_messages||chars+[...x.text].length>c.max_total_chars)reason='test_limit';
      else if(previous.slice(-20).some(p=>norm===p||similarity(norm,p)>=c.duplicate_similarity))reason='duplicate';
    }
    Object.assign(x,{word_count:tokens.length,character_count:[...x.text].length,interval:actual,effective_interval:effective,burst_id:null,message_wpm:0,score_wpm:0,exclusion:reason||null});
    if(!reason) {if(!accepted.length||actual>c.burst_gap)burst++;Object.assign(x,{burst_id:burst,message_wpm:tokens.length*60/effective,score_wpm:Math.min(tokens.length*60/effective,c.message_wpm_cap)});accepted.push(x);previous.push(norm);prev=x.timestamp;chars+=x.character_count;}
    enriched.push(x);
  }
  const all=accepted.flatMap(x=>words(x.text)), rates=accepted.map(x=>x.score_wpm), sorted=[...rates].sort((a,b)=>a-b),n=rates.length,elapsed=accepted.reduce((v,x)=>v+x.effective_interval,0);
  return [{total_messages:n,total_words:all.length,total_characters:chars,observed_messages:rows.length,excluded_messages:rows.length-n,raw_chat_wpm:all.length*60/c.duration,interval_chat_wpm:elapsed?all.length*60/elapsed:0,median_chat_wpm:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:0,wpm_consistency:consistency(rates),word_diversity:all.length?100*new Set(all).size/all.length:0,bursts:burst,insufficient_data:n<c.min_messages||all.length<c.min_words},enriched];
}
export function chatScore(m,accuracy,r=rules) {
  const c=r.chat,parts={wpm:clamp(m[c.wpm_source]/c.wpm_max*100),accuracy,consistency:m.wpm_consistency,diversity:m.word_diversity};
  return [m.insufficient_data?0:weighted(parts,c.weights),parts];
}
export function tier(score,pool,r=rules) {
  const c=r.calibration;score=clamp(score,c.score_min,c.score_max);const relative=pool.length>=c.min_pool;
  const tie={midrank:.5,lower:0,upper:1}[c.tie_policy];
  const value=relative?100*(pool.filter(s=>s<score).length+pool.filter(s=>s===score).length*tie)/pool.length:score;
  const bounds=relative?c.percentile_lower_bounds:c.absolute_lower_bounds;
  return [Math.max(1,Math.min(10,bounds.filter(b=>value>=b).length)),{mode:relative?'relative':'absolute',pool_size:pool.length,rank_value:value,tie_policy:c.tie_policy,bounds}];
}
export const finalTag=(chat,mt)=>[(chat+mt)/2,`D-${(chat+mt)/2}`];
export function mtMetrics(events,prompt,r=rules) {
  const c=r.mt,buffer=[],target=[...prompt],bins=Array(Math.ceil(c.duration/c.bin_seconds)).fill(0);let inserted=0,correctInserted=0,errors=0,corrections=0,keys=0,last=-1;
  for(const e of events) {
    const t=e?.t;if(typeof t!=='number'||!Number.isFinite(t)||t<0||t>=c.duration*1000||t<last)throw new Conflict('Invalid event timestamp/order');last=t;
    if(e.kind==='key') {if(typeof e.key!=='string'||e.key.length>32)throw new Conflict('Invalid key');keys++;}
    else if(e.kind==='insert') {if(typeof e.char!=='string'||[...e.char].length!==1||/[\p{C}\p{Zl}\p{Zp}]/u.test(e.char)||(e.char!==' '&&/\p{Zs}/u.test(e.char)))throw new Conflict('Only single printable character input is supported');if(buffer.length>=target.length)throw new Conflict('Prompt exhausted');const ok=e.char===target[buffer.length];inserted++;correctInserted+=+ok;errors+=+!ok;buffer.push(e.char);bins[Math.min(bins.length-1,Math.floor(t/1000/c.bin_seconds))]+=+ok;}
    else if(e.kind==='delete') {if(buffer.length){corrections+=+(buffer.at(-1)!==target[buffer.length-1]);buffer.pop();}}
    else throw new Conflict('Unsupported event kind');
  }
  const correct=buffer.filter((v,i)=>v===target[i]).length,residual=buffer.length-correct,accuracy=inserted?100*correctInserted/inserted:0,quality=buffer.length?100*(1-residual/buffer.length):0,wpm=correct/5/(c.duration/60);
  const parts={wpm:clamp(wpm/c.wpm_max*100),accuracy,consistency:consistency(bins),quality};
  return {duration:c.duration,wpm,raw_wpm:inserted/5/(c.duration/60),accuracy,consistency:parts.consistency,quality,errors,corrections,remaining_errors:residual,inserted_characters:inserted,correct_characters:correct,key_presses:keys,first_event_ms:events[0]?.t??null,last_event_ms:events.length?last:null,score:inserted&&correct?weighted(parts,c.weights):0,components:parts};
}
const RU='время человек сегодня дорога город свет книга ветер слово работа новая мысль тёплый вечер после рядом важно просто можно утром завтра вместе читать писать видеть помнить хороший каждый воздух тихо снова быстро спокойно вопрос ответ окно музыка солнце река лес берег поле голос смысл начало конец рука место друг разговор история мир движение радость план выбор шаг путь день ночь облако дождь жизнь задача решение внимание память знание опыт идея чувство сила помощь случай результат встреча весна лето осень зима'.split(' ');
const EN='time people today road city light book wind word work new thought warm evening after near important simple morning tomorrow together read write see remember good every air quiet again fast calm question answer window music sun river forest shore field voice meaning start finish hand place friend story world motion joy plan choice step way day night cloud rain life task solution attention memory knowledge idea feeling help result meeting spring summer autumn winter'.split(' ');
export function prompt(language='ru') { const list=language==='en'?EN:RU;return Array.from(crypto.getRandomValues(new Uint32Array(600)),n=>list[n%list.length]).join(' '); }
export async function sha(text) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
export async function hmac(key,text) {const enc=new TextEncoder();const k=await crypto.subtle.importKey('raw',typeof key==='string'?enc.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode(text)));}
export function safeEqual(a,b) {if(typeof a!=='string'||typeof b!=='string')return false;let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
export async function authenticate(raw,token,time=now()) {
  if(typeof raw!=='string'||raw.length>16384)throw new Conflict('Invalid initData',401);
  const pairs=[...new URLSearchParams(raw)],data=Object.fromEntries(pairs);
  if(new Set(pairs.map(p=>p[0])).size!==pairs.length)throw new Conflict('Duplicate initData fields',401);
  const given=data.hash;delete data.hash;
  const check=Object.keys(data).sort().map(k=>`${k}=${data[k]}`).join('\n');
  const expected=Array.from(await hmac(await hmac('WebAppData',token),check),b=>b.toString(16).padStart(2,'0')).join('');
  if(!safeEqual(expected,given))throw new Conflict('Invalid Telegram signature',401);
  let user;try{user=JSON.parse(data.user);}catch{throw new Conflict('Invalid Telegram user',401);}
  const stamp=Number(data.auth_date);
  if(!Number.isInteger(stamp)||stamp>time+30||time-stamp>3600)throw new Conflict('Сессия истекла. Откройте Mini App заново.',401);
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0||user.is_bot)throw new Conflict('Invalid Telegram user',401);
  return {user:user.id,launch:data.start_param||''};
}
export function validateAnalysis(value) {
  if(!value||Object.keys(value).sort().join(',')!=='accuracy,context_relevance,quality,reasoning')throw new Error('LLM schema mismatch');
  for(const k of ['accuracy','quality','context_relevance'])if(typeof value[k]!=='number'||!Number.isFinite(value[k])||value[k]<0||value[k]>100)throw new Error('Invalid LLM score');
  if(typeof value.reasoning!=='string'||value.reasoning.length>2000)throw new Error('Invalid LLM reasoning');return value;
}
