// .csd names (CNS, the Cairn Name Service), read and checked here.
//
// The names are Cairn's: an on-chain convention on Compute Substrate, by InverseAltruism, whose rules
// and reference resolver are @inversealtruism/cairnx-core (CONVENTION.md). Registering, renewing and
// trading names happen on Cairn; this only reads them.
//
// How a name is read:
//   1. Cairn's server lists the transactions that make up the name's history (`name-history`). They
//      are hints, not trusted.
//   2. Each one is proven against the proof-of-work by the light client (src/light.ts): its bytes,
//      its signer, its outputs and its block.
//   3. The proven events are replayed through cairnx-core's own resolver, the same pure function
//      every Cairn replayer runs, which decides who holds the name and where it points.
// The server can still leave events out. Cairn's server marks a history as one a scoped replay can't
// fully decide (`scopedReplaySufficient: false`), and then this says so.
//
// What a name points to: its address (`nset`, else its owner), and, by convention between apps, keys
// in its profile (`nprofile`): `ipfs` for a site on IPFS, `csd.node` for a node, `url` for a link.
import type { Hex } from "./csd";
import type { Verified } from "./light";

export const CAIRN = "https://cairn-substrate.com";
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const normName = (n: string) => n.trim().toLowerCase().replace(/^web\+csd:(\/\/)?/, "").replace(/\.csd$/, "").replace(/\/+$/, "");

export type CsdName = {
  name: string;
  state: "held" | "free" | "lapsed" | "pending";
  owner?: Hex;
  addr?: Hex;                         // where it resolves: its nset address, else its owner
  profile: Record<string, string>;
  checked: boolean;                   // every event proven, and the replay decides the name on its own
  why?: string;                       // why not, when not
  serverDisagrees?: boolean;          // Cairn's server says otherwise than the proven replay
};

type Light = { checkTx: (txid: Hex) => Promise<Verified>; syncTail: () => Promise<{ height: number }> };
type History = {
  ok: boolean; name: string; tipHeight: number;
  resolve?: { addr?: string; owner?: string; lapsed?: boolean };
  events: { txid: string; height: number; pos: number; kind: string }[];
  scopedReplaySufficient: boolean; caveat?: string;
};

// The proven transaction, as the resolver's event
function eventOf(v: Verified, paidToFromOutputs: (o: { addr: string; value: number }[]) => Record<string, string>) {
  const app = v.tx.app, who = (v.author ?? "0x" + "0".repeat(40)).toLowerCase();
  const paidTo = paidToFromOutputs(v.tx.outputs.map(o => ({ addr: o.addr20.toLowerCase(), value: Number(o.value) })));
  if (app.kind === "propose") {
    let ph = ""; for (const b of app.payloadHash) ph += b.toString(16).padStart(2, "0");
    return { kind: "propose" as const, id: v.txid.toLowerCase(), proposer: who, uri: app.uri, payloadHash: "0x" + ph, expiresEpoch: Number(app.expiresEpoch), height: v.height, pos: v.index, paidTo };
  }
  if (app.kind === "attest") {
    return { kind: "attest" as const, txid: v.txid.toLowerCase(), proposalId: app.proposalId.toLowerCase(), attester: who, score: app.score, confidence: app.confidence, height: v.height, pos: v.index, paidTo };
  }
  return null;
}

export async function lookupCsdName(name: string, light: Light, opts: { cairn?: string; fetch?: typeof fetch } = {}): Promise<CsdName> {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  if (!NAME_RE.test(name)) throw new Error("A .csd name is 1 to 32 lowercase letters, digits and dashes, not starting or ending with a dash.");
  // the rules, loaded only when a name is looked up
  const core = await import("@inversealtruism/cairnx-core");
  if (core.RESERVED_NAMES.has(name)) return { name, state: "free", profile: {}, checked: true, why: "a reserved name" };
  const r = await f(`${(opts.cairn ?? CAIRN).replace(/\/$/, "")}/trade/api/cairnx/name-history/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return { name, state: "free", profile: {}, checked: false, why: "Cairn's server has no record of it" };
  if (!r.ok) throw new Error(`CAIRN_${r.status}`);
  const h = (await r.json()) as History;
  if (h?.name !== name || !Array.isArray(h.events)) throw new Error("CAIRN_BAD_ANSWER");

  // every event proven against the proof-of-work, at the height and position the server named
  const events: any[] = [];
  for (const e of h.events) {
    let v: Verified;
    try { v = await light.checkTx(e.txid as Hex); }
    catch (x: any) {
      // a node this page can't check against the proof-of-work at all: Cairn's server's word, said so
      if (/NODE_404|STALE_ANCHORS/.test(String(x?.message))) return serversWord(name, h);
      throw x;
    }
    if (v.height !== e.height || v.index !== e.pos) throw new Error(`BAD_PROOF: ${e.txid} isn't where Cairn's server says it is`);
    const ev = eventOf(v, core.paidToFromOutputs);
    if (ev) events.push(ev);
  }
  const tip = (await light.syncTail()).height;
  const st = core.resolve(events, tip).names[name];
  const out: CsdName = { name, state: "free", profile: {}, checked: h.scopedReplaySufficient, why: h.scopedReplaySufficient ? undefined : h.caveat ?? "this name's history can't be decided from its own events alone" };
  if (st) {
    out.owner = st.owner as Hex;
    out.profile = st.profile ?? {};
    out.state = st.pending ? "pending" : st.expired ? "lapsed" : "held";
    if (out.state === "held") out.addr = (st.addr ?? st.owner) as Hex;
  }
  const said = h.resolve?.addr?.toLowerCase();
  if ((said ?? null) !== (out.addr?.toLowerCase() ?? null)) out.serverDisagrees = true;
  return out;
}

function serversWord(name: string, h: History): CsdName {
  const addr = h.resolve?.addr?.toLowerCase() as Hex | undefined;
  return { name, state: addr ? "held" : h.resolve?.lapsed ? "lapsed" : "free", owner: h.resolve?.owner?.toLowerCase() as Hex | undefined, addr, profile: {},
    checked: false, why: "this node can't be checked against the proof-of-work, so this is Cairn's server's word" };
}

// Where a name sends someone who opens it
export type Target = { kind: "ipfs"; cid: string } | { kind: "url"; url: string } | { kind: "page"; addr: Hex };
export function targetOf(n: CsdName): Target | null {
  if (n.state !== "held") return null;
  const ipfs = n.profile["ipfs"]?.replace(/^ipfs:\/\//, "");
  if (ipfs && /^[a-z0-9]{20,100}$/i.test(ipfs)) return { kind: "ipfs", cid: ipfs };
  const url = n.profile["url"];
  if (url && /^https:\/\/\S+$/.test(url)) return { kind: "url", url };
  return n.addr ? { kind: "page", addr: n.addr } : null;
}
export const nodeOf = (n: CsdName): string | null => {
  const v = n.state === "held" ? n.profile["csd.node"] : undefined;
  return v && (/^https?:\/\/\S+$/.test(v) || /^\/(ip4|ip6|dns4|dns6|dns)\/\S+$/.test(v)) ? v : null;
};
