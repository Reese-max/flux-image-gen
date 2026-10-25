import assert from 'node:assert/strict';
import test from 'node:test';
import { localRuntime } from './local-runtime.mjs';
import { prove } from '../../cloudflare/qa/browser.mjs';
test('real HTTPS exact CSP, workerd/R2, C2PA WASM and four end-to-end fixture roundtrips',{timeout:300000},async()=>{
  const runtime=await localRuntime();
  try {
    let result;try{result=await prove({origin:runtime.origin,key:runtime.vars.QA_ACCESS_TOKEN,run:runtime.vars.QA_RUN,sourceSha:runtime.vars.QA_SOURCE_SHA,local:true});}catch(error){console.log(JSON.stringify({qaFailure:error.qaFailure}));throw error;}
    assert.equal(result.status,'passed');assert.equal(result.scenarios.length,4);assert.equal(result.realC2paWasm,true);assert.equal(result.fixtureTrustAnchorsInstalled,false);
    assert.equal(runtime.outbound.length,0);assert.equal((await runtime.bucket.list({prefix:'qa-runs/'+runtime.vars.QA_RUN+'/'})).objects.length,0);
    assert.ok(runtime.assetCalls.includes('/static/vendor/c2pa-worker.js'),'HTTPS must use actual self-hosted module Worker');
    console.log(JSON.stringify({localHttps:true,exactCsp:runtime.csp,scenarios:result.scenarios.map(item=>({scenario:item.scenario,credentialStatus:item.credentialStatus})),outboundCalls:runtime.outbound.length,ownObjectsAfterCleanup:0}));
  }finally{await runtime.close();}
});
