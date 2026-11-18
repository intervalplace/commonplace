// Commonplace keeps a copy of itself in the browser, so a host is needed only once, to bring you in.
//
// The service worker (public/sw.js) serves the page from the browser's own storage. Which release it
// serves can come from two places:
//   - the host the page was first loaded from (until a network release is known), or
//   - the network: the .csd name RELEASE_NAME (Cairn's name service) points to the current release
//     by its IPFS address (its profile's `contenthash`, ipfs://<CIDv1>). Only a name held by RELEASE_KEY counts, so a name
//     that lapses or changes hands can't push a release to anyone.
// A release from the network is downloaded from any IPFS gateway as a CAR file and checked before
// use: every block must hash to its own address, and the files must hang off exactly the address
// the name points to. A gateway can refuse to answer; it can't change a byte.
import type { CsdName } from "./cns";

export const RELEASE_NAME = (process.env.NEXT_PUBLIC_RELEASE_NAME ?? "").trim();
export const RELEASE_KEY = (process.env.NEXT_PUBLIC_RELEASE_KEY ?? "").trim().toLowerCase();
const GATEWAYS = (process.env.NEXT_PUBLIC_IPFS_GATEWAYS ?? "https://trustless-gateway.link,https://ipfs.io,https://dweb.link")
  .split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
const META_CACHE = "cp-meta", META_KEY = "/__cp/meta";
const MAX_BYTES = 64 * 1024 * 1024, MAX_FILES = 5000;

export type Meta = { cache: string; source: "host" | "ipfs"; cid?: string; at?: number };

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json", txt: "text/plain; charset=utf-8", svg: "image/svg+xml",
  png: "image/png", ico: "image/x-icon", woff2: "font/woff2", woff: "font/woff", wasm: "application/wasm",
};
const mime = (p: string) => MIME[p.split(".").pop() ?? ""] ?? "application/octet-stream";

export async function readMeta(): Promise<Meta | null> {
  try {
    if (!(await caches.has(META_CACHE))) return null;
    const r = await (await caches.open(META_CACHE)).match(META_KEY);
    return r ? await r.json() : null;
  } catch { return null; }
}
async function writeMeta(m: Meta) {
  await (await caches.open(META_CACHE)).put(META_KEY, new Response(JSON.stringify(m), { headers: { "content-type": "application/json" } }));
}

