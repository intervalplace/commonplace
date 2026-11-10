// An Arweave data item (ANS-104), signed with an Ethereum-style secp256k1 key: the writing key.
// Bundling services (Turbo) take these and put them on Arweave. Written out here rather than
// pulled in from a library, so the page needs no Node polyfills; test/ans104.test.mts checks
// every item against arbundles, the reference implementation.
//
//   u16 signature type (3: Ethereum) | 65-byte signature | 65-byte owner (uncompressed pubkey)
//   | 0 (no target) | 0 (no anchor) | u64 tag count | u64 tag bytes | tags (Avro) | data
// The signature is EIP-191 over deepHash(["dataitem", "1", "3", owner, target, anchor, tags, data]),
// and the item's id is base64url(sha256(signature)).

import { sha256, sha384 } from "@noble/hashes/sha2";
import { secp256k1 } from "@noble/curves/secp256k1";
import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, concat, hexToBytes, utf8 } from "./csd";

const SIG_ETHEREUM = 3;

function u16(n: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u64(n: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; }

// Avro: a long is zigzag, then base-128 little-endian
function avroLong(n: number): Uint8Array {
  let z = BigInt(n) >= 0n ? BigInt(n) << 1n : (-BigInt(n) << 1n) - 1n;
  const out: number[] = [];
  do { let b = Number(z & 0x7fn); z >>= 7n; if (z) b |= 0x80; out.push(b); } while (z);
  return new Uint8Array(out);
}
const avroBytes = (b: Uint8Array) => concat(avroLong(b.length), b);
export function encodeTags(tags: { name: string; value: string }[]): Uint8Array {
  if (!tags.length) return new Uint8Array(0);
  const parts: Uint8Array[] = [avroLong(tags.length)];
  for (const t of tags) parts.push(avroBytes(utf8(t.name)), avroBytes(utf8(t.value)));
  parts.push(avroLong(0));
  return concat(...parts);
}

type Chunk = Uint8Array | Chunk[];
function deepHash(c: Chunk): Uint8Array {
  if (Array.isArray(c)) {
    let acc = sha384(concat(utf8("list"), utf8(String(c.length))));
    for (const x of c) acc = sha384(concat(acc, deepHash(x)));
    return acc;
  }
  return sha384(concat(sha384(concat(utf8("blob"), utf8(String(c.length)))), sha384(c)));
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function dataItem(priv: Uint8Array, data: Uint8Array, tags: { name: string; value: string }[]): Promise<{ bytes: Uint8Array; id: string }> {
  const owner = secp256k1.getPublicKey(priv, false); // 65 bytes
  const rawTags = encodeTags(tags);
  const empty = new Uint8Array(0);
  const message = deepHash([utf8("dataitem"), utf8("1"), utf8(String(SIG_ETHEREUM)), owner, empty, empty, rawTags, data]);
  const sig = hexToBytes(await privateKeyToAccount(bytesToHex(priv)).signMessage({ message: { raw: message } }));
  if (sig.length !== 65) throw new Error("BAD_SIGNATURE");
  const bytes = concat(u16(SIG_ETHEREUM), sig, owner, new Uint8Array([0]), new Uint8Array([0]), u64(tags.length), u64(rawTags.length), rawTags, data);
  return { bytes, id: b64url(sha256(sig)) };
}
