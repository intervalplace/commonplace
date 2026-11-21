// Invite links: CSD put on a key of its own, with that key in the link (after the #, so it never
// reaches any server). Whoever opens the link first moves the CSD to their own writing key. The
// invite keys come from the writing key that made them, numbered, so the maker can find them again
// on any device and take back any nobody used. No server is involved.

import { sha256 } from "@noble/hashes/sha2";
import { SEND_FEE, buildSendTx, concat, keyFromPrivate, sha256d, utf8, type AppPayload, type CsdKey, type Hex } from "./csd";
import { EPOCH_LEN } from "./csd";
import { KEEP_EPOCHS } from "./entries";

export const inviteKey = (maker: CsdKey, n: number): CsdKey => {
  const i = new Uint8Array(4); new DataView(i.buffer).setUint32(0, n);
  return keyFromPrivate(sha256(concat(utf8("commonplace invite v1"), maker.priv, i)));
};

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const inviteCode = (k: CsdKey) => b64u(k.priv);
export function keyFromCode(code: string): CsdKey | null {
  try {
    const b = Uint8Array.from(atob(code.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    return b.length === 32 ? keyFromPrivate(b) : null;
  } catch { return null; }
}
export const inviteLink = (k: CsdKey) => `${location.origin}${location.pathname}#/invite/${inviteCode(k)}`;

// what the maker puts on each invite: the gift plus the fee for moving it on, so it arrives whole
export const fundFor = (gift: bigint) => gift + SEND_FEE;

// Open invites: invite links listed on the network for anyone to take, first come first served, so
// a newcomer can start with nothing and without asking anyone. The record carries the links' codes
// (the keys holding the CSD); whoever claims one first moves its CSD to their own key. Listed in
// the same transaction that funds them.
//
// They go in one pool shared by every app on the network, csd.welcome (the compute-substrate kit's
// welcome() reads it too), so whoever fills it helps every app's newcomers. Commonplace's older
// pool, cp.invites, is still read.
export const WELCOME_TOPIC = "csd.welcome";
export const OPEN_TOPIC = WELCOME_TOPIC;
export const OPEN_TOPICS = [WELCOME_TOPIC, "cp.invites"];
export const OPEN_MAX = 10; // codes per record: 43 characters each, within 512 bytes
export const openInvitesUri = (codes: string[]) => `invites:${codes.join(",")}`;
export function parseOpenInvites(uri: string): string[] {
  const m = /^(?:cp:)?invites:([A-Za-z0-9_,-]+)$/.exec(uri);
  return m ? m[1].split(",").filter(c => keyFromCode(c) !== null).slice(0, OPEN_MAX) : [];
}
export function openInvitesArgs(codes: string[], height: number): AppPayload {
  const uri = openInvitesUri(codes);
  return { kind: "propose", domain: OPEN_TOPIC, payloadHash: sha256d(utf8(uri)), uri, expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS };
}

// A newcomer's welcome: when a writing key made here has never held anything, take one open invite
// onto it, so its first entry just works. Once per key, in this browser. Returns what's on its way.
type InviteApi = {
  proposalsIn: (d: string, limit?: number) => Promise<{ uri?: string; height: number | bigint }[]>;
  utxos: (a: Hex) => Promise<{ txid: Hex; vout: number; value: bigint }[]>;
  submit: (tx: any) => Promise<Hex>;
};
export async function welcome(api: InviteApi, to: Hex): Promise<bigint | null> {
  const mark = `cp.welcomed.${to.toLowerCase()}`;
  try { if (localStorage.getItem(mark)) return null; } catch {}
  const done = () => { try { localStorage.setItem(mark, "1"); } catch {} };
  if ((await api.utxos(to)).length) { done(); return null; }
  const codes = new Set<string>();
  for (const t of OPEN_TOPICS) {
    const ps = await api.proposalsIn(t, 200).catch(() => []);
    for (const p of [...ps].sort((a, b) => Number(b.height) - Number(a.height))) for (const c of parseOpenInvites(p.uri ?? "")) codes.add(c);
  }
  const list = [...codes];
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  for (const code of list.slice(0, 40)) {
    const k = keyFromCode(code);
    if (!k) continue;
    const us = await api.utxos(k.addr20).catch(() => []);
    const held = us.reduce((s, u) => s + u.value, 0n);
    if (held <= SEND_FEE) continue;
    try { await api.submit(buildSendTx(us as any, k, to, "all")); done(); return held - SEND_FEE; } catch { /* taken a moment ago */ }
  }
  return null;
}
