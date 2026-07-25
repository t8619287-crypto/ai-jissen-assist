// =====================================================
// サービスワーカー:アプリのファイルを端末に記憶して、
// オフラインでも基本画面を開けるようにする仕組み
// =====================================================

// キャッシュ(記憶場所)の名前。アプリを更新したらここの数字を上げる
const CACHE_NAME = "ai-jissen-assist-v2";

// 記憶しておくファイル一覧
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

// インストール時:ファイルをまとめて記憶する
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 有効化時:古いバージョンの記憶を掃除する
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// 通信時:まずネットワークから取得し(常に最新)、
// つながらないときは記憶しておいたファイルを使う(オフライン対応)
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // 取得できたら記憶も最新に更新しておく
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then((cached) => cached || caches.match("./index.html"))
      )
  );
});
