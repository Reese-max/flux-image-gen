// Fixed-scope CI controller. This module does nothing remotely on import.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync,existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_NAME, QA_BUCKET, QA_KIND, FEATURE_HEAD, FEATURE_TREE, RUN, SHA, KEY } from './contract.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const here = path.join(root, 'cloudflare/qa');
const owner = { schema:1, repository:'Reese-max/flux-image-gen', worker:QA_NAME, bucket:QA_BUCKET, purpose:QA_KIND };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function requireValue(condition, message) { if (!condition) throw new Error(message); }
export function validateSource(base = root) {
  const manifest = JSON.parse(readFileSync(path.join(base,'cloudflare/qa/frozen-source.json'),'utf8'));
  requireValue(manifest.featureHead===FEATURE_HEAD && manifest.featureTree===FEATURE_TREE,'Frozen manifest identity changed');
  const entries=Object.entries(manifest.sha256);
  requireValue(entries.length>=250,'Incomplete frozen manifest');
  for(const [name,hash] of entries) {
    requireValue(!name.includes('..')&&!path.isAbsolute(name)&&/^[a-f0-9]{64}$/.test(hash),'Invalid frozen path');
    requireValue(sha256(readFileSync(path.join(base,name)))===hash,'Frozen source changed: '+name);
  }
  const walk = dir => readdirSync(path.join(base,dir)).flatMap(name=>{
    const relative=dir+'/'+name;return statSync(path.join(base,relative)).isDirectory()?walk(relative):[relative];
  });
  for(const dir of ['app','cloudflare/src','cloudflare/public'])
    for(const name of walk(dir)) requireValue(Object.hasOwn(manifest.sha256,name),'Unreviewed product source: '+name);
  return {head:FEATURE_HEAD,tree:FEATURE_TREE,files:entries.length};
}
export function validateConfig(config) {
  const canonical=JSON.parse(readFileSync(path.join(here,'wrangler.json'),'utf8'));
  // An explicit shape check prevents a changed canonical file authorizing new bindings.
  requireValue(JSON.stringify(Object.keys(config).sort())===JSON.stringify(['name','main','compatibility_date','compatibility_flags','workers_dev','preview_urls','routes','assets','rules','observability','previews'].sort()),'Unexpected QA config field');
  requireValue(config.name===QA_NAME && config.main==='entry.mjs' && config.workers_dev===false && config.preview_urls===true,'Unsafe QA identity/routing');
  requireValue(config.compatibility_date==='2026-06-24'&&JSON.stringify(config.compatibility_flags)==='["nodejs_compat"]','Unexpected runtime compatibility');
  requireValue(JSON.stringify(config.routes)==='[]' && config.observability.enabled===false,'Unsafe QA routes/logging');
  requireValue(JSON.stringify(config.assets)===JSON.stringify({directory:'../public',binding:'ASSETS',run_worker_first:true}),'Assets must authenticate first');
  requireValue(JSON.stringify(Object.keys(config.previews).sort())===JSON.stringify(['vars','r2_buckets','version_metadata','observability'].sort()),'Unexpected Preview binding or paid-only limit override');
  requireValue(JSON.stringify(config.previews.r2_buckets)===JSON.stringify([{binding:'QA_BUCKET',bucket_name:QA_BUCKET}]),'Unsafe QA R2 binding');
  requireValue(JSON.stringify(config.previews.vars)===JSON.stringify({QA_KIND,QA_FROZEN_TREE:FEATURE_TREE}),'Unexpected Preview variable');
  requireValue(JSON.stringify(config.rules)===JSON.stringify([{type:'Data',globs:['**/tests/fixtures/provenance/*.jpg'],fallthrough:true}]),'Unexpected module rule');
  requireValue(JSON.stringify(config.previews.version_metadata)==='{"binding":"CF_VERSION_METADATA"}'&&JSON.stringify(config.previews.observability)==='{"enabled":false}','Unexpected Preview runtime setting');
  requireValue(JSON.stringify(config)===JSON.stringify(canonical),'QA config differs from reviewed config');
  return config;
}
export function validateAdmission(env, event, pr, checkedOut) {
  const supplied=event.pull_request;
  requireValue(env.GITHUB_EVENT_NAME==='pull_request' && env.GITHUB_REPOSITORY===owner.repository,'Only same-repo pull_request allowed');
  requireValue(env.GITHUB_ACTOR==='Reese-max' && env.GITHUB_TRIGGERING_ACTOR==='Reese-max','Only owner-triggered QA allowed');
  requireValue(supplied?.number===45 && pr.number===45 && pr.state==='open' && pr.draft===true,'Only open draft PR45 allowed');
  requireValue(pr.user?.login==='Reese-max' && pr.head?.repo?.full_name===owner.repository && supplied.head?.repo?.full_name===owner.repository,'Fork/nonowner PR refused');
  requireValue(pr.base?.ref==='main' && pr.head?.ref==='feature/flux-reliability-sweep-20261024','Unexpected PR branch');
  requireValue(SHA.test(checkedOut) && pr.head.sha===checkedOut && supplied.head.sha===checkedOut,'PR head changed; rerun exact head');
  requireValue(RUN.test(env.GITHUB_RUN_ID+'-'+env.GITHUB_RUN_ATTEMPT),'Invalid CI run identity');
  return {run:env.GITHUB_RUN_ID+'-'+env.GITHUB_RUN_ATTEMPT,sourceSha:checkedOut};
}
export function immutableOrigin(url, deploymentId) {
  requireValue(/^[a-z0-9-]{8,64}$/.test(deploymentId),'Invalid Preview deployment ID');
  const parsed=new URL(url);
  requireValue(parsed.protocol==='https:' && !parsed.username&&!parsed.password&&!parsed.port&&!parsed.search&&!parsed.hash && parsed.pathname==='/','Unsafe Preview URL');
  const suffix='-'+QA_NAME+'.';
  const host=parsed.hostname;
  requireValue(host.startsWith(deploymentId+suffix) && /^[a-z0-9-]+\.workers\.dev$/.test(host.slice((deploymentId+suffix).length)),'Expected immutable QA deployment URL');
  return parsed.origin;
}
export function parseSecretDeployment(output) {
  const clean=output.replace(/\x1b\[[0-9;]*m/g,'');
  const match=clean.match(/Created Preview deployment ([a-z0-9-]{8,64}) with secret QA_ACCESS_TOKEN\./);
  requireValue(match,'Wrangler did not return a secret-bound Preview deployment');
  const urls=clean.match(/https:\/\/[^\s,]+/g)||[];
  const safe=urls.flatMap(url=>{try{return [immutableOrigin(url,match[1])];}catch{return [];}});
  requireValue(safe.length===1,'Expected one immutable secret-bound Preview URL');
  return {deploymentId:match[1],origin:safe[0]};
}
export function parseInitialDeployment(output,previewName) {
  const first=JSON.parse(output);
  requireValue(first.preview?.worker_name===QA_NAME&&first.preview?.name===previewName,'Unexpected first Preview identity');
  requireValue(Array.isArray(first.deployment?.urls)&&first.deployment.urls.length===1,'Missing initial immutable deployment URL');
  return immutableOrigin(first.deployment.urls[0],first.deployment.id);
}
export function noOrdinaryScript(status,stdout,stderr,kind) {
  requireValue(['versions','deployments'].includes(kind),'Invalid Worker preflight');
  if(status===0){const entries=JSON.parse(stdout);requireValue(Array.isArray(entries)&&entries.length===0,'QA Worker collides with an ordinary '+kind+' history');return 'empty-'+kind;}
  const message=stdout+'\n'+stderr;
  requireValue(/\[code:\s*10007\]/.test(message)&&message.includes('/workers/scripts/'+QA_NAME+'/'+kind)&&!(/\[code:\s*(10000|9109)\]/.test(message)),'Worker preflight did not prove missing ordinary script');
  return 'missing-ordinary-script';
}
export function sanitizedFailure(output, key='') {
  // Artifact masking is stricter than log masking: no raw diagnostic sentence,
  // token-like string or account identifier is ever copied to a receipt.
  const raw=String(output).replace(/\x1b\[[0-9;]*m/g,'');
  const withoutKey=key?raw.split(key).join('[redacted]').split(Buffer.from('flux-qa:'+key).toString('base64')).join('[redacted]'):raw;
  const codes=[...withoutKey.matchAll(/\[code:\s*([0-9]{3,8})\]/g)].map(match=>'Cloudflare API code: '+match[1]);
  const classification=/Authentication error/i.test(withoutKey)?['Authentication error']:/permission|not authorized|insufficient/i.test(withoutKey)?['Permission request failed']:[];
  const endpoint=withoutKey.includes('/r2/buckets')?['API endpoint: /accounts/[account]/r2/buckets']:
    withoutKey.includes('/workers/scripts/'+QA_NAME)?['API endpoint: /accounts/[account]/workers/scripts/'+QA_NAME]:
    withoutKey.includes('/workers/workers/'+QA_NAME)?['API endpoint: /accounts/[account]/workers/workers/'+QA_NAME]:[];
  return [...new Set([...codes,...classification,...endpoint])].slice(0,8);
}
export function bucketNames(output) {
  const clean=output.replace(/\x1b\[[0-9;]*m/g,'');
  const names=[...clean.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map(match=>match[1]);
  if(names.length)return names;
  const lines=clean.split('\n').map(line=>line.trim()).filter(Boolean);
  requireValue(lines.includes('Listing buckets...')&&lines.every(line=>line==='Listing buckets...'||/wrangler 4\.135\.0/.test(line)||/^[─━\s]+$/.test(line)),'Unrecognised R2 inventory output');
  return [];
}
function cli(args,{input,key,ordinaryKind}={}) {
  const result=spawnSync(process.execPath,[path.join(here,'node_modules/wrangler/bin/wrangler.js'),...args],{
    cwd:root,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',NO_COLOR:'1'},input,encoding:'utf8',maxBuffer:8*1024*1024,timeout:240000
  });
  if(ordinaryKind){try{return noOrdinaryScript(result.status,result.stdout,result.stderr,ordinaryKind);}catch{const error=new Error('Ordinary Worker collision/permission preflight failed: '+ordinaryKind);error.receipt={exitCode:result.status,details:sanitizedFailure(result.stdout+'\n'+result.stderr,key)};throw error;}}
  if(result.status!==0){const error=new Error('Wrangler command failed: '+args.slice(0,3).join(' '));error.receipt={exitCode:result.status,details:sanitizedFailure(result.stdout+'\n'+result.stderr,key)};throw error;}
  return result.stdout;
}
export function failureReceipt(stage,error,identity={}) {
  const allowed=['initial_preflight','worker_preflight','r2_inventory','r2_owner_read','r2_create','initial_preview','missing_key_denial','preview_secret_put','secret_bound_status'];
  const safeStage=allowed.includes(stage)?stage:'initial_preflight';
  const receipt=error?.receipt;
  const safeDetails=Array.isArray(receipt?.details)?receipt.details.filter(value=>typeof value==='string'&&(/^(Cloudflare API code: [0-9]{3,8}|Authentication error|Permission request failed)$/.test(value)||value==='API endpoint: /accounts/[account]/r2/buckets'||value==='API endpoint: /accounts/[account]/workers/scripts/'+QA_NAME||value==='API endpoint: /accounts/[account]/workers/workers/'+QA_NAME)):[];
  const safeIdentity={};
  if(typeof identity.run==='string'&&RUN.test(identity.run))safeIdentity.run=identity.run;
  if(typeof identity.sourceSha==='string'&&SHA.test(identity.sourceSha))safeIdentity.sourceSha=identity.sourceSha;
  return {status:'FAILED_CLOSED',...safeIdentity,worker:QA_NAME,bucket:QA_BUCKET,action:safeStage,wrangler:receipt?{exitCode:Number.isInteger(receipt.exitCode)?receipt.exitCode:null,details:safeDetails}:null,noCredentialFallback:true};
}
export function emitFailureReceipt(stage,error,identity={},write=value=>process.stdout.write(value)) {
  const report=failureReceipt(stage,error,identity);
  // Print the exact bounded receipt, never Error.message or subprocess output.
  // This remains inspectable when an artifact file reference cannot be read.
  write(JSON.stringify(report)+'\n');return report;
}
function gh(args) {
  const result=spawnSync('gh',[...args,'--hostname','github.com'],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  requireValue(result.status===0,'Fresh PR metadata unavailable');return result.stdout;
}
export function admitted() {
  validateSource();validateConfig(JSON.parse(readFileSync(path.join(here,'wrangler.json'),'utf8')));
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
  requireValue(git.status===0,'Checkout identity unavailable');
  return validateAdmission(process.env,JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),JSON.parse(gh(['api','repos/'+owner.repository+'/pulls/45'])),git.stdout.trim());
}
function statePaths() {
  requireValue(process.env.RUNNER_TEMP&&path.isAbsolute(process.env.RUNNER_TEMP),'Runner temp directory required');
  const dir=path.join(process.env.RUNNER_TEMP,'flux-isolated-qa');mkdirSync(dir,{recursive:true,mode:0o700});
  return {dir,state:path.join(dir,'private-state.json'),config:path.join(dir,'wrangler.json'),marker:path.join(dir,'owner.json')};
}
export async function prepare() {
  const identity=admitted(),paths=statePaths();
  requireValue(!existsSync(paths.state),'QA private state already exists; do not republish same run');
  requireValue(!process.env.WRANGLER_API_TOKEN && !process.env.CLOUDFLARE_API_KEY,'Alternate credentials refused');
  requireValue(!process.env.CLOUDFLARE_API_BASE_URL&&!process.env.CF_API_BASE_URL,'Cloudflare API endpoint override refused');
  requireValue(Boolean(process.env.CLOUDFLARE_API_TOKEN)&&Boolean(process.env.CLOUDFLARE_ACCOUNT_ID),'Missing required environment CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID');
  requireValue(JSON.parse(readFileSync(path.join(here,'node_modules/wrangler/package.json'),'utf8')).version==='4.135.0','Wrong QA Wrangler version');
  const key=randomBytes(32).toString('hex');
  // These protocol directives are consumed by GitHub Actions; values never enter reports.
  process.stdout.write('::add-mask::'+key+'\n::add-mask::'+Buffer.from('flux-qa:'+key).toString('base64')+'\n');
  const now=Date.now(),config=JSON.parse(readFileSync(path.join(here,'wrangler.json'),'utf8'));
  config.main=path.join(here,'entry.mjs');config.assets.directory=path.join(root,'cloudflare/public');
  Object.assign(config.previews.vars,{QA_RUN:identity.run,QA_SOURCE_SHA:identity.sourceSha,QA_CREATED_AT:new Date(now).toISOString(),QA_EXPIRES_AT:new Date(now+3_600_000).toISOString()});
  writeFileSync(paths.config,JSON.stringify(config),{mode:0o600});writeFileSync(paths.marker,JSON.stringify(owner),{mode:0o600});
  const state={...identity,key,expiresAt:config.previews.vars.QA_EXPIRES_AT,previewName:'pr45-'+identity.run};
  writeFileSync(paths.state,JSON.stringify(state),{mode:0o600});
  let stage='worker_preflight';
  try {
    const ordinaryPreflight={};
    for(const kind of ['versions','deployments'])ordinaryPreflight[kind]=cli([kind,'list','--name',QA_NAME,'--json','--config',paths.config],{key,ordinaryKind:kind});
    stage='r2_inventory';const buckets=cli(['r2','bucket','list','--config',paths.config],{key});
    const names=bucketNames(buckets);
    if(names.includes(QA_BUCKET)) {
      stage='r2_owner_read';
      const marker=path.join(paths.dir,'remote-owner.json');
      cli(['r2','object','get',QA_BUCKET+'/qa-owner.json','--remote','--file',marker,'--config',paths.config],{key});
      requireValue(JSON.stringify(JSON.parse(readFileSync(marker,'utf8')))===JSON.stringify(owner),'Existing QA bucket is not owned by this workflow');
    } else {
      stage='r2_create';
      admitted();cli(['r2','bucket','create',QA_BUCKET,'--update-config','false','--config',paths.config],{key});
      cli(['r2','object','put',QA_BUCKET+'/qa-owner.json','--remote','--file',paths.marker,'--content-type','application/json','--force','--config',paths.config],{key});
    }
    admitted();
    stage='initial_preview';
    state.initialOrigin=parseInitialDeployment(cli(['preview','--config',paths.config,'--name',state.previewName,'--ignore-base-config','--json'],{key}),state.previewName);
    // No secret yet: every asset/API must deny. No auth header is sent here.
    stage='missing_key_denial';for(const asset of ['/','/__qa/status','/static/provenance.js','/static/vendor/c2pa.wasm','/static/vendor/c2pa-worker.js']) {
      const response=await fetch(state.initialOrigin+asset,{redirect:'error'});
      requireValue(response.status===401,'Initial missing-key Preview was not deny-all');await response.arrayBuffer();
    }
    admitted();
    stage='preview_secret_put';
    Object.assign(state,parseSecretDeployment(cli(['preview','secret','put','QA_ACCESS_TOKEN','--config',paths.config,'--name',state.previewName],{input:key+'\n',key})));
    writeFileSync(paths.state,JSON.stringify(state),{mode:0o600});
    stage='secret_bound_status';const status=await fetch(state.origin+'/__qa/status',{headers:{authorization:'Bearer '+key},redirect:'error'}).then(async response=>{requireValue(response.status===200,'Secret-bound Preview not ready');return response.json();});
    requireValue(status.kind===QA_KIND&&status.run===state.run&&status.sourceSha===state.sourceSha&&status.frozenTree===FEATURE_TREE,'Preview status identity mismatch');
    const report={status:'READY_FOR_BROWSER',...identity,worker:QA_NAME,bucket:QA_BUCKET,previewName:state.previewName,deploymentId:state.deploymentId,origin:state.origin,frozenHead:FEATURE_HEAD,frozenTree:FEATURE_TREE,noProductionDeployment:true,ordinaryPreflight,noPaidProviderCalls:true,expiresAt:state.expiresAt};
    writeFileSync(path.join(root,'output/qa/preview.json'),JSON.stringify(report,null,2));
    return report;
  } catch(error) {
    const report=emitFailureReceipt(stage,error,identity);
    writeFileSync(path.join(root,'output/qa/preview.json'),JSON.stringify(report,null,2));throw new Error('Isolated QA stopped; see sanitized preview.json');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  mkdirSync(path.join(root,'output/qa'),{recursive:true});
  if(process.argv[2]==='validate') console.log(JSON.stringify({source:validateSource(),config:Boolean(validateConfig(JSON.parse(readFileSync(path.join(here,'wrangler.json'),'utf8'))))}));
  else if(process.argv[2]==='prepare') {
    try{await prepare();}catch{
      const file=path.join(root,'output/qa/preview.json');if(!existsSync(file))writeFileSync(file,JSON.stringify(emitFailureReceipt('initial_preflight',null),null,2));
      throw new Error('Isolated QA stopped; see sanitized preview.json');
    }
  }
  else throw new Error('Use validate or prepare');
}
