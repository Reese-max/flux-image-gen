import assert from 'node:assert/strict';
import test from 'node:test';
import {emitReadyReceipt,emitBrowserReceipt,emitBrowserFailureReceipt} from '../../cloudflare/qa/receipts.mjs';
import {QA_NAME,QA_KIND,FEATURE_HEAD,FEATURE_TREE,SCENARIOS} from '../../cloudflare/qa/contract.mjs';
const key='b'.repeat(64),basic=Buffer.from('flux-qa:'+key).toString('base64');
const context={run:'12345-1',sourceSha:'c'.repeat(40),origin:'https://abcdef12-'+QA_NAME+'.isolated.workers.dev',deploymentId:'abcdef12-1111-4222-8333-444444444444',key};
const ready={...context,status:'READY_FOR_BROWSER',frozenHead:FEATURE_HEAD,frozenTree:FEATURE_TREE,deniedBeforeKey:5,noProductionDeployment:true,noPaidProviderCalls:true,headers:{authorization:key},raw:basic,unknown:'OPAQUE_PRIVATE'};
const row=(scenario,index)=>({scenario,credentialStatus:['present_untrusted','absent','absent','invalid'][index],outputSha256:'a'.repeat(64),parentReceiptSha256:'d'.repeat(64),childReceiptSha256:'e'.repeat(64),downloadBytePreserved:true,editLineage:true,artworkImportVerified:true,backupImportVerified:true,shares:[{outputSha256:'a'.repeat(64)},{outputSha256:'a'.repeat(64)}],prompt:key,headers:basic});
const result={...context,status:'passed',kind:QA_KIND,frozenHead:FEATURE_HEAD,frozenTree:FEATURE_TREE,realC2paWasm:true,exactFrozenCsp:true,fixtureTrustAnchorsInstalled:false,serviceWorkersBlocked:true,scenarios:SCENARIOS.map(row),transport:{externalBlocked:0,redirectsRejected:0,failures:0,teardownCanceled:0,wasmLoaded:true,moduleWorkerLoaded:true,raw:key},cleanup:{verified:true,scope:context.run,removed:25,path:basic},unknown:'OPAQUE_PRIVATE'};
test('actual READY and proof emitters expose only bounded validated fields, never secret/unknown payloads',()=>{
  const lines=[];emitReadyReceipt(ready,key,value=>lines.push(value));emitBrowserReceipt(result,context,value=>lines.push(value));
  assert.equal(JSON.parse(lines[0]).status,'READY_FOR_BROWSER');assert.equal(JSON.parse(lines[1]).scenarios.length,4);
  assert.doesNotMatch(lines.join(''),new RegExp(key+'|'+basic+'|OPAQUE_PRIVATE|authorization|headers|prompt|unknown|path'));
  const failed=[];emitBrowserFailureReceipt({message:key,qaFailure:{stage:key,code:basic,unknown:key}},context,value=>failed.push(value));
  assert.equal(JSON.parse(failed[0]).stage,'unknown');assert.doesNotMatch(failed[0],new RegExp(key+'|'+basic));
});
test('emitters reject secrets in nominally allowed fields and refuse incomplete/forged successful proof',()=>{
  assert.throws(()=>emitReadyReceipt({...ready,sourceSha:key},key,()=>assert.fail('must not emit')));
  assert.throws(()=>emitReadyReceipt({...ready,deniedBeforeKey:0},key,()=>assert.fail('must not emit')));
  for(const patch of [{scenarios:result.scenarios.slice(0,3)},{fixtureTrustAnchorsInstalled:true},{realC2paWasm:false},{cleanup:{...result.cleanup,scope:'other'}},{transport:{...result.transport,failures:1}}])assert.throws(()=>emitBrowserReceipt({...result,...patch},context,()=>assert.fail('must not emit')));
  const bad=structuredClone(result);bad.scenarios[0].outputSha256=key;bad.scenarios[0].shares.forEach(item=>{item.outputSha256=key;});
  assert.throws(()=>emitBrowserReceipt(bad,context,()=>assert.fail('secret must not emit')));
});
