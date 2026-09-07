import {readFile} from 'node:fs/promises';
// Read only the locally ignored .dev.vars. Never print token/secret values.
let local={};try{for(const line of (await readFile('.dev.vars','utf8')).split(/\r?\n/)){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)local[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');}}catch{}
const url=process.env.PUBLIC_URL||local.PUBLIC_URL,secret=process.env.WEBHOOK_SECRET||local.WEBHOOK_SECRET;
if(!url||!secret)throw new Error('Set PUBLIC_URL and WEBHOOK_SECRET in your ignored .dev.vars file or environment.');
const target=new URL('/admin/setup',url);if(target.protocol!=='https:')throw new Error('HTTPS required');
try{const r=await fetch(target,{method:'POST',headers:{Authorization:'Bearer '+secret},signal:AbortSignal.timeout(60000)});const value=await r.json();console.log(JSON.stringify(value,null,2));if(!r.ok)process.exitCode=1;}catch{console.error('Setup request failed. Check PUBLIC_URL and Worker logs.');process.exitCode=1;}