// The files of a release, from a CAR file, with every block checked against its own address and
// the whole tree against `root`
export async function filesFromCar(bytes: Uint8Array, root: string): Promise<Map<string, Uint8Array>> {
  const [{ CarReader }, dagPb, { UnixFS }, { sha256 }, { CID }] = await Promise.all([
    import("@ipld/car"), import("@ipld/dag-pb"), import("ipfs-unixfs"), import("multiformats/hashes/sha2"), import("multiformats/cid"),
  ]);
  const car = await CarReader.fromBytes(bytes);
  const want = CID.parse(root).toV1().toString();
  const blocks = new Map<string, Uint8Array>();
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  for await (const b of car.blocks()) {
    if (b.cid.multihash.code !== sha256.code) throw new Error("a block uses a hash this page doesn't check");
    const d = await sha256.digest(b.bytes);
    if (!same(d.digest, b.cid.multihash.digest)) throw new Error("a block doesn't match its address");
    blocks.set(b.cid.toV1().toString(), b.bytes);
  }
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const block = (cid: any) => { const b = blocks.get(cid.toV1().toString()); if (!b) throw new Error("the release is incomplete"); return b; };
  const fileBytes = (cid: any): Uint8Array => {
    const b = block(cid);
    if (cid.code === 0x55) return b; // a raw leaf
    const node = dagPb.decode(b), fs = UnixFS.unmarshal(node.Data!);
    if (fs.type !== "file" && fs.type !== "raw") throw new Error("expected a file");
    const parts = [fs.data ?? new Uint8Array(), ...node.Links.map(l => fileBytes(l.Hash))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const walk = (cid: any, path: string) => {
    const node = dagPb.decode(block(cid)), fs = UnixFS.unmarshal(node.Data!);
    if (fs.type !== "directory") throw new Error(`unsupported folder (${fs.type})`);
    for (const l of node.Links) {
      const name = l.Name ?? "";
      if (!name || name.includes("/") || name === "." || name === "..") throw new Error("a bad file name");
      const p = path ? `${path}/${name}` : name;
      const child = l.Hash.code === 0x55 ? null : UnixFS.unmarshal(dagPb.decode(block(l.Hash)).Data!);
      if (child?.type === "directory") walk(l.Hash, p);
      else {
        const bytes = fileBytes(l.Hash);
        total += bytes.length;
        if (total > MAX_BYTES || files.size >= MAX_FILES) throw new Error("the release is larger than a page should be");
        files.set(p, bytes);
      }
    }
  };
  const roots = (await car.getRoots()).map(r => r.toV1().toString());
  if (!roots.includes(want)) throw new Error("the CAR isn't the release asked for");
  walk(CID.parse(want), "");
  if (!files.has("index.html")) throw new Error("the release has no index.html");
  return files;
}

async function download(cid: string): Promise<Map<string, Uint8Array>> {
  let last: unknown = null;
  for (const gw of GATEWAYS) {
    try {
      const r = await fetch(`${gw}/ipfs/${cid}?format=car`, { headers: { accept: "application/vnd.ipld.car" }, signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`${gw} answered ${r.status}`);
      return await filesFromCar(new Uint8Array(await r.arrayBuffer()), cid);
    } catch (e) { last = e; }
  }
  throw last ?? new Error("no gateway had it");
}

// Put a checked release in the browser's storage and make it the one served from now on
export async function install(cid: string, files: Map<string, Uint8Array>) {
  const name = `cp-ipfs-${cid}`;
  const cache = await caches.open(name);
  for (const [path, bytes] of files) {
    const res = () => new Response(bytes as BodyInit, { headers: { "content-type": mime(path) } });
    await cache.put(`/${path}`, res());
    if (path === "index.html") await cache.put("/", res());
  }
  await writeMeta({ cache: name, source: "ipfs", cid, at: Date.now() });
  navigator.serviceWorker?.controller?.postMessage({ type: "cp-meta" });
  // the previous release goes once this one is in place
  for (const k of await caches.keys()) if (k.startsWith("cp-") && k !== name && k !== META_CACHE) await caches.delete(k);
}

export type UpdateResult = { state: "off" | "current" | "updated" | "skipped"; cid?: string; why?: string };

// Ask the network which release is current, and install it if it's new. `lookup` resolves a .csd
// name with its records checked (src/cns.ts).
export async function updateFromNetwork(lookup: (name: string) => Promise<CsdName>): Promise<UpdateResult> {
  if (!RELEASE_NAME || !RELEASE_KEY || typeof caches === "undefined" || !("serviceWorker" in navigator)) return { state: "off" };
  const n = await lookup(RELEASE_NAME);
  if (!n.checked || n.state !== "held") return { state: "skipped", why: "the release name couldn't be checked" };
  if (n.owner?.toLowerCase() !== RELEASE_KEY) return { state: "skipped", why: "the release name isn't held by the release key" };
  const cid = /^ipfs:\/\/(b[a-z2-7]{50,100})$/.exec(n.profile["contenthash"] ?? "")?.[1] ?? "";
  if (!/^bafy[a-z2-7]{50,}$/.test(cid)) return { state: "skipped", why: "the release name doesn't point to a release" };
  const m = await readMeta();
  if (m?.cid === cid) return { state: "current", cid };
  await install(cid, await download(cid));
  return { state: "updated", cid };
}

// Register the service worker; `?sw=off` takes it away again (handled in the worker itself too)
export async function registerWorker() {
  if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
  if (new URLSearchParams(location.search).get("sw") === "off") {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) if (k.startsWith("cp-")) await caches.delete(k);
    return;
  }
  try { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch {}
}
