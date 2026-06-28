(function(){
  // Bump this whenever the caching strategy changes. The activate handler deletes
  // any cache that does not match, forcing a clean re-cache of current assets.
  var CACHE_NAME = 'ai-image-generator-pwa-v3';
  var STATIC_URLS = [
    '/',
    '/static/styles.css',
    '/static/generation-settings.js',
    '/static/prompt-enhancer.js',
    '/static/failure-advice.js',
    '/static/app.js',
    '/static/prompt-transform.js',
    '/static/idea-store.js',
    '/static/idea-cards.js',
    '/static/history-store.js',
    '/static/history-wall.js',
    '/static/tutorial.js',
    '/static/prompt-pack.js',
    '/static/hf-ideas.js'
  ];

  self.addEventListener('install', function(event){
    event.waitUntil(
      caches.open(CACHE_NAME).then(function(cache){
        return cache.addAll(STATIC_URLS);
      }).then(function(){
        return self.skipWaiting();
      })
    );
  });

  self.addEventListener('activate', function(event){
    event.waitUntil(
      caches.keys().then(function(names){
        return Promise.all(names.map(function(name){
          if(name !== CACHE_NAME){
            return caches.delete(name);
          }
          return Promise.resolve();
        }));
      }).then(function(){
        return self.clients.claim();
      })
    );
  });

  // Only same-origin GETs for the app shell and static assets are cached here.
  // API calls (/generate, /prompt/*, /gallery) and cross-origin requests (e.g. the
  // Hugging Face dataset) bypass the cache entirely.
  function isAppAsset(request){
    if(request.method !== 'GET'){ return false; }
    var url = new URL(request.url);
    if(url.origin !== self.location.origin){ return false; }
    return url.pathname === '/' || url.pathname.indexOf('/static/') === 0;
  }

  // Stale-while-revalidate: serve the cached copy instantly, then refresh it in the
  // background so the NEXT load always picks up a new deploy. This is the fix for the
  // old cache-first strategy, which served stale JS forever until CACHE_NAME changed.
  self.addEventListener('fetch', function(event){
    if(!isAppAsset(event.request)){ return; }
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache){
        return cache.match(event.request).then(function(cached){
          var network = fetch(event.request).then(function(response){
            if(response && response.status === 200){
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(function(){
            return cached;
          });
          return cached || network;
        });
      })
    );
  });

  self.addEventListener('message', function(event){
    if(event.data && event.data.type === 'SKIP_WAITING'){
      self.skipWaiting();
    }
  });
})();
