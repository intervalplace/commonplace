// Commonplace's service worker: serves the page from the browser's own storage, so once you've been
// here, opening Commonplace needs no host at all, not even its domain name.
//
// Which copy it serves is written by the page (src/install.ts) in the "cp-meta" cache:
//   source "ipfs"  a release the network named, downloaded and checked block by block against its
//                  IPFS address. Served entirely from storage; the host isn't asked.
//   source "host"  the copy the page came from. The page itself is fetched fresh when the host
//                  answers within a few seconds, so new releases on the host still arrive; its
//                  scripts and styles (whose names change with their contents) are kept once fetched.
// ?sw=off on any page removes this worker and everything it kept (a reset: the next ordinary visit
// starts afresh from the host).
const META = "cp-meta", META_KEY = "/__cp/meta";
let active = null;

async function meta() {
  if (active) return active;
  try {
    const r = await (await caches.open(META)).match(META_KEY);
    active = r ? await r.json() : null;
  } catch { active = null; }
  return (active ??= { cache: "cp-host", source: "host" });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("message", e => { if (e.data && e.data.type === "cp-meta") active = null; });

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/__cp/")) return;
  if (url.searchParams.get("sw") === "off") { e.respondWith(off(req)); return; }
  e.respondWith(serve(req, url));
});

let gone = false;
async function off(req) {
  gone = true;
  await self.registration.unregister();
  for (const k of await caches.keys()) if (k.startsWith("cp-")) await caches.delete(k);
  return fetch(req);
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);

async function serve(req, url) {
  // after ?sw=off, until the page closes: straight to the network, keeping nothing
  if (gone) return fetch(req);
  const m = await meta();
  const cache = await caches.open(m.cache);
  const nav = req.mode === "navigate";
  const key = nav ? "/" : url.pathname;
  if (m.source === "ipfs") {
    const hit = await cache.match(key);
    if (hit) return hit;
    // not part of the release (an outside file the page links to by path): the network, if any
    return fetch(req);
  }
  if (nav) {
    try {
      const r = await timeout(fetch(req, { cache: "no-store" }), 4000);
      if (r.ok) await cache.put("/", r.clone());
      return r;
    } catch (err) {
      const hit = await cache.match("/");
      if (hit) return hit;
      throw err;
    }
  }
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && url.pathname.startsWith("/_next/")) await cache.put(key, r.clone());
  return r;
}
