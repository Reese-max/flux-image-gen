import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {root} from '../../cloudflare/qa/control.mjs';
import {createQaOriginRouter,selectEditInput} from '../../cloudflare/qa/browser.mjs';
import {localRuntime} from './local-runtime.mjs';
const {chromium}=createRequire(path.join(root,'cloudflare/package.json'))('playwright');
test('delayed real lazy edit script: old file event is dropped, actual driver waits for registered listener',{timeout:60000},async()=>{
  const runtime=await localRuntime(),bytes=readFileSync(path.join(root,'tests/fixtures/provenance/C.jpg'));
  let browser;
  try{
    browser=await chromium.launch();
    for(const mode of ['old','current','held-health']){
      const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',httpCredentials:{origin:runtime.origin,username:'flux-qa',password:runtime.vars.QA_ACCESS_TOKEN}});
      const router=createQaOriginRouter({origin:runtime.origin,key:runtime.vars.QA_ACCESS_TOKEN,local:true});
      let release,seen,releaseHealth;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{seen=resolve;}),healthHeld=new Promise(resolve=>{releaseHealth=resolve;});
      let healthRequests=0;
      try{
        await context.route('**/*',router.handle);
        await context.route('**/static/image-edit.js',async route=>{seen();await held;await router.handle(route);});
        if(mode==='held-health')await context.route('**/api/health',async route=>{healthRequests++;await healthHeld;try{await router.handle(route);}catch{/* canceled held fixture on cleanup */}});
        await context.addInitScript(()=>localStorage.setItem('aiImageTutorialSeen.v1','true'));
        const page=await context.newPage();await page.goto(runtime.origin);
        if(mode==='old'){
          await page.locator('#tab-edit').click();await requested;
          assert.equal(await page.evaluate(()=>Boolean(window.ImageEdit)),false);
          await page.locator('#editFiles').setInputFiles({name:'signed.jpg',mimeType:'image/jpeg',buffer:bytes});
          release();await page.evaluate(()=>ImageFeatureLoader.load('edit'));
          assert.equal(await page.locator('.edit-thumb').count(),0,'old change event arrived before real handler');
        }else{
          const selected=selectEditInput(page,bytes);await requested;
          assert.equal(await page.locator('#editFiles').evaluate(input=>input.files.length),0,'actual driver must not select before feature readiness');
          release();await selected;
          assert.equal(await page.locator('.edit-thumb').count(),1);
          assert.equal(router.stats.failures,0);
          if(mode==='held-health'){assert.ok(healthRequests>0);assert.equal(await page.locator('#editGo').isDisabled(),true);}
        }
      }finally{release();releaseHealth();await router.finish();await context.close();}
    }
    assert.equal(runtime.outbound.length,0);
  }finally{await browser?.close();await runtime.close();}
});
