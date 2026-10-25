// QA only: unchanged product handlers, owned fixed payloads, no storage or
// provider bindings. No inbound runtime environment is spread into product.
import {AsyncLocalStorage} from 'node:async_hooks';
import product from '../src/index.js';
import {KIND,TREE,ROUTES,CASES,authorized,privateResponse,fixtureRequest,expectedResult} from './contract.mjs';
const requests=new AsyncLocalStorage();
// Permanent transport denial, including positive controls. Never restore native
// fetch: parallel requests cannot open an egress window for another request.
globalThis.fetch=async()=>{const state=requests.getStore();if(state)state.fetchCalls++;throw new Error('Synthetic QA transport unavailable');};
function projected(mode,state){
 const env={ENVIRONMENT:'production',TURNSTILE_REQUIRED:'true',POLLINATIONS_FALLBACK_ENABLED:'false',VISION_QA_ENABLED:'false',GEMINI_API_KEY:'public-synthetic-not-a-credential',NVIDIA_API_KEY:'public-synthetic-not-a-credential',AI:{async run(){state.aiCalls++;throw new Error('Synthetic QA AI unavailable');}}};
 if(mode==='wrong')env.GENERATE_RATE_LIMITER={};
 if(mode==='throw'||mode==='combined')env.GENERATE_RATE_LIMITER={limit(){throw new Error('Synthetic QA limiter failure');}};
 if(mode==='malformed')env.GENERATE_RATE_LIMITER={async limit(){return {};}};
 if(mode==='deny')env.GENERATE_RATE_LIMITER={async limit(){return {success:false};}};
 if(mode==='empty')env.ENVIRONMENT='';if(mode==='staging')env.ENVIRONMENT='staging';if(mode==='typo')env.ENVIRONMENT='prodution';
 if(['missing-secret','missing-site','missing-token','turnstile-down'].includes(mode))env.GENERATE_RATE_LIMITER={async limit(){return {success:true};}};
 if(mode==='missing-secret')env.TURNSTILE_SITE_KEY='public-synthetic-site';
 if(mode==='missing-site')env.TURNSTILE_SECRET_KEY='public-synthetic-not-a-credential';
 if(mode==='missing-token'||mode==='turnstile-down'){env.TURNSTILE_SITE_KEY='public-synthetic-site';env.TURNSTILE_SECRET_KEY='public-synthetic-not-a-credential';}
 if(mode==='development'){env.ENVIRONMENT='development';env.TURNSTILE_REQUIRED='false';delete env.NVIDIA_API_KEY;}
 return env;
}
export default {async fetch(request,env){
 if(!authorized(request,env))return privateResponse({schema:1,status:'DENIED'},401);
 const u=new URL(request.url);
 const identity={schema:1,kind:KIND,run:env.QA_RUN,sourceSha:env.QA_SOURCE_SHA,productTree:TREE};
 if(u.pathname==='/__qa/status'&&request.method==='GET'&&!u.search)return privateResponse({...identity,versionMetadataId:typeof env.CF_VERSION_METADATA?.id==='string'?env.CF_VERSION_METADATA.id:null,storageBindings:0,providerBindings:0});
 const mode=request.headers.get('x-flux-abuse-case');
 if(request.method!=='POST'||u.search||!ROUTES.includes(u.pathname)||!CASES.includes(mode))return privateResponse({schema:1,status:'NOT_FOUND'},404);
 // Caller data is never sent to product/providers/logs. Only fixed fixtures are
 // admitted. Cancel a supplied body instead of buffering arbitrary uploads.
 if(request.body){const reader=request.body.getReader();let timer;
  const first=await Promise.race([reader.read().catch(()=>({done:false})),new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false}),250);})]);clearTimeout(timer);
  if(!first.done){reader.cancel().catch(()=>{});return privateResponse({schema:1,status:'BODY_REFUSED'},400);}
 }
 try {expectedResult(mode,u.pathname);const state={aiCalls:0,fetchCalls:0};
  return await requests.run(state,async()=>{
   const response=await product.fetch(fixtureRequest(u.origin,u.pathname,mode),projected(mode,state));
   const body=await response.json();
   return privateResponse({...identity,case:mode,route:u.pathname,productStatus:response.status,productCode:typeof body.code==='string'?body.code:null,aiCalls:state.aiCalls,fetchCalls:state.fetchCalls,externalTransport:'DENIED'},response.status);
  });
 }catch{return privateResponse({schema:1,status:'QA_CONTRACT_FAILURE'},500);}
}};
