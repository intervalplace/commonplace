// Documents on Arweave: stored for good, paid once. Uploads go through Turbo (ArDrive's upload
// service) as data items signed with the writing key, which is an Ethereum-style key too. Turbo stores files
// up to 105 KiB free, within an allowance per key, so a text document costs only its entry.

import { bytesToHex, sha256d, type CsdKey } from "./csd";
import { dataItem } from "./ans104";

export const FREE_BYTES = 105 * 1024;
export const GATEWAY = process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ?? "https://arweave.net";
export const TEXT_TYPES: Record<string, string> = { md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8" };

export function contentTypeOf(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return TEXT_TYPES[ext] ?? null;
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
export async function fromGateways(id: string): Promise<Response> {
  let last = 0;
  for (const g of GATEWAYS) {
    try { const r = await fetch(`${g}/${id}`); if (r.ok) return r; last = r.status; } catch {}
  }
  throw new Error(`GATEWAY_${last || "UNREACHABLE"}`);
}

// The file, and whether it is exactly the one the entry fingerprinted
export async function fetchDoc(id: string, payloadHash: string): Promise<{ text: string; bytes: number; matches: boolean }> {
  const r = await fromGateways(id);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { text: new TextDecoder().decode(buf), bytes: buf.length, matches: bytesToHex(sha256d(buf)).toLowerCase() === payloadHash.toLowerCase() };
}
