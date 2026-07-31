const CACHE_NAME = "aviation-collection-v1";
const ASSETS = ["/", "/manifest.json"];

self.addEventListener("install", function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener("activate", function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
});

self.addEventListener("fetch", function(e) {
  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200 && resp.type === "basic") {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(c) {
            c.put(e.request, clone);
          });
        }
        return resp;
      });
    })
  );
});
