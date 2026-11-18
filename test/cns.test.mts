// .csd names (src/cns.ts): proven events replayed through Cairn's own resolver. The node and Cairn's
// server are stood in for: a name-history and the proven transactions behind it.
//   npx tsx test/cns.test.mts
import { nameClaim, nameSet, nameProfile, nameRegFee, TREASURY_ADDR } from "@inversealtruism/cairnx-core";
import { txid as txidOf, hexToBytes, keyFromPrivate, signTx, serializeTx, bytesToHex, type Hex, type Tx } from "../src/csd";
import { primaryCsdName, lookupCsdName, targetOf, nodeOf } from "../src/cns";
import type { Verified } from "../src/light";
let failures = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failures++; };
const kA = keyFromPrivate(new Uint8Array(32).fill(1)), kB = keyFromPrivate(new Uint8Array(32).fill(2));
const A = kA.addr20.toLowerCase() as Hex, B = kB.addr20.toLowerCase() as Hex;
const keyOf = (a: Hex) => (a === A ? kA : kB);
const H0 = 40_100; // after names leases, before sealed registration: a direct claim with its fee
type Built = { uri: string; payloadHash: string };
const proven = new Map<string, Verified>(), history: { txid: string; height: number; pos: number; kind: string }[] = [];
const raw: { txid: string; height: number; pos: number; tx_raw: string }[] = [];
let n = 0;
const add = (by: Hex, b: Built, height: number, pay: { addr: Hex; value: bigint }[] = []) => {
  const tx: Tx = signTx({ version: 1, inputs: [{ txid: ("0x" + (++n).toString(16).padStart(64, "0")) as Hex, vout: 0, scriptSig: new Uint8Array() }], outputs: pay.map(p => ({ addr20: p.addr, value: p.value })), locktime: 0,
    app: { kind: "propose", domain: "cairnx:v1", payloadHash: hexToBytes(b.payloadHash), uri: b.uri, expiresEpoch: BigInt(Math.floor(height / 30) + 100) } }, keyOf(by));
  const txid = txidOf(tx);
  proven.set(txid, { txid, tx, author: by, height, index: 1, blockHash: ("0x" + "00".repeat(32)) as Hex, depth: 10 });
  history.push({ txid, height, pos: 1, kind: "x" });
  raw.push({ txid, height, pos: 1, tx_raw: bytesToHex(serializeTx(tx)) });
};
add(A, nameClaim({ name: "alice" }), H0, [{ addr: TREASURY_ADDR as Hex, value: nameRegFee("alice", H0) }]);
add(B, nameClaim({ name: "alice" }), H0 + 5, [{ addr: TREASURY_ADDR as Hex, value: nameRegFee("alice", H0 + 5) }]);
add(A, nameSet({ name: "alice", addr: B }), H0 + 10);
add(A, nameProfile({ name: "alice", p: { contenthash: "ipfs://bafybeigqtu3nfqikwhmevdp7unfajbhdx7eikz4nc7k4puvqluaebo3jc4", "csd.node": "https://csd.aon.network" } }), H0 + 20);
const light = { checkTx: async (id: Hex) => { const v = proven.get(id); if (!v) throw new Error("BAD_PROOF"); return v; }, syncTail: async () => ({ height: H0 + 100 }) };
const fakeCairn = (body: object, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const hist = (resolve: object, sufficient = true) => ({ ok: true, name: "alice", tipHeight: H0 + 100, resolve, events: history, scopedReplaySufficient: sufficient });

const r = await lookupCsdName("alice", light, { fetch: fakeCairn(hist({ addr: B, owner: A })) });
ok(r.state === "held" && r.owner === A, "the first claim holds it; a later claim by someone else doesn't");
ok(r.addr === B, "it resolves to the address its owner set");
ok(r.profile["csd.node"] === "https://csd.aon.network", "its profile is read");
ok(r.checked && !r.serverDisagrees, "every event proven, and Cairn's server agrees");
const t = targetOf(r);
ok(t?.kind === "ipfs", "opening it goes to its site on IPFS, when it has one");
ok(nodeOf(r) === "https://csd.aon.network", "and its node is where the node chooser goes");
const lying = await lookupCsdName("alice", light, { fetch: fakeCairn(hist({ addr: A, owner: A })) });
ok(lying.addr === B && lying.serverDisagrees, "a server that says otherwise is caught; the proven replay stands");
const partial = await lookupCsdName("alice", light, { fetch: fakeCairn(hist({ addr: B, owner: A }, false)) });
ok(!partial.checked && partial.why, "a history the server marks as not decidable on its own isn't called checked");
const free = await lookupCsdName("nobody", light, { fetch: fakeCairn({}, 404) });
ok(free.state === "free", "a name Cairn has no record of is free");
let refused = false;
try { await lookupCsdName("alice", { ...light, checkTx: async () => { throw new Error("BAD_PROOF: not in that block"); } }, { fetch: fakeCairn(hist({ addr: B, owner: A })) }); } catch { refused = true; }
ok(refused, "an event that doesn't prove stops the lookup");
// Cairn's server gone: the name is rebuilt from a node's whole CairnX history
let pages = 0;
const nodeFetch = (async (u: string) => {
  const m = /\/events\/[^/]+\/(\d+)\/(\d+)$/.exec(String(u))!; pages++;
  const from = +m[1], to = from + +m[2] - 1;
  return new Response(JSON.stringify({ ok: true, events: raw.filter(e => e.height >= from && e.height <= to) }), { status: 200 });
}) as unknown as typeof fetch;
const down = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
const fb = await lookupCsdName("alice", light, { fetch: down, node: { base: "http://node", fetch: nodeFetch } });
ok(fb.source === "node" && fb.state === "held" && fb.owner === A && fb.addr === B && fb.checked, "with Cairn's server down, the node's own history decides the same, proven");
ok(pages > 0, `it read the history in pages (${pages})`);
const again = await lookupCsdName("alice", light, { fetch: down, node: { base: "http://node", fetch: nodeFetch } });
ok(again.addr === B, "and a second lookup reuses what it read");
const lyingNode = (async (u: string) => { const r = await nodeFetch(u as any); const j = await r.json(); for (const e of j.events) e.tx_raw = e.tx_raw.slice(0, -2) + (e.tx_raw.endsWith("00") ? "01" : "00"); return new Response(JSON.stringify(j)); }) as unknown as typeof fetch;
let caught = false;
try { await lookupCsdName("alice", light, { fetch: down, node: { base: "http://other-node", fetch: lyingNode } }); } catch { caught = true; }
ok(caught, "a node that alters a record is caught");
// someone's own .csd name: one they hold that points to their own address
add(B, nameClaim({ name: "bob" }), H0 + 30, [{ addr: TREASURY_ADDR as Hex, value: nameRegFee("bob", H0 + 30) }]);
add(B, nameSet({ name: "bob", addr: B }), H0 + 31);
const nodeB = { base: "http://node-b", fetch: nodeFetch };
const pb = await primaryCsdName(B, light, nodeB);
ok(pb?.name === "bob" && pb.checked, "B's own name is found from the history and checked");
ok((await primaryCsdName(A, light, nodeB)) === null, "A holds alice, but it points to B, so A has no name of their own to show");
ok((await primaryCsdName(B, { ...light, checkTx: async () => { throw new Error("BAD_PROOF"); } }, { base: "http://node-c", fetch: nodeFetch })) === null, "a name that can't be checked isn't shown");
console.log(failures ? `\n${failures} failed` : "\nall passed"); process.exit(failures ? 1 : 0);
