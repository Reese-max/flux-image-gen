// Real Chromium + real C2PA WASM + workerd + local R2. Provider outputs are
// frozen files; outbound Worker fetch is denied. No account/config/deployment.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'cloudflare/package.json'));
const { chromium } = require('playwright');
const { Miniflare } = require('miniflare');
const { build } = require('esbuild');
const fixtures = path.join(root, 'tests/fixtures/provenance');
const signed = readFileSync(path.join(fixtures, 'C.jpg'));
const absent = readFileSync(path.join(fixtures, 'absent.jpg'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const csp = readFileSync(path.join(root, 'cloudflare/public/_headers'), 'utf8').match(/Content-Security-Policy: (.+)/)[1];
const tampered = Buffer.from(signed);
let sos = -1;
for (let i = 2; i < tampered.length - 3; i++) if (tampered[i] === 255 && tampered[i + 1] === 218) { sos = i; break; }
assert.ok(sos > 0, 'signed fixture must contain JPEG entropy');
tampered[sos + 100] ^= 1;

async function runtime() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'flux-provenance-workerd-'));
  const bundled = await build({ stdin: { resolveDir: root, sourcefile: 'offline-provenance-worker.mjs', contents: `
    import worker from './cloudflare/src/index.js';
    let scenario = 'signed', gate = 'development', calls = 0;
    export default { async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === '/__fixture/control') {
        const input = await request.json(); scenario = input.scenario || 'signed'; gate = input.gate || 'development';
        return Response.json({ scenario, gate, calls });
      }
      if (url.pathname === '/__fixture/status') return Response.json({ scenario, gate, calls });
      const bound = { ...env, ENVIRONMENT: gate === 'development' ? 'development' : 'production',
        TURNSTILE_REQUIRED: gate === 'development' ? 'false' : 'true', POLLINATIONS_FALLBACK_ENABLED: 'false', VISION_QA_ENABLED: 'false',
        GALLERY_TOKEN_SECRET: 'synthetic-local-gallery-signing-only',
        CF_VERSION_METADATA: { id: 'isolated-workerd-fixture-build' },
        AI: { async run() {
          calls++; const object = await env.FIXTURE_BUCKET.get(scenario);
          if (!object) throw new Error('Unknown local provider fixture');
          const bytes = new Uint8Array(await object.arrayBuffer()); let text = '';
          for (let i=0; i<bytes.length; i+=32768) text += String.fromCharCode.apply(null, bytes.subarray(i,i+32768));
          return { image: btoa(text) };
        } } };
      if (gate === 'missing-turnstile') bound.GENERATE_RATE_LIMITER = { async limit() { return { success:true }; } };
      return worker.fetch(request, bound, ctx);
    } };
  ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
  const outbound = [];
  const mf = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-06-24', compatibilityFlags: ['nodejs_compat'],
    r2Buckets: ['IMAGE_BUCKET', 'FIXTURE_BUCKET'], r2Persist: workdir,
    outboundService: request => { outbound.push(new URL(request.url).origin); return new Response('Offline fixture denies outbound transport', { status: 502 }); } });
  await mf.ready;
  const source = await mf.getR2Bucket('FIXTURE_BUCKET');
  for (const [name, bytes] of Object.entries({ signed, absent, tampered })) await source.put(name, bytes);
  const gallery = await mf.getR2Bucket('IMAGE_BUCKET');
  const servers = [];
  return { mf, source, gallery, outbound,
    async serve(mode) {
      const base = path.join(root, mode === 'deploy' ? 'cloudflare/public' : 'app/static');
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/static/'))) {
            const relative = url.pathname === '/' ? 'index.html' : (mode === 'deploy' ? url.pathname.slice(1) : url.pathname.slice(8));
            const file = path.resolve(base, relative);
            if (!file.startsWith(base + path.sep) || !existsSync(file)) return res.writeHead(404).end();
            const type = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.wasm':'application/wasm', '.json':'application/json', '.jpg':'image/jpeg', '.webp':'image/webp' }[path.extname(file)] || 'application/octet-stream';
            // SDK inline workers on localhost HTTP require blob:; production
            // HTTPS uses the unmodified same-origin module-worker CSP.
            res.writeHead(200, { 'content-type':type, 'content-security-policy': csp.replace("worker-src 'self'", "worker-src 'self' blob:") });
            return res.end(readFileSync(file));
          }
          if (['/service-worker.js','/manifest.webmanifest'].includes(url.pathname)) return res.writeHead(404).end();
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          const response = await mf.dispatchFetch(`http://${req.headers.host}${req.url}`, {
            method:req.method, headers:req.headers, ...(chunks.length ? { body:Buffer.concat(chunks) } : {}) });
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) { res.writeHead(500).end('Isolated test server error'); }
      });
      servers.push(server); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); await mf.dispose(); rmSync(workdir,{recursive:true,force:true}); }
  };
}

