// QA-only Chromium proof against an authenticated, immutable fixture Worker.
// No product assets, CSP, trust anchors, provider bindings or receipt code change.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_NAME, QA_KIND, FEATURE_HEAD, FEATURE_TREE, KEY, RUN, SHA, SCENARIOS,immutableOrigin } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixturePath = name => path.join(root, 'tests/fixtures/provenance', name);
class ProofError extends Error {}
const check = (condition, code) => { if (!condition) throw new ProofError(code); };

function validatedOrigin(value, local,deploymentId) {
  check(typeof value === 'string', 'invalid_origin');
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid_origin'); }
  check(value === url.origin && url.protocol === 'https:' && !url.username && !url.password, 'invalid_origin');
  if (local) {
    check(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'invalid_local_origin');
  } else {
    check(immutableOrigin(value,deploymentId)===value,'immutable_qa_origin_required');
  }
  return url.origin;
}

async function downloadedBytes(promise) {
  const download = await promise;
  const stream = await download.createReadStream();
  check(stream, 'download_unavailable');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Wait for the real lazy feature before dispatching its file change event. */
export async function selectEditInput(page,bytes,phase=()=>{}) {
  phase('feature_load');
  await page.locator('#tab-edit').click();
  // Local readiness is separate from the optional provider-health promise.
  await page.waitForFunction(()=>Boolean(window.ImageEdit&&document.querySelector('#editFiles')&&!document.querySelector('#editFiles').disabled));
  check(await page.evaluate(()=>Boolean(window.ImageEdit)),'edit_feature_unavailable');
  phase('file_input');
  await page.locator('#editFiles').setInputFiles({name:'public-fixture.jpg',mimeType:'image/jpeg',buffer:bytes});
  phase('input_inspection');
  await page.waitForFunction(()=>document.querySelectorAll('.edit-thumb').length===1);
}

/** Exact-origin transport, exported for two-origin/redirect security canaries. */
export function createQaOriginRouter({ origin, key, scenario = 'signed', local = false, transport,deploymentId } = {}) {
  check(typeof local === 'boolean', 'invalid_local_flag');
  origin = validatedOrigin(origin, local,deploymentId);
  check(typeof key === 'string' && KEY.test(key), 'invalid_qa_key');
  check(SCENARIOS.includes(scenario), 'invalid_fixture_scenario');
  const stats = transport || { externalBlocked: 0, redirectsRejected: 0, failures: 0, teardownCanceled: 0, wasmLoaded: false, moduleWorkerLoaded: false };
  const active = new Set();
  let stopping = false;
  const abort = async (route, reason) => { try { await route.abort(reason); } catch { /* a canceled route needs no diagnostics */ } };
  const serve = async route => {
    if (stopping) return abort(route, 'blockedbyclient');
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { stats.failures++; return abort(route, 'blockedbyclient'); }
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    if (url.origin !== origin) { stats.externalBlocked++; return abort(route, 'blockedbyclient'); }
    let response;
    try {
      response = await route.fetch({
        headers: { ...request.headers(), authorization: 'Bearer ' + key, 'x-flux-qa-fixture': scenario },
        maxRedirects: 0, timeout: 30000
      });
      // This also rejects 304. Routed requests do not use the browser HTTP cache.
      if (response.status() >= 300 && response.status() < 400) {
        stats.redirectsRejected++;
        return abort(route, 'blockedbyclient');
      }
      if (response.ok() && url.pathname === '/static/vendor/c2pa.wasm') stats.wasmLoaded = true;
      if (response.ok() && url.pathname === '/static/vendor/c2pa-worker.js') stats.moduleWorkerLoaded = true;
      await route.fulfill({ response });
    } catch (error) {
      // Only known cancellation during our explicit shutdown is bookkeeping.
      // Other failures still fail the proof; raw diagnostics never escape.
      if (stopping && /closed|disposed|canceled|cancelled|aborted|already handled/i.test(String(error?.message || ''))) stats.teardownCanceled = (stats.teardownCanceled || 0) + 1;
      else stats.failures++;
      await abort(route, 'failed');
    } finally {
      // Disposal can race a closed APIRequestContext after successful delivery;
      // it is resource cleanup, not a failed product/browser network request.
      if (response) { try { await response.dispose(); } catch { /* no raw diagnostics */ } }
    }
  };
  const handle = route => {
    const pending = serve(route);
    active.add(pending);
    return pending.finally(() => active.delete(pending));
  };
  const finish = async () => {
    // Keep the route installed while draining. New requests are aborted, so
    // there is never an unguarded interval before context.close().
    stopping = true;
    while (active.size) await Promise.allSettled([...active]);
  };
  return { handle, finish, stats };
}

/**
 * Calls only the validated QA origin. The caller authorizes the fixture-only run.
 * Errors deliberately discard Playwright diagnostics that can contain headers.
 * No tracing, HAR, screenshots, console forwarding or persistent browser profile.
 */
export async function prove({ origin, key, run, sourceSha, local = false,deploymentId } = {}) {
  check(typeof local === 'boolean', 'invalid_local_flag');
  origin = validatedOrigin(origin, local,deploymentId);
  check(KEY.test(key || '') && typeof key === 'string', 'invalid_qa_key');
  check(typeof run === 'string' && RUN.test(run), 'invalid_qa_run');
  check(typeof sourceSha === 'string' && SHA.test(sourceSha), 'invalid_source_sha');
  const signed = readFileSync(fixturePath('C.jpg'));
  const absent = readFileSync(fixturePath('absent.jpg'));
  const expectedCsp = readFileSync(path.join(root, 'cloudflare/public/_headers'), 'utf8').match(/Content-Security-Policy: (.+)/)?.[1];
  check(expectedCsp && !/worker-src[^;]*blob:/.test(expectedCsp), 'frozen_csp_missing');
  const tampered = Buffer.from(signed);
  let sos = -1;
  for (let i = 2; i < tampered.length - 3; i++) {
    if (tampered[i] === 255 && tampered[i + 1] === 218) { sos = i; break; }
  }
  check(sos > 0 && sos + 100 < tampered.length, 'invalid_frozen_fixture');
  tampered[sos + 100] ^= 1;
  const { chromium } = createRequire(path.join(root, 'cloudflare/package.json'))('playwright');
  let browser, control, statusVerified = false, cleanup, result,activePage;
  let stage = 'launch';
  const contexts = new Set();
  const routers = new Map();
  const transport = { externalBlocked: 0, redirectsRejected: 0, failures: 0, teardownCanceled: 0, wasmLoaded: false, moduleWorkerLoaded: false };
  const closeContext = async context => {
    await routers.get(context)?.finish();
    await context.close(); contexts.delete(context); routers.delete(context);
  };
  const makeContext = async scenario => {
    const context = await browser.newContext({
      acceptDownloads: true, serviceWorkers: 'block', ignoreHTTPSErrors: local,
      // Chromium module-worker fetches can bypass page routing. Basic auth is
      // scoped to this exact origin; it is never a global HTTP header.
      httpCredentials: { origin, username: 'flux-qa', password: key }
    });
    contexts.add(context);
    context.setDefaultTimeout(45000);
    context.setDefaultNavigationTimeout(45000);
    context.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== origin || !response.ok()) return;
      if (url.pathname === '/static/vendor/c2pa.wasm') transport.wasmLoaded = true;
      if (url.pathname === '/static/vendor/c2pa-worker.js') transport.moduleWorkerLoaded = true;
    });
    const router = createQaOriginRouter({ origin, key, scenario, local, transport,deploymentId });
    routers.set(context, router);
    await context.route('**/*', router.handle);
    await context.addInitScript(() => localStorage.setItem('aiImageTutorialSeen.v1', 'true'));
    return context;
  };
  const privateStrings = ['Private fixture artwork', 'a cat in a garden', 'Make the scene blue'];
  const noPrivatePrompts = value => privateStrings.every(text => !JSON.stringify(value).includes(text));
  try {
    browser = await chromium.launch({ headless: true });
    stage = 'unauthenticated_paths';
    const anonymous=await browser.newContext({ignoreHTTPSErrors:local,serviceWorkers:'block'});contexts.add(anonymous);
    for(const resource of ['/','/static/provenance.js','/static/vendor/c2pa.wasm','/static/vendor/c2pa-worker.js','/generate','/gallery','/__qa/status','/?key=guess']){
      const denied=await anonymous.request.get(origin+resource,{maxRedirects:0});
      check(denied.status()===401,'unauthenticated_resource_exposed');
      check(denied.headers()['cache-control']==='private, no-store','unauthenticated_resource_cacheable');await denied.dispose();
    }
    await closeContext(anonymous);
    stage = 'status';
    control = await (await makeContext('signed')).newPage();
    const response = await control.goto(origin + '/__qa/status');
    check(response?.status() === 200, 'qa_status_rejected');
    const status = await response.json();
    check(status.kind === QA_KIND && status.run === run && status.sourceSha === sourceSha, 'qa_identity_mismatch');
    check(status.frozenHead === FEATURE_HEAD && status.frozenTree === FEATURE_TREE, 'frozen_source_mismatch');
    check(status.paidProviders === false && status.productionBindings === false, 'unsafe_qa_bindings');
    check(typeof status.version === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(status.version), 'qa_version_missing');
    statusVerified = true;
    const scenarios = [];
    for (const [scenario, expectedStatus] of [['signed', 'present_untrusted'], ['absent', 'absent'], ['stripped', 'absent'], ['tampered', 'invalid']]) {
      stage = scenario + '_browser';
      const context = await makeContext(scenario);
      const page = await context.newPage();
      activePage=page;
      let pageErrors = 0;
      page.on('pageerror', () => { pageErrors++; });
      const entry = await page.goto(origin);
      check(entry?.status() === 200, 'product_page_unavailable');
      check((await entry.headerValue('content-security-policy')) === expectedCsp, 'product_csp_changed');
      await page.evaluate(() => {
        const modal = document.querySelector('#tutorialModal');
        if (modal && !modal.hidden) document.querySelector('#finishTutorial').click();
      });
      let fixtureBytes = { signed, absent, tampered }[scenario];
      if (scenario === 'signed' || scenario === 'stripped') {
        stage = scenario + '_wasm';
        const inspected = await page.evaluate(async data => {
          const original = ImageProvenance.imageBlob(data);
          const originalStatus = await C2paInspector.inspect(original);
          const image = new Image(); image.src = data; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
          canvas.getContext('2d').drawImage(image, 0, 0);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'));
          const transformed = await ImageProvenance.inspectCredentials(blob, { transformed: true });
          const absentStatus = await C2paInspector.inspect(blob);
          return { original: originalStatus.status, transformed: transformed.status, stripped: absentStatus.status,
            bytes: canvas.toDataURL('image/jpeg').split(',')[1] };
        }, 'data:image/jpeg;base64,' + signed.toString('base64'));
        check(inspected.original === 'present_untrusted', 'signed_wasm_validation_failed');
        check(inspected.transformed === 'unknown_after_transform' && inspected.stripped === 'absent', 'canvas_strip_validation_failed');
        if (scenario === 'stripped') {
          fixtureBytes = Buffer.from(inspected.bytes, 'base64');
          const upload = await page.evaluate(async bytes => {
            const raw = Uint8Array.from(atob(bytes), c => c.charCodeAt(0));
            const response = await fetch('/__qa/fixtures/stripped', { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: raw });
            return { status: response.status, body: await response.json() };
          }, inspected.bytes);
          check(upload.status === 200 && upload.body.sha256 === hash(fixtureBytes) && upload.body.bytes === fixtureBytes.length, 'stripped_upload_hash_mismatch');
        }
      }
      stage = scenario + '_generation';
      await page.locator('#plainPrompt').fill('Private fixture artwork ' + scenario);
      await page.evaluate(() => { document.querySelector('#advancedSettings').open = true; ImageGenApp.setGenerationSettings({ model: 'schnell' }); });
      await page.locator('#prompt').fill('a cat in a garden');
      const generation = page.waitForResponse(response => new URL(response.url()).origin === origin && new URL(response.url()).pathname === '/generate' && response.request().method() === 'POST');
      await page.locator('#go').click();
      const generationResponse = await generation;
      check(generationResponse.status() === 200, 'fixture_generation_failed');
      const generated = await generationResponse.json();
      check(typeof generated.galleryToken === 'string' && generated.galleryToken.length > 0, 'gallery_capability_missing');
      await page.waitForFunction(() => ImageHistoryStore.loadRecords().length === 1 && ImageHistoryStore.loadRecords()[0]?.provenance?.receipt_sha256);
      const parent = await page.evaluate(() => ImageHistoryStore.loadRecords()[0]);
      check(parent.provenance.credential.status === expectedStatus, 'generated_credential_mismatch');
      check(parent.provenance.output_sha256 === hash(fixtureBytes), 'generated_output_hash_mismatch');
      check(parent.provenance.build_version === status.version, 'generated_build_mismatch');
      check((await page.evaluate(item => ImageProvenance.verifyReceipt(item), parent)).status === 'hash_verified', 'parent_receipt_failed');
      const download = page.waitForEvent('download'); await page.locator('#dl').click();
      check((await downloadedBytes(download)).equals(fixtureBytes), 'download_bytes_changed');

      stage = scenario + '_artwork_export';
      await page.locator('#tab-history').click();
      await page.evaluate(item => ImageHistoryWall.openHistoryDetail(item), parent);
      const exportDownload = page.waitForEvent('download'); await page.locator('#exportHistoryJson').click();
      const artworkBytes = await downloadedBytes(exportDownload);
      const artwork = JSON.parse(artworkBytes.toString('utf8'));
      check(noPrivatePrompts(artwork) && !/galleryToken|deleteToken/.test(JSON.stringify(artwork)), 'private_artwork_export');
      check(artwork.provenance.receipt_sha256 === parent.provenance.receipt_sha256, 'artwork_receipt_changed');
      check(await page.evaluate(item => ImageProvenance.verifyReceipt(ImageHistoryStore.parseRecords(JSON.stringify(item))[0]).then(r => r.status === 'hash_verified'), artwork), 'artwork_import_receipt_failed');
      const receiptDownload = page.waitForEvent('download'); await page.locator('#downloadHistoryReceipt').click();
      const receipt = JSON.parse((await downloadedBytes(receiptDownload)).toString('utf8'));
      check(JSON.stringify(receipt) === JSON.stringify(parent.provenance), 'receipt_download_changed');
      check((await page.evaluate(item => ImageProvenance.verifyReceipt({ ...item, image: item.image.slice(0, -4) + 'AAAA' }), parent)).status === 'modified', 'changed_image_not_detected');
      await page.locator('#closeHistoryDetail').click();

      await selectEditInput(page,fixtureBytes,phase=>{stage=scenario+'_edit_'+phase;});
      stage = scenario + '_edit_submit';
      await page.locator('#editPrompt').fill('Make the scene blue'); await page.locator('#editGo').click();
      stage = scenario + '_edit_receipt';
      await page.waitForFunction(() => ImageHistoryStore.loadRecords().length === 2 && ImageHistoryStore.loadRecords()[0]?.provenance?.receipt_sha256);
      const child = await page.evaluate(() => ImageHistoryStore.loadRecords()[0]);
      check(child.provenance.settings.mode === 'edit' && child.sourceRecordId === parent.id && child.versionNumber === 2, 'edit_lineage_failed');
      check(child.provenance.parent_receipt_sha256 === parent.provenance.receipt_sha256, 'edit_parent_receipt_failed');
      check(child.provenance.inputs[0].original_sha256 === parent.provenance.output_sha256, 'edit_input_hash_failed');
      check(child.provenance.inputs[0].original_credential_status === expectedStatus && child.provenance.inputs[0].credential_status === 'unknown_after_transform', 'edit_input_credential_failed');
      check(child.provenance.inputs[0].submitted_sha256 !== parent.provenance.output_sha256, 'edit_transform_not_observed');
      check(child.provenance.credential.status === (expectedStatus === 'absent' ? 'unknown_after_transform' : expectedStatus), 'edit_output_credential_failed');
      check(child.provenance.output_sha256 === hash(fixtureBytes), 'edit_output_hash_failed');
      check((await page.evaluate(item => ImageProvenance.verifyReceipt(item), child)).status === 'hash_verified', 'child_receipt_failed');

      stage = scenario + '_r2_share';
      const shares = [];
      for (const item of [parent, child]) {
        const saved = await page.evaluate(async ({ item, token }) => {
          const response = await fetch('/gallery', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': token },
            body: JSON.stringify({ image: item.image, meta: { promptPublic: false, prompt: item.prompt, provenance: item.provenance } }) });
          return { status: response.status, body: await response.json() };
        }, { item, token: generated.galleryToken });
        check(saved.status === 201 && /^[a-zA-Z0-9._-]{1,96}$/.test(saved.body.id || ''), 'gallery_save_failed');
        const shared = await page.evaluate(async ({ id, imageUrl, shareUrl }) => {
          const safe = value => { const url = new URL(value, location.origin); if (url.origin !== location.origin || url.username || url.password) throw new Error('Invalid gallery URL'); return url.href; };
          const proof = await fetch('/__qa/object/' + encodeURIComponent(id));
          const image = await fetch(safe(imageUrl));
          const html = await fetch(safe(shareUrl));
          return { proofStatus: proof.status, proof: await proof.json(), imageStatus: image.status,
            imageSha256: await ImageProvenance.sha256(await image.blob()), htmlStatus: html.status, html: await html.text() };
        }, { id: saved.body.id, imageUrl: saved.body.url, shareUrl: saved.body.shareUrl });
        check(shared.proofStatus === 200 && shared.imageStatus === 200 && shared.htmlStatus === 200, 'gallery_readback_failed');
        check(shared.proof.sha256 === hash(fixtureBytes) && shared.imageSha256 === hash(fixtureBytes), 'r2_share_hash_mismatch');
        check(shared.proof.customMetadata.outputSha256 === item.provenance.output_sha256 && shared.proof.customMetadata.receiptSha256 === item.provenance.receipt_sha256, 'r2_object_metadata_mismatch');
        check(shared.proof.metadata.provenance.credential_status === item.provenance.credential.status, 'r2_credential_metadata_mismatch');
        check(noPrivatePrompts(shared.proof.metadata) && !/prompt_sha256|token|secret/i.test(JSON.stringify(shared.proof.metadata)), 'r2_metadata_not_private');
        check(shared.html.includes('來源與驗證') && noPrivatePrompts(shared.html), 'share_page_not_private');
        shares.push({ outputSha256: shared.proof.sha256, receiptSha256: shared.proof.customMetadata.receiptSha256, credentialStatus: shared.proof.metadata.provenance.credential_status });
      }
      const rejected = await page.evaluate(async ({ item, token }) => {
        item.provenance.output_sha256 = '0'.repeat(64);
        const response = await fetch('/gallery', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gallery-token': token }, body: JSON.stringify({ image: item.image, meta: { provenance: item.provenance } }) });
        const body = await response.json(); return { status: response.status, code: body.code };
      }, { item: parent, token: generated.galleryToken });
      check(rejected.status === 400 && rejected.code === 'invalid_provenance', 'modified_gallery_receipt_accepted');

      stage = scenario + '_backup_import';
      await page.locator('#tab-history').click();
      page.once('dialog', dialog => dialog.accept());
      const backupDownload = page.waitForEvent('download'); await page.locator('#exportAllHistoryJson').click();
      const backupBytes = await downloadedBytes(backupDownload);
      const backup = JSON.parse(backupBytes.toString('utf8'));
      check(backup.records?.length === 2 && !/deleteToken|galleryToken/.test(JSON.stringify(backup)), 'backup_invalid');
      const restored = await page.evaluate(async payload => {
        localStorage.removeItem(ImageHistoryStore.STORAGE_KEY);
        ImageHistoryStore.saveRecords(ImageHistoryStore.parseRecords(JSON.stringify(payload)));
        const records = ImageHistoryStore.loadRecords();
        return Promise.all(records.map(async record => ({ receiptSha256: record.provenance.receipt_sha256,
          outputSha256: record.provenance.output_sha256, verified: (await ImageProvenance.verifyReceipt(record)).status })));
      }, backup);
      check(restored.length === 2 && restored.every(record => record.verified === 'hash_verified'), 'backup_import_failed');
      check(restored[0].receiptSha256 === child.provenance.receipt_sha256 && restored[1].receiptSha256 === parent.provenance.receipt_sha256, 'backup_lineage_changed');
      await page.reload(); await page.waitForFunction(() => ImageHistoryStore.loadRecords().length === 2);
      check(pageErrors === 0, 'browser_page_error');
      scenarios.push({ scenario, credentialStatus: expectedStatus, parentReceiptSha256: parent.provenance.receipt_sha256,
        childReceiptSha256: child.provenance.receipt_sha256, outputSha256: hash(fixtureBytes),
        artworkExportSha256: hash(artworkBytes), backupExportSha256: hash(backupBytes),
        downloadBytePreserved: true, editLineage: true, artworkImportVerified: true, backupImportVerified: true,
        canvasStrippedStatus: scenario === 'stripped' ? 'unknown_after_transform' : undefined, shares });
      await closeContext(context);
    }
    check(transport.redirectsRejected === 0 && transport.failures === 0, 'browser_transport_failed');
    // present_untrusted is established by actual SDK validation; no fixture root
    // is installed and hash-verified internal receipts are never issuer trust.
    check(transport.wasmLoaded, 'c2pa_wasm_not_loaded');
    check(transport.moduleWorkerLoaded, 'c2pa_module_worker_not_loaded');
    result = { status: 'passed', kind: QA_KIND, origin, run, sourceSha, frozenHead: FEATURE_HEAD, frozenTree: FEATURE_TREE,
      version: status.version, scenarios, transport, realC2paWasm: true, fixtureTrustAnchorsInstalled: false,
      paidProviders: false, productionBindings: false, serviceWorkersBlocked: true, exactFrozenCsp: true };
  } catch (error) {
    // Neither private prompts nor credential-bearing Playwright errors escape.
    const reason = error instanceof ProofError ? '_' + error.message : '';
    let diagnostic;
    if(activePage&&!activePage.isClosed())try{diagnostic=await activePage.evaluate(()=>{
      const text=document.querySelector('#editStatus')?.textContent||'';
      return {thumbs:document.querySelectorAll('.edit-thumb').length,inputState:/圖片都無法處理/.test(text)?'input_processing_failed':/已加入/.test(text)?'input_ready':/參考圖/.test(text)?'references_message':'other',editDisabled:Boolean(document.querySelector('#editGo')?.disabled),visibility:document.visibilityState,hasFocus:document.hasFocus()};
    });}catch{/* no raw diagnostics */}
    const safe=new Error('qa_browser_failed_at_' + stage + reason);safe.qaFailure={stage,code:error instanceof ProofError?error.message:'operation_failed',diagnostic};throw safe;
  } finally {
    try {
      if (statusVerified && control && !control.isClosed()) {
        cleanup = await control.evaluate(async () => {
          const response = await fetch('/__qa/cleanup', { method: 'DELETE' });
          const body = await response.json(); return { status: response.status, removed: body.removed, scope: body.scope };
        });
      }
    } catch { cleanup = { status: 0 }; }
    for (const context of [...contexts]) { try { await closeContext(context); } catch { /* no raw diagnostics */ } }
    if (browser) { try { await browser.close(); } catch { /* no raw diagnostics */ } }
  }
  check(transport.redirectsRejected===0&&transport.failures===0,'browser_transport_failed_after_drain');
  check(cleanup?.status === 200 && cleanup.scope === run && Number.isSafeInteger(cleanup.removed) && cleanup.removed >= 17, 'qa_cleanup_not_verified');
  result.cleanup = { verified: true, removed: cleanup.removed, scope: run };
  // Defend even against a QA response unexpectedly reflecting authorization in
  // an otherwise allowed version/hash field. Only this redacted object escapes.
  let serialized = JSON.stringify(result);
  for (const secret of [key, Buffer.from('flux-qa:' + key).toString('base64')]) {
    serialized = serialized.split(secret).join('[redacted]');
  }
  return JSON.parse(serialized);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await prove({ origin: process.env.FLUX_QA_ORIGIN, key: process.env.FLUX_QA_KEY,
      run: process.env.FLUX_QA_RUN, sourceSha: process.env.FLUX_QA_SOURCE_SHA, deploymentId:process.env.FLUX_QA_DEPLOYMENT_ID, local: process.env.FLUX_QA_LOCAL === 'true' });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stderr.write('Isolated QA browser proof failed; no credential-bearing diagnostics were emitted.\n');
    process.exitCode = 1;
  }
}
