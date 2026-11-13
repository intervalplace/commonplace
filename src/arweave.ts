// Documents on Arweave: stored for good, paid once. Uploads go through Turbo (ArDrive's upload
// service) as data items signed with the writing key, which is an Ethereum-style key too. Turbo stores files
// up to 105 KiB free, within an allowance per key, so a text document costs only its entry.

import { bytesToHex, sha256d, type CsdKey } from "./csd";
import { dataItem } from "./ans104";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

export const FREE_BYTES = 105 * 1024;
export const GATEWAY = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? "https://arweave.net";
export const TEXT_TYPES: Record<string, string> = { md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8" };

export function contentTypeOf(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return TEXT_TYPES[ext] ?? null;
}

// The address Turbo bills uploads to: the Ethereum address of the writing key (keccak of the
// uncompressed public key), which is not the key's CSD address
// in EIP-55 checksummed form: Turbo's balance lookup only finds the account under that spelling
export function turboAddress(priv: Uint8Array): string {
  return checksumAddress(bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(-20)));
}
export function checksumAddress(a: string): string {
  const h = a.toLowerCase().replace(/^0x/, "");
  const k = bytesToHex(keccak_256(new TextEncoder().encode(h))).replace(/^0x/, "");
  return "0x" + [...h].map((c, i) => (parseInt(k[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}
export const TURBO_TOPUP = "https://console.ar.io/topup";
export const TURBO_PAYMENT = process.env.TURBO_PAYMENT ?? "https://payment.ardrive.io";
// Turbo credits held by an address, in winc (10^12 winc = 1 credit); null when Turbo has no account for it
export async function turboBalance(addr: string): Promise<bigint | null> {
  const r = await fetch(`${TURBO_PAYMENT}/v1/balance?address=${checksumAddress(addr)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`TURBO_${r.status}`);
  const j = await r.json();
  return BigInt(j.effectiveBalance ?? j.winc ?? 0);
}

export const UPLOADER = process.env.NEXT_PUBLIC_TURBO_UPLOAD ?? "https://upload.ardrive.io";

// Signs the file as an Arweave data item with the writing key and hands it to Turbo
export async function upload(key: CsdKey, data: Uint8Array, contentType: string, title: string): Promise<string> {
  const item = await dataItem(key.priv, data, [
    { name: "Content-Type", value: contentType }, { name: "App-Name", value: "Commonplace" }, { name: "Title", value: title.slice(0, 200) },
  ]);
  const r = await fetch(`${UPLOADER}/v1/tx/ethereum`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Blob([item.bytes as BlobPart]) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 402 ? "UPLOAD_NOT_FREE" : `UPLOAD_${r.status}`);
  if (j.id && j.id !== item.id) throw new Error("UPLOAD_ID_MISMATCH");
  return item.id;
}

// Gateways to read from, in order. A file just uploaded through Turbo is served by Turbo's own
// gateway at once, and by others only once it has been bundled onto Arweave, which can take a while.
export const GATEWAYS = [...new Set([GATEWAY, "https://turbo-gateway.com", "https://arweave.net", "https://ardrive.net"])];

// Each gateway is asked for /raw/<id> first: /<id> now redirects to a per-file subdomain that some
// networks block. A response wrapped in a multipart envelope isn't the file itself, so it's skipped.
async function* copies(id: string): AsyncGenerator<Uint8Array> {
  for (const g of GATEWAYS) for (const path of [`raw/${id}`, id]) {
    try {
      const r = await fetch(`${g}/${path}`);
      if (!r.ok) continue;
      if ((r.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/")) continue;
      yield new Uint8Array(await r.arrayBuffer());
      break; // this gateway answered; the next copy comes from the next gateway
    } catch {}
  }
}

// The file's bytes: the first copy that matches the fingerprint, when there is one. With no
// fingerprint, the first copy. Throws when no gateway has it (or none has the fingerprinted file).
export async function readAr(id: string, payloadHash?: string): Promise<Uint8Array> {
  const want = payloadHash?.toLowerCase().replace(/^0x/, "");
  let any = false;
  for await (const buf of copies(id)) {
    any = true;
    if (!want || bytesToHex(sha256d(buf)).toLowerCase().replace(/^0x/, "") === want) return buf;
  }
  throw new Error(any ? "GATEWAY_MISMATCH" : "GATEWAY_UNREACHABLE");
}

// The file, and whether it is exactly the one the entry fingerprinted
export async function fetchDoc(id: string, payloadHash: string): Promise<{ text: string; bytes: number; matches: boolean }> {
  let first: Uint8Array | null = null;
  const want = payloadHash.toLowerCase().replace(/^0x/, "");
  for await (const buf of copies(id)) {
    first ??= buf;
    if (want && bytesToHex(sha256d(buf)).toLowerCase().replace(/^0x/, "") === want) return { text: new TextDecoder().decode(buf), bytes: buf.length, matches: true };
  }
  if (!first) throw new Error("GATEWAY_UNREACHABLE");
  return { text: new TextDecoder().decode(first), bytes: first.length, matches: false };
}
