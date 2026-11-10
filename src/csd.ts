// Compute Substrate (CSD) for the browser: keys, transactions with an app payload, signing, and
// the node's HTTP API. Everything follows the consensus code in compute-substrate:
//   addresses     addr20 = ripemd160(sha256(compressed secp256k1 pubkey))       src/crypto/mod.rs
//   encoding      bincode, fixed-int, little endian                              src/codec/mod.rs
//   transaction   version u32, inputs, outputs, locktime u32, app AppPayload     src/types/mod.rs
//   txid          sha256d(tx with every script_sig emptied)                      src/crypto/mod.rs
//   sighash       sha256d(tagged("CSD_SIG_V1", stripped tx || CHAIN_ID_HASH))    src/crypto/mod.rs
//   script_sig    [64][sig64 compact low-S][33][pub33], 99 bytes                 src/state/utxo.rs
// test/csd.test.ts checks the encoding byte for byte against the node itself.

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { ripemd160 } from "@noble/hashes/legacy";
import { hmac } from "@noble/hashes/hmac";

export type Hex = `0x${string}`;
export type Bytes = Uint8Array;

export const COIN = 100_000_000n;
export const MIN_FEE_PROPOSE = 25_000_000n; // params/mod.rs
export const MIN_FEE_ATTEST = 5_000_000n;
export const EPOCH_LEN = 30;
export const MAX_URI_BYTES = 512;
export const MAX_DOMAIN_BYTES = 128;

// sha256("compute-substrate-mainnet"), params/mod.rs CHAIN_ID_HASH
const CHAIN_ID_HASH = hexToBytes("0x1b17c7b04d05394674ca2c8e24f7433e251a1973cac2000c7b60966546e0b875");

