export const REPO='Reese-max/flux-image-gen';
export const BRANCH='feature/issue11-isolated-abuse-qa-20261025';
export const BASE='ac6fec19336fec1140b6c2b0cc862e95611bf43d';
export const TREE='70cb68de02fbe6ffedf26621c86db7c23d51ddfe';
export const NAME='flux-issue11-qa-20261025';
export const KIND='flux-abuse-qa/20261025';
export const MARKER='<!-- flux-issue11-isolated-qa:20261025 -->';
export const GRANT_MS=180000;
export const SHA=/^[a-f0-9]{40}$/;
export const RUN=/^[0-9]{1,20}-[1-9][0-9]{0,3}$/;
export const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const ROUTES=['/generate','/generate/batch','/edit','/prompt/transform','/prompt/complete','/prompt/enhance'];
export const CASES=['missing','wrong','empty','staging','typo','throw','malformed','combined','deny','missing-secret','missing-site','missing-token','turnstile-down','development'];
export function requireValue(value){if(!value)throw new Error('Isolated abuse QA contract rejected');}
export function authorized(request,env,now=Date.now()){
 const created=Date.parse(env.QA_CREATED_AT),expires=Date.parse(env.QA_EXPIRES_AT);
 if(env.QA_KIND!==KIND||env.QA_PRODUCT_TREE!==TREE||!SHA.test(env.QA_SOURCE_SHA||'')||!RUN.test(env.QA_RUN||'')||!/^([a-f0-9]{64})$/.test(env.QA_ACCESS_TOKEN||'')||!Number.isFinite(created)||!Number.isFinite(expires)||created>now||now>=expires||expires<=created||expires-created>GRANT_MS)return false;
 const actual=request.headers.get('authorization')||'',expected='Bearer '+env.QA_ACCESS_TOKEN;
 if(actual.length!==expected.length)return false;
 let difference=0;for(let i=0;i<actual.length;i++)difference|=actual.charCodeAt(i)^expected.charCodeAt(i);
 return difference===0;
}
export function privateResponse(body,status=200){return Response.json(body,{status,headers:{'cache-control':'private, no-store','x-robots-tag':'noindex, nofollow','referrer-policy':'no-referrer','x-content-type-options':'nosniff'}});}
export function fixtureRequest(origin,route,mode){
 requireValue(ROUTES.includes(route)&&CASES.includes(mode));
 const token=mode==='turnstile-down'?'public-synthetic-token':'';
 let body,headers={};
 if(route==='/edit'){body=new FormData();body.set('prompt','change background to beach');body.set('turnstileToken',token);body.set('images',new Blob([new Uint8Array(10)],{type:'image/png'}),'fixture.png');}
 else {headers['content-type']='application/json';body=JSON.stringify(route==='/prompt/transform'?{source:'一隻可愛柴犬在月球上',style:'auto'}:route==='/prompt/complete'?{source:'女生雨中',style:'cinematic'}:route==='/prompt/enhance'?{prompt:'a cat',effect:'更夢幻'}:{prompt:'a red cat on a table',model:'schnell',style:'realistic',size:'square',count:2,turnstileToken:token});}
 return new Request(origin+route,{method:'POST',headers,body});
}
export function immutableOrigin(value,id){
 requireValue(typeof id==='string'&&UUID.test(id));const u=new URL(value),prefix=id.slice(0,8)+'-'+NAME+'.';
 requireValue(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.pathname==='/'&&u.hostname.startsWith(prefix)&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(u.hostname.slice(prefix.length)));
 return u.origin;
}
export function expectedResult(mode,route){
 if(['missing','wrong','empty','staging','typo'].includes(mode))return [503,'rate_limiter_unavailable',0,0];
 if(['throw','malformed','combined'].includes(mode))return [503,'rate_limiter_error',0,0];
 if(mode==='deny')return [429,'rate_limited',0,0];
 if(['missing-secret','missing-site'].includes(mode)&&ROUTES.slice(0,3).includes(route))return [503,'turnstile_unconfigured',0,0];
 if(mode==='missing-token'&&ROUTES.slice(0,3).includes(route))return [403,'turnstile_required',0,0];
 if(mode==='turnstile-down'&&ROUTES.slice(0,3).includes(route))return [503,'turnstile_unavailable',0,1];
 if(mode==='development'&&route==='/generate')return [502,'workers_ai_error',1,0];
 if(mode==='development'&&route==='/prompt/complete')return [200,null,0,1];
 throw new Error('Unsupported fixture combination');
}
