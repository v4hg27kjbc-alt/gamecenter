const CACHE_NAME = "aviation-v20260804";
const ASSETS = ["/", "/manifest.json"];

// 安装完成立即接管，不等旧 SW 释放
self.addEventListener("install", function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    })
  );
});

// 激活后立即控制所有页面
self.addEventListener("activate", function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// network-first: 优先走网络拿最新，网络失败才回退缓存
self.addEventListener("fetch", function(e) {
  // 只处理 GET 请求
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request).then(function(response) {
      // 网络成功 → 更新缓存，返回最新
      if (response && response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(c) {
          c.put(e.request, clone);
        });
      }
      return response;
    }).catch(function() {
      // 网络失败 → 回退缓存（离线可用）
      return caches.match(e.request);
    })
  );
});
