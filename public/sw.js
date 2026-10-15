const CACHE = "longbox-v2";
const PRECACHE = ["/", "/manifest.webmanifest"];

function isCacheableAppResponse(response, requestPath, origin) {
  if (!response || response.type !== "basic" || response.redirected || !response.ok) return false;
  let url;
  try {
    url = new URL(response.url);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  if (url.pathname !== requestPath) return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com")) return false;
  if (path.includes("/cdn-cgi/access")) return false;
  if (response.headers.get("location")) return false;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (requestPath === "/manifest.webmanifest") return type.includes("manifest") || type.includes("json");
  if (requestPath === "/") return type.includes("text/html");
  return false;
}

async function putIfApp(cache, path) {
  try {
    const response = await fetch(path, { credentials: "include", redirect: "manual", cache: "no-store" });
    if (!isCacheableAppResponse(response, path, self.location.origin)) return;
    await cache.put(path, response);
  } catch {
    // A login redirect or a dropped network must not fill the cache.
  }
}

function registerLongboxWorker(scope) {
  scope.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(PRECACHE.map((path) => putIfApp(cache, path)))));
    scope.skipWaiting();
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
        .then(() => scope.clients.claim()),
    );
  });

  scope.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    event.respondWith(fetch(request).catch(() => caches.match(request)));
  });
}

if (typeof self !== "undefined" && typeof self.skipWaiting === "function") {
  registerLongboxWorker(self);
}
