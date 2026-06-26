(function(){
  var CACHE_NAME = 'ai-image-generator-pwa-v2';
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
    '/static/tutorial.js'
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

  self.addEventListener('fetch', function(event){
    if(event.request.method !== 'GET'){ return; }
    event.respondWith(
      caches.match(event.request).then(function(cached){
        if(cached){ return cached; }
        return fetch(event.request);
      })
    );
  });

  self.addEventListener('message', function(event){
    if(event.data && event.data.type === 'SKIP_WAITING'){
      self.skipWaiting();
    }
  });
})();
