'use strict';
const $ = id => document.getElementById(id);
const tg=window.Telegram?.WebApp;
let initData=tg?.initData || '', run=null, startKey=null, cache=null, retryAction=null;
let pending=[],seq=0,flushPromise=null,stopAt=0,startedAt=0,raf=null,typed='',inserted=0,correctInserted=0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);}
async function api(path,data={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);
  try{
    const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:initData,...data}),signal:controller.signal});
    const body=await response.json();if(!response.ok){const e=new Error(body.error||'Ошибка сервера');e.status=response.status;throw e;}return body;
  }finally{clearTimeout(timer);}
}
function retryWith(fn){retryAction=fn;$('retry').hidden=false;}
$('retry').onclick=async()=>{$('retry').hidden=true;try{await retryAction();}catch(e){notice(e.message,true);$('retry').hidden=false;}};
function showStatus(s){
  document.body.classList.toggle('completed',!!s.mt_d);
  cache=s;$('wpm-weight').textContent=Math.round(s.mt_wpm_weight*100)+'%';$('chat-state').textContent=s.chat_d?`D-${s.chat_d} · готово`:'Ожидает /getDchat';
  $('mt-state').textContent=s.mt_d?`D-${s.mt_d} · готово`:`${s.attempts.filter(a=>a.status!=='RUNNING').length} из 3 попыток`;
  $('final-tier').textContent=s.tag||'—';$('tier-note').textContent=s.tag?'Зафиксирован навсегда':'После двух тестов';
  $('tag-state').textContent=s.tag_status==='ASSIGNED'?'Тег назначен':s.tag?'Тег в очереди':'Ожидает результатов';
  const scores=s.attempts.filter(a=>a.status!=='RUNNING'),best=scores.length?Math.max(...scores.map(a=>a.score)):null;
  $('attempts').replaceChildren(...[0,1,2].map(i=>{
    const a=s.attempts[i],el=document.createElement('article'),n=document.createElement('p'),v=document.createElement('strong'),sub=document.createElement('span');
    n.textContent=`0${i+1}`;v.textContent=a&&a.status!=='RUNNING'?Number(a.score).toFixed(1):'—';
    sub.textContent=!a?'Ещё не начата':a.status==='RUNNING'?'Идёт попытка':a.status==='DONE'?`${a.metrics.wpm.toFixed(1)} WPM · ${a.metrics.accuracy.toFixed(0)}%`:'0 · попытка потрачена';
    if(a&&a.status!=='RUNNING'&&a.score===best)el.classList.add('best');el.append(n,v,sub);return el;
  }));
  const active=s.attempts.find(a=>a.status==='RUNNING');
  if(!run){
    $('start').disabled=!!active||s.attempts.length>=3||!!s.mt_d;
    $('start').textContent=s.mt_d?'MT завершён':active?'Попытка уже идёт':s.attempts.length>=3?'Попытки использованы':`Начать попытку ${s.attempts.length+1} ↗`;
    $('attempt-label').textContent=`ПОПЫТКА ${Math.min(3,s.attempts.length+1)} / 3`;
    if(active)notice('Активная попытка открыта в другом окне или прервана перезагрузкой. Новая станет доступна после её окончания.');
    else if(s.mt_d)notice(s.final_d?'Оба теста завершены. D больше не изменится.':'MT завершён. Пройди /getDchat в группе, чтобы получить Final D.');
    else notice('Готово. После нажатия будет отсчёт 3–2–1.');
  }
}
async function refresh(){showStatus(await api('status'));}
function drawPrompt(){
  if(!run)return;
  const fragment=document.createDocumentFragment();
  for(let i=Math.max(0,typed.length-80);i<Math.min(run.prompt.length,typed.length+550);i++){
    const span=document.createElement('span');span.textContent=run.prompt[i];
    if(i<typed.length)span.className=typed[i]===run.prompt[i]?'correct':'wrong';else if(i===typed.length)span.className='cursor';
    fragment.append(span);
  }
  $('prompt').replaceChildren(fragment);$('prompt').classList.remove('idle');
  const cursor=$('prompt').querySelector('.cursor');
  if(cursor)$('prompt').scrollTop=Math.max(0,cursor.offsetTop-$('prompt').offsetTop-70);
}
function add(event){const t=performance.now()-startedAt;if(t>=0&&t<30000)pending.push({t:Math.round(t*100)/100,...event});}
async function flush(){
  if(flushPromise)return flushPromise;
  flushPromise=(async()=>{
    while(pending.length){
      const events=pending.slice(0,250),thisSeq=seq;let done=false;
      for(let retry=0;retry<3&&!done;retry++){
        try{await api('mt/events',{attempt_id:run.attempt_id,seq:thisSeq,events});done=true;}
        catch(e){if(e.status&&e.status<500)throw e;if(retry===2)throw e;await sleep(150);}
      }
      pending.splice(0,events.length);seq++;
    }
  })();
  try{await flushPromise;}finally{flushPromise=null;}
}
async function endTest(){
  if(!run||run.ending)return;run.ending=true;$('typing').disabled=true;cancelAnimationFrame(raf);
  $('timer').textContent='0';$('timer-unit').textContent='секунд';notice('Сохраняем события и проверяем результат…');
  const finish=async()=>{
    await flush();
    // Finish cannot shorten the server-authoritative window.
    let result;
    for(let i=0;i<6;i++){
      try{result=await api('mt/finish',{attempt_id:run.attempt_id});break;}
      catch(e){if(i<5&&e.message.includes('ещё не истекли'))await sleep(150);else throw e;}
    }
    run=null;document.body.classList.remove('running');startKey=null;await refresh();
    notice(`Сохранено: ${result.wpm.toFixed(1)} WPM · Accuracy ${result.accuracy.toFixed(1)}% · Score ${result.score.toFixed(1)}. Итог рассчитывает сервер.`);
  };
  try{await finish();}catch(e){notice(e.message,true);retryWith(finish);}
}
async function abortTest(reason){
  if(!run||run.ending)return;run.ending=true;$('typing').disabled=true;cancelAnimationFrame(raf);
  try{await api('mt/abort',{attempt_id:run.attempt_id});}catch(e){/* server expires this consumed attempt independently */}
  if(flushPromise)try{await flushPromise;}catch(e){}
  run=null;pending=[];startKey=null;document.body.classList.remove('running');notice(reason+' Попытка потрачена, Score = 0.',true);
  try{await refresh();notice(reason+' Попытка потрачена, Score = 0.',true);}catch(e){retryWith(refresh);}
}
function tick(){
  if(!run||run.ending)return;
  const now=performance.now();
  if(now<startedAt){$('timer').textContent=Math.ceil((startedAt-now)/1000);$('timer-unit').textContent='до старта';}
  else{
    if($('typing').disabled){$('typing').disabled=false;$('typing').focus();notice('GO. Печатай текст выше.');}
    $('timer').textContent=Math.max(0,Math.ceil((stopAt-now)/1000));$('timer-unit').textContent='секунд';
    const correct=[...typed].filter((c,i)=>c===run.prompt[i]).length;
    $('live-wpm').textContent=(correct/5/Math.max((now-startedAt)/60000,1/60)).toFixed(0);
    $('live-accuracy').textContent=inserted?`${(correctInserted/inserted*100).toFixed(0)}%`:'—';
    if(now>=stopAt){endTest();return;}
  }
  raf=requestAnimationFrame(tick);
}
$('start').onclick=async()=>{
  $('start').disabled=true;
  startKey=startKey||crypto.randomUUID();
  const start=async()=>{
    const before=performance.now();const response=await api('mt/start',{request_id:startKey});const after=performance.now();
    if(response.status!=='RUNNING'){startKey=null;await refresh();return;}
    run=response;pending=[];seq=0;typed='';inserted=0;correctInserted=0;$('typing').value='';$('typing').disabled=true;
    startedAt=(before+after)/2+(run.started_at-run.server_now)*1000;stopAt=startedAt+30000;
    document.body.classList.add('running');$('test-title').textContent='Печатай в своём темпе';$('attempt-label').textContent=`ПОПЫТКА ${run.ordinal} / 3`;
    drawPrompt();$('retry').hidden=true;tick();
  };
  try{await start();}catch(e){notice(e.message,true);retryWith(start);}
};
$('typing').addEventListener('keydown',e=>{
  if(!run||run.ending||performance.now()<startedAt||performance.now()>=stopAt)return;
  if(e.ctrlKey||e.metaKey||e.altKey||['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Delete','Enter','Tab'].includes(e.key)){e.preventDefault();return;}
  add({kind:'key',key:e.key.slice(0,32)});
});
$('typing').addEventListener('beforeinput',e=>{
  if(!run||run.ending)return;
  if(!['insertText','deleteContentBackward'].includes(e.inputType)||e.isComposing||(e.data&&[...e.data].length!==1)){
    e.preventDefault();abortTest('Вставка, автозамена или IME не поддерживаются.');
  }
});
$('typing').addEventListener('input',()=>{
  if(!run||run.ending)return;
  if(performance.now()<startedAt||performance.now()>=stopAt){$('typing').value=typed;return;}
  const value=$('typing').value;
  if(value.startsWith(typed)&&[...value].length===[...typed].length+1){
    const ch=[...value].at(-1);add({kind:'insert',char:ch});inserted++;correctInserted+=Number(ch===run.prompt[typed.length]);
  }else if(typed.startsWith(value)&&[...value].length===[...typed].length-1){add({kind:'delete'});}
  else{$('typing').value=typed;abortTest('Обнаружен неподдерживаемый ввод.');return;}
  typed=value;drawPrompt();
});
for(const type of ['paste','drop'])$('typing').addEventListener(type,e=>{e.preventDefault();abortTest('Вставка текста запрещена.');});
$('typing').addEventListener('select',()=>{if(run)$('typing').setSelectionRange($('typing').value.length,$('typing').value.length);});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&run)abortTest('Окно теста было скрыто.');});
setInterval(()=>{if(run&&!run.ending&&pending.length)flush().catch(e=>abortTest('Не удалось передать события вовремя.'));},500);
setInterval(()=>{if(!run&&initData)refresh().catch(()=>{});},4000);
if(tg){tg.ready();tg.expand();}
if(!initData){$('start').textContent='Открой через Telegram';notice('Открой персональную кнопку из /getDmt в группе. В обычном браузере тест не запускается.',true);}
else refresh().catch(e=>{notice(e.message,true);retryWith(refresh);});
