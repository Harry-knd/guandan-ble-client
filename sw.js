/* 只缓存静态资源；绝不缓存 BLE 快照、私牌或操作。 */
const CACHE = "gd-ble-static-v5";
const FILES = ["./", "./index.html", "./style.css", "./protocol.js", "./app.js", "./transports.js", "./table-ui.js"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("gd-ble-static-") && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request, {ignoreSearch: event.request.mode === "navigate"}).then(cached => cached || fetch(event.request)));
});
