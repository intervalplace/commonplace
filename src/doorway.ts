// Doorway's key: when Commonplace is opened through Doorway (at commonplace.localhost), Doorway
// keeps one key for every site, and Commonplace asks it to write instead of holding a key itself.
// Doorway shows each entry and resonance and signs once it's allowed (or without asking, for sites
// the person lets write freely); the key never reaches this page. See Doorway's README, "Your key".
import { bytesToHex, type AppPayload, type Hex } from "@/csd";

export type DoorwayMe = { addr20: Hex; doorway: true };

const here = () => typeof location !== "undefined" && location.hostname.endsWith(".localhost");

// Doorway's key's address, when this page was opened through Doorway and it answers
export async function doorwayAccount(): Promise<Hex | null> {
  if (!here()) return null;
  try {
    const r = await fetch("/.doorway/key", { signal: AbortSignal.timeout(2000) });
    const a = r.ok ? String((await r.json())?.address ?? "").toLowerCase() : "";
    return /^0x[0-9a-f]{40}$/.test(a) ? (a as Hex) : null;
  } catch { return null; }
}

async function ask(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_, v) => typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? `Doorway answered ${r.status}`);
  return j;
}

export async function doorwaySubmit(app: AppPayload, fee: bigint): Promise<Hex> {
  return String((await ask("/.doorway/write", { app, fee })).txid).toLowerCase() as Hex;
}

// that Doorway's key controls its address, for buying CSD with USDC (CSD can only arrive there)
export function doorwayProve(authHash: Hex): Promise<{ pubKey: string; sig: string }> {
  return ask("/.doorway/prove", { authHash });
}

// Doorway's own way to add CSD (by card): its window comes forward with it. False from a Doorway
// too old to have it.
export async function doorwayAdd(): Promise<boolean> {
  try { return (await fetch("/.doorway/add", { method: "POST" })).ok; } catch { return false; }
}
