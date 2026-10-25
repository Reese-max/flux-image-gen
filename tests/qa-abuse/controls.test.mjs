import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {root,admission,validateConfig,validateSource,credentials,inventory,parseInitial,parseSecret,previewArgs,assertCase,cleanup} from '../../cloudflare/qa-abuse/control.mjs';
import {REPO,BRANCH,NAME,KIND,MARKER,TREE,GRANT_MS,ROUTES,BASE,authorized,immutableOrigin,fixtureRequest,expectedResult} from '../../cloudflare/qa-abuse/contract.mjs';
const require=createRequire(path.join(root,'cloudflare/package.json')),{build}=require('esbuild'),{Miniflare,Log,LogLevel}=require('miniflare');
const now=Date.now(),head='a'.repeat(40),key='b'.repeat(64);
const env={QA_KIND:KIND,QA_PRODUCT_TREE:TREE,QA_RUN:'123-1',QA_SOURCE_SHA:head,QA_ACCESS_TOKEN:key,QA_CREATED_AT:new Date(now-1000).toISOString(),QA_EXPIRES_AT:new Date(now+50000).toISOString()};
const request=()=>new Request('https://owned.invalid/generate',{headers:{authorization:'Bearer '+key}});
test('strict auth permits only current owned grant; expiry, future and malformed values deny',()=>{
 assert(authorized(request(),env,now));assert(!authorized(new Request('https://owned.invalid'),env,now));
 for(const [k,v] of [['QA_KIND','other'],['QA_PRODUCT_TREE','c'.repeat(40)],['QA_RUN','1-0'],['QA_SOURCE_SHA','x'],['QA_ACCESS_TOKEN','x'],['QA_CREATED_AT','bad'],['QA_EXPIRES_AT','bad'],['QA_CREATED_AT',new Date(now+1).toISOString()],['QA_EXPIRES_AT',new Date(now).toISOString()],['QA_EXPIRES_AT',new Date(now+GRANT_MS+1).toISOString()]])assert.equal(authorized(request(),{...env,[k]:v},now),false,k);
});
const ghEnv={GITHUB_REPOSITORY:REPO,GITHUB_ACTOR:'Reese-max',GITHUB_TRIGGERING_ACTOR:'Reese-max',GITHUB_EVENT_NAME:'pull_request',GITHUB_REF:'refs/pull/99/merge',GITHUB_HEAD_REF:BRANCH,GITHUB_BASE_REF:'main',GITHUB_SHA:'f'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
const pr={number:99,state:'open',draft:true,body:MARKER,user:{login:'Reese-max'},head:{repo:{full_name:REPO},ref:BRANCH,sha:head},base:{repo:{full_name:REPO},ref:'main'}},event={action:'opened',number:99,pull_request:structuredClone(pr)};
test('PR admission is exact owner, event/ref, marker, checked-out head and fresh same draft PR',()=>{
 assert.deepEqual(admission(ghEnv,event,[pr],head),{run:'123-1',sourceSha:head,pr:99});
 for(const [k,v] of [['GITHUB_REPOSITORY','fork/repo'],['GITHUB_ACTOR','other'],['GITHUB_TRIGGERING_ACTOR','other'],['GITHUB_EVENT_NAME','pull_request_target'],['GITHUB_REF','refs/heads/main'],['GITHUB_SHA','bad'],['GITHUB_HEAD_REF','other'],['GITHUB_BASE_REF','production'],['GITHUB_RUN_ATTEMPT','0']])assert.throws(()=>admission({...ghEnv,[k]:v},event,[pr],head));
 for(const p of [{...pr,number:100},{...pr,body:''},{...pr,draft:false},{...pr,state:'closed'},{...pr,user:{login:'other'}},{...pr,head:{...pr.head,sha:'d'.repeat(40)}},{...pr,head:{...pr.head,repo:{full_name:'fork/repo'}}},{...pr,base:{...pr.base,ref:'production'}}]){assert.throws(()=>admission(ghEnv,event,[p],head));assert.throws(()=>admission(ghEnv,{...event,pull_request:p},[pr],head));}
 for(const rows of [[],[pr,pr]])assert.throws(()=>admission(ghEnv,event,rows,head));for(const action of ['closed','converted_to_draft','edited','labeled'])assert.throws(()=>admission(ghEnv,{...event,action},[pr],head));
 for(const action of ['opened','synchronize','reopened'])assert.doesNotThrow(()=>admission(ghEnv,{...event,action},[pr],head));
});
test('configuration permits no storage/provider/assets/routes/paid limits and credentials fail closed',()=>{
 const config=JSON.parse(readFileSync(path.join(root,'cloudflare/qa-abuse/wrangler.json'),'utf8'));assert(validateConfig(config));
 for(const patch of [{name:'flux-image-gen'},{workers_dev:true},{routes:['owned.invalid/*']},{assets:{directory:'../public'}},{limits:{cpu_ms:10}},{previews:{...config.previews,ai:{binding:'AI'}}},{previews:{...config.previews,r2_buckets:[]}},{previews:{...config.previews,d1_databases:[]}}])assert.throws(()=>validateConfig({...config,...patch}));
 const good={CLOUDFLARE_API_TOKEN:'public-synthetic-token',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32)};assert.doesNotThrow(()=>credentials(good));
 for(const patch of [{CLOUDFLARE_API_TOKEN:''},{CLOUDFLARE_API_TOKEN:'token\n'},{CLOUDFLARE_ACCOUNT_ID:'x'},{CLOUDFLARE_API_BASE_URL:'https://other.invalid'},{CF_API_BASE_URL:'https://other.invalid'},{CLOUDFLARE_API_KEY:'other'},{WRANGLER_API_TOKEN:'other'}])assert.throws(()=>credentials({...good,...patch}));
});
const response=(rows,info)=>Response.json({success:true,errors:[],result:rows,...(info===undefined?{}:{result_info:info})});
test('complete inventories use only GET/fixed account endpoints and bounded page/cursor completion',async()=>{
 const urls=[];const r=await inventory('a'.repeat(32),'public-synthetic-token',async(url,opts)=>{urls.push(url);assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');assert.equal(new URL(url).origin,'https://api.cloudflare.com');return response([], {page:1,total_pages:0,count:0,total_count:0,per_page:100});});assert.deepEqual(r,{calls:2,counts:{scripts:0,native:0}});assert(urls[0].includes('/workers/scripts?'));assert(urls[1].includes('/workers/workers?'));
 const pages=[];const r2=await inventory('a'.repeat(32),'public-synthetic-token',async(url)=>{const u=new URL(url);pages.push(u);if(u.pathname.endsWith('/scripts'))return u.searchParams.get('page')==='2'?response([{id:'second'}],{page:2,total_count:2,count:1}):response([{id:'first'}],{page:1,total_count:2,count:1});return u.searchParams.get('cursor')?response([{name:'second'}],{total_count:2,count:1}):response([{name:'first'}],{total_count:2,count:1,cursors:{after:'owned-cursor'}});});assert.deepEqual(r2,{calls:4,counts:{scripts:2,native:2}});
});
for(const [name,fetcher] of [
 ['403 no retry',async()=>new Response('opaque private token-like diagnostic',{status:403})],
 ['name collision',async()=>response([{id:NAME}],{total_count:1})],
 ['nonempty zero pages',async()=>response([{id:'x'}],{page:1,total_pages:0})],
 ['malformed cursors',async()=>response([],{cursors:'private-value'})],
 ['unfulfilled count',async()=>response([],{total_count:2})],
 ['incomplete more',async()=>Response.json({success:true,result:[],truncated:true})],
 ['duplicate entries',async()=>response([{id:'same'},{id:'same'}])],
 ['invalid success',async()=>Response.json({success:false,result:[]})],
 ['full unknown page',async()=>response(Array.from({length:100},(_,i)=>({id:'item'+i})))],
 ['pagination budget',async(url)=>{const p=Number(new URL(url).searchParams.get('page')||1);return response([{id:'item'+p}],{page:p,total_count:100});}],
 ['body bound',async()=>new Response('x'.repeat(1048577))]
])test('inventory refuses '+name,async()=>{let calls=0;await assert.rejects(inventory('a'.repeat(32),'public-synthetic-token',async(...args)=>{calls++;return fetcher(...args);}));assert(calls<=20);if(name==='403 no retry')assert.equal(calls,1);});
const id='12345678-abcd-4567-89ab-123456789abc',next='87654321-abcd-4567-89ab-123456789abc';
const origin='https://12345678-'+NAME+'.owned-account.workers.dev',nextOrigin='https://87654321-'+NAME+'.owned-account.workers.dev';
const context={config:'/owned/qa.json',previewName:'issue11-123-1',created:Date.now()-1000};
function initialRecord(){return [{type:'wrangler-session',version:1,wrangler_version:'4.135.0',command_line_args:previewArgs(context.config,context.previewName),timestamp:new Date().toISOString()},{type:'preview',version:1,preview_id:'owned-preview',preview_name:context.previewName,deployment_id:id,deployment_urls:[origin],preview_urls:['https://issue11-123-1-'+NAME+'.owned-account.workers.dev'],timestamp:new Date().toISOString()}];}
test('official private Preview record and scoped-secret immutable identities are strict',()=>{
 const rows=initialRecord(),p=parseInitial(rows.map(JSON.stringify).join('\n'),context);assert.equal(p.origin,origin);
 const message='Created Preview deployment '+next+' with secret QA_ACCESS_TOKEN.\nYour Preview "'+context.previewName+'" is now live at '+nextOrigin;assert.equal(parseSecret(message,p,context.previewName).origin,nextOrigin);
 for(const mutate of [r=>{r[0].wrangler_version='4.104.0';},r=>{r[0].command_line_args=['deploy'];},r=>{r[1].deployment_urls=[nextOrigin];},r=>{r[1].preview_urls=[origin];},r=>{r[1].worker_name='flux-image-gen';},r=>{r[1].preview_name='other';},r=>{r[1].timestamp='2000-01-01T00:00:00.000Z';},r=>{r[1].extra='opaque';},r=>{r[1].version=true;}]){const changed=structuredClone(rows);mutate(changed);assert.throws(()=>parseInitial(changed.map(JSON.stringify).join('\n'),context));}
 assert.throws(()=>parseSecret(message.replace('owned-account','other-account'),p,context.previewName));assert.throws(()=>immutableOrigin('https://evil.invalid/'+origin,id));assert.throws(()=>immutableOrigin(origin+'?token=private',id));assert.throws(()=>parseInitial(JSON.stringify(rows[1]),context));
});
test('fixed result receipt rejects stale/malformed/cost-gate bypass counters',()=>{
 const identity={run:'123-1',sourceSha:head},good={status:503,body:{schema:1,kind:KIND,run:identity.run,sourceSha:head,productTree:TREE,case:'missing',route:'/generate',productStatus:503,productCode:'rate_limiter_unavailable',aiCalls:0,fetchCalls:0,externalTransport:'DENIED',unknownPrivateField:'not copied'}};
 assert.deepEqual(assertCase(good,identity,'/generate','missing'),{case:'missing',route:'/generate',status:503,code:'rate_limiter_unavailable',aiCalls:0,fetchCalls:0});
 for(const patch of [{sourceSha:'c'.repeat(40)},{aiCalls:1},{fetchCalls:1},{productStatus:200},{productCode:'other'},{case:'throw'},{externalTransport:'ALLOWED'}])assert.throws(()=>assertCase({...good,body:{...good.body,...patch}},identity,'/generate','missing'));
});
test('runner cleanup removes only owned directory and refuses a symlink',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'flux-abuse-cleanup-')),prior=process.env.RUNNER_TEMP;process.env.RUNNER_TEMP=dir;
 try{const own=path.join(dir,'flux-issue11-isolated-qa'),sibling=path.join(dir,'unrelated');mkdirSync(own,{mode:0o700});mkdirSync(sibling);writeFileSync(path.join(own,'secret'),'public-fixture');writeFileSync(path.join(sibling,'keep'),'keep');assert.equal(cleanup().remoteDeletion,false);assert(!existsSync(own));assert(existsSync(path.join(sibling,'keep')));symlinkSync(sibling,own);assert.throws(()=>cleanup());assert(existsSync(path.join(sibling,'keep')));}finally{if(prior===undefined)delete process.env.RUNNER_TEMP;else process.env.RUNNER_TEMP=prior;rmSync(dir,{recursive:true,force:true});}
});
test('real workerd: auth-first all-path faults, isolated counters, actual expiry and zero Worker egress',{timeout:60000},async()=>{
 const bundle=await build({entryPoints:[path.join(root,'cloudflare/qa-abuse/entry.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:async_hooks'],write:false});let outbound=0;
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-24',compatibilityFlags:['nodejs_compat'],log:new Log(LogLevel.NONE),bindings:env,outboundService:()=>{outbound++;return new Response('Unexpected egress',{status:502});}});
 async function call(route,mode,auth=key,body){const r=await mf.dispatchFetch('https://owned.invalid'+route,{method:mode?'POST':'GET',headers:{...(auth?{authorization:'Bearer '+auth}:{}),...(mode?{'x-flux-abuse-case':mode}:{})},...(body?{body}:{})});return {status:r.status,body:await r.json()};}
 try{await mf.ready;
  for(const route of ['/__qa/status',...ROUTES,'/unknown'])assert.equal((await call(route,route==='/__qa/status'?null:'missing',null)).status,401);
  for(const mode of ['missing','wrong','empty','staging','typo','throw','malformed','combined','deny'])for(const route of ROUTES){const result=await call(route,mode);assert.equal(result.body.case,mode,JSON.stringify(result));assertCase(result,{run:env.QA_RUN,sourceSha:head},route,mode);}
  for(const mode of ['missing-secret','missing-site','missing-token','turnstile-down'])for(const route of ROUTES.slice(0,3))assertCase(await call(route,mode),{run:env.QA_RUN,sourceSha:head},route,mode);
  for(const route of ['/generate','/prompt/complete'])assertCase(await call(route,'development'),{run:env.QA_RUN,sourceSha:head},route,'development');
  await Promise.all(Array.from({length:4},()=>ROUTES).flat().map(async route=>assertCase(await call(route,'throw'),{run:env.QA_RUN,sourceSha:head},route,'throw')));
  assert.equal((await call('/generate','missing',key,'opaque caller body')).status,400);assert.equal((await call('/generate','unknown')).status,404);assert.equal((await call('/generate?private=value','missing')).status,404);assert.equal(outbound,0);
  const expires=Date.now()+120;await mf.setOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-24',compatibilityFlags:['nodejs_compat'],log:new Log(LogLevel.NONE),bindings:{...env,QA_CREATED_AT:new Date(expires-1000).toISOString(),QA_EXPIRES_AT:new Date(expires).toISOString()},outboundService:()=>{outbound++;return new Response('Denied');}});await new Promise(resolve=>setTimeout(resolve,150));
  for(const route of ['/__qa/status',...ROUTES])assert.equal((await call(route,route==='/__qa/status'?null:'missing')).status,401);assert.equal(outbound,0);
 }finally{await mf.dispose();}
});
test('registered workflow keeps old C2PA job exact and secrets follow source/lease guard',()=>{
 const source=validateSource();assert.equal(source.base,BASE);const w=readFileSync(path.join(root,'.github/workflows/provenance-preview-qa.yml'),'utf8'),job=w.slice(w.indexOf('  isolated-abuse:'));
 assert.doesNotMatch(w,/workflow_dispatch:/);assert.match(job,/github.event.pull_request.head.sha/);assert.match(job,/flux-issue11-isolated-qa:20261025/);
 assert(job.indexOf('control.mjs guard')<job.indexOf('secrets.CLOUDFLARE_API_TOKEN'));assert.match(job,/if: steps.abuse-guard.outputs.ready == 'true'/);assert.match(job,/if: always\(\)\n\s+run: node cloudflare\/qa-abuse\/control.mjs cleanup/);assert.doesNotMatch(job,/pull_request_target|CF_REFRESH_TOKEN|command: deploy|versions upload|versions deploy/);
});
