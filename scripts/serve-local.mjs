// Serves the built site from ./out and passes /node/* through to a CSD node, so a build made
// with NEXT_PUBLIC_CSD_API=/node talks to your own node from the same origin.
//
//   NEXT_PUBLIC_CSD_API=/node npm run build && node scripts/serve-local.mjs [port] [node url] [aon node url]

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.argv[2] ?? 3000);
const upstream = new URL(process.argv[3] ?? "http://127.0.0.1:8789");
// optional: an AON node behind /aon/*, for testing top-ups against a local market
const aonUp = process.argv[4] ? new URL(process.argv[4]) : null;
const root = new URL(process.env.OUT_DIR ? `../${process.env.OUT_DIR}/` : "../out/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".txt": "text/plain", ".woff2": "font/woff2" };

http.createServer(async (req, res) => {
  const via = req.url.startsWith("/node/") ? [upstream, 5] : aonUp && req.url.startsWith("/aon/") ? [aonUp, 4] : null;
  if (via) {
    const [up, cut] = via;
    const p = http.request({ host: up.hostname, port: up.port, path: req.url.slice(cut), method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" } }, r => {
      res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json" });
      r.pipe(res);
    });
    p.on("error", () => { res.writeHead(502); res.end("{}"); });
    req.pipe(p);
    return;
  }
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, path);
  try { if ((await stat(file)).isDirectory()) file = join(file, "index.html"); } catch { file = join(root, "404.html"); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(port, () => console.log(`http://localhost:${port}  (node: ${upstream.href})`));
