// A stand-in for Turbo and an Arweave gateway, for testing documents on a local chain. It
// accepts a signed data item only if arbundles verifies it (as Turbo would), keeps its data,
// and serves it back by id. Never used by the real site.
//
//   node scripts/fake-arweave.mjs [port]
//   build with NEXT_PUBLIC_TURBO_UPLOAD=http://localhost:<port> NEXT_PUBLIC_ARWEAVE_GATEWAY=http://localhost:<port>

import http from "node:http";
import { createRequire } from "node:module";

const { DataItem } = createRequire(import.meta.url)("@dha-team/arbundles");
const port = Number(process.argv[2] ?? 3030);
// with FAKE_ARWEAVE_DIR set, files are also kept on disk, so a restart doesn't forget them
import fs from "node:fs";
import path from "node:path";
const dir = process.env.FAKE_ARWEAVE_DIR;
const store = new Map();
if (dir) { fs.mkdirSync(dir, { recursive: true }); for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); store.set(j.id, { data: Buffer.from(j.data, "base64"), type: j.type }); } }
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "POST" && req.url === "/v1/tx/ethereum") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (buf.length > 110 * 1024) { res.writeHead(402, cors); return res.end("{}"); }
    if (!(await DataItem.verify(buf))) { res.writeHead(400, cors); return res.end(JSON.stringify({ error: "invalid data item" })); }
    const item = new DataItem(buf);
    store.set(item.id, { data: Buffer.from(item.rawData), type: item.tags.find(t => t.name === "Content-Type")?.value ?? "application/octet-stream" });
    if (dir) fs.writeFileSync(path.join(dir, `${item.id}.json`), JSON.stringify({ id: item.id, type: store.get(item.id).type, data: store.get(item.id).data.toString("base64") }));
    console.log("stored", item.id, item.rawData.length, "bytes");
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    return res.end(JSON.stringify({ id: item.id, owner: item.owner }));
  }
  const id = (req.url ?? "").slice(1);
  const hit = store.get(id);
  if (req.method === "GET" && hit) { res.writeHead(200, { ...cors, "content-type": hit.type }); return res.end(hit.data); }
  res.writeHead(404, cors); res.end();
}).listen(port, () => console.log(`fake Turbo and gateway on http://localhost:${port}`));
