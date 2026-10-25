export const QA_NAME = 'flux-pr45-qa-20261025';
export const QA_BUCKET = 'flux-pr45-qa-20261025';
export const QA_KIND = 'flux-provenance-qa/20261025';
export const FEATURE_HEAD = 'c12518d450aa50edea7d6be66503f4bb51e87945';
export const FEATURE_TREE = 'f01e1299eed96e70662be5cdc8c951938e2cb877';
export const RUN = /^[0-9]{1,20}-[1-9][0-9]{0,3}$/;
export const SHA = /^[a-f0-9]{40}$/;
export const KEY = /^[a-f0-9]{64}$/;
export const SCENARIOS = ['signed', 'absent', 'stripped', 'tampered'];
export const DEPLOYMENT_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
export function immutableOrigin(value, deploymentId) {
  if(typeof deploymentId!=='string'||!DEPLOYMENT_ID.test(deploymentId))throw new Error('Invalid Preview deployment ID');
  const url=new URL(value),prefix=deploymentId.slice(0,8)+'-'+QA_NAME+'.';
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/')throw new Error('Unsafe Preview URL');
  if(!url.hostname.startsWith(prefix)||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/.test(url.hostname.slice(prefix.length)))throw new Error('Expected immutable QA deployment URL');
  return url.origin;
}
export function qaWorkerNamespace(origin) {
  const host=new URL(origin).hostname,marker='-'+QA_NAME+'.',offset=host.indexOf(marker);
  if(offset<0)throw new Error('Invalid QA Worker namespace');
  return host.slice(offset+1);
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
export function authorized(request, env, now = Date.now()) {
  const created = Date.parse(env.QA_CREATED_AT), expires = Date.parse(env.QA_EXPIRES_AT);
  if (env.QA_KIND !== QA_KIND || env.QA_FROZEN_TREE !== FEATURE_TREE || !RUN.test(env.QA_RUN || '')
      || !SHA.test(env.QA_SOURCE_SHA || '') || !KEY.test(env.QA_ACCESS_TOKEN || '')
      || !Number.isFinite(created) || !Number.isFinite(expires) || created > now || now >= expires
      || expires <= created || expires - created > 3_600_000) return false;
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Bearer ')) return safeEqual(header.slice(7), env.QA_ACCESS_TOKEN);
  if (header.startsWith('Basic ')) {
    try { return safeEqual(atob(header.slice(6)), 'flux-qa:' + env.QA_ACCESS_TOKEN); } catch { return false; }
  }
  return false;
}
export function ownedPrefix(env) {
  if (!RUN.test(env.QA_RUN || '')) throw new Error('Invalid QA ownership');
  return 'qa-runs/' + env.QA_RUN + '/';
}
export function privateResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Authorization');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, headers });
}
