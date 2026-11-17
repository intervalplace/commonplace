// Checks the light client (src/light.ts) against a real node: the header rules (proof-of-work and the
// difficulty rule) must accept every header the node accepted, a real entry must check out with
// its author, and every kind of forged answer must be refused.
//
//   CSD_API=http://127.0.0.1:8789 CSD_TEST_KEY=<hex private key holding CSD> npx tsx test/light.test.mts
//
// Use a test chain: this writes an entry.
import { buildAppTx, hexToBytes, bytesToHex, keyFromPrivate, MIN_FEE_PROPOSE, node, type Hex } from "../src/csd";
import { proposeArgs } from "../src/entries";
import { checkHeaders, lightClient, parseHeader, GENESIS_HASH, type Header } from "../src/light";

const base = process.env.CSD_API ?? "http://127.0.0.1:8789";
const priv = process.env.CSD_TEST_KEY;
if (!priv) { console.error("CSD_TEST_KEY is not set"); process.exit(2); }
const api = node(base);
const key = keyFromPrivate(hexToBytes(priv));
let failures = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failures++; };
const refuses = async (p: Promise<unknown>, what: string) => { try { await p; ok(false, `${what} (it was accepted)`); } catch (e: any) { ok(true, `${what}: ${e.message}`); } };
const wait = async (pred: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await new Promise(r => setTimeout(r, 3000)); } return false; };

// 1. Every header the node holds passes the same rules the node applied to it
const tip = (await api.tip()).height;
const all: Header[] = ((await (await fetch(`${base}/headers/0/2000`)).json()).headers as string[]).map(h => parseHeader(hexToBytes("0x" + h)));
ok(all.length === tip + 1, `the node serves all ${tip + 1} headers`);
ok(all[0].hash === GENESIS_HASH, "block 0 is the network's genesis");
try { checkHeaders([all[0]], 1, all.slice(1)); ok(true, "every header links, has valid proof-of-work and exactly the difficulty the rule demands"); }
catch (e: any) { ok(false, `header rules: ${e.message}`); }
// and a header with the difficulty nudged is refused
{
  const bad = all.slice(1, 4).map(h => ({ ...h }));
  bad[1] = { ...bad[1], bits: bad[1].bits - 1 };
  let refused = false; try { checkHeaders([all[0]], 1, bad); } catch { refused = true; }
  ok(refused, "a header claiming a different difficulty is refused");
}

// 2. A real entry checks out, with its author
const coins = await api.utxos(key.addr20);
const tx = buildAppTx(coins, key, proposeArgs(`Light client test, ${new Date().toISOString()}`, "Commonplace Tests", tip), MIN_FEE_PROPOSE);
const id = (await api.submit(tx)).toLowerCase() as Hex;
console.log(`submitted ${id}; waiting for it to be mined and buried a few blocks deep`);
let minedAt = 0;
ok(await wait(async () => { const j = await (await fetch(`${base}/proof/tx/${id.slice(2)}`)).json(); if (j.ok) minedAt = j.height; return j.ok && (await api.tip()).height >= j.height + 12; }, 30 * 60_000), "the entry is mined");

// anchors every 10 blocks, made from the fully checked headers, short of the tip
const now = (await api.tip()).height;
const hs: Header[] = ((await (await fetch(`${base}/headers/0/2000`)).json()).headers as string[]).map(h => parseHeader(hexToBytes("0x" + h)));
const every = 10, end = Math.floor((now - 5) / every) * every;
const anchors = { every, hashes: hs.filter((_, i) => i % every === 0 && i <= end).map(h => h.hash) };
console.log(`entry at block ${minedAt}, anchors to ${end}, tip ${now}`);

const light = lightClient(base, { anchors });
const v = await light.checkTx(id);
ok(v.height === minedAt, `checked: in block ${v.height}, ${v.depth} deep`);
ok(v.author === key.addr20, "its author is the key that signed it");
ok(v.tx.app.kind === "propose" && tx.app.kind === "propose" && v.tx.app.domain === tx.app.domain && v.tx.app.uri === tx.app.uri, `its topic and words are the ones written (${v.tx.app.kind === "propose" ? v.tx.app.domain : "?"})`);
// one in the tail above the newest anchor, if there is one, else below: try both sides
const lightTail = lightClient(base, { anchors: { every, hashes: anchors.hashes.slice(0, Math.max(1, Math.floor(minedAt / every))) } });
ok((await lightTail.checkTx(id)).author === key.addr20, "it also checks out above the newest anchor, through the full header check");

// 3. Forged answers are refused
const forge = (edit: (path: string, j: any) => any) => lightClient(base, {
  anchors,
  fetch: (async (u: any, i?: any) => {
    const r = await fetch(u, i); const j = await r.json(); const path = String(u).slice(base.length);
    return new Response(JSON.stringify(edit(path, j) ?? j), { status: r.status });
  }) as typeof fetch,
});
const flip = (h: string, at: number) => { const b = hexToBytes(h); b[at] ^= 1; return bytesToHex(b); };
await refuses(forge((p, j) => p.startsWith("/proof/") ? { ...j, tx_raw: flip(j.tx_raw, 40) } : j).checkTx(id), "a changed transaction");
await refuses(forge((p, j) => p.startsWith("/proof/") ? { ...j, merkle_branch: [{ hash: "0x" + "11".repeat(32), position: "right" }] } : j).checkTx(id), "a made-up merkle branch");
await refuses(forge((p, j) => p.startsWith("/proof/") ? { ...j, tx_index: j.tx_index + 1 } : j).checkTx(id), "the right branch for the wrong position");
await refuses(forge((p, j) => p.startsWith("/proof/") ? { ...j, height: j.height - 1 } : j).checkTx(id), "the wrong block");
await refuses(forge((p, j) => p.startsWith("/headers/") && j.headers?.length > 3 ? { ...j, headers: j.headers.map((h: string, i: number) => (i === 3 ? flip("0x" + h, 40).slice(2) : h)) } : j).checkTx(id), "a changed header");
await refuses(lightClient(base, { anchors: { every, hashes: anchors.hashes.map((h, i) => (i === anchors.hashes.length - 1 ? flip(h, 0) : h)) } }).checkTx(id), "a chain that doesn't contain the anchored blocks");

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
