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
// What a name points to: its address (`nset`, else its owner), and keys in its profile (`nprofile`),
// as agreed with Cairn: `contenthash` (ipfs://<CIDv1>) for a site, `url` for a link, and a node to
// read the network through (`csd.rpc`; see nodeOf).
import { bytesToHex, deserializeTx, hexToBytes, signerOf, txid, type Hex, type Tx } from "./csd";
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
  source?: "cairn" | "node";          // whose list of the name's records it was read from
};

type Light = { checkTx: (txid: Hex) => Promise<Verified>; syncTail: () => Promise<{ height: number }>; authorOf: (tx: Tx) => Promise<Hex | null> };
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

// The whole CairnX history, from a node, block by block (`/events/cairnx:v1/<from>/<count>`), kept per
// node so a later lookup reads only the blocks since. Each event is its raw transaction, which must
// hash to its txid.
type RawEvent = { txid: Hex; height: number; pos: number; tx: Tx };
const histories = new Map<string, { to: number; events: RawEvent[] }>();
async function nodeHistory(node: NodeSource, tip: number, activation: number): Promise<RawEvent[]> {
  const key = node.base;
  const had = histories.get(key) ?? { to: activation - 1, events: [] };
  const url = (from: number) => `${node.base.replace(/\/$/, "")}/events/${encodeURIComponent("cairnx:v1")}/${from}/2000`;
  const pages: number[] = [];
  for (let from = had.to + 1; from <= tip; from += 2000) pages.push(from);
  const got: RawEvent[][] = new Array(pages.length);
  // four requests at a time
  for (let i = 0; i < pages.length; i += 4) {
    await Promise.all(pages.slice(i, i + 4).map(async (from, k) => {
      const r = await node.fetch(url(from), { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(r.status === 404 ? "NODE_404" : `NODE_${r.status}`);
      const j = await r.json();
      got[i + k] = (j.events ?? []).map((e: any) => {
        const tx = deserializeTx(hexToBytes(e.tx_raw));
        if (txid(tx).toLowerCase() !== String(e.txid).toLowerCase()) throw new Error("BAD_PROOF: an event isn't the transaction it claims to be");
        return { txid: String(e.txid).toLowerCase() as Hex, height: Number(e.height), pos: Number(e.pos), tx };
      });
    }));
  }
  const all = { to: tip, events: [...had.events, ...got.flat()] };
  histories.set(key, all);
  return all.events;
}

// The events that decide one name: its own records, offers selling it, what claims and fills those
// offers, and the commitment a sealed registration of it revealed. A commitment names its author, so
// each revealing record's author is read from the coin it spends (light.authorOf), not its signature.
async function touching(core: any, name: string, evs: RawEvent[], light: Light): Promise<Set<string>> {
  const ids = new Set<string>(), offers = new Set<string>(), commits = new Set<string>();
  const recs = evs.map(e => (e.tx.app.kind === "propose" ? { e, rec: core.parseRecord(e.tx.app.uri, bytesToHex(e.tx.app.payloadHash)) } : { e, rec: null }));
  for (const { e, rec } of recs) {
    if (!rec) continue;
    if (rec.name === name) {
      ids.add(e.txid);
      const by = rec.salt ? await light.authorOf(e.tx) : null;
      if (by) commits.add(core.nameCommit(name, rec.salt, by).toLowerCase());
    }
    if (rec.t === "offer" && rec.give?.name === name) { ids.add(e.txid); offers.add(e.txid); }
  }
  for (const { e, rec } of recs) {
    if (rec?.t === "ncommit" && commits.has(String(rec.commit).toLowerCase())) ids.add(e.txid);
    if (rec?.t === "fclaim" && offers.has(String(rec.offer).toLowerCase())) { ids.add(e.txid); offers.add(e.txid); }
  }
  for (const e of evs) if (e.tx.app.kind === "attest" && offers.has(e.tx.app.proposalId.toLowerCase())) ids.add(e.txid);
  return ids;
}

// `authors`: the proven authors of the events that decide the name. Any other event is only a hint
// (it decides other names), so its signature stands in for its author there.
const asEvent = (e: RawEvent, paidToFromOutputs: any, authors?: Map<string, Hex | null>) =>
  eventOf({ txid: e.txid, tx: e.tx, author: authors?.has(e.txid) ? authors.get(e.txid)! : signerOf(e.tx), height: e.height, index: e.pos, blockHash: "0x" as Hex, depth: 0 }, paidToFromOutputs);

export type NodeSource = { base: string; fetch: typeof fetch };

// A name, from Cairn's server's list of its records when it answers, or else rebuilt from a node's
// full CairnX history; either way the records that decide it are proven here, and Cairn's own
// resolver decides.
export async function lookupCsdName(name: string, light: Light, opts: { cairn?: string; fetch?: typeof fetch; node?: NodeSource } = {}): Promise<CsdName> {
  if (!NAME_RE.test(name)) throw new Error("A .csd name is 1 to 32 lowercase letters, digits and dashes, not starting or ending with a dash.");
  // the rules, loaded only when a name is looked up
  const core = await import("@inversealtruism/cairnx-core");
  if (core.RESERVED_NAMES.has(name)) return { name, state: "free", profile: {}, checked: true, why: "a reserved name" };
  let viaCairn: CsdName | null = null, cairnFailed: unknown = null;
  try { viaCairn = await fromCairn(core, name, light, opts); } catch (x) { cairnFailed = x; }
  // Cairn's answer stands when it is fully proven; otherwise the node's whole history decides
  if (viaCairn?.checked || !opts.node) {
    if (viaCairn) return viaCairn;
    throw cairnFailed;
  }
  try {
    const tip = (await light.syncTail()).height;
    const evs = await nodeHistory(opts.node, tip, core.ACTIVATION_HEIGHT);
    const decide = await touching(core, name, evs, light);
    const authors = new Map<string, Hex | null>();
    for (const e of evs) if (decide.has(e.txid)) {
      const v = await light.checkTx(e.txid);
      if (v.height !== e.height || v.index !== e.pos) throw new Error("BAD_PROOF: a record isn't where the node said it is");
      authors.set(e.txid, v.author);
    }
    const st = core.resolve(evs.map(e => asEvent(e, core.paidToFromOutputs, authors)).filter((x): x is NonNullable<typeof x> => !!x), tip).names[name];
    const out: CsdName = { name, state: "free", profile: {}, checked: true, source: "node" };
    if (st) {
      out.owner = st.owner as Hex; out.profile = st.profile ?? {};
      out.state = st.pending ? "pending" : st.expired ? "lapsed" : "held";
      if (out.state === "held") out.addr = (st.addr ?? st.owner) as Hex;
    }
    if (viaCairn && (viaCairn.addr ?? null) !== (out.addr ?? null)) out.serverDisagrees = true;
    return out;
  } catch (x: any) {
    // the node can't do it either (older node software, say): Cairn's partial answer, or the first error
    if (viaCairn) return viaCairn;
    throw /NODE_404/.test(String(x?.message)) && cairnFailed ? cairnFailed : x;
  }
}

async function fromCairn(core: any, name: string, light: Light, opts: { cairn?: string; fetch?: typeof fetch }): Promise<CsdName> {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const r = await f(`${(opts.cairn ?? CAIRN).replace(/\/$/, "")}/trade/api/cairnx/name-history/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(15_000) });
  if (r.status === 404) return { name, state: "free", profile: {}, checked: false, why: "Cairn's server has no record of it", source: "cairn" };
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
  const out: CsdName = { name, state: "free", profile: {}, checked: h.scopedReplaySufficient, source: "cairn", why: h.scopedReplaySufficient ? undefined : h.caveat ?? "this name's history can't be decided from its own events alone" };
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
    checked: false, source: "cairn", why: "this node can't be checked against the proof-of-work, so this is Cairn's server's word" };
}

// Where a name sends someone who opens it
export type Target = { kind: "ipfs"; cid: string } | { kind: "url"; url: string } | { kind: "page"; addr: Hex };
export function targetOf(n: CsdName): Target | null {
  if (n.state !== "held") return null;
  // a site: `contenthash`, as ipfs://<CIDv1> (Cairn's convention; ipns:// may come later)
  const ipfs = /^ipfs:\/\/(b[a-z2-7]{50,100})$/.exec(n.profile["contenthash"] ?? "")?.[1];
  if (ipfs) return { kind: "ipfs", cid: ipfs };
  const url = n.profile["url"];
  if (url && /^https:\/\/\S+$/.test(url)) return { kind: "url", url };
  return n.addr ? { kind: "page", addr: n.addr } : null;
}
// A node to read the network through: `csd.rpc` (CairnX convention, section 36), either an https
// base URL with no credentials, query or fragment, or a gateway's multiaddr ending in its peer id.
// `csd.node`, the key used before that was settled, is still read. Never an address on the reader's
// own computer or network (loopback, link-local, private): a profile can't point a page at those.
const PRIVATE_V4 = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const privateHost = (h: string) => {
  h = h.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || PRIVATE_V4.test(h)
    || h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h);
};
export const nodeOf = (n: CsdName): string | null => {
  if (n.state !== "held") return null;
  const v = (n.profile["csd.rpc"] ?? n.profile["csd.node"] ?? "").trim();
  if (/^https:\/\/[^\s?#@]+$/.test(v)) {
    try { const u = new URL(v); return u.username || u.password || privateHost(u.hostname) ? null : v.replace(/\/+$/, ""); } catch { return null; }
  }
  const m = /^\/(ip4|ip6|dns4|dns6|dns)\/([^/\s]+)\/\S*\/p2p\/[1-9A-HJ-NP-Za-km-z]{40,60}$/.exec(v);
  return m && !privateHost(m[2]) ? v : null;
};

// Someone's .csd name: the one Cairn's rules make their primary (a name they hold that points to
// their own address; the oldest if several). Found from a node's whole CairnX history, then looked up
// and checked like any name, and shown only if that check says it's theirs. Null when they have none,
// or when it can't be checked.
const primaries = new Map<string, Promise<CsdName | null>>();
export function primaryCsdName(addr: Hex, light: Light, node: NodeSource): Promise<CsdName | null> {
  const key = `${node.base}|${addr.toLowerCase()}`;
  let p = primaries.get(key);
  if (!p) {
    p = (async () => {
      const core = await import("@inversealtruism/cairnx-core");
      const tip = (await light.syncTail()).height;
      const evs = await nodeHistory(node, tip, core.ACTIVATION_HEIGHT);
      const st = core.resolve(evs.map(e => asEvent(e, core.paidToFromOutputs)).filter((x): x is NonNullable<typeof x> => !!x), tip);
      const name = core.pickPrimaryName(Object.values(st.names) as any, addr.toLowerCase());
      if (!name) return null;
      const n = await lookupCsdName(name, light, { node });
      return n.checked && n.state === "held" && n.owner?.toLowerCase() === addr.toLowerCase() && n.addr?.toLowerCase() === addr.toLowerCase() ? n : null;
    })().catch(() => null);
    primaries.set(key, p);
    // a failure isn't kept: the next look tries again
    p.then(r => { if (!r) setTimeout(() => primaries.delete(key), 60_000); });
  }
  return p;
}
