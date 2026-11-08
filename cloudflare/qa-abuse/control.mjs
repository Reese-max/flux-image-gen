// Dedicated issue11 controller. Import/validate/guard never mutate Cloudflare.
import {readFileSync,writeFileSync,mkdirSync,statSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {REPO,BRANCH,BASE,TREE,NAME,KIND,MARKER,GRANT_MS,SHA,RUN,UUID,ROUTES,expectedResult,immutableOrigin,requireValue} from './contract.mjs';
export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const here=path.join(root,'cloudflare/qa-abuse'),workflow='.github/workflows/provenance-preview-qa.yml';
const exactConfig={name:NAME,main:'entry.mjs',compatibility_date:'2026-06-24',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:true,routes:[],observability:{enabled:false},previews:{vars:{QA_KIND:KIND,QA_PRODUCT_TREE:TREE},version_metadata:{binding:'CF_VERSION_METADATA'},observability:{enabled:false}}};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function git(args,cwd=root){const r=spawnSync('git',args,{cwd,encoding:'utf8',maxBuffer:8*1024*1024});requireValue(r.status===0);return r.stdout;}
function treeMap(ref,base){return new Map(git(['ls-tree','-rz',ref],base).split('\0').filter(Boolean).map(row=>{const split=row.indexOf('\t');return [row.slice(split+1),row.slice(0,split)];}));}
export function validateConfig(config){requireValue(JSON.stringify(config)===JSON.stringify(exactConfig));return true;}
export function validateSource(base=root){
 requireValue(git(['rev-parse',BASE+'^{tree}'],base).trim()===TREE);
 const before=treeMap(BASE,base),after=treeMap('HEAD',base);
 for(const [name,blob] of before)if(name!==workflow)requireValue(after.get(name)===blob);
 for(const [name,blob] of after)if(!before.has(name))requireValue((name.startsWith('cloudflare/qa-abuse/')||name.startsWith('tests/qa-abuse/'))&&blob.startsWith('100644 blob '));
 const old=git(['show',BASE+':'+workflow],base),current=readFileSync(path.join(base,workflow),'utf8');
 // Existing registered PR45 job is preserved verbatim, including strict pins.
 requireValue(current.includes(old.slice(old.indexOf('  isolated-preview:\n'))));
 requireValue(current.includes(old.slice(old.indexOf('  pull_request:\n'),old.indexOf('\npermissions:\n'))));
 requireValue(current.includes(old.slice(old.indexOf('\npermissions:\n'),old.indexOf('  isolated-preview:\n'))));
 requireValue(git(['diff','--name-only','HEAD','--'],base).trim()==='');
 validateConfig(JSON.parse(readFileSync(path.join(base,'cloudflare/qa-abuse/wrangler.json'),'utf8')));
 return {base:BASE,tree:TREE,preserved:before.size-1,head:git(['rev-parse','HEAD'],base).trim()};
}
export function admission(env,event,prs,head){
 requireValue(env.GITHUB_REPOSITORY===REPO&&env.GITHUB_ACTOR==='Reese-max'&&env.GITHUB_TRIGGERING_ACTOR==='Reese-max');
 requireValue(env.GITHUB_EVENT_NAME==='pull_request'&&['opened','synchronize','reopened'].includes(event.action)&&SHA.test(head)&&SHA.test(env.GITHUB_SHA||''));
 requireValue(Array.isArray(prs)&&prs.length===1&&Number.isSafeInteger(event.number)&&event.number>0&&env.GITHUB_REF==='refs/pull/'+event.number+'/merge'&&env.GITHUB_HEAD_REF===BRANCH&&env.GITHUB_BASE_REF==='main');
 for(const p of [event.pull_request,prs[0]])requireValue(p?.number===event.number&&p.state==='open'&&p.draft===true&&p.user?.login==='Reese-max'&&p.head?.repo?.full_name===REPO&&p.head?.ref===BRANCH&&p.head?.sha===head&&p.base?.repo?.full_name===REPO&&p.base?.ref==='main'&&typeof p.body==='string'&&p.body.includes(MARKER));
 const p=prs[0];
 const run=env.GITHUB_RUN_ID+'-'+env.GITHUB_RUN_ATTEMPT;requireValue(RUN.test(run));return {run,sourceSha:head,pr:p.number};
}
async function jsonRequest(url,options={},fetcher=fetch,deadline=Date.now()+10000){
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),Math.max(1,deadline-Date.now()));
 try {requireValue(Date.now()<deadline);const r=await fetcher(url,{...options,method:'GET',redirect:'error',signal:abort.signal});
  if(!r.ok){const e=new Error('Remote read failed');e.httpStatus=r.status;throw e;}
  const reader=r.body?.getReader();requireValue(reader);const chunks=[];let size=0;
  while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>1048576){await reader.cancel();throw new Error('Bounded JSON rejected');}chunks.push(item.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }finally{clearTimeout(timer);}
}
function paths(){requireValue(process.env.RUNNER_TEMP&&path.isAbsolute(process.env.RUNNER_TEMP));const dir=path.join(realpathSync(process.env.RUNNER_TEMP),'flux-issue11-isolated-qa');return {dir,guard:path.join(dir,'guard.json'),state:path.join(dir,'state.json'),config:path.join(dir,'wrangler.json'),output:path.join(root,'output/qa-abuse')};}
async function admitted(){const source=validateSource(),event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));admission(process.env,event,[event.pull_request],source.head);requireValue(process.env.GH_TOKEN);
 const pr=await jsonRequest('https://api.github.com/repos/'+REPO+'/pulls/'+event.number,{headers:{authorization:'Bearer '+process.env.GH_TOKEN,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'}});
 return admission(process.env,event,[pr],source.head);
}
export async function guard(){const identity=await admitted(),p=paths();requireValue(!existsSync(p.dir));mkdirSync(p.dir,{mode:0o700});writeFileSync(p.guard,JSON.stringify({...identity,created:Date.now()}),{mode:0o600,flag:'wx'});requireValue(process.env.GITHUB_OUTPUT);writeFileSync(process.env.GITHUB_OUTPUT,'ready=true\n',{flag:'a'});return identity;}
export function credentials(env){requireValue(typeof env.CLOUDFLARE_API_TOKEN==='string'&&env.CLOUDFLARE_API_TOKEN.length>0&&env.CLOUDFLARE_API_TOKEN.length<=4096&&env.CLOUDFLARE_API_TOKEN.trim()===env.CLOUDFLARE_API_TOKEN&&!/[\r\n]/.test(env.CLOUDFLARE_API_TOKEN)&&/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID||''));
 for(const key of ['WRANGLER_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','CLOUDFLARE_API_BASE_URL','CF_API_BASE_URL'])requireValue(!env[key]);
}
// Two bounded complete inventories. No names, account IDs or bodies are emitted.
export async function inventory(account,token,fetcher=fetch){
 requireValue(/^[a-f0-9]{32}$/.test(account));let calls=0;const deadline=Date.now()+10000,counts={};
 for(const [family,suffix] of [['scripts','scripts'],['native','workers']]){let page=1,cursor,seen=0,total,complete=false;const names=new Set(),cursors=new Set();
  while(!complete){requireValue(++calls<=20);const u=new URL('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/'+suffix);u.searchParams.set('per_page','100');if(cursor)u.searchParams.set('cursor',cursor);else if(page>1)u.searchParams.set('page',String(page));
   const d=await jsonRequest(u.href,{headers:{authorization:'Bearer '+token}},fetcher,deadline);requireValue(d.success===true&&(!d.errors||Array.isArray(d.errors)&&d.errors.length===0)&&Array.isArray(d.result)&&d.result.length<=100);
   for(const row of d.result){const name=family==='scripts'?row?.id:row?.name;requireValue(typeof name==='string'&&name.length>0&&name.length<=255&&!names.has(name)&&name!==NAME);names.add(name);}
   seen+=d.result.length;const info=d.result_info??{};requireValue(info&&typeof info==='object'&&!Array.isArray(info));
   for(const key of ['count','page','per_page','total_count','total_pages'])if(info[key]!==undefined)requireValue(Number.isSafeInteger(info[key])&&info[key]>=0);
   if(info.count!==undefined)requireValue(info.count===d.result.length);if(info.page!==undefined)requireValue(info.page===page);if(info.per_page!==undefined)requireValue(info.per_page===100);
   if(info.total_count!==undefined){if(total!==undefined)requireValue(total===info.total_count);total=info.total_count;requireValue(seen<=total);}
   if(info.cursors!==undefined)requireValue(info.cursors&&typeof info.cursors==='object'&&!Array.isArray(info.cursors));
   const next=info.cursor??info.cursors?.after;requireValue(next===undefined||next===null||next===''||typeof next==='string'&&next.length<=1024);
   for(const obj of [info,d])for(const key of ['has_more','truncated'])if(obj[key]!==undefined)requireValue(typeof obj[key]==='boolean');
   const more=info.has_more===true||info.truncated===true||d.has_more===true||d.truncated===true;
   if(next){requireValue(!cursors.has(next)&&d.result.length>0);cursors.add(next);cursor=next;page++;continue;}
   requireValue(!more);
   if(info.total_pages!==undefined){requireValue(info.total_pages!==0||seen===0&&(total===undefined||total===0));if(page<info.total_pages){requireValue(d.result.length>0);page++;continue;}requireValue(page===info.total_pages||info.total_pages===0);complete=true;}
   else if(total!==undefined){if(seen<total){requireValue(d.result.length>0);page++;continue;}complete=true;}
   else {requireValue(d.result.length<100);complete=true;}
   if(complete&&total!==undefined)requireValue(seen===total);
  }counts[family]=seen;
 }return {calls,counts};
}
export function previewArgs(config,name){return ['preview','--config',config,'--worker-name',NAME,'--name',name,'--ignore-base-config','--json'];}
export function parseInitial(text,context){
 requireValue(typeof text==='string'&&Buffer.byteLength(text)<=16384);const lines=text.split(/\r?\n/).filter(x=>x.trim());requireValue(lines.length===2);const [session,d]=lines.map(x=>JSON.parse(x));
 requireValue(session.type==='wrangler-session'&&session.version===1&&session.wrangler_version==='4.135.0'&&JSON.stringify(session.command_line_args)===JSON.stringify(previewArgs(context.config,context.previewName)));
 requireValue(Object.keys(session).every(k=>['type','version','wrangler_version','command_line_args','log_file_path','timestamp'].includes(k))&&(session.log_file_path===undefined||typeof session.log_file_path==='string'&&session.log_file_path.length<=4096));
 requireValue(d.type==='preview'&&d.version===1&&d.preview_name===context.previewName&&/^issue11-[0-9]{1,20}-[1-9][0-9]{0,3}$/.test(d.preview_name)&&(d.worker_name===undefined||d.worker_name===NAME));
 requireValue(Object.keys(d).every(k=>['type','version','worker_name','preview_id','preview_name','preview_slug','preview_urls','deployment_id','deployment_urls','timestamp'].includes(k))&&typeof d.preview_id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(d.preview_id));
 for(const v of [session.timestamp,d.timestamp])requireValue(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Date.parse(v)>=context.created&&Date.parse(v)<=Date.now()+5000&&Date.now()-Date.parse(v)<=300000);
 requireValue(Array.isArray(d.deployment_urls)&&d.deployment_urls.length===1&&Array.isArray(d.preview_urls)&&d.preview_urls.length<=4);
 const origin=immutableOrigin(d.deployment_urls[0],d.deployment_id),namespace=origin.slice(origin.indexOf('-'+NAME+'.')+1);
 const aliases=d.preview_urls.map(value=>{const u=new URL(value);requireValue(u.protocol==='https:'&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password&&!u.port&&u.hostname.includes('-'+NAME+'.')&&u.origin.endsWith(namespace));return u.origin;});requireValue(!aliases.includes(origin));
 return {origin,deploymentId:d.deployment_id,previewId:d.preview_id,aliases};
}
export function parseSecret(text,initial,previewName){
 requireValue(typeof text==='string'&&Buffer.byteLength(text)<=1048576);const clean=text.replace(/\x1b\[[0-9;]*m/g,'');const match=clean.match(/Created Preview deployment ([a-f0-9-]+) with secret QA_ACCESS_TOKEN\./);requireValue(match&&UUID.test(match[1])&&clean.includes('Your Preview "'+previewName+'" is now live at '));
 const urls=(clean.match(/https:\/\/[^\s,]+/g)||[]).flatMap(value=>{try{return [immutableOrigin(value,match[1])];}catch{return [];}});requireValue(urls.length===1&&urls[0]!==initial.origin&&!initial.aliases.includes(urls[0])&&match[1]!==initial.deploymentId&&new URL(urls[0]).hostname.slice(8)===new URL(initial.origin).hostname.slice(8));return {origin:urls[0],deploymentId:match[1]};
}
function cli(args,{input,outputFile}={}){const env={...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_OUTPUT_FILE_PATH:outputFile||'',WRANGLER_OUTPUT_FILE_DIRECTORY:'',NO_COLOR:'1'};delete env.GH_TOKEN;delete env.GITHUB_TOKEN;
 const r=spawnSync(process.execPath,[path.join(root,'cloudflare/qa/node_modules/wrangler/bin/wrangler.js'),...args],{cwd:root,env,input,encoding:'utf8',timeout:90000,maxBuffer:2097152});
 if(r.status!==0){const error=new Error('QA CLI failed');error.cfCodes=[...new Set([...((r.stdout||'')+(r.stderr||'')).matchAll(/\[code:\s*([0-9]{3,8})\]/g)].map(x=>Number(x[1])))].slice(0,4);throw error;}return r.stdout;
}
function privateFile(file){const s=statSync(file);requireValue(s.isFile()&&(s.mode&0o077)===0&&s.size<=32768);return JSON.parse(readFileSync(file,'utf8'));}
function report(name,value){const p=paths();mkdirSync(p.output,{recursive:true});writeFileSync(path.join(p.output,name+'.json'),JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value));}
async function readProof(origin,key,route,mode){immutableOrigin(origin,origin.split('://')[1].slice(0,8)+'-0000-0000-0000-000000000000');const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),5000);
 try {const r=await fetch(origin+route,{method:mode?'POST':'GET',headers:key?{authorization:'Bearer '+key,...(mode?{'x-flux-abuse-case':mode}:{})}:{},redirect:'error',signal:abort.signal});const bytes=await r.arrayBuffer();requireValue(bytes.byteLength<=8192);return {status:r.status,body:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};}finally{clearTimeout(timer);}}
