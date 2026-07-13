(function(){
  // Bump this whenever the caching strategy changes. The activate handler deletes
  // any cache that does not match, forcing a clean re-cache of current assets.
  var CACHE_NAME = 'ai-image-generator-pwa-v22';
  var STATIC_URLS = [
    '/',
    '/static/styles.css',
    '/static/tabs.js',
    '/static/generation-settings.js',
    '/static/prompt-enhancer.js',
    '/static/failure-advice.js',
    '/static/app.js',
    '/static/canvas-viewport.js',
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
        // cache: 'reload' 繞過 HTTP 快取直達伺服器，避免新版 SW 安裝時
        // 從瀏覽器快取抓到舊資產、把舊檔案裝進新 cache。
        return cache.addAll(STATIC_URLS.map(function(url){
          return new Request(url, { cache: 'reload' });
        }));
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

  // HTML 與靜態資產都採 network-first：同一個頁面不會混用新版 HTML
  // 與舊版 JavaScript。離線或網路失敗時才退回最後一次成功快取。
  self.addEventListener('fetch', function(event){
    if(!isAppAsset(event.request)){ return; }
    event.respondWith(
      caches.open(CACHE_NAME).then(function(cache){
        return cache.match(event.request).then(function(cached){
          // no-cache：帶 ETag 向伺服器驗證，確保拿到的是最新部署。
          var network = fetch(new Request(event.request, { cache: 'no-cache' })).then(function(response){
            if(response && response.status === 200){
              cache.put(event.request, response.clone());
            }
            return response;
          }).catch(function(){
            return cached;
          });
          return network.then(function(response){ return response || cached; });
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
