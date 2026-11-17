// Makes src/anchors.json: the hash of every 1000th block, which each release carries so a visitor's
// browser can check any block below the newest anchor by hash alone (see src/light.ts).
//
// It reads every header from genesis from a node and checks all of them in full on the way:
// each links to the one before, has valid proof-of-work, and has exactly the difficulty the
// network's rule demands. It stops 100 blocks short of the tip, so no anchor sits where a reorg
// could still move it. Run it before a release, against any node (your own is best):
//
//   npx tsx scripts/anchors.mts https://csd.aon.network
//
// Anyone can check a release's anchors the same way against their own node.
import { writeFileSync } from "node:fs";
import { parseHeader, checkHeaders, GENESIS_HASH, type Header } from "../src/light";
import { hexToBytes } from "../src/csd";

const base = (process.argv[2] ?? "https://csd.aon.network").replace(/\/$/, "");
const EVERY = 1000, KEEP_BACK = 100;
const get = async (p: string) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json() as any; };

const tip = (await get("/tip")).height as number;
const end = Math.max(0, Math.floor((tip - KEEP_BACK) / EVERY) * EVERY);
console.log(`tip ${tip}; checking every header to ${end}`);

const hashes: string[] = [];
let window: Header[] = [];
for (let s = 0; s <= end; s += 2000) {
  const j = await get(`/headers/${s}/${Math.min(2000, end - s + 1)}`);
  const hs = (j.headers as string[]).map(h => parseHeader(hexToBytes("0x" + h)));
  if (!hs.length) throw new Error(`no headers from ${s}`);
  if (s === 0) {
    if (hs[0].hash !== GENESIS_HASH) throw new Error("the node's genesis isn't the network's");
    checkHeaders([hs[0]], 1, hs.slice(1));
  } else checkHeaders(window, s, hs);
  hs.forEach((h, i) => { if ((s + i) % EVERY === 0) hashes.push(h.hash); });
  window = [...window, ...hs].slice(-50);
  process.stdout.write(`\r${s + hs.length - 1} of ${end}`);
}
writeFileSync(new URL("../src/anchors.json", import.meta.url), JSON.stringify({ every: EVERY, hashes }, null, 2) + "\n");
console.log(`\nwrote ${hashes.length} anchors, to block ${(hashes.length - 1) * EVERY}`);
