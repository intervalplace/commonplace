// How long a site is kept up on the doors, from its keep records (the kit's keep.ts, the same rules
// the doors follow): a record under `csd.keep` whose text is the site's address keeps it a year from
// where its time stands (or from its own block, once that has run out), plus a year for every
// 0.25 CSD it burns to the all-zero address.
import { EPOCH_LEN, MIN_FEE_PROPOSE, deserializeTx, hexToBytes, sha256d, utf8, type AppPayload, type node } from "./csd";

export const KEEP_TOPIC = "csd.keep";
const BURN = "0x" + "00".repeat(20);
const YEAR_BLOCKS = 365 * 24 * 30;
const PER_YEAR = MIN_FEE_PROPOSE;
const MAX_YEARS = 1000;
const KEEP_FROM = 147_000;
const CID_RE = /^b[a-z2-7]{50,100}$/;

type Api = Pick<ReturnType<typeof node>, "tip" | "events">;
const caches = new Map<Api, { next: number; until: Map<string, number> }>();

// Every kept site: its address -> the block it's kept until, and the tip
export async function keptSites(api: Api): Promise<{ tip: number; until: Map<string, number> }> {
  let c = caches.get(api);
  if (!c) caches.set(api, c = { next: KEEP_FROM, until: new Map() });
  let tip = (await api.tip()).height;
  while (c.next <= tip) {
    const r = await api.events(KEEP_TOPIC, c.next, 2000);
    if (!r) break; // an older node: no keep records
    for (const e of r.events) {
      let tx; try { tx = deserializeTx(hexToBytes(e.tx_raw)); } catch { continue; }
      if (tx.app.kind !== "propose") continue;
      const uri = tx.app.uri.trim(), cid = uri.replace(/^ipfs:\/\//, "");
      if (!uri.startsWith("ipfs://") || !CID_RE.test(cid)) continue;
      const burned = tx.outputs.filter(o => o.addr20.toLowerCase() === BURN).reduce((s, o) => s + o.value, 0n);
      const years = Math.min(MAX_YEARS, 1 + Number(burned / PER_YEAR));
      c.until.set(cid, Math.max(c.until.get(cid) ?? 0, e.height) + years * YEAR_BLOCKS);
    }
    if (r.to < c.next) break;
    c.next = r.to + 1;
    tip = Math.max(tip, r.tip);
  }
  return { tip, until: c.until };
}

// The year a site's kept time runs out, or null if it isn't kept (past its name)
export async function keptUntilYear(api: Api, cid: string): Promise<number | null> {
  const { tip, until } = await keptSites(api);
  const u = until.get(cid);
  return u && u > tip ? new Date(Date.now() + (u - tip) * 120_000).getFullYear() : null;
}

// A record keeping `cid` up one more year (its fee is the year; nothing burned)
export function keepArgs(cid: string, tip: number): AppPayload {
  const uri = `ipfs://${cid}`;
  return { kind: "propose", domain: KEEP_TOPIC, payloadHash: sha256d(utf8(uri)), uri, expiresEpoch: BigInt(Math.floor(tip / EPOCH_LEN)) + 10_000_000n };
}
