// Checks this app's CSD encoding against a real node: builds an entry, a reply and a resonance
// with src/csd.ts, submits them, and requires the node to accept each one (it checks the
// signature over its own encoding of the transaction) and to report the same txid.
//
//   CSD_API=http://127.0.0.1:8789 CSD_TEST_KEY=<hex private key holding CSD> npm test
//
// Use a test chain: this writes permanent entries.

import { buildAppTx, hexToBytes, keyFromPrivate, MIN_FEE_ATTEST, MIN_FEE_PROPOSE, node, serializeTx, txid, type Hex } from "../src/csd";
import { parseEntry, proposeArgs } from "../src/entries";

const base = process.env.CSD_API ?? "http://127.0.0.1:8789";
const priv = process.env.CSD_TEST_KEY;
if (!priv) { console.error("CSD_TEST_KEY is not set"); process.exit(2); }
const api = node(base);
const key = keyFromPrivate(hexToBytes(priv));
let failures = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failures++; };
const wait = async (pred: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await new Promise(r => setTimeout(r, 3000)); } return false; };

// Encoding facts that don't need a node
{
  const t = { version: 1, inputs: [], outputs: [], locktime: 0, app: { kind: "none" as const } };
  ok(serializeTx(t).length === 4 + 8 + 8 + 4 + 4, "an empty tx is version, two counts, locktime and the app tag");
}

const tip = await api.tip();
console.log(`node ${base}, height ${tip.height}, key ${key.addr20}`);
const coins = await api.utxos(key.addr20);
ok(coins.length > 0, `the test key holds coins (${coins.reduce((s, u) => s + u.value, 0n)} units)`);

const text = `A test entry, written at ${new Date().toISOString()}. Ünïcødé too: ✓`;
const tx1 = buildAppTx(coins, key, proposeArgs(text, "Commonplace Tests", tip.height), MIN_FEE_PROPOSE);
const id1 = (await api.submit(tx1)).toLowerCase();
ok(id1 === txid(tx1), `the node accepts an entry and agrees on its txid (${id1})`);

const landed = await wait(async () => (await api.proposals(50)).some(p => p.proposal_id.toLowerCase() === id1), 15 * 60_000);
ok(landed, "the entry is mined and listed");
if (landed) {
  const p = (await api.proposals(50)).find(p => p.proposal_id.toLowerCase() === id1)!;
  const e = parseEntry(p);
  ok(e.kind === "note" && e.text === text && e.topic === "commonplace tests", "it reads back as the same text, under the normalized topic");
  const full = await api.proposal(id1 as Hex);
  ok(full?.proposer.toLowerCase() === key.addr20, "its author is the test key");

  const coins2 = await api.utxos(key.addr20);
  const tx2 = buildAppTx(coins2, key, proposeArgs("A reply.", "commonplace tests", tip.height, id1 as Hex), MIN_FEE_PROPOSE);
  const id2 = (await api.submit(tx2)).toLowerCase();
  ok(id2 === txid(tx2), "the node accepts a reply");

  const tx3 = buildAppTx(await api.utxos(key.addr20), key, { kind: "attest", proposalId: id1 as Hex, score: 1, confidence: 1 }, MIN_FEE_ATTEST);
  const id3 = (await api.submit(tx3)).toLowerCase();
  ok(id3 === txid(tx3), "the node accepts a resonance");

  const counted = await wait(async () => ((await api.resonance())[id1]?.count ?? 0) >= 1, 15 * 60_000);
  ok(counted, "the resonance is counted for the entry");
  const replied = (await api.proposals(50)).map(parseEntry).some(e => e.kind === "reply" && e.replyTo === id1 && e.text === "A reply.");
  ok(replied, "the reply reads back as a reply to the entry");
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
