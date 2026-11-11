// Invite links: CSD put on a key of its own, with that key in the link (after the #, so it never
// reaches any server). Whoever opens the link first moves the CSD to their own writing key. The
// invite keys come from the writing key that made them, numbered, so the maker can find them again
// on any device and take back any nobody used. No server is involved.

import { sha256 } from "@noble/hashes/sha2";
import { SEND_FEE, concat, keyFromPrivate, utf8, type CsdKey } from "./csd";

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
