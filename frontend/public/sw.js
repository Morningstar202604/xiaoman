/* 小满 · Service Worker
 * 目标：让应用可离线打开（壳与静态资源缓存），同时在线时永远拿到最新版本。
 * 原则：
 *   1. 只缓存同源 GET 资源，绝不拦截 /api/*（数据始终走网络）；
 *   2. HTML 导航：网络优先、缓存兜底（在线=最新版本，离线=上次缓存的壳）；
 *   3. 静态资源：stale-while-revalidate；
 *   4. 每次构建自动 bump CACHE 版本（scripts/bump-sw.mjs），发布新版本时清理旧缓存。 */

const CACHE = "wo-shell-1790731724634"; // 构建脚本自动替换版本号
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 跨域（行情等）一律不缓存
  if (url.pathname.startsWith("/api/")) return; // API 永不缓存

  // HTML 导航：网络优先，离线回退到缓存壳
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // 静态资源：stale-while-revalidate（命中即返回，同时后台刷新缓存）
  event.respondWith(
    caches.match(request).then((hit) => {
      const refresh = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    }),
  );
});
