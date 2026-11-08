// Actual native file chooser with delayed/failed lazy edit JS, over local HTTPS.
// Static source/deploy assets only; no generation or provider transport exists.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import https from 'node:https';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const {chromium}=createRequire(path.join(root,'cloudflare/package.json'))('playwright');
const csp=readFileSync(path.join(root,'cloudflare/public/_headers'),'utf8').match(/Content-Security-Policy: (.+)/)[1];
for(const mode of ['source','deploy'])test(`visible ${mode} edit picker waits for lazy readiness and stays disabled on failure`,{timeout:60000},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'flux-edit-ready-')),base=path.join(root,mode==='source'?'app/static':'cloudflare/public');
  const cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  let providerRequests=0,browser;
  const server=https.createServer({cert:readFileSync(cert),key:readFileSync(key)},(req,res)=>{
    const url=new URL(req.url,'https://127.0.0.1');
    if(url.pathname==='/api/health'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({providers:{workersAI:true},providerList:['workers-ai']}));return;}
    if(req.method!=='GET'){providerRequests++;res.writeHead(503).end('No provider exists in readiness fixture');return;}
    const relative=url.pathname==='/'?'index.html':mode==='source'?url.pathname.replace(/^\/static\//,''):url.pathname.slice(1);
    const file=path.resolve(base,relative);
    if(!file.startsWith(base+path.sep)||!existsSync(file)){res.writeHead(404).end();return;}
    const type={'.html':'text/html','.js':'application/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.jpg':'image/jpeg','.webp':'image/webp'}[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'content-type':type,'content-security-policy':csp});res.end(readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='https://127.0.0.1:'+server.address().port;
  try{
    browser=await chromium.launch();
    for(const outcome of ['ready','failure','held-health']){
      const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block'});
      let release,seen,releaseHealth;const held=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{seen=resolve;}),healthHeld=new Promise(resolve=>{releaseHealth=resolve;});
      let healthRequests=0;
      try{
        await context.addInitScript(()=>localStorage.setItem('aiImageTutorialSeen.v1','true'));
        await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
        await context.route('**/static/image-edit.js',async route=>{seen();await held;if(outcome==='failure')await route.abort();else await route.continue();});
        if(outcome==='held-health')await context.route('**/api/health',async route=>{healthRequests++;await healthHeld;try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({providers:{workersAI:true},providerList:['workers-ai']})});}catch{/* context cleanup may cancel the intentionally held request */}});
        const page=await context.newPage();let choosers=0;page.on('filechooser',()=>choosers++);
        await page.goto(origin);await page.locator('#tab-edit').click();await requested;
        assert.equal(await page.locator('#editFiles').isDisabled(),true,'file input must be disabled before its handler exists');
        assert.equal(await page.locator('#editDrop').getAttribute('aria-disabled'),'true');
        assert.equal(await page.locator('#editDrop').getAttribute('aria-busy'),'true');
        await page.locator('#editDrop').click({force:true});assert.equal(choosers,0,'visible label must not open native chooser early');
        assert.equal(await page.evaluate(()=>{const drop=new Event('drop',{bubbles:true,cancelable:true});document.querySelector('#editDrop').dispatchEvent(drop);return drop.defaultPrevented;}),true,'unready file drop must not navigate away');
        release();
        if(outcome==='failure'){
          await assert.rejects(()=>page.evaluate(()=>ImageFeatureLoader.load('edit')));
          assert.equal(await page.locator('#editFiles').isDisabled(),true);
          assert.equal(await page.locator('#editDrop').getAttribute('aria-disabled'),'true');
          await page.locator('#editStatus').filter({hasText:'功能載入失敗'}).waitFor();
        }else{
          if(outcome==='held-health'){
            await page.waitForFunction(()=>Boolean(window.ImageEdit&&window.ImageEdit.applyHealth));
            assert.ok(healthRequests>0,'actual provider-health transport must be pending');
            assert.equal(await page.locator('#editGo').isDisabled(),true,'held health must retain existing provider submit policy');
          }else await page.evaluate(()=>ImageFeatureLoader.load('edit'));
          assert.equal(await page.locator('#editFiles').isDisabled(),false);
          assert.equal(await page.locator('#editDrop').getAttribute('aria-disabled'),'false');
          const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.locator('#editDrop').click()]);
          await chooser.setFiles(path.join(root,'tests/fixtures/provenance/C.jpg'));
          await page.waitForFunction(()=>document.querySelectorAll('.edit-thumb').length===1);
          assert.equal(choosers,1);assert.equal(await page.locator('#editFiles').evaluate(input=>input.files.length),0);
        }
      }finally{release();releaseHealth();await context.close();}
    }
    assert.equal(providerRequests,0);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