// ── bytes ───────────────────────────────────────────────────────────────────
export function hexToBytes(h: string): Bytes {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error("BAD_HEX");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const bytesToHex = (b: Bytes): Hex => ("0x" + Array.from(b, x => x.toString(16).padStart(2, "0")).join("")) as Hex;
export const utf8 = (s: string) => new TextEncoder().encode(s);
export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const str = (s: string) => { const b = utf8(s); return concat(u64(b.length), b); };
export const sha256d = (b: Bytes) => sha256(sha256(b));
export const hash160 = (b: Bytes) => ripemd160(sha256(b));

// ── keys ────────────────────────────────────────────────────────────────────
export type CsdKey = { priv: Bytes; pub33: Bytes; addr20: Hex };

export function keyFromPrivate(priv: Bytes): CsdKey {
  const pub33 = secp256k1.getPublicKey(priv, true);
  return { priv, pub33, addr20: bytesToHex(hash160(pub33)) };
}

// The writing key, from an Ethereum wallet's signature over WALLET_MESSAGE: the same wallet makes
// the same key on any device, and nothing needs storing
export const WALLET_MESSAGE =
  "Commonplace\n\n" +
  "Signing this makes your Commonplace writing key. Anyone with this signature can write as you " +
  "and spend the CSD it holds, so only sign it on commonplace.place.\n\n" +
  "Version 1";

export function keyFromSignature(signature: Hex): CsdKey {
  const seed = sha256(concat(utf8("Commonplace key v1"), hexToBytes(signature)));
  for (let ctr = 0; ; ctr++) {
    const d = hmac(sha256, seed, concat(utf8("key"), u32(ctr)));
    if (secp256k1.utils.isValidPrivateKey(d)) return keyFromPrivate(d);
  }
}

// ── transactions ────────────────────────────────────────────────────────────
export type AppPayload =
  | { kind: "none" }
  | { kind: "propose"; domain: string; payloadHash: Bytes; uri: string; expiresEpoch: bigint }
  | { kind: "attest"; proposalId: Hex; score: number; confidence: number };
export type TxIn = { txid: Hex; vout: number; scriptSig: Bytes };
export type TxOut = { value: bigint; addr20: Hex };
export type Tx = { version: number; inputs: TxIn[]; outputs: TxOut[]; locktime: number; app: AppPayload };

function encodeApp(a: AppPayload): Bytes {
  // enum variant index u32, then the fields in declaration order
  if (a.kind === "none") return u32(0);
  if (a.kind === "propose") {
    if (a.payloadHash.length !== 32) throw new Error("BAD_PAYLOAD_HASH");
    return concat(u32(1), str(a.domain), a.payloadHash, str(a.uri), u64(a.expiresEpoch));
  }
  const pid = hexToBytes(a.proposalId);
  if (pid.length !== 32) throw new Error("BAD_PROPOSAL_ID");
  return concat(u32(2), pid, u32(a.score), u32(a.confidence));
}

export function serializeTx(tx: Tx, stripScripts = false): Bytes {
  const parts: Bytes[] = [u32(tx.version), u64(tx.inputs.length)];
  for (const i of tx.inputs) {
    const s = stripScripts ? new Uint8Array(0) : i.scriptSig;
    parts.push(hexToBytes(i.txid), u32(i.vout), u64(s.length), s);
  }
  parts.push(u64(tx.outputs.length));
  for (const o of tx.outputs) {
    const a = hexToBytes(o.addr20);
    if (a.length !== 20) throw new Error("BAD_ADDR20");
    parts.push(u64(o.value), a);
  }
  parts.push(u32(tx.locktime), encodeApp(tx.app));
  return concat(...parts);
}

export const txid = (tx: Tx): Hex => bytesToHex(sha256d(serializeTx(tx, true)));

export function sighash(tx: Tx): Bytes {
  const tag = sha256(utf8("CSD_SIG_V1"));
  return sha256d(sha256(concat(tag, tag, serializeTx(tx, true), CHAIN_ID_HASH)));
}

export function signTx(tx: Tx, key: CsdKey): Tx {
  const sig = secp256k1.sign(sighash(tx), key.priv, { lowS: true }).toCompactRawBytes();
  const scriptSig = concat(new Uint8Array([64]), sig, new Uint8Array([33]), key.pub33);
  return { ...tx, inputs: tx.inputs.map(i => ({ ...i, scriptSig })) };
}

export type Utxo = { txid: Hex; vout: number; value: bigint };

const SPLIT_MIN = 30_000_000n; // 0.3 CSD: enough for an entry with room to spare

// A transaction carrying `app`, paying `fee` from the key's coins, the rest back to the key
export function buildAppTx(utxos: Utxo[], key: CsdKey, app: AppPayload, fee: bigint): Tx {
  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const picked: Utxo[] = []; let total = 0n;
  for (const u of sorted) { if (total >= fee) break; picked.push(u); total += u.value; }
  if (total < fee) throw new Error("NOT_ENOUGH_CSD");
  // Change comes back as up to four coins rather than one. The node only spends coins that are
  // already in a block, so with a single coin, writing twice before the next block would fail;
  // with a few, the next entries and resonances have a coin ready.
  const change = total - fee, parts = change >= SPLIT_MIN * 2n ? BigInt(Math.min(4, Number(change / SPLIT_MIN))) : change > 0n ? 1n : 0n;
  const outputs: TxOut[] = [];
  for (let k = 0n; k < parts; k++) outputs.push({ value: k === 0n ? change - (change / parts) * (parts - 1n) : change / parts, addr20: key.addr20 });
  const unsigned: Tx = { version: 1, inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, scriptSig: new Uint8Array(0) })), outputs, locktime: 0, app };
  return signTx(unsigned, key);
}

// The node's /tx/submit JSON: serde's default shapes, byte arrays as number arrays
export function txToJson(tx: Tx) {
  const a = tx.app;
  const app = a.kind === "none" ? "None"
    : a.kind === "propose" ? { Propose: { domain: a.domain, payload_hash: Array.from(a.payloadHash), uri: a.uri, expires_epoch: Number(a.expiresEpoch) } }
    : { Attest: { proposal_id: Array.from(hexToBytes(a.proposalId)), score: a.score, confidence: a.confidence } };
  return {
    version: tx.version,
    inputs: tx.inputs.map(i => ({ prevout: { txid: Array.from(hexToBytes(i.txid)), vout: i.vout }, script_sig: Array.from(i.scriptSig) })),
    outputs: tx.outputs.map(o => ({ value: Number(o.value), script_pubkey: Array.from(hexToBytes(o.addr20)) })),
    locktime: tx.locktime,
    app,
  };
}

