// Remembering someone: a private note to yourself that you liked what a person writes.
//
// It is an entry under the topic `cp.remember` with `uri` `cp:remember:<base64url(nonce || sealed)>`,
// where `sealed` is AES-256-GCM over 21 bytes: 1 to remember or 0 to forget, then the person's
// address. The AES key is sha256("commonplace remember v1" || the writing key's private key), so
// only the same wallet can read it, on any device, and every entry has the same length: anyone can
// see that a key kept something here and when, but not who, and not whether it was remembering or
// forgetting. Replaying a key's entries oldest first gives its list. The person is never told.

import { sha256 } from "@noble/hashes/sha2";
import { EPOCH_LEN, bytesToHex, concat, hexToBytes, sha256d, utf8, type CsdKey, type Hex } from "./csd";
import { KEEP_EPOCHS } from "./entries";

export const REMEMBER_TOPIC = "cp.remember";
const PREFIX = "cp:remember:";

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

// WebCrypto wants a plain ArrayBuffer behind each view
const buf = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>;

const keys = new WeakMap<CsdKey, Promise<CryptoKey>>();
function aesKey(k: CsdKey) {
  let p = keys.get(k);
  if (!p) {
    p = crypto.subtle.importKey("raw", buf(sha256(concat(utf8("commonplace remember v1"), k.priv))), "AES-GCM", false, ["encrypt", "decrypt"]);
    keys.set(k, p);
  }
  return p;
}

export async function sealRemember(k: CsdKey, who: Hex, remember: boolean): Promise<string> {
  const plain = concat(new Uint8Array([remember ? 1 : 0]), hexToBytes(who));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(k), buf(plain)));
  return PREFIX + b64u(concat(iv, sealed));
}

// null for anything that isn't one of this key's own
export async function openRemember(k: CsdKey, uri: string): Promise<{ who: Hex; remember: boolean } | null> {
  if (!uri.startsWith(PREFIX)) return null;
  try {
    const raw = unb64u(uri.slice(PREFIX.length));
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(raw.slice(0, 12)) }, await aesKey(k), buf(raw.slice(12))));
    if (plain.length !== 21 || plain[0] > 1) return null;
    return { who: bytesToHex(plain.slice(1)), remember: plain[0] === 1 };
  } catch { return null; }
}

export function rememberArgs(uri: string, height: number) {
  return { kind: "propose" as const, domain: REMEMBER_TOPIC, payloadHash: sha256d(utf8(uri)), uri, expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS };
}
