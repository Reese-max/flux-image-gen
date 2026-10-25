// QA-only wrapper around frozen product code. No provider/service bindings or
// production configuration are passed through. Auth runs before every asset.
import product from '../src/index.js';
import signedData from '../../tests/fixtures/provenance/C.jpg';
import absentData from '../../tests/fixtures/provenance/absent.jpg';
import { authorized, privateResponse, ownedPrefix, QA_KIND, FEATURE_TREE, FEATURE_HEAD, SCENARIOS } from './contract.mjs';

const signed = new Uint8Array(signedData), absent = new Uint8Array(absentData);
const tampered = signed.slice();
let start = -1;
for (let i = 2; i < tampered.length - 3; i++) if (tampered[i] === 255 && tampered[i + 1] === 218) { start = i; break; }
if (start < 0) throw new Error('Invalid frozen signed fixture');
tampered[start + 100] ^= 1;
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
function scopedBucket(bucket, prefix) {
  const key = value => {
    if (typeof value !== 'string' || value.length > 256 || !/^(gallery\/|gallery-meta\/|usage-events\/)/.test(value)
        || value.split('/').some(part => part === '..' || part === '.') || /[^a-zA-Z0-9._/-]/.test(value)) throw new Error('Unowned QA object path');
    return prefix + value;
  };
  return {
    put: (name, bytes, options) => bucket.put(key(name), bytes, options),
    get: name => bucket.get(key(name)),
    delete: name => bucket.delete(key(name)),
    async list(options = {}) {
      const requested = options.prefix || 'gallery/';
      const result = await bucket.list({ ...options, limit: Math.min(1000, options.limit || 100), prefix:key(requested) });
      return { ...result, objects:result.objects.map(object=>({ ...object, key:object.key.slice(prefix.length) })) };
    }
  };
}
async function boundedJpeg(request) {
  const reader = request.body?.getReader(); if (!reader) throw new Error('Missing fixture');
  const chunks = []; let length = 0;
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length;
    if (length > 1_048_576) { await reader.cancel(); throw new Error('Fixture too large'); } chunks.push(part.value); }
  const bytes = new Uint8Array(length); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('Expected JPEG fixture');
  return bytes;
}
async function run(request, env, ctx) {
  if (!authorized(request, env)) return new Response('QA authorization required', {status:401,headers:{'WWW-Authenticate':'Basic realm="Flux isolated QA", charset="UTF-8"'}});
  if (!env.QA_BUCKET || !env.ASSETS) return new Response('Isolated QA binding unavailable',{status:503});
  const url=new URL(request.url), prefix=ownedPrefix(env), bucket=scopedBucket(env.QA_BUCKET,prefix);
  if (url.pathname === '/__qa/status') return Response.json({kind:QA_KIND,run:env.QA_RUN,sourceSha:env.QA_SOURCE_SHA,frozenHead:FEATURE_HEAD,frozenTree:FEATURE_TREE,version:env.CF_VERSION_METADATA?.id || '',paidProviders:false,productionBindings:false});
  if (url.pathname === '/__qa/fixtures/stripped' && request.method === 'PUT') {
    const bytes=await boundedJpeg(request);await env.QA_BUCKET.put(prefix+'fixtures/stripped.jpg',bytes,{httpMetadata:{contentType:'image/jpeg'}});
    return Response.json({sha256:await digest(bytes),bytes:bytes.length});
  }
  if (url.pathname.startsWith('/__qa/object/')) {
    const id=url.pathname.slice('/__qa/object/'.length);if(!/^[a-zA-Z0-9._-]{1,96}$/.test(id)) return new Response('Not found',{status:404});
    const image=await bucket.get('gallery/'+id),meta=await bucket.get('gallery-meta/'+id+'.json');
    if(!image||!meta)return new Response('Not found',{status:404});
    return Response.json({sha256:await digest(await image.arrayBuffer()),customMetadata:image.customMetadata,metadata:JSON.parse(await meta.text()).metadata});
  }
  if (url.pathname === '/__qa/cleanup' && request.method === 'DELETE') {
    let count=0;
    // Re-list from the beginning after deleting, avoiding stale pagination
    // cursors. Bound each invocation to 1000 objects in this run only.
    while(count<1000){const list=await env.QA_BUCKET.list({prefix,limit:Math.min(100,1000-count)});
      if(list.objects.some(object=>!object.key.startsWith(prefix)))throw new Error('Unowned cleanup key');
      if(list.objects.length)await env.QA_BUCKET.delete(list.objects.map(object=>object.key));count+=list.objects.length;
      if(!list.truncated)break;
    }
    const remaining=await env.QA_BUCKET.list({prefix,limit:1});
    return Response.json({removed:count,scope:env.QA_RUN,complete:remaining.objects.length===0},{status:remaining.objects.length?409:200});
  }
  if (url.pathname.startsWith('/__qa/')) return new Response('Not found',{status:404});
  const scenario=request.headers.get('x-flux-qa-fixture') || 'signed';
  if(!SCENARIOS.includes(scenario))return new Response('Unknown fixture',{status:400});
  const bound={
    ASSETS:env.ASSETS,IMAGE_BUCKET:bucket,ENVIRONMENT:'development',TURNSTILE_REQUIRED:'false',
    POLLINATIONS_FALLBACK_ENABLED:'false',VISION_QA_ENABLED:'false',GALLERY_TOKEN_SECRET:env.QA_ACCESS_TOKEN,
    USAGE_ESTIMATED_COST_USD_PER_IMAGE:'0',CF_VERSION_METADATA:env.CF_VERSION_METADATA,
    AI:{async run(){let bytes=scenario==='signed'?signed:scenario==='absent'?absent:scenario==='tampered'?tampered:null;
      if(!bytes){const item=await env.QA_BUCKET.get(prefix+'fixtures/stripped.jpg');if(!item)throw new Error('Missing stripped fixture');bytes=new Uint8Array(await item.arrayBuffer());}
      let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode.apply(null,bytes.subarray(i,i+32768));return{image:btoa(value)};}}
  };
  return product.fetch(request,bound,ctx);
}
export default {async fetch(request,env,ctx){try{return privateResponse(await run(request,env,ctx));}catch{return privateResponse(new Response('Isolated QA request failed',{status:500}));}}};
