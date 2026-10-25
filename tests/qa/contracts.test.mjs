import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { authorized,ownedPrefix,privateResponse,QA_KIND,FEATURE_TREE,QA_NAME } from '../../cloudflare/qa/contract.mjs';
import { validateSource,validateConfig,validateAdmission,immutableOrigin,parseSecretDeployment,parseInitialDeployment,noOrdinaryScript,bucketNames,sanitizedFailure,failureReceipt,root } from '../../cloudflare/qa/control.mjs';
import { localRuntime } from './local-runtime.mjs';
const now=Date.now(),key='b'.repeat(64);
const env={QA_KIND,QA_FROZEN_TREE:FEATURE_TREE,QA_RUN:'12345-1',QA_SOURCE_SHA:'a'.repeat(40),QA_ACCESS_TOKEN:key,QA_CREATED_AT:new Date(now-1000).toISOString(),QA_EXPIRES_AT:new Date(now+100000).toISOString()};
const request=authorization=>new Request('https://qa.example/',{headers:authorization?{authorization}:{}});
test('short-lived exact Bearer/Basic auth denies bad identity, absent/future/expired/overlong grants',()=>{
  for(const authorization of ['Bearer '+key,'Basic '+Buffer.from('flux-qa:'+key).toString('base64')])assert.equal(authorized(request(authorization),env,now),true);
  for(const authorization of [null,'Bearer wrong','Basic !!!','Basic '+Buffer.from('other:'+key).toString('base64')])assert.equal(authorized(request(authorization),env,now),false);
  for(const changed of [{QA_ACCESS_TOKEN:''},{QA_RUN:'../x'},{QA_KIND:'prod'},{QA_FROZEN_TREE:'a'.repeat(40)},{QA_SOURCE_SHA:'x'},{QA_CREATED_AT:new Date(now+1).toISOString()},{QA_EXPIRES_AT:new Date(now).toISOString()},{QA_EXPIRES_AT:new Date(now+3_600_000).toISOString()}])assert.equal(authorized(request('Bearer '+key),{...env,...changed},now),false);
  assert.equal(authorized(new Request('https://qa.example/?key='+key,{headers:{cookie:'key='+key}}),env,now),false);
  assert.throws(()=>ownedPrefix({QA_RUN:'../'}));assert.equal(ownedPrefix(env),'qa-runs/12345-1/');
  const response=privateResponse(new Response('ok',{headers:{'content-security-policy':"worker-src 'self'"}}));
  assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('content-security-policy'),"worker-src 'self'");
});
test('owner same-repo open draft exact-head admission rejects fork, nonowner, stale head and nonPR',()=>{
  const ci={GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY:'Reese-max/flux-image-gen',GITHUB_ACTOR:'Reese-max',GITHUB_TRIGGERING_ACTOR:'Reese-max',GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1'};
  const pr={number:45,state:'open',draft:true,user:{login:'Reese-max'},base:{ref:'main'},head:{ref:'feature/flux-reliability-sweep-20261024',sha:'a'.repeat(40),repo:{full_name:ci.GITHUB_REPOSITORY}}};
  assert.equal(validateAdmission(ci,{pull_request:pr},pr,pr.head.sha).run,'12345-1');
  for(const patch of [{draft:false},{state:'closed'},{number:46},{user:{login:'attacker'}},{head:{...pr.head,sha:'c'.repeat(40)}},{head:{...pr.head,repo:{full_name:'attacker/fork'}}},{head:{...pr.head,ref:'production'}},{base:{ref:'production'}}])assert.throws(()=>validateAdmission(ci,{pull_request:pr},{...pr,...patch},pr.head.sha));
  for(const patch of [{GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_EVENT_NAME:'workflow_dispatch'},{GITHUB_ACTOR:'attacker'},{GITHUB_TRIGGERING_ACTOR:'attacker'},{GITHUB_REPOSITORY:'attacker/fork'},{GITHUB_RUN_ATTEMPT:'0'}])assert.throws(()=>validateAdmission({...ci,...patch},{pull_request:pr},pr,pr.head.sha));
});
test('frozen source/config manifest and immutable secret-bound URL reject wrong binding/alias',()=>{
  assert.ok(validateSource().files>=271);
  const config=JSON.parse(readFileSync(path.join(root,'cloudflare/qa/wrangler.json'),'utf8'));assert.equal(validateConfig(config),config);
  for(const change of [c=>c.name='flux-image-gen',c=>c.workers_dev=true,c=>c.assets.run_worker_first=false,c=>c.previews.r2_buckets[0].bucket_name='flux-image-gallery',c=>c.previews.ai={},c=>c.previews.vars.QA_ACCESS_TOKEN=key,c=>c.services=[],c=>c.routes=['*example/*']]){const copy=structuredClone(config);change(copy);assert.throws(()=>validateConfig(copy));}
  const url='https://abcdef12-'+QA_NAME+'.isolated.workers.dev/';assert.equal(immutableOrigin(url,'abcdef12'),url.slice(0,-1));
  assert.equal(parseInitialDeployment(JSON.stringify({preview:{worker_name:QA_NAME,name:'pr45-12345-1'},deployment:{id:'abcdef12',urls:[url]}}),'pr45-12345-1'),url.slice(0,-1));
  assert.throws(()=>parseInitialDeployment(JSON.stringify({worker_name:QA_NAME,preview_name:'pr45-12345-1',deployment_id:'abcdef12',deployment_urls:[url]}),'pr45-12345-1'));
  assert.equal(parseSecretDeployment('Success! Created Preview deployment abcdef12 with secret QA_ACCESS_TOKEN.\nYour Preview is live at '+url).origin,url.slice(0,-1));
  for(const changed of [url.replace('https:','http:'),url.replace('abcdef12-','pr45-12345-1-'),url.replace(QA_NAME,'flux-image-gen'),url+'?key=secret',url.replace('.workers.dev','.workers.dev.attacker.test'),url.replace('https://','https://user:pass@')])assert.throws(()=>immutableOrigin(changed,'abcdef12'));
  assert.throws(()=>parseSecretDeployment('Success at '+url));
  assert.doesNotMatch(JSON.stringify(sanitizedFailure('Authentication error [code: 10000] '+key+' Basic '+Buffer.from('flux-qa:'+key).toString('base64'),key)),new RegExp(key));
  assert.deepEqual(sanitizedFailure('Authentication error [code: 10000] opaqueFormalToken_WITH_nonhex_value'),['Cloudflare API code: 10000','Authentication error']);
  let malformed;try{JSON.parse('OPAQUE_OWNER_CANARY_DO_NOT_EXPORT');}catch(error){malformed=error;}
  assert.doesNotMatch(JSON.stringify(failureReceipt('r2_owner_read',malformed)),/OPAQUE_OWNER_CANARY/);
  assert.doesNotMatch(JSON.stringify(failureReceipt('unexpectedsecret',{receipt:{exitCode:1,details:['OPAQUE_CANARY','Cloudflare API code: 10000']}})),/OPAQUE_CANARY|unexpectedsecret/);
  assert.deepEqual(bucketNames(' ⛅️ wrangler 4.135.0\n────────────────\nListing buckets...\n'),[]);
  assert.deepEqual(bucketNames('Listing buckets...\nname: flux-image-gallery\ncreation_date: date\n\nname: '+QA_NAME+'\ncreation_date: date'),['flux-image-gallery',QA_NAME]);
  assert.throws(()=>bucketNames('Listing buckets...\nname_changed: existing-unowned'));
});
test('ordinary Worker preflight accepts only empty history or exact missing-script10007',()=>{
  for(const kind of ['versions','deployments']){
    assert.equal(noOrdinaryScript(0,'[]','',kind),'empty-'+kind);
    assert.equal(noOrdinaryScript(1,'','A request to the Cloudflare API (/accounts/account/workers/scripts/'+QA_NAME+'/'+kind+') failed.\n[code: 10007]',kind),'missing-ordinary-script');
    for(const [status,out,error] of [[0,'[{"id":"ordinary-prod"}]',''],[0,'{}',''],[1,'','Authentication error [code: 10000]'],[1,'','Missing Worker [code: 10007]'],[1,'','/workers/scripts/flux-image-gen/'+kind+' [code: 10007]'],[null,'','timeout']])assert.throws(()=>noOrdinaryScript(status,out,error,kind));
  }
});
test('actual workerd enforces all-path auth before assets/R2 and cleans only owned prefix',{timeout:60000},async()=>{
  const runtime=await localRuntime();
  try {
    const auth={authorization:'Bearer '+runtime.vars.QA_ACCESS_TOKEN};
    for(const resource of ['/','/static/js/provenance.js','/static/vendor/c2pa/c2pa.wasm','/generate','/__qa/status','/__qa/cleanup','/?key='+key]){
      const response=await runtime.mf.dispatchFetch('https://local.test'+resource,{method:resource==='/__qa/cleanup'?'DELETE':'GET'});assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'private, no-store');
    }
    assert.equal(runtime.assetCalls.length,0);assert.equal((await runtime.bucket.list()).objects.length,0);
    const home=await runtime.mf.dispatchFetch('https://local.test/',{headers:auth});assert.equal(home.status,200);assert.equal(home.headers.get('content-security-policy'),runtime.csp);
    const status=await runtime.mf.dispatchFetch('https://local.test/__qa/status',{headers:auth}).then(r=>r.json());assert.equal(status.productionBindings,false);assert.equal(status.paidProviders,false);
    await runtime.bucket.put('qa-owner.json','keep');await runtime.bucket.put('qa-runs/other-run/original','keep');await runtime.bucket.put('qa-runs/'+runtime.vars.QA_RUN+'/fixtures/own','delete');
    const cleaned=await runtime.mf.dispatchFetch('https://local.test/__qa/cleanup',{method:'DELETE',headers:auth}).then(r=>r.json());assert.equal(cleaned.removed,1);
    assert.ok(await runtime.bucket.get('qa-owner.json'));assert.ok(await runtime.bucket.get('qa-runs/other-run/original'));assert.equal(await runtime.bucket.get('qa-runs/'+runtime.vars.QA_RUN+'/fixtures/own'),null);
    assert.equal(runtime.outbound.length,0);
  }finally{await runtime.close();}
});
