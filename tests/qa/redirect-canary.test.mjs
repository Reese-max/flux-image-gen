import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root } from '../../cloudflare/qa/control.mjs';
import { createQaOriginRouter } from '../../cloudflare/qa/browser.mjs';
import { localRuntime } from './local-runtime.mjs';
const {chromium}=createRequire(path.join(root,'cloudflare/package.json'))('playwright');
test('two-origin redirect canary never forwards QA Authorization or requests to external destination',{timeout:60000},async()=>{
  const received=[],key='b'.repeat(64);
  const canary=await localRuntime({}, {request(req,res){received.push({path:req.url,authorization:Boolean(req.headers.authorization)});res.writeHead(200,{'Access-Control-Allow-Origin':'*'}).end('external');return true;}});
  const external=canary.origin;
  let authorizedSource=0,followedSameOrigin=0;
  const runtime=await localRuntime({}, {request(req,res){
    if(req.url==='/__canary/redirect'){if(req.headers.authorization==='Bearer '+key)authorizedSource++;res.writeHead(302,{Location:external+'/stolen'}).end();return true;}
    if(req.url==='/__canary/same'){res.writeHead(302,{Location:'/__canary/finish'}).end();return true;}
    if(req.url==='/__canary/finish'){followedSameOrigin++;res.end('unsafe redirect followed');return true;}
    if(req.url==='/__canary/worker.js'){res.writeHead(200,{'Content-Type':'application/javascript'}).end('fetch('+JSON.stringify(external+'/from-worker')+').then(()=>postMessage("unexpected")).catch(()=>postMessage("blocked"));');return true;}
    return false;
  }});
  let browser,context,router;
  try{
    browser=await chromium.launch();context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
    router=createQaOriginRouter({origin:runtime.origin,key,local:true});await context.route('**/*',router.handle);
    for(const url of [runtime.origin+'/__canary/redirect',runtime.origin+'/__canary/same',external+'/direct']){
      const rejectedPage=await context.newPage();await assert.rejects(()=>rejectedPage.goto(url));await rejectedPage.close();
    }
    const page=await context.newPage();
    await page.goto(runtime.origin);
    const workerResult=await page.evaluate(()=>new Promise(resolve=>{const worker=new Worker('/__canary/worker.js',{type:'module'});const timer=setTimeout(()=>{worker.terminate();resolve('timeout');},10000);worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};worker.onerror=()=>{clearTimeout(timer);worker.terminate();resolve('worker-error');};}));
    assert.equal(workerResult,'blocked','dedicated module Worker must execute and have outbound fetch blocked');
    assert.equal(authorizedSource,1);assert.equal(followedSameOrigin,0);assert.deepEqual(received,[]);
    assert.equal(router.stats.redirectsRejected,2);assert.ok(router.stats.externalBlocked>=2);assert.equal(router.stats.failures,0);
  }finally{await router?.finish();await context?.close();await browser?.close();await runtime.close();await canary.close();}
});
