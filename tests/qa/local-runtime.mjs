// A local HTTPS bridge into the actual QA Worker in workerd and persisted R2.
// No Cloudflare account/token/config is loaded. Outbound Worker fetch is denied.
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { root } from '../../cloudflare/qa/control.mjs';
import { QA_KIND, FEATURE_TREE } from '../../cloudflare/qa/contract.mjs';
const require=createRequire(path.join(root,'cloudflare/package.json'));
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const csp=readFileSync(path.join(root,'cloudflare/public/_headers'),'utf8').match(/Content-Security-Policy: (.+)/)[1];
export async function localRuntime(overrides={},hooks={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'flux-isolated-https-')),outbound=[],assetCalls=[];
  const bundled=await build({entryPoints:[path.join(root,'cloudflare/qa/entry.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',loader:{'.jpg':'binary'},write:false});
  const vars={QA_KIND,QA_FROZEN_TREE:FEATURE_TREE,QA_RUN:'12345-1',QA_SOURCE_SHA:'a'.repeat(40),QA_ACCESS_TOKEN:'b'.repeat(64),QA_CREATED_AT:new Date(Date.now()-1000).toISOString(),QA_EXPIRES_AT:new Date(Date.now()+600_000).toISOString(),CF_VERSION_METADATA:{id:'isolated-local-https-fixture'},...overrides};
  const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-06-24',compatibilityFlags:['nodejs_compat'],bindings:vars,r2Buckets:['QA_BUCKET'],r2Persist:path.join(dir,'r2'),
    outboundService:request=>{outbound.push(new URL(request.url).origin);return new Response('Denied fixture outbound',{status:502});},
    serviceBindings:{ASSETS:request=>{
      const url=new URL(request.url);assetCalls.push(url.pathname);
      const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
      const base=path.join(root,'cloudflare/public'),file=path.resolve(base,relative);
      if(!file.startsWith(base+path.sep)||!existsSync(file))return new Response('Missing local asset',{status:404});
      const type={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.jpg':'image/jpeg','.webp':'image/webp','.webmanifest':'application/manifest+json'}[path.extname(file)]||'application/octet-stream';
      return new Response(readFileSync(file),{headers:{'content-type':type,'content-security-policy':csp,'x-content-type-options':'nosniff'}});
    }}});
  await mf.ready;
  const cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'ignore'});
  const server=https.createServer({cert:readFileSync(cert),key:readFileSync(key)},async(req,res)=>{
    try {if(hooks.request?.(req,res))return;const parts=[];for await(const chunk of req)parts.push(chunk);
      const response=await mf.dispatchFetch('https://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(parts.length?{body:Buffer.concat(parts)}:{})});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500).end('Local QA bridge failed');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {mf,vars,outbound,assetCalls,origin:'https://127.0.0.1:'+server.address().port,csp,bucket:await mf.getR2Bucket('QA_BUCKET'),
    async close(){await new Promise(resolve=>server.close(resolve));await mf.dispose();rmSync(dir,{recursive:true,force:true});}};
}
