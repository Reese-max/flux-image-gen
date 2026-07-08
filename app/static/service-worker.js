(function(){
  // Bump this whenever the caching strategy changes. The activate handler deletes
  // any cache that does not match, forcing a clean re-cache of current assets.
  var CACHE_NAME = 'ai-image-generator-pwa-v12';
  var STATIC_URLS = [
    '/',
    '/static/styles.css',
    '/static/tabs.js',
    '/static/generation-settings.js',
    '/static/prompt-enhancer.js',
    '/static/failure-advice.js',
    '/static/app.js',
    '/static/image-edit.js',
    '/static/prompt-transform.js',
    '/static/idea-store.js',
    '/static/idea-cards.js',
    '/static/history-store.js',
    '/static/history-wall.js',
    '/static/project-store.js',
    '/static/project-board.js',
    '/static/usage-dashboard.js',
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

  // 判斷是否為 HTML 導覽請求（app shell）。這類請求走 network-first，確保
  // 部署後回訪者「第一次載入」就是新版，而不是先看到上一版、下次才更新。
  function isDocumentRequest(request){
    if(request.mode === 'navigate'){ return true; }
    var url = new URL(request.url);
    return url.pathname === '/';
  }

  // 快取策略：
  //  - HTML 文件 → network-first：先抓網路最新，離線時才退回快取（新版即預設）。
  //  - 靜態資產（/static/*）→ stale-while-revalidate：先給快取秒開，背景更新下一版。
  self.addEventListener('fetch', function(event){
    if(!isAppAsset(event.request)){ return; }
    var documentRequest = isDocumentRequest(event.request);
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
          if(documentRequest){
            // network-first：網路成功即用最新版；失敗（network 已 catch 成 cached）退回快取。
            return network.then(function(response){ return response || cached; });
          }
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