export async function prepare(){let stage='admission';
 try {const identity=await admitted(),p=paths(),g=privateFile(p.guard);requireValue(g.sourceSha===identity.sourceSha&&g.run===identity.run&&g.pr===identity.pr&&Date.now()-g.created>=0&&Date.now()-g.created<=300000&&!existsSync(p.state));
  stage='credentials';credentials(process.env);requireValue(JSON.parse(readFileSync(path.join(root,'cloudflare/qa/node_modules/wrangler/package.json'),'utf8')).version==='4.135.0');
  stage='inventory';const listed=await inventory(process.env.CLOUDFLARE_ACCOUNT_ID,process.env.CLOUDFLARE_API_TOKEN);
  const key=randomBytes(32).toString('hex');process.stdout.write('::add-mask::'+key+'\n');const created=Date.now(),expires=created+GRANT_MS,previewName='issue11-'+identity.run,config=structuredClone(exactConfig);config.main=path.join(here,'entry.mjs');Object.assign(config.previews.vars,{QA_RUN:identity.run,QA_SOURCE_SHA:identity.sourceSha,QA_CREATED_AT:new Date(created).toISOString(),QA_EXPIRES_AT:new Date(expires).toISOString()});writeFileSync(p.config,JSON.stringify(config),{mode:0o600,flag:'wx'});
  await admitted();stage='initial_preview';const outputFile=path.join(p.dir,'initial.jsonl');writeFileSync(outputFile,'',{mode:0o600,flag:'wx'});cli(previewArgs(p.config,previewName),{outputFile});requireValue((statSync(outputFile).mode&0o077)===0);const initial=parseInitial(readFileSync(outputFile,'utf8'),{config:p.config,previewName,created});
  stage='missing_key';for(const route of ['/__qa/status',...ROUTES]){const r=await readProof(initial.origin,null,route,route==='/__qa/status'?null:'missing');requireValue(r.status===401&&r.body.status==='DENIED');}
  await admitted();stage='scoped_secret';const bound=parseSecret(cli(['preview','secret','put','QA_ACCESS_TOKEN','--config',p.config,'--worker-name',NAME,'--name',previewName],{input:key+'\n'}),initial,previewName);
  writeFileSync(p.state,JSON.stringify({...identity,...bound,key,expires,previewName}),{mode:0o600,flag:'wx'});stage='identity';const status=await readProof(bound.origin,key,'/__qa/status');requireValue(status.status===200&&status.body.kind===KIND&&status.body.run===identity.run&&status.body.sourceSha===identity.sourceSha&&status.body.productTree===TREE&&status.body.storageBindings===0&&status.body.providerBindings===0);
  report('preview',{schema:1,status:'READY',...identity,worker:NAME,origin:bound.origin,deploymentId:bound.deploymentId,productTree:TREE,inventory:listed,anonymousDenials:7,expiresAt:new Date(expires).toISOString(),providerBindings:0,storageBindings:0});
 }catch(e){report('preview',{schema:1,status:'FAILED_CLOSED',stage,httpStatus:Number.isInteger(e.httpStatus)?e.httpStatus:null,cfCodes:Array.isArray(e.cfCodes)?e.cfCodes:[]});throw new Error('Isolated QA stopped; fixed receipt only');}}
