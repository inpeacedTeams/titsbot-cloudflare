import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const dir of ['src','scripts','tests'])for(const file of await readdir(dir))if(file.endsWith('.mjs')){const r=spawnSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});if(r.status)process.exit(r.status);}
const r=spawnSync(process.execPath,['--check','public/app.js'],{stdio:'inherit'});if(r.status)process.exit(r.status);
for(const path of ['src/index.mjs','src/coordinator.mjs','src/remote.mjs']){const text=await readFile(path,'utf8');if(text.includes('{{')||text.includes('shaPlaceholder'))throw new Error('Unresolved placeholder: '+path);}
console.log('Syntax and source checks passed');
