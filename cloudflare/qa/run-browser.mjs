import { readFileSync,writeFileSync,statSync } from 'node:fs';
import path from 'node:path';
import { admitted,root } from './control.mjs';
import { prove } from './browser.mjs';
const identity=admitted();
const file=path.join(process.env.RUNNER_TEMP,'flux-isolated-qa/private-state.json');
if((statSync(file).mode&0o077)!==0)throw new Error('Private QA state permissions invalid');
const state=JSON.parse(readFileSync(file,'utf8'));
if(state.run!==identity.run||state.sourceSha!==identity.sourceSha)throw new Error('Private QA state identity mismatch');
let report;
try {report=await prove({origin:state.origin,key:state.key,run:state.run,sourceSha:state.sourceSha});}
catch(error){report={status:'FAILED_CLOSED',run:state.run,sourceSha:state.sourceSha,origin:state.origin,action:'Hosted browser verification failed; raw headers/downloads deliberately omitted',failure:error.qaFailure};process.exitCode=1;}
writeFileSync(path.join(root,'output/qa/browser.json'),JSON.stringify(report,null,2));
