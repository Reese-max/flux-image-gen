import { readFileSync,writeFileSync,statSync } from 'node:fs';
import path from 'node:path';
import { admitted,root } from './control.mjs';
import { prove } from './browser.mjs';
import {emitBrowserReceipt,emitBrowserFailureReceipt} from './receipts.mjs';
const identity=admitted();
const file=path.join(process.env.RUNNER_TEMP,'flux-isolated-qa/private-state.json');
if((statSync(file).mode&0o077)!==0)throw new Error('Private QA state permissions invalid');
const state=JSON.parse(readFileSync(file,'utf8'));
if(state.run!==identity.run||state.sourceSha!==identity.sourceSha)throw new Error('Private QA state identity mismatch');
let report;
try {report=await prove({origin:state.origin,deploymentId:state.deploymentId,key:state.key,run:state.run,sourceSha:state.sourceSha});emitBrowserReceipt(report,state);}
catch(error){report=emitBrowserFailureReceipt(error,state);process.exitCode=1;}
writeFileSync(path.join(root,'output/qa/browser.json'),JSON.stringify(report,null,2));