for (const mode of ['source','deploy']) {
  test(`workerd/R2 ${mode}: signed/absent/stripped/tampered UI generation+edit share/download/JSON roundtrip`, {timeout:180000}, async () => {
    const local = await runtime();
    const browser = await chromium.launch({headless:true});
    const stats = [];
    try {
      const origin = await local.serve(mode);
      const control = (scenario, gate='development') => local.mf.dispatchFetch(origin+'/__fixture/control', {method:'POST',body:JSON.stringify({scenario,gate})}).then(r=>r.json());
      // Actual deployed handlers must still stop before fixture/provider work.
      for (const gate of ['missing-limiter','missing-turnstile']) {
        await control('signed',gate);
        const response = await local.mf.dispatchFetch(origin+'/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'a cat',model:'schnell',size:'square',seed:42})});
        assert.equal(response.status,503);
      }
      assert.equal((await control('signed')).calls,0);
      for (const [scenario,status] of [['signed','present_untrusted'],['absent','absent'],['stripped','absent'],['tampered','invalid']]) {
        const context = await browser.newContext({acceptDownloads:true});
        const blocked = [], errors = [];
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) { blocked.push(url.origin); return route.abort(); }
          return route.continue();
        });
        await context.addInitScript(() => localStorage.setItem('aiImageTutorialSeen.v1','true'));
        const page = await context.newPage(); page.on('pageerror',error=>errors.push(error.message));
        await page.goto(origin);
        await page.evaluate(() => { const modal=document.querySelector('#tutorialModal'); if(modal&&!modal.hidden) document.querySelector('#finishTutorial').click(); });
        if (scenario==='stripped') {
          const bytes = await page.evaluate(async data => {
            const img=new Image();img.src=data;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
            canvas.getContext('2d').drawImage(img,0,0);return canvas.toDataURL('image/jpeg').split(',')[1];
          },'data:image/jpeg;base64,'+signed.toString('base64'));
          await local.source.put('stripped',Buffer.from(bytes,'base64'));
        }
        const fixtureBytes = Buffer.from(await (await local.source.get(scenario)).arrayBuffer());
        const start = (await control(scenario)).calls;
        await page.locator('#plainPrompt').fill('private artwork '+scenario);
        await page.evaluate(() => {document.querySelector('#advancedSettings').open=true;ImageGenApp.setGenerationSettings({model:'schnell'});});
        await page.locator('#prompt').fill('a cat in a garden');
        const generationResponse = page.waitForResponse(response => new URL(response.url()).pathname==='/generate' && response.request().method()==='POST');
        await page.locator('#go').click();
        const generated = await (await generationResponse).json();
        assert.ok(generated.galleryToken,'real Worker generation must issue its own gallery capability');
        await page.waitForFunction(() => ImageHistoryStore.loadRecords()[0]?.provenance?.receipt_sha256);
        const parent=await page.evaluate(()=>ImageHistoryStore.loadRecords()[0]);
        assert.equal(parent.provenance.credential.status,status);
        assert.equal(parent.provenance.output_sha256,hash(fixtureBytes));
        assert.equal(parent.provenance.build_version,'isolated-workerd-fixture-build');
        const downloadPromise=page.waitForEvent('download');await page.locator('#dl').click();
        assert.deepEqual(readFileSync(await(await downloadPromise).path()),fixtureBytes);
        await page.locator('#tab-history').click();await page.evaluate(item=>ImageHistoryWall.openHistoryDetail(item),parent);
        const exportPromise=page.waitForEvent('download');await page.locator('#exportHistoryJson').click();
        const artwork=JSON.parse(readFileSync(await(await exportPromise).path(),'utf8'));
        assert.doesNotMatch(JSON.stringify(artwork),/private artwork|a cat in a garden|galleryToken|deleteToken/);
        assert.equal(artwork.provenance.receipt_sha256,parent.provenance.receipt_sha256);
        assert.equal(await page.evaluate(item=>ImageProvenance.verifyReceipt(ImageHistoryStore.parseRecords(JSON.stringify(item))[0]).then(r=>r.status),artwork),'hash_verified');
        const receiptPromise=page.waitForEvent('download');await page.locator('#downloadHistoryReceipt').click();
        assert.deepEqual(JSON.parse(readFileSync(await(await receiptPromise).path(),'utf8')),parent.provenance);
        // Rehashing an unsigned internal receipt does not create issuer trust.
        const changed=await page.evaluate(item=>ImageProvenance.verifyReceipt({...item,image:item.image.slice(0,-4)+'AAAA'}),parent);
        assert.equal(changed.status,'modified');
        await page.locator('#closeHistoryDetail').click();await page.locator('#tab-edit').click();
        await page.locator('#editFiles').setInputFiles({name:'local-fixture.jpg',mimeType:'image/jpeg',buffer:fixtureBytes});
        await page.waitForFunction(()=>document.querySelectorAll('.edit-thumb').length===1);
        await page.locator('#editPrompt').fill('Make the scene blue');await page.locator('#editGo').click();
        await page.waitForFunction(()=>ImageHistoryStore.loadRecords().length===2&&ImageHistoryStore.loadRecords()[0]?.provenance?.receipt_sha256);
        const child=await page.evaluate(()=>ImageHistoryStore.loadRecords()[0]);
        assert.equal(child.provenance.settings.mode,'edit');assert.equal(child.sourceRecordId,parent.id);
        assert.equal(child.versionNumber,2);assert.equal(child.provenance.parent_receipt_sha256,parent.provenance.receipt_sha256);
        assert.equal(child.provenance.inputs[0].original_sha256,parent.provenance.output_sha256);
        assert.equal(child.provenance.inputs[0].original_credential_status,status);
        assert.equal(child.provenance.inputs[0].credential_status,'unknown_after_transform');
        assert.notEqual(child.provenance.inputs[0].submitted_sha256,parent.provenance.output_sha256);
        assert.equal(child.provenance.credential.status,status==='absent'?'unknown_after_transform':status);
        const shared=[];
        for (const item of [parent,child]) {
          const saved=await page.evaluate(async({item,token})=>{
            const response=await fetch('/gallery',{method:'POST',headers:{'content-type':'application/json','x-gallery-token':token},body:JSON.stringify({image:item.image,meta:{promptPublic:false,prompt:item.prompt,provenance:item.provenance}})});
            return {status:response.status,...await response.json()};
          },{item,token:generated.galleryToken});
          assert.equal(saved.status,201,JSON.stringify(saved));
          const object=await local.gallery.get('gallery/'+saved.id);
          assert.deepEqual(Buffer.from(await object.arrayBuffer()),fixtureBytes);
          assert.equal(object.customMetadata.outputSha256,item.provenance.output_sha256);
          assert.equal(object.customMetadata.receiptSha256,item.provenance.receipt_sha256);
          const metadata=JSON.parse(await(await local.gallery.get('gallery-meta/'+saved.id+'.json')).text());
          assert.doesNotMatch(JSON.stringify(metadata.metadata),/private artwork|a cat in a garden|Make the scene blue|prompt_sha256|token|secret/i);
          assert.equal(metadata.metadata.provenance.credential_status,item.provenance.credential.status);
          const html=await(await local.mf.dispatchFetch(origin+saved.shareUrl)).text();
          assert.match(html,/來源與驗證/);assert.doesNotMatch(html,/private artwork|a cat in a garden|Make the scene blue/);
          shared.push(saved.id);
        }
        const before=(await local.gallery.list()).objects.length;
        const bad=await page.evaluate(async({item,token})=>{
          item.provenance.output_sha256='0'.repeat(64);
          const response=await fetch('/gallery',{method:'POST',headers:{'content-type':'application/json','x-gallery-token':token},body:JSON.stringify({image:item.image,meta:{provenance:item.provenance}})});
          return {status:response.status,...await response.json()};
        },{item:parent,token:generated.galleryToken});
        assert.equal(bad.status,400);assert.equal(bad.code,'invalid_provenance');
        assert.equal((await local.gallery.list()).objects.length,before,'tampered receipt must not write R2');
        await page.locator('#tab-history').click();
        page.once('dialog',dialog=>dialog.accept());const backupPromise=page.waitForEvent('download');await page.locator('#exportAllHistoryJson').click();
        const backup=JSON.parse(readFileSync(await(await backupPromise).path(),'utf8'));
        assert.equal(backup.records.length,2);assert.doesNotMatch(JSON.stringify(backup),/deleteToken|galleryToken/);
        const restored=await page.evaluate(async payload=>{
          localStorage.removeItem(ImageHistoryStore.STORAGE_KEY);
          ImageHistoryStore.saveRecords(ImageHistoryStore.parseRecords(JSON.stringify(payload)));
          const records=ImageHistoryStore.loadRecords();return Promise.all(records.map(r=>ImageProvenance.verifyReceipt(r)));
        },backup);
        assert.ok(restored.every(r=>r.status==='hash_verified'));
        await page.reload();await page.waitForFunction(()=>ImageHistoryStore.loadRecords().length===2);
        if (scenario==='signed') {
          // Actual PR45 regeneration UI must make a third version and a new
          // receipt, keeping the edit parent and original generation intact.
          await page.locator('#tab-history').click();await page.evaluate(item=>ImageHistoryWall.openHistoryDetail(item),child);
          await page.locator('#regenerateHistoryDetail').click();
          await page.waitForFunction(()=>ImageHistoryStore.loadRecords().length===3&&ImageHistoryStore.loadRecords()[0]?.provenance?.receipt_sha256);
          const version=await page.evaluate(()=>ImageHistoryStore.loadRecords()[0]);
          assert.equal(version.sourceRecordId,child.id);assert.equal(version.versionNumber,3);
          assert.equal(version.provenance.settings.mode,'regenerate');
          assert.equal(version.provenance.parent_receipt_sha256,child.provenance.receipt_sha256);
          assert.equal(version.provenance.credential.status,'present_untrusted');
          assert.equal(version.provenance.output_sha256,parent.provenance.output_sha256);
          assert.notEqual(version.provenance.receipt_sha256,parent.provenance.receipt_sha256);
          // A real second tab clears storage while optional inspection waits.
          // Finishing the first tab must not resurrect any deleted artwork.
          await page.evaluate(image => {
            const inspect=C2paInspector.inspect, create=ImageProvenance.createReceipt;
            window.__receiptFinished=false;
            C2paInspector.inspect=blob=>new Promise(resolve=>{window.__releaseInspection=()=>inspect(blob).then(resolve);});
            ImageProvenance.createReceipt=(...args)=>create(...args).finally(()=>{window.__receiptFinished=true;});
            document.dispatchEvent(new CustomEvent('imagegen:generated',{detail:{id:'cross-tab-deleted',image,prompt:'temporary artwork',provider:'fixture',model:'schnell',createdAt:new Date().toISOString()}}));
          },parent.image);
          await page.waitForFunction(()=>typeof window.__releaseInspection==='function');
          const other=await context.newPage();
          await other.addInitScript(()=>localStorage.setItem('aiImageGenerationHistory.v1','[]'));
          await other.goto(origin);
          await page.evaluate(()=>window.__releaseInspection());
          await page.waitForFunction(()=>window.__receiptFinished);
          assert.equal(await page.evaluate(()=>ImageHistoryStore.loadRecords().length),0,'completed inspection must preserve another tab deletion');
          await other.close();
        }
        const end=(await control(scenario)).calls;assert.equal(end-start,scenario==='signed'?3:2,'only explicit generation/edit/regeneration may call the fixture provider');
        assert.deepEqual(errors,[]);assert.ok(blocked.every(origin=>origin==='https://datasets-server.huggingface.co'));
        stats.push({scenario,status,parentReceipt:parent.provenance.receipt_sha256,childReceipt:child.provenance.receipt_sha256,outputSha256:hash(fixtureBytes),fixtureProviderCalls:end-start,shared:shared.length,bytePreserved:true,privateExport:true,roundtrip:true,blockedExternalOrigins:[...new Set(blocked)]});
        await context.close();
      }
      assert.deepEqual(local.outbound,[],'workerd must make zero external fetch attempts');
      console.log('[provenance-workerd] '+JSON.stringify({mode,scenarios:stats,paidProviderCalls:0,workerOutboundCalls:0,remoteR2Writes:0,localGalleryObjects:(await local.gallery.list()).objects.length}));
    } finally {await browser.close();await local.close();}
  });
}
