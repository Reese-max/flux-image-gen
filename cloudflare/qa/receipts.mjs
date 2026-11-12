// Public CI log projections. Never stringify arbitrary reports or errors here.
import {QA_KIND,FEATURE_HEAD,FEATURE_TREE,RUN,SHA,KEY,SCENARIOS,immutableOrigin} from './contract.mjs';
const HASH=/^[a-f0-9]{64}$/;
function ensure(value){if(!value)throw new Error('Invalid bounded QA receipt');}
function common(value){
  ensure(RUN.test(value.run||'')&&SHA.test(value.sourceSha||''));
  ensure(value.frozenHead===FEATURE_HEAD&&value.frozenTree===FEATURE_TREE);
  const origin=immutableOrigin(value.origin,value.deploymentId);
  return {run:value.run,sourceSha:value.sourceSha,origin,deploymentId:value.deploymentId,frozenHead:FEATURE_HEAD,frozenTree:FEATURE_TREE};
}
export function readyReceipt(value){
  ensure(value.status==='READY_FOR_BROWSER'&&value.noProductionDeployment===true&&value.noPaidProviderCalls===true);
  ensure(Number.isInteger(value.deniedBeforeKey)&&value.deniedBeforeKey>=5&&value.deniedBeforeKey<=16);
  return {status:'READY_FOR_BROWSER',...common(value),deniedBeforeKey:value.deniedBeforeKey,noProductionDeployment:true,paidProviders:false};
}
export function browserReceipt(value,context){
  const identity=common({...context,frozenHead:value.frozenHead,frozenTree:value.frozenTree});
  ensure(value.status==='passed'&&value.kind===QA_KIND&&value.run===identity.run&&value.sourceSha===identity.sourceSha&&value.origin===identity.origin);
  ensure(value.realC2paWasm===true&&value.exactFrozenCsp===true&&value.fixtureTrustAnchorsInstalled===false&&value.serviceWorkersBlocked===true);
  ensure(Array.isArray(value.scenarios)&&value.scenarios.length===4);
  const statuses=['present_untrusted','absent','absent','invalid'];
  const scenarios=value.scenarios.map((row,index)=>{
    ensure(row.scenario===SCENARIOS[index]&&row.credentialStatus===statuses[index]);
    for(const name of ['outputSha256','parentReceiptSha256','childReceiptSha256'])ensure(typeof row[name]==='string'&&HASH.test(row[name]));
    for(const name of ['downloadBytePreserved','editLineage','artworkImportVerified','backupImportVerified'])ensure(row[name]===true);
    ensure(Array.isArray(row.shares)&&row.shares.length===2&&row.shares.every(item=>item.outputSha256===row.outputSha256));
    return {scenario:row.scenario,status:row.credentialStatus,outputSha256:row.outputSha256,parentReceiptSha256:row.parentReceiptSha256,childReceiptSha256:row.childReceiptSha256};
  });
  const transport={};
  for(const name of ['externalBlocked','redirectsRejected','failures','teardownCanceled']){
    const count=value.transport?.[name];ensure(Number.isInteger(count)&&count>=0&&count<=1000);transport[name]=count;
  }
  ensure(transport.redirectsRejected===0&&transport.failures===0&&value.transport.wasmLoaded===true&&value.transport.moduleWorkerLoaded===true);
  ensure(value.cleanup?.verified===true&&value.cleanup.scope===identity.run&&Number.isInteger(value.cleanup.removed)&&value.cleanup.removed>=17&&value.cleanup.removed<=1000);
  return {status:'HOSTED_PROOF_PASSED',...identity,scenarios,csp:true,wasm:true,moduleWorker:true,transport,cleanup:{scope:identity.run,removed:value.cleanup.removed,verified:true}};
}
export function browserFailureReceipt(error,context){
  const phases=['launch','status','unauthenticated_paths'];
  for(const scenario of SCENARIOS)for(const phase of ['browser','wasm','generation','artwork_export','edit_feature_load','edit_file_input','edit_input_inspection','edit_submit','edit_receipt','r2_share','backup_import'])phases.push(scenario+'_'+phase);
  const codes=['product_csp_changed','product_page_unavailable','signed_wasm_validation_failed','canvas_strip_validation_failed','qa_status_rejected','qa_identity_mismatch','qa_version_missing','frozen_source_mismatch','fixture_generation_failed','generated_credential_mismatch','generated_output_hash_mismatch','generated_build_mismatch','edit_input_credential_failed','edit_output_credential_failed','c2pa_wasm_not_loaded','c2pa_module_worker_not_loaded','qa_cleanup_not_verified','browser_transport_failed','browser_transport_failed_after_drain','browser_page_error','r2_share_hash_mismatch','r2_object_metadata_mismatch','r2_credential_metadata_mismatch','r2_metadata_not_private','operation_failed'];
  ensure(RUN.test(context.run||'')&&SHA.test(context.sourceSha||''));
  return {status:'HOSTED_PROOF_FAILED',run:context.run,sourceSha:context.sourceSha,stage:phases.includes(error?.qaFailure?.stage)?error.qaFailure.stage:'unknown',code:codes.includes(error?.qaFailure?.code)?error.qaFailure.code:'operation_failed'};
}
function emit(value,key,write=text=>process.stdout.write(text)){
  ensure(typeof key==='string'&&KEY.test(key));const text=JSON.stringify(value);
  ensure(text.length<=8192&&!text.includes(key)&&!text.includes(Buffer.from('flux-qa:'+key).toString('base64')));
  write(text+'\n');return value;
}
export function emitReadyReceipt(value,key,write){return emit(readyReceipt(value),key,write);}
export function emitBrowserReceipt(value,context,write){return emit(browserReceipt(value,context),context.key,write);}
export function emitBrowserFailureReceipt(error,context,write){return emit(browserFailureReceipt(error,context),context.key,write);}