// ── the node's API ──────────────────────────────────────────────────────────
export type ProposalItem = { proposal_id: Hex; height: number; time: number; domain: string; payload_hash: Hex; uri: string };

export function node(base: string) {
  const url = (p: string) => `${base.replace(/\/$/, "")}${p}`;
  const get = async (p: string) => {
    const r = await fetch(url(p));
    if (!r.ok) throw new Error(`NODE_${r.status}`);
    return r.json();
  };
  const strip = (h: string) => h.replace(/^0x/, "");
  return {
    tip: async (): Promise<{ height: number }> => ({ height: Number((await get("/tip")).height) }),
    header: async (height: number): Promise<{ bits: number; time: number }> => (await get(`/block/height/${height}`)).header,
    // coins at the address; by default only those not already being spent in the mempool
    utxos: async (addr20: Hex, includeSpending = false): Promise<Utxo[]> =>
      ((await get(`/utxos/${strip(addr20)}${includeSpending ? "" : "?available=true"}`)).utxos ?? []).map((u: any) => ({ txid: String(u.txid).toLowerCase() as Hex, vout: Number(u.vout), value: BigInt(u.value) })),
    // the newest proposals across all topics (the node returns at most 500), and per topic
    proposals: async (limit = 500): Promise<ProposalItem[]> => (await get(`/proposals/${limit}`)).proposals ?? [],
    proposalsIn: async (domain: string, limit = 500): Promise<ProposalItem[]> => (await get(`/proposals/${encodeURIComponent(domain)}/${limit}`)).proposals ?? [],
    proposal: async (id: Hex) => {
      const j = await get(`/proposal/${strip(id)}`);
      return j.ok ? (j.proposal as { proposer: Hex; fee: number; created_height: number; created_epoch: number; expires_epoch: number; domain: string; uri: string }) : null;
    },
    // every attestation ever, summed per proposal
    resonance: async (): Promise<Record<string, { count: number; weight: number }>> => {
      const j = await get("/top/all-time");
      const rows: any[] = j.items ?? j.top ?? j.proposals ?? (Array.isArray(j) ? j : []);
      const out: Record<string, { count: number; weight: number }> = {};
      for (const r of rows) out[String(r.proposal_id).toLowerCase()] = { count: Number(r.attest_count), weight: Number(r.economic_weight) };
      return out;
    },
    topk: async (epoch: number, domain: string): Promise<{ proposal_id: Hex; score: number }[]> => {
      const j = await get(`/topk/${epoch}/${encodeURIComponent(domain)}`);
      return j.items ?? j.topk ?? j.rows ?? [];
    },
    // what an address has done: entries it made ("proposal"), resonances ("attestation"), coins in
    activity: async (addr20: Hex, limit = 200): Promise<{ kind: string; txid: Hex; height: number; time: number; domain?: string; proposal_id?: Hex; uri?: string }[]> =>
      (await get(`/address/${strip(addr20)}/activity?limit=${limit}`)).activity ?? [],
    domains: async (): Promise<{ domain: string; proposals: number; attestations: number }[]> => (await get("/domains")).domains ?? [],
    mempoolTxids: async (): Promise<Hex[]> => ((await get("/mempool/txids")).txids ?? []).map((t: any) => t.txid),
    tx: (id: Hex) => get(`/tx/${strip(id)}`),
    submit: async (tx: Tx): Promise<Hex> => {
      const r = await fetch(url("/tx/submit"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: txToJson(tx) }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.err ?? `NODE_${r.status}`);
      return j.txid;
    },
  };
}
export type Node = ReturnType<typeof node>;
