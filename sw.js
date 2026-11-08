/* 차트 계산기 오프라인 껍데기 — 이 폴더의 파일만 캐시(시세는 캐시하지 않음: 다른 출처 요청은 건드리지 않는다).
   파일을 바꾸면 VERSION 을 올린다(옛 캐시는 activate 에서 지움). */
const VERSION = "calc-v5";
const SHELL = ["./", "index.html", "app.js", "app.css", "manifest.webmanifest", "vendor/lightweight-charts.standalone.production.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 출처: 네트워크 먼저(새 판이 바로 보이게) → 안 되면 캐시
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r && r.ok) {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("index.html"))));
});
