import {words,consistency,similarity} from './core.mjs';
export const CHAT_METHOD='chat-typos-v2';
export const graphemes=text=>Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)).length;
export function measureChat(messages,started,duration=60){
  const list=[...messages].sort((a,b)=>a.timestamp-b.timestamp||Number(a.message_id)-Number(b.message_id));
  const bins=Array(Math.ceil(duration/10)).fill(0),allWords=[],long=[];let chars=0,repeats=0;
  const enriched=list.map(row=>{const m={...row},inside=m.timestamp>=started&&m.timestamp<started+duration&&!['before_start'].includes(m.exclusion);
    if(!inside){m.exclusion='before_start';return m;}
    m.exclusion=null;m.character_count=graphemes(m.text);m.word_count=words(m.text).length;chars+=m.character_count;allWords.push(...words(m.text));bins[Math.min(bins.length-1,Math.floor((m.timestamp-started)/10))]+=m.character_count;
    const norm=words(m.text).join(' ');m.long_repeat=false;
    if(norm.length>=80){m.long_repeat=long.slice(-20).some(p=>similarity(norm,p)>=.95);repeats+=Number(m.long_repeat);long.push(norm);}
    return m;
  });
  const accepted=enriched.filter(m=>!m.exclusion),wpm=chars/5/(duration/60);
  return [{methodology:CHAT_METHOD,duration,total_messages:accepted.length,total_words:allWords.length,total_characters:chars,observed_messages:list.length,excluded_messages:list.length-accepted.length,chat_wpm:wpm,raw_chat_wpm:allWords.length/(duration/60),wpm_consistency:consistency(bins),word_diversity:allWords.length?100*new Set(allWords).size/allWords.length:0,long_repeat_messages:repeats,insufficient_data:chars===0,counting:'Unicode graphemes, including whitespace/punctuation/emoji; no message separators added'},enriched];
}
export function typoTokens(messages){return messages.map(m=>({message_id:String(m.message_id),text:m.text,tokens:[...m.text.matchAll(/[\p{L}]+(?:[-’'][\p{L}]+)*/gu)].map((match,i)=>({id:i,text:match[0]}))}));}
// Optimal-string-alignment edit distance: a transposition is one typo.
export function typoDistance(a,b){a=[...a];b=[...b];const dp=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));for(let i=0;i<=a.length;i++)dp[i][0]=i;for(let j=0;j<=b.length;j++)dp[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++){dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+Number(a[i-1]!==b[j-1]));if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])dp[i][j]=Math.min(dp[i][j],dp[i-2][j-2]+1);}return dp[a.length][b.length];}
export function typoAccuracy(messages,response){
  if(!response||Object.keys(response).join(',')!=='typos'||!Array.isArray(response.typos)||response.typos.length>512)throw new Error('InvalidTypoResponse');
  const tokens=typoTokens(messages),map=new Map(tokens.map(m=>[m.message_id,m])),seen=new Set(),accepted=[];
  const letters=messages.reduce((n,m)=>n+[...m.text].filter(c=>/\p{L}/u.test(c)).length,0);
  for(const t of response.typos){
    if(!t||typeof t.message_id!=='string'||!Number.isInteger(t.token_index)||typeof t.original!=='string'||typeof t.correction!=='string'||!Number.isFinite(t.confidence)||t.confidence<0||t.confidence>1)throw new Error('InvalidTypoEvidence');
    const source=map.get(t.message_id)?.tokens[t.token_index]?.text,key=t.message_id+':'+t.token_index;
    if(source!==t.original||seen.has(key))throw new Error('UnmatchedTypoEvidence');seen.add(key);
    if(t.confidence<.95||source.length>80||t.correction.length>80||!/^[\p{L}]+(?:[-’'][\p{L}]+)*$/u.test(t.correction))continue;
    const normalize=s=>s.normalize('NFC').toLowerCase().replaceAll('ё','е');
    const distance=typoDistance(normalize(source),normalize(t.correction));
    if(distance<1||distance>2)continue;
    accepted.push({...t,edit_count:distance});
  }
  const edits=accepted.reduce((n,t)=>n+t.edit_count,0);
  return {accuracy:letters?Math.max(0,100*(1-edits/letters)):null,accuracy_kind:'estimated_typo_character_accuracy',letter_count:letters,typo_edits:edits,typos:accepted,reasoning:'Только вероятные опечатки. Грамматика, пунктуация, смысл, регистр и е/ё не оцениваются.'};
}