export function assertCase(result,identity,route,mode){const body=result.body,expected=expectedResult(mode,route);requireValue(body.schema===1&&body.kind===KIND&&body.run===identity.run&&body.sourceSha===identity.sourceSha&&body.productTree===TREE&&body.case===mode&&body.route===route&&result.status===expected[0]&&body.productStatus===expected[0]&&body.productCode===expected[1]&&body.aiCalls===expected[2]&&body.fetchCalls===expected[3]&&body.externalTransport==='DENIED');return {case:mode,route,status:result.status,code:body.productCode,aiCalls:body.aiCalls,fetchCalls:body.fetchCalls};}
export async function verify(){let stage='admission';try{const identity=await admitted(),p=paths(),state=privateFile(p.state);requireValue(state.run===identity.run&&state.sourceSha===identity.sourceSha&&state.pr===identity.pr&&state.expires>Date.now()&&state.expires-Date.now()<=GRANT_MS);immutableOrigin(state.origin,state.deploymentId);const records=[];
  stage='matrix';for(const mode of ['missing','wrong','empty','staging','typo','throw','malformed','combined','deny'])for(const route of ROUTES)records.push(assertCase(await readProof(state.origin,state.key,route,mode),identity,route,mode));
  for(const mode of ['missing-secret','missing-site','missing-token','turnstile-down'])for(const route of ROUTES.slice(0,3))records.push(assertCase(await readProof(state.origin,state.key,route,mode),identity,route,mode));
  for(const route of ['/generate','/prompt/complete'])records.push(assertCase(await readProof(state.origin,state.key,route,'development'),identity,route,'development'));
  stage='repeat_concurrent';for(let repeat=0;repeat<3;repeat++)for(const route of ROUTES)records.push(assertCase(await readProof(state.origin,state.key,route,'missing'),identity,route,'missing'));
  records.push(...await Promise.all(Array.from({length:4},()=>ROUTES).flat().map(async route=>assertCase(await readProof(state.origin,state.key,route,'throw'),identity,route,'throw'))));requireValue(records.length===110);
  stage='expiry';const wait=state.expires-Date.now()+100;requireValue(wait>=0&&wait<=GRANT_MS+100);await new Promise(resolve=>setTimeout(resolve,wait));for(const route of ['/__qa/status',...ROUTES]){const r=await readProof(state.origin,state.key,route,route==='/__qa/status'?null:'missing');requireValue(r.status===401&&r.body.status==='DENIED');}
  report('runtime',{schema:1,status:'HOSTED_ABUSE_QA_PASS',...identity,worker:NAME,origin:state.origin,deploymentId:state.deploymentId,productTree:TREE,records,expiredDenials:7,realProviderCalls:0,externalTransport:'PERMANENTLY_STUBBED',storageBindings:0,faults:'JS fault doubles inside actual deployed Worker; not vendor outage proof',scope:'Synthetic fixed handlers/abuse-gate acceptance only; no production/real challenge/CLEAN claim'});
 }catch(e){report('runtime',{schema:1,status:'FAILED_CLOSED',stage,httpStatus:Number.isInteger(e.httpStatus)?e.httpStatus:null});throw new Error('Isolated runtime proof failed');}}
export function cleanup(){const p=paths();if(existsSync(p.dir)){requireValue(realpathSync(p.dir)===p.dir);rmSync(p.dir,{recursive:true,force:false});}return {schema:1,status:'RUNNER_PRIVATE_FILES_REMOVED',remoteDeletion:false};}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const command=process.argv[2];if(command==='validate')console.log(JSON.stringify(validateSource()));else if(command==='guard')await guard();else if(command==='prepare')await prepare();else if(command==='verify')await verify();else if(command==='cleanup')console.log(JSON.stringify(cleanup()));else throw new Error('Unsupported command');}catch{console.error('Isolated abuse QA failed; no raw diagnostics emitted');process.exitCode=1;}}
