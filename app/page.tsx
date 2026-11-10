"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { COIN, MIN_FEE_ATTEST, MIN_FEE_PROPOSE, EPOCH_LEN, buildAppTx, bytesToHex, hexToBytes, keyFromPrivate, node, txid as txidOf, type CsdKey, type Hex } from "@/csd";
import { DEFAULT_TOPIC, NAME_MAX, PROFILE_TOPIC, cleanName, docArgs, docRoom, guestbookOwner, guestbookTopic, isReserved, linkHref, normTopic, parseEntry, profileArgs, proposeArgs, room, topicOk, type Entry } from "@/entries";
import { Avatar, PICTURES } from "@/avatars";
import { FREE_BYTES, GATEWAY, contentTypeOf, fetchDoc, upload } from "@/arweave";
import { Markdown } from "@/markdown";
import hiddenList from "../moderation/hidden.json";
import { sha256d } from "@/csd";
import { K_PAYER, TopUpBox, type EthWallet } from "@/topup";
import { deriveKey, discoverWallets, type WalletInfo } from "@/wallet";

// ── settings and small stores ───────────────────────────────────────────────
const DEFAULT_NODE = process.env.NEXT_PUBLIC_CSD_API ?? "https://csd.aon.network";
function nodeUrl(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("node");
    if (q) localStorage.setItem("commonplace.node", q);
    return localStorage.getItem("commonplace.node") || DEFAULT_NODE;
  } catch { return DEFAULT_NODE; }
}
function load<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
const K_SESSION = "commonplace.key1", K_DRAFT = "commonplace.draft1", K_PENDING = "commonplace.pending1", K_AUTHORS = "commonplace.authors1", K_MINE = "commonplace.resonated1";

type Pending = Entry & { sentAt: number };

// What this window doesn't display (moderation/README.md): clearly illegal entries, each listed
// publicly with its reason. The entry stays on chain and other clients can show it.
const HIDDEN = new Map<string, string>(((hiddenList as any).entries ?? []).map((h: any) => [String(h.id).toLowerCase(), String(h.reason ?? "")]));
const HIDDEN_POLICY = "https://github.com/intervalplace/commonplace/blob/main/moderation/README.md";

// ── formatting ──────────────────────────────────────────────────────────────
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const csd = (v: bigint) => { const n = Number(v) / Number(COIN); return n >= 100 ? Math.floor(n).toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }); };
function when(t: number): string {
  const d = new Date(t * 1000), now = new Date();
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400_000);
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  if (days < 7) return `${d.toLocaleDateString("en-GB", { weekday: "long" })} ${hm}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
// Epochs: the chain groups blocks in 30s (about an hour at its 2-minute target). Each topic is
// ranked anew every epoch, and an entry can be resonated with until its expiry epoch.
const BLOCK_SECS = 120;
const epochOf = (height: number) => Math.floor(height / EPOCH_LEN);
function epochEnds(height: number): string {
  const blocksLeft = (epochOf(height) + 1) * EPOCH_LEN - height;
  const mins = Math.max(1, Math.round((blocksLeft * BLOCK_SECS) / 60));
  return mins < 90 ? `about ${mins} minute${mins === 1 ? "" : "s"}` : `about ${Math.round(mins / 60)} hours`;
}
const todayLine = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

// ── routing by hash, so the static site works from any folder or gateway ───
type Route = { view: "me" } | { view: "topics" } | { view: "topic"; topic: string } | { view: "entry"; id: Hex } | { view: "everyone" } | { view: "person"; addr: Hex };
function parseRoute(h: string): Route {
  const p = h.replace(/^#\/?/, "").split("/");
  if (p[0] === "topics") return { view: "topics" };
  if (p[0] === "t" && p[1]) return { view: "topic", topic: decodeURIComponent(p.slice(1).join("/")) };
  if (p[0] === "e" && /^0x[0-9a-f]{64}$/i.test(p[1] ?? "")) return { view: "entry", id: p[1].toLowerCase() as Hex };
  if (p[0] === "everyone") return { view: "everyone" };
  if (p[0] === "p" && /^0x[0-9a-f]{40}$/i.test(p[1] ?? "")) return { view: "person", addr: p[1].toLowerCase() as Hex };
  return { view: "me" };
}
const hrefTopic = (t: string) => `#/t/${encodeURIComponent(t)}`;
const hrefEntry = (id: string) => `#/e/${id}`;
const hrefPerson = (addr: string) => `#/p/${addr.toLowerCase()}`;

// ── the page ────────────────────────────────────────────────────────────────
export default function Page() {
  const [route, setRoute] = useState<Route>({ view: "me" });
  const [base, setBase] = useState(DEFAULT_NODE);
  useEffect(() => {
    setBase(nodeUrl());
    const on = () => { setRoute(parseRoute(window.location.hash)); window.scrollTo(0, 0); };
    on(); window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const api = useMemo(() => node(base), [base]);

  // the shared memory: every proposal on chain, refreshed every 30 s
  const [height, setHeight] = useState(0);
  const [chain, setChain] = useState<Entry[]>([]);
  const [resonance, setResonance] = useState<Record<string, { count: number; weight: number }>>({});
  const [loaded, setLoaded] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [authors, setAuthors] = useState<Record<string, Hex>>({});
  useEffect(() => { setPending(load(K_PENDING, [])); setAuthors(load(K_AUTHORS, {})); }, []);

  const refresh = useCallback(async () => {
    try {
      const [t, ps] = await Promise.all([api.tip(), api.proposals(500)]);
      setHeight(t.height);
      const es = ps.map(parseEntry).sort((a, b) => b.height - a.height || (a.id < b.id ? -1 : 1));
      setChain(es);
      api.resonance().then(setResonance).catch(() => {});
      setNetError(null);
      // anything of ours that has landed in a block is no longer pending; give up on a send after a day
      setPending(prev => {
        const ids = new Set(es.map(e => e.id));
        const next = prev.filter(p => !ids.has(p.id) && Date.now() - p.sentAt < 86400_000);
        if (next.length !== prev.length) save(K_PENDING, next);
        return next;
      });
    } catch (e: any) {
      setNetError(`Can't reach the CSD node at ${base}.`);
    } finally { setLoaded(true); }
  }, [api, base]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 30_000); return () => clearInterval(t); }, [refresh]);

  // who wrote what: one lookup per entry, kept for good (it can't change)
  const asking = useRef(new Set<string>());
  const needAuthors = useCallback(async (ids: Hex[]) => {
    const want = ids.filter(id => !authors[id] && !asking.current.has(id));
    if (!want.length) return;
    want.forEach(id => asking.current.add(id));
    const got: Record<string, Hex> = {};
    for (let i = 0; i < want.length; i += 8) {
      await Promise.all(want.slice(i, i + 8).map(async id => {
        try { const p = await api.proposal(id); if (p?.proposer) got[id] = p.proposer.toLowerCase() as Hex; } catch {}
      }));
    }
    setAuthors(prev => { const next = { ...prev, ...got }; save(K_AUTHORS, next); return next; });
  }, [api, authors]);

  const learnAuthors = useCallback((m: Record<string, Hex>) => {
    setAuthors(prev => { if (Object.entries(m).every(([k, v]) => prev[k] === v)) return prev; const next = { ...prev, ...m }; save(K_AUTHORS, next); return next; });
  }, []);

  // the writing key
  // kept for this tab only (sessionStorage), so a reload doesn't ask the wallet again; closing
  // the tab forgets it
  const [key, setKeyState] = useState<CsdKey | null>(null);
  const setKey = useCallback((k: CsdKey | null) => {
    setKeyState(k);
    try { k ? sessionStorage.setItem(K_SESSION, bytesToHex(k.priv)) : sessionStorage.removeItem(K_SESSION); } catch {}
  }, []);
  useEffect(() => { try { const h = sessionStorage.getItem(K_SESSION); if (h) setKeyState(keyFromPrivate(hexToBytes(h))); } catch {} }, []);
  const [balance, setBalance] = useState<bigint | null>(null);
  // change from our own sends that isn't in a block yet: spendable after the next block, and
  // still ours, so it counts in the balance shown
  const inflight = useRef<{ txid: string; change: bigint; at: number }[]>([]);
  const refreshBalance = useCallback(async () => {
    if (!key) return setBalance(null);
    try {
      const [avail, all] = await Promise.all([api.utxos(key.addr20), api.utxos(key.addr20, true)]);
      const landed = new Set(all.map(u => u.txid));
      inflight.current = inflight.current.filter(f => !landed.has(f.txid as Hex) && Date.now() - f.at < 3600_000);
      setBalance(avail.reduce((s, u) => s + u.value, 0n) + inflight.current.reduce((s, f) => s + f.change, 0n));
    } catch {}
  }, [api, key]);
  const send = async (app: Parameters<typeof buildAppTx>[2], fee: bigint) => {
    if (!key) throw new Error("Connect a wallet first.");
    const utxos = await api.utxos(key.addr20);
    if (utxos.reduce((s, u) => s + u.value, 0n) < fee && inflight.current.length) throw new Error("WAIT_FOR_BLOCK");
    const tx = buildAppTx(utxos, key, app, fee);
    const id = (await api.submit(tx)).toLowerCase() as Hex;
    if (id !== txidOf(tx).toLowerCase()) console.warn("node txid differs", id, txidOf(tx));
    const change = tx.outputs.filter(o => o.addr20 === key.addr20).reduce((s, o) => s + o.value, 0n);
    inflight.current.push({ txid: id, change, at: Date.now() });
    refreshBalance();
    return id;
  };
  useEffect(() => { refreshBalance(); const t = setInterval(refreshBalance, 30_000); return () => clearInterval(t); }, [refreshBalance]);

  const all: Entry[] = useMemo(() => {
    const withAuthor = chain.map(e => HIDDEN.has(e.id)
      ? { ...e, author: authors[e.id], hidden: HIDDEN.get(e.id) || "listed in this site's hidden entries", text: "", docId: undefined }
      : { ...e, author: authors[e.id] });
    const mine = pending.map(p => ({ ...p, author: key?.addr20 ?? p.author }));
    return [...mine, ...withAuthor];
  }, [chain, pending, authors, key]);
  const entries = useMemo(() => all.filter(e => e.kind !== "profile" && !isReserved(e.topic)), [all]);
  // each key's newest profile entry (pending ones first, so a change shows at once)
  const profiles = useMemo(() => {
    const out: Record<string, Profile> = {};
    for (const e of all) if (e.kind === "profile" && e.author && !out[e.author]) out[e.author] = { pic: e.pic ?? 0, name: e.name ?? "" };
    return out;
  }, [all]);
  useEffect(() => { needAuthors(chain.filter(e => e.kind === "profile").map(e => e.id)); }, [chain, needAuthors]);
  const byId = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);

  // my own page needs to know which entries are mine
  useEffect(() => { if (key && chain.length) needAuthors(chain.map(e => e.id)); }, [key, chain, needAuthors]);

  useEffect(() => { document.body.classList.toggle("night", route.view === "everyone"); }, [route]);

  // keeping an entry, or resonating with one
  const [keeping, setKeeping] = useState<null | { text: string; topic: string; replyTo?: Hex; doc?: Doc; done: () => void }>(null);
  const [resonated, setResonated] = useState<Record<string, true>>({});
  useEffect(() => setResonated(load(K_MINE, {})), []);

  const keep = async (text: string, topic: string, replyTo?: Hex, doc?: Doc, step?: (s: string) => void) => {
    if (!key) throw new Error("Connect a wallet first.");
    // a document: the file goes to Arweave first, then the entry that points at it
    let docId: string | undefined;
    if (doc) { step?.("Storing the file on Arweave…"); docId = await upload(key, doc.bytes, doc.type, text); step?.("Keeping the entry…"); }
    const t = await api.tip();
    const args = doc && docId ? docArgs(docId, text, topic, sha256d(doc.bytes), t.height) : proposeArgs(text, topic, t.height, replyTo);
    const id = await send(args, MIN_FEE_PROPOSE);
    const p: Pending = { id, topic: normTopic(topic), text, kind: doc ? "doc" : replyTo ? "reply" : "note", docId, replyTo, height: t.height + 1, time: Math.floor(Date.now() / 1000), pending: true, author: key.addr20, sentAt: Date.now() };
    setPending(prev => { const next = [p, ...prev]; save(K_PENDING, next); return next; });
    return id;
  };
  const keepProfile = async (pic: number, name: string) => {
    if (!key) throw new Error("Connect a wallet first.");
    const t = await api.tip();
    const id = await send(profileArgs(pic, name, t.height), MIN_FEE_PROPOSE);
    const p: Pending = { id, topic: PROFILE_TOPIC, text: cleanName(name), kind: "profile", pic, name: cleanName(name), height: t.height + 1, time: Math.floor(Date.now() / 1000), pending: true, author: key.addr20, sentAt: Date.now() };
    setPending(prev => { const next = [p, ...prev]; save(K_PENDING, next); return next; });
  };
  const [editingProfile, setEditingProfile] = useState(false);
  const [eth, setEth] = useState<EthWallet | null>(null);
  const resonate = async (id: Hex) => {
    await send({ kind: "attest", proposalId: id, score: 1, confidence: 1 }, MIN_FEE_ATTEST);
    setResonated(prev => { const next = { ...prev, [id]: true as const }; save(K_MINE, next); return next; });
  };

  const ctx: Ctx = { route, entries, byId, height, loaded, netError, resonance, me: key, balance, authors, needAuthors, resonated, resonate, all, api, learnAuthors, startKeep: (text, topic, replyTo, done, doc) => setKeeping({ text, topic, replyTo, done, doc }), editProfile: () => setEditingProfile(true) };

  return (
    <Pay.Provider value={{ eth, setEth, api, refresh: () => { refreshBalance(); setTimeout(refreshBalance, 90_000); } }}>
    <KeyCtx.Provider value={key}>
    <Profiles.Provider value={profiles}>
      <Header route={route} keyState={[key, setKey]} balance={balance} />
      {route.view === "me" && <Me {...ctx} />}
      {route.view === "topics" && <Topics {...ctx} />}
      {route.view === "topic" && <Topic {...ctx} topic={route.topic} />}
      {route.view === "entry" && <EntryView {...ctx} id={route.id} />}
      {route.view === "everyone" && <Everyone {...ctx} />}
      {route.view === "person" && <Person {...ctx} addr={route.addr} />}
      <footer className="cp-foot">
        <span>Kept on Compute Substrate. No account, no server, no owner.</span>
        <span>Node: {base.replace(/^https?:\/\//, "")}</span>
        {height > 0 && <span>Block {height.toLocaleString("en-US")}</span>}
        {height > 0 && <span title="The chain ranks every topic anew each epoch of 30 blocks">Epoch {epochOf(height).toLocaleString("en-US")}, ends in {epochEnds(height)}</span>}
      </footer>
      {keeping && (
        <KeepDialog
          {...keeping} keyState={[key, setKey]} balance={balance}
          onKeep={async step => { await keep(keeping.text, keeping.topic, keeping.replyTo, keeping.doc, step); keeping.done(); setKeeping(null); }}
          onClose={() => setKeeping(null)}
        />
      )}
      {editingProfile && key && (
        <ProfileDialog addr={key.addr20} current={profiles[key.addr20]} balance={balance}
          onKeep={async (pic, name) => { await keepProfile(pic, name); setEditingProfile(false); }}
          onClose={() => setEditingProfile(false)} />
      )}
    </Profiles.Provider>
    </KeyCtx.Provider>
    </Pay.Provider>
  );
}

// The Ethereum wallet that made the key (and can pay for top-ups), shared with the dialogs
const Pay = createContext<{ eth: EthWallet | null; setEth: (e: EthWallet | null) => void; api: ReturnType<typeof node> | null; refresh: () => void }>({ eth: null, setEth: () => {}, api: null, refresh: () => {} });
function TopUpHere({ me, compact }: { me: CsdKey; compact?: boolean }) {
  const p = useContext(Pay);
  if (!p.api) return null;
  return <TopUpBox me={me} eth={p.eth} setEth={p.setEth} csdNode={p.api} onLocked={p.refresh} compact={compact} />;
}

// ── who wrote it: picture, chosen name, and always the address ──────────────
type Profile = { pic: number; name: string };
const Profiles = createContext<Record<string, Profile>>({});
function Who({ addr, you, size = 20 }: { addr: string; you?: boolean; size?: number }) {
  const p = useContext(Profiles)[addr];
  return (
    <a href={hrefPerson(addr)} className="cp-whois" style={{ display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
      <Avatar addr={addr} pic={p?.pic} size={size} />
      {p?.name ? <span style={{ color: "var(--ink)", fontWeight: 500 }}>{you ? "you" : p.name}</span> : you ? <span style={{ color: "var(--ink)" }}>you</span> : null}
      <span className="cp-who">{short(addr)}</span>
    </a>
  );
}

type Ctx = {
  route: Route; entries: Entry[]; byId: Map<string, Entry>; height: number; loaded: boolean; netError: string | null;
  resonance: Record<string, { count: number; weight: number }>; me: CsdKey | null; balance: bigint | null;
  authors: Record<string, Hex>; needAuthors: (ids: Hex[]) => void; resonated: Record<string, true>; resonate: (id: Hex) => Promise<void>;
  startKeep: (text: string, topic: string, replyTo: Hex | undefined, done: () => void, doc?: Doc) => void;
  editProfile: () => void;
  all: Entry[]; api: ReturnType<typeof node>; learnAuthors: (m: Record<string, Hex>) => void;
};

// ── header: the zoom, and the wallet ────────────────────────────────────────
function Header({ route, keyState, balance }: { route: Route; keyState: [CsdKey | null, (k: CsdKey | null) => void]; balance: bigint | null }) {
  const level = route.view === "me" ? "me" : route.view === "everyone" ? "everyone" : route.view === "topic" || route.view === "topics" ? "topics" : "";
  return (
    <header className="cp-header">
      <a className="cp-mark" href="#/">Commonplace</a>
      <nav className="cp-zoom" aria-label="Zoom">
        <a href="#/" aria-current={level === "me" ? "page" : undefined}>Me</a>
        <span className="rule" aria-hidden="true" />
        <a href="#/topics" aria-current={level === "topics" ? "page" : undefined}>Topics</a>
        <span className="rule" aria-hidden="true" />
        <a href="#/everyone" aria-current={level === "everyone" ? "page" : undefined}>Everyone</a>
      </nav>
      <WalletButton keyState={keyState} balance={balance} />
    </header>
  );
}

function WalletButton({ keyState: [key, setKey], balance }: { keyState: [CsdKey | null, (k: CsdKey | null) => void]; balance: bigint | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // closes on Escape or a click anywhere else
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down); window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="cp-wallet" ref={box}>
      <button aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {key ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><WalletPic addr={key.addr20} />{short(key.addr20)}{balance !== null && <span className="bal">{csd(balance)} CSD</span>}</span> : "Connect wallet"}
      </button>
      {open && (
        <div className="cp-menu">
          {key ? <KeyInfo k={key} balance={balance} onForget={() => { setKey(null); setOpen(false); }} /> : <Connect onKey={k => { setKey(k); }} />}
        </div>
      )}
    </div>
  );
}

function KeyInfo({ k, balance, onForget }: { k: CsdKey; balance: bigint | null; onForget: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <span>Your writing key holds <strong>{balance === null ? "…" : csd(balance)} CSD</strong>. Each entry costs 0.25 CSD and each resonance 0.05 CSD.</span>
      <span>To add CSD from another wallet, send it to:</span>
      <span className="addr">{k.addr20}</span>
      <button className="choice" onClick={() => { navigator.clipboard?.writeText(k.addr20); setCopied(true); }}>{copied ? "Copied" : "Copy address"}</button>
      <hr style={{ border: "none", borderTop: "1px solid var(--rule)", margin: "4px 0", width: "100%" }} />
      <TopUpHere me={k} compact />
      <hr style={{ border: "none", borderTop: "1px solid var(--rule)", margin: "4px 0", width: "100%" }} />
      <button className="choice" onClick={onForget}>Disconnect</button>
    </>
  );
}

function Connect({ onKey }: { onKey: (k: CsdKey) => void }) {
  const pay = useContext(Pay);
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => discoverWallets(setWallets), []);
  const go = async (w: WalletInfo) => {
    setBusy(w.id); setErr(null);
    try { const r = await deriveKey(w); pay.setEth({ wallet: w, account: r.account }); try { sessionStorage.setItem(K_PAYER, w.id); } catch {} onKey(r.key); } catch (e: any) { setErr(e?.message?.includes("rejected") ? "The wallet didn't sign." : String(e?.message ?? e)); } finally { setBusy(null); }
  };
  return (
    <>
      <span>Your wallet signs one message (twice, to check it's stable). That signature becomes your writing key. Nothing is sent anywhere.</span>
      {wallets === null ? <span>Looking for wallets…</span> : wallets.length === 0 ? <span>No browser wallet found. Install one, such as MetaMask or Rabby, then reload.</span> :
        wallets.map(w => (
          <button key={w.id} className="choice" disabled={!!busy} onClick={() => go(w)}>
            {w.icon && <img src={w.icon} alt="" />}{busy === w.id ? "Check your wallet…" : w.name}
          </button>
        ))}
      {err && <span className="err">{err}</span>}
    </>
  );
}

// ── one entry in a list ─────────────────────────────────────────────────────
function EntryItem({ e, resonance, showAuthor, showTopic = true }: { e: Entry; resonance?: { count: number }; showAuthor?: boolean; showTopic?: boolean }) {
  const href = e.kind === "link" ? linkHref(e.text) : null;
  return (
    <article className="cp-entry">
      {e.kind === "doc" && <span className="cp-doclabel">Document</span>}
      {e.hidden !== undefined ? <a className="cp-hint" href={hrefEntry(e.id)}>Not shown on this site: {e.hidden}.</a>
        : e.pending ? <p>{e.text}</p> : <a className="text" href={hrefEntry(e.id)}>{e.text}</a>}
      <div className="cp-meta">
        {showAuthor && e.author && <Who addr={e.author} />}
        {showTopic && <TopicLink topic={e.topic} />}
        {e.kind === "reply" && e.replyTo && showTopic && <a href={hrefEntry(e.replyTo)}>in reply</a>}
        {e.pending ? <span className="cp-pending">Being kept now, waiting for the next block</span> : <span>{when(e.time)}</span>}
        {!e.pending && <span className="cp-mono">block {e.height.toLocaleString("en-US")}</span>}
        {resonance && resonance.count > 0 && <span>{resonance.count} resonated</span>}
        {href && <a href={href} target="_blank" rel="noreferrer noopener">Open link</a>}
      </div>
    </article>
  );
}

// ── Me ──────────────────────────────────────────────────────────────────────
function Me(c: Ctx) {
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<"write" | "doc">("write");
  useEffect(() => { const d = load(K_DRAFT, { text: "", topic: "" }); setText(d.text); setTopic(d.topic); }, []);
  useEffect(() => { save(K_DRAFT, { text, topic }); }, [text, topic]);
  const left = room(text.trim());
  const mine = c.me ? c.entries.filter(e => e.author === c.me!.addr20) : [];
  const canKeep = text.trim().length > 0 && left >= 0 && topicOk(topic);
  const prof = useContext(Profiles)[c.me?.addr20 ?? ""];
  return (
    <main className="cp-main">
      {c.me && (
        <div className="cp-row" style={{ justifyContent: "flex-start", gap: 16 }}>
          <Avatar addr={c.me.addr20} pic={prof?.pic} size={56} label="Your picture" />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span style={{ fontFamily: "var(--serif)", fontSize: 22 }}>{prof?.name || "No name yet"}</span>
            <span className="cp-who" style={{ color: "var(--muted)" }}>{c.me.addr20}</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <a className="cp-btn-ghost" style={{ textDecoration: "none" }} href={hrefPerson(c.me.addr20)}>Your page as others see it</a>
            <button className="cp-btn-ghost" onClick={c.editProfile}>{prof ? "Change" : "Choose a picture and name"}</button>
          </div>
        </div>
      )}
      <section className="cp-write" aria-label="Write">
        <div className="cp-row">
          <label htmlFor="draft" className="cp-date">{todayLine()}</label>
          <div className="cp-modes" role="group" aria-label="What to keep">
            <button type="button" aria-pressed={mode === "write"} onClick={() => setMode("write")}>Write</button>
            <button type="button" aria-pressed={mode === "doc"} onClick={() => setMode("doc")}>Publish a document</button>
          </div>
        </div>
        {mode === "write"
          ? <textarea id="draft" value={text} onChange={e => setText(e.target.value)} placeholder="Write something you mean." />
          : <DocWriter c={c} topic={topic} />}
        <div className="cp-row">
          <label className="cp-topic">Topic
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder={DEFAULT_TOPIC} maxLength={64} />
          </label>
          {mode === "write" && (
            <div className="cp-row" style={{ justifyContent: "flex-end" }}>
              {text && <Left left={left} />}
              <button className="cp-btn" disabled={!canKeep} onClick={() => c.startKeep(text.trim(), topic, undefined, () => setText(""))}>Keep it</button>
            </div>
          )}
        </div>
      </section>

      {c.netError && <p className="cp-notice">{c.netError}</p>}

      <section className="cp-list" aria-label="Your page">
        {!c.me ? (
          <p className="cp-empty">Your page is everything you have kept. Connect a wallet to see it, or just start writing: the draft stays in this browser until you choose to keep it.</p>
        ) : mine.length === 0 ? (
          <p className="cp-empty">Nothing kept yet. The first thing you keep starts your page, and it stays there for as long as the network runs.</p>
        ) : mine.map(e => <EntryItem key={e.id} e={e} resonance={c.resonance[e.id]} />)}
      </section>

      <a className="cp-out" href="#/everyone">Zoom out and see your page among everyone's</a>
    </main>
  );
}

// ── Topics ──────────────────────────────────────────────────────────────────
function topicStats(entries: Entry[]) {
  const m = new Map<string, { topic: string; count: number; last: number }>();
  for (const e of entries) {
    const s = m.get(e.topic) ?? { topic: e.topic, count: 0, last: 0 };
    s.count++; s.last = Math.max(s.last, e.time); m.set(e.topic, s);
  }
  return [...m.values()].sort((a, b) => b.last - a.last);
}

function Topics(c: Ctx) {
  const ts = topicStats(c.entries);
  return (
    <main className="cp-main">
      <div>
        <h1 className="cp-topic-title" style={{ fontSize: 44 }}>Topics</h1>
        <p className="cp-hint" style={{ fontSize: 15, marginTop: 10 }}>Anyone can start one by writing under it. Most recently written in first.</p>
      </div>
      {!c.loaded ? <p className="cp-empty">Reading the chain…</p> : ts.length === 0 ? <p className="cp-empty">No topics yet. Whatever you write first names the first one.</p> : (
        <nav aria-label="Topics" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ts.map(t => <a key={t.topic} className="cp-topiclink" href={hrefTopic(t.topic)}>{t.topic}<span>{t.count} {t.count === 1 ? "entry" : "entries"}, {when(t.last)}</span></a>)}
        </nav>
      )}
      {c.netError && <p className="cp-notice">{c.netError}</p>}
    </main>
  );
}

function Topic(c: Ctx & { topic: string }) {
  const list = c.entries.filter(e => e.topic === c.topic && e.kind !== "reply");
  const all = c.entries.filter(e => e.topic === c.topic);
  const [top, setTop] = useState<Hex[]>([]);
  const [topEpoch, setTopEpoch] = useState<number | null>(null);
  useEffect(() => { c.needAuthors(list.slice(0, 40).filter(e => !e.pending).map(e => e.id)); }, [c.topic, list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // what consensus ranks highest in this topic for the current epoch (and the one before, early on)
  useEffect(() => {
    if (!c.height) return;
    const ep = Math.floor(c.height / EPOCH_LEN);
    const api = node(nodeUrl());
    // this epoch's ranking; early in an epoch, when nobody has resonated yet, the last one's
    Promise.allSettled([ep, ep - 1].filter(e => e >= 0).map(e => api.topk(e, c.topic))).then(rs => {
      const ids = (i: number) => { const r = rs[i]; return r && r.status === "fulfilled" ? r.value.filter(x => Number(x.score) > 0).map(x => String(x.proposal_id).toLowerCase() as Hex) : []; };
      const cur = ids(0), prev = ids(1);
      if (cur.length) { setTop(cur); setTopEpoch(ep); } else if (prev.length) { setTop(prev); setTopEpoch(ep - 1); } else { setTop([]); setTopEpoch(null); }
    });
  }, [c.height, c.topic]);
  const now = list.map(e => e.id).filter(id => top.includes(id));
  const nowEntries = top.map(id => c.byId.get(id)).filter((e): e is Entry => !!e && e.kind !== "reply");
  const others = topicStats(c.entries).filter(t => t.topic !== c.topic).slice(0, 12);
  const t0 = all.length ? Math.min(...all.map(e => e.time)) : 0, t1 = Date.now() / 1000;
  return (
    <div className="cp-wide">
      <div className="cp-cols">
        <main>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <h1 className="cp-topic-title">{c.topic}</h1>
            <p className="cp-hint" style={{ fontSize: 15, margin: 0 }}>Everything written under this topic, by everyone, kept since the first entry.</p>
          </div>
          {all.length > 0 && (
            <figure style={{ margin: 0 }}>
              <div className="cp-strip" role="img" aria-label={`When the ${all.length} entries in this topic were written`}>
                {all.map((e, i) => {
                  const x = t1 > t0 ? ((e.time - t0) / (t1 - t0)) * 96 + 2 : 50;
                  const r = c.resonance[e.id]?.count ?? 0, s = r ? 10 : 6;
                  return <span key={e.id} style={{ left: `${x}%`, bottom: 8 + ((i * 13) % 34), width: s, height: s, background: r ? "var(--accent)" : "#8A93B2" }} />;
                })}
              </div>
              <figcaption className="cp-strip-cap"><span>{t0 ? when(t0) : ""}</span><span>now</span></figcaption>
            </figure>
          )}
          {list.length > 0 && c.height > 0 && (
            <section className="cp-list" aria-labelledby="now">
              <h2 id="now" className="cp-h2">{topEpoch === epochOf(c.height) - 1 ? "Resonated most last epoch" : "Resonating this epoch"}</h2>
              <p className="cp-hint" style={{ margin: "0 0 4px" }}>
                {(() => { const ep = topEpoch ?? epochOf(c.height); return `Epoch ${ep.toLocaleString("en-US")}, blocks ${(ep * EPOCH_LEN).toLocaleString("en-US")} to ${(ep * EPOCH_LEN + EPOCH_LEN - 1).toLocaleString("en-US")}${ep === epochOf(c.height) ? `, ends in ${epochEnds(c.height)}` : ""}. `; })()}
                The chain ranks each topic anew every epoch (30 blocks, about an hour), by what was paid to resonate.
                {nowEntries.length === 0 ? " Nothing here has been resonated with this epoch or the last." : ""}
              </p>
              {nowEntries.map(e => <EntryItem key={e.id} e={e} resonance={c.resonance[e.id]} showAuthor showTopic={false} />)}
            </section>
          )}
          <section className="cp-list" aria-labelledby="all">
            <h2 id="all" className="cp-h2">Newest first</h2>
            {list.length === 0 ? <p className="cp-empty">{c.loaded ? "Nothing here yet. Write under this topic and you're its first entry." : "Reading the chain…"}</p> :
              list.map(e => <EntryItem key={e.id} e={e} resonance={c.resonance[e.id]} showAuthor showTopic={false} />)}
          </section>
        </main>
        <aside aria-labelledby="near">
          <h2 id="near" className="cp-h2">Other topics</h2>
          {others.length === 0 ? <p className="cp-hint">None yet.</p> : others.map(t => <a key={t.topic} className="cp-topiclink" href={hrefTopic(t.topic)}>{t.topic}<span>{t.count}</span></a>)}
        </aside>
      </div>
    </div>
  );
}

// ── one entry, and what was written in reply ────────────────────────────────
function EntryView(c: Ctx & { id: Hex }) {
  const e = c.byId.get(c.id);
  const replies = c.entries.filter(r => r.replyTo === c.id).sort((a, b) => a.height - b.height);
  const parent = e?.replyTo ? c.byId.get(e.replyTo) : undefined;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expires, setExpires] = useState<number | null>(null);
  useEffect(() => { setExpires(null); c.api.proposal(c.id).then(p => p && setExpires(Number(p.expires_epoch))).catch(() => {}); }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { c.needAuthors([c.id, ...replies.filter(r => !r.pending).map(r => r.id)]); }, [c.id, replies.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!e) return <main className="cp-main"><p className="cp-empty">{c.loaded ? "This entry isn't on the chain this node follows, or not yet." : "Reading the chain…"}</p></main>;
  const r = c.resonance[e.id], href = e.kind === "link" ? linkHref(e.text) : null;
  const left = room(text.trim(), e.id);
  const mineAlready = !!c.resonated[e.id];
  const ep = epochOf(c.height);
  const closed = expires !== null && c.height > 0 && ep > expires;
  const openLine = expires === null || !c.height ? "" : closed
    ? `Resonance closed after epoch ${expires.toLocaleString("en-US")}, when this entry expired.`
    : expires - ep > 100_000 ? "Open for resonance for good."
    : `Open for resonance until the end of epoch ${expires.toLocaleString("en-US")}, about ${when(Math.floor(Date.now() / 1000) + ((expires + 1) * EPOCH_LEN - c.height) * BLOCK_SECS)}.`;
  return (
    <main className="cp-main">
      {parent && <a className="cp-hint" href={hrefEntry(parent.id)}>In reply to: {parent.text.slice(0, 90)}{parent.text.length > 90 ? "…" : ""}</a>}
      <article style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="cp-meta">
          {e.author && <Who addr={e.author} size={24} />}
          <TopicLink topic={e.topic} />
          {e.pending ? <span className="cp-pending">Being kept now</span> : <><span>{when(e.time)}</span><span className="cp-mono">block {e.height.toLocaleString("en-US")}</span></>}
        </div>
        {e.kind === "doc" && <span className="cp-doclabel">Document</span>}
        {e.hidden !== undefined ? (
          <p className="cp-notice" style={{ margin: 0 }}>This site doesn&apos;t show this entry: {e.hidden}. It is still on Compute Substrate, and other clients can show it. <a href={HIDDEN_POLICY} target="_blank" rel="noreferrer noopener">What this site doesn&apos;t show, and why</a></p>
        ) : <>
          <p className="cp-big">{e.text}</p>
          {href && <a href={href} target="_blank" rel="noreferrer noopener">Open link</a>}
          {e.kind === "doc" && <DocBody e={e} />}
        </>}
        {!e.pending && (
          <div className="cp-row" style={{ justifyContent: "flex-start" }}>
            <button className="cp-btn-line" disabled={busy || !c.me || mineAlready || closed} onClick={async () => { setBusy(true); setErr(null); try { await c.resonate(e.id); } catch (x: any) { setErr(nice(x)); } finally { setBusy(false); } }}>
              {mineAlready ? "You resonated" : busy ? "Sending…" : "Resonate"}
            </button>
            <span className="cp-hint">{r?.count ? `${r.count} resonated. ` : ""}{closed ? "" : c.me ? "Each costs 0.05 CSD, about half a cent, and is public. " : "Connect a wallet to resonate. "}{openLine}</span>
          </div>
        )}
        {err && <p className="cp-hint over" style={{ margin: 0 }}>{err}</p>}
      </article>

      {replies.length > 0 && (
        <section className="cp-replies" aria-labelledby="replies">
          <h2 id="replies" className="cp-h2">Written in reply</h2>
          {replies.map(x => <EntryItem key={x.id} e={x} resonance={c.resonance[x.id]} showAuthor showTopic={false} />)}
        </section>
      )}

      {!e.pending && (
        <section className="cp-write" aria-label="Reply">
          <label htmlFor="reply" className="cp-hint" style={{ fontSize: 14 }}>Write in reply</label>
          <textarea id="reply" className="small" value={text} onChange={x => setText(x.target.value)} placeholder="A reply is kept like any entry: forever." />
          <div className="cp-row" style={{ justifyContent: "flex-end" }}>
            {text && <Left left={left} />}
            <button className="cp-btn" disabled={!text.trim() || left < 0} onClick={() => c.startKeep(text.trim(), e.topic, e.id, () => setText(""))}>Keep it</button>
          </div>
        </section>
      )}
    </main>
  );
}

// ── Everyone: the whole memory as a sky ─────────────────────────────────────
function Everyone(c: Ctx) {
  const [range, setRange] = useState<"day" | "all">("all");
  const [picked, setPicked] = useState<string | null>(null);
  const now = Date.now() / 1000;
  const shown = c.entries.filter(e => range === "all" || now - e.time < 86400);
  const topics = topicStats(shown).sort((a, b) => b.count - a.count);
  const bands = topics.slice(0, 6).map(t => t.topic);
  const hasElse = topics.length > 6;
  const rows = bands.length + (hasElse ? 1 : 0) || 1;
  const t0 = shown.length ? Math.min(...shown.map(e => e.time)) : now - 86400, t1 = now;
  const H = 560, top = 32, rowH = H / rows;
  const pos = (e: Entry, i: number) => {
    const b = bands.indexOf(e.topic), row = b >= 0 ? b : bands.length;
    const x = t1 > t0 ? 6 + ((e.time - t0) / (t1 - t0)) * 90 : 50;
    const h = parseInt(e.id.slice(-6), 16) / 0xffffff; // stable scatter within the band
    return { x, y: top + row * rowH + 26 + h * Math.max(rowH - 40, 8), i };
  };
  const p = picked ? shown.find(e => e.id === picked) : undefined;
  const pp = p ? pos(p, 0) : null;
  useEffect(() => { if (p && !p.author && !p.pending) c.needAuthors([p.id]); }, [p?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mineId = c.me?.addr20;
  return (
    <div className="cp-wide">
      <div className="cp-row" style={{ marginBottom: 16 }}>
        <p className="cp-sky-intro" style={{ margin: 0 }}>Every point is something someone meant enough to keep.{mineId ? " Yours are the gold ones." : ""}</p>
        <div style={{ display: "flex", gap: 6 }} role="group" aria-label="Time range">
          {(["day", "all"] as const).map(r => (
            <button key={r} aria-pressed={range === r} onClick={() => { setRange(r); setPicked(null); }}
              style={{ fontSize: 13, padding: "8px 12px", borderRadius: 8, background: "transparent", color: range === r ? "var(--star)" : "var(--night-muted)", border: `1px solid ${range === r ? "var(--star)" : "#3A4260"}` }}>
              {r === "day" ? "Last 24 hours" : "Since the first entry"}
            </button>
          ))}
        </div>
      </div>
      <div className="cp-sky" role="group" aria-label="All entries, placed by when they were written and their topic">
        {[...bands, ...(hasElse ? ["elsewhere"] : [])].map((b, i) => <span key={b} className="band" style={{ top: top + i * rowH }}>{b}</span>)}
        {shown.map((e, i) => {
          const q = pos(e, i), r = c.resonance[e.id]?.weight ?? 0;
          const mine = !!mineId && e.author === mineId;
          const size = (e.pending ? 8 : r > 0 ? Math.min(14, 7 + Math.log2(1 + r / Number(MIN_FEE_ATTEST)) * 2) : mine ? 8 : 6) + (e.kind === "doc" ? 4 : 0);
          const color = mine ? "var(--gold)" : r > 0 ? "var(--star)" : "var(--star-dim)";
          const style = e.pending ? { width: size, height: size, border: `1.5px solid ${color}`, background: "transparent", opacity: 0.8 } : { width: size, height: size, background: color, boxShadow: picked === e.id ? "0 0 0 6px rgba(236,234,228,0.18)" : undefined };
          return (
            <button key={e.id} className="dot" style={{ left: `${q.x}%`, top: q.y }} aria-label={`${mine ? "Your entry" : "An entry"} in ${e.topic}${e.pending ? ", being kept now" : ""}`} aria-pressed={picked === e.id} onClick={() => setPicked(picked === e.id ? null : e.id)}>
              <span style={style} />
            </button>
          );
        })}
        {p && pp && (
          <div className="card" style={{ left: `min(${pp.x + 1.5}%, calc(100% - 316px))`, top: Math.min(pp.y + 16, H - 140) }}>
            <p>{p.hidden !== undefined ? `Not shown on this site: ${p.hidden}.` : p.text}</p>
            <div className="cp-meta" style={{ fontSize: 12 }}>
              {p.author && <Who addr={p.author} you={p.author === mineId} />}
              <span>{p.topic}</span>
              <span>{p.pending ? "being kept now" : when(p.time)}</span>
            </div>
            {!p.pending && <a href={hrefEntry(p.id)} style={{ fontSize: 14 }}>Open</a>}
          </div>
        )}
        {shown.length === 0 && <div className="cp-sky-empty">{c.loaded ? (range === "day" ? "Nothing was kept in the last 24 hours. It's quiet tonight." : "The sky is empty. The first entry kept will be its first star.") : "Reading the chain…"}</div>}
        <div className="axis"><span>{shown.length ? when(t0) : ""}</span><span>now</span></div>
      </div>
      {c.netError && <p className="cp-notice" style={{ marginTop: 16, background: "transparent", color: "var(--night-muted)", borderColor: "#3A4260" }}>{c.netError}</p>}
    </div>
  );
}

// ── the moment of keeping ───────────────────────────────────────────────────
function nice(e: any): string {
  const m = String(e?.message ?? e);
  if (m.includes("UPLOAD_NOT_FREE")) return "Arweave wants payment for this file. Free storage covers files up to 105 KB, within an allowance per writer.";
  if (m.startsWith("UPLOAD_")) return "Arweave's upload service didn't take the file. Nothing was kept; try again in a moment.";
  if (m.includes("WAIT_FOR_BLOCK")) return "Your last send is still being kept. This one can go once it's in a block, in a minute or two.";
  if (m.includes("NOT_ENOUGH_CSD")) return "Your writing key doesn't hold enough CSD for this.";
  if (/rejected|denied/i.test(m)) return "The wallet didn't sign.";
  if (m.startsWith("NODE_") || /fetch/i.test(m)) return "The CSD node didn't answer. Try again in a moment.";
  return m;
}

function KeepDialog({ text, topic, replyTo, doc, keyState, balance, onKeep, onClose }: {
  text: string; topic: string; replyTo?: Hex; doc?: Doc; keyState: [CsdKey | null, (k: CsdKey | null) => void]; balance: bigint | null;
  onKeep: (step: (s: string) => void) => Promise<void>; onClose: () => void;
}) {
  const [step, setStep] = useState<string | null>(null);
  const [key, setKey] = keyState;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [busy, onClose]);
  const short_ = balance !== null && balance < MIN_FEE_PROPOSE;
  return (
    <div className="cp-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="keep-title">
        <h2 id="keep-title">{doc ? "Publish this document forever?" : replyTo ? "Keep this reply forever?" : "Keep this forever?"}</h2>
        {doc ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}><span className="cp-doclabel">Document</span><blockquote>{text}</blockquote><span className="cp-hint">{doc.name}, {kb(doc.bytes.length)}</span></div> : <blockquote>{text}</blockquote>}
        <ul>
          <li>Anyone, anywhere, will be able to read it.</li>
          <li>Nobody can edit or remove it, including you.</li>
          <li>It is kept with the time it was written, and that can't be changed either.</li>
          {doc && <li>The file is stored on Arweave, which keeps it for good (free at this size), and the entry holds its fingerprint, so anyone can check it is exactly this file.</li>}
        </ul>
        <div className="facts"><span>{guestbookOwner(normTopic(topic)) ? <>In the guestbook of <span className="cp-mono" style={{ color: "var(--ink)" }}>{short(guestbookOwner(normTopic(topic))!)}</span></> : <>Topic <span style={{ color: "var(--ink)" }}>{normTopic(topic)}</span></>}</span><span>Costs 0.25 CSD, about 2.5 cents</span></div>
        {!key ? (
          <div className="cp-menu" style={{ position: "static", width: "auto", boxShadow: "none" }}><Connect onKey={setKey} /></div>
        ) : short_ ? (
          <div className="cp-notice" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <span>Your writing key needs a little CSD first: it holds {csd(balance!)} and an entry takes 0.25. Your draft stays here while you add some.</span>
            <TopUpHere me={key} />
            <span className="cp-hint">Or send CSD from any CSD wallet to <span className="cp-mono" style={{ wordBreak: "break-all" }}>{key.addr20}</span>.</span>
          </div>
        ) : null}
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button ref={first} className="cp-btn" disabled={!key || busy || short_ || balance === null} onClick={async () => { setBusy(true); setErr(null); try { await onKeep(setStep); } catch (x) { setErr(nice(x)); setBusy(false); setStep(null); } }}>
            {busy ? (step ?? "Keeping…") : doc ? "Publish it forever" : "Keep it forever"}
          </button>
          <button className="cp-btn-ghost" disabled={busy} onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Not yet</button>
        </div>
      </section>
    </div>
  );
}

function WalletPic({ addr }: { addr: string }) {
  const p = useContext(Profiles)[addr];
  return <Avatar addr={addr} pic={p?.pic} size={18} />;
}

// ── choosing a picture and a name ───────────────────────────────────────────
function ProfileDialog({ addr, current, balance, onKeep, onClose }: {
  addr: Hex; current?: Profile; balance: bigint | null; onKeep: (pic: number, name: string) => Promise<void>; onClose: () => void;
}) {
  const [pic, setPic] = useState(current?.pic ?? 0);
  const [name, setName] = useState(current?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [busy, onClose]);
  const low = balance !== null && balance < MIN_FEE_PROPOSE;
  const same = current && current.pic === pic && current.name === cleanName(name);
  const options = [{ n: 0, label: "Made from your key" }, ...PICTURES.map((p, i) => ({ n: i + 1, label: p.name }))];
  return (
    <div className="cp-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="pf-title">
        <h2 id="pf-title">Your picture and name</h2>
        <fieldset style={{ border: "none", margin: 0, padding: 0 }}>
          <legend className="cp-hint" style={{ marginBottom: 12 }}>The first is made from your key and is yours alone. The others anyone can pick.</legend>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(56px, 1fr))", gap: 10 }}>
            {options.map(o => (
              <label key={o.n} title={o.label} className="cp-pic" style={{ cursor: "pointer", position: "relative", borderRadius: 12, padding: 3, border: `2px solid ${pic === o.n ? "var(--accent)" : "transparent"}`, display: "flex", justifyContent: "center" }}>
                <input type="radio" name="pic" value={o.n} checked={pic === o.n} onChange={() => setPic(o.n)} style={{ position: "absolute", opacity: 0, width: 1, height: 1 }} aria-label={o.label} />
                <Avatar addr={addr} pic={o.n} size={48} />
              </label>
            ))}
          </div>
        </fieldset>
        <label className="cp-topic" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>Name
          <input value={name} onChange={e => setName(e.target.value)} maxLength={NAME_MAX} placeholder="Leave empty to go without one" style={{ width: "100%", borderRadius: 8, fontSize: 16, padding: "10px 12px" }} />
        </label>
        <ul>
          <li>Your picture and name are kept like an entry: public, and on chain for good.</li>
          <li>You can change them later. The newest one is the one people see, and the old ones stay on the record.</li>
          <li>Names aren&apos;t unique, so your address always shows beside yours.</li>
        </ul>
        <div className="facts"><span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}><Avatar addr={addr} pic={pic} size={28} />{cleanName(name) || "No name"}</span><span>Costs 0.25 CSD, about 2.5 cents</span></div>
        {low && <div className="cp-notice" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <span>Your writing key needs a little CSD first: it holds {csd(balance!)} and this takes 0.25.</span>
          <TopUpHereFor addr={addr} />
        </div>}
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button className="cp-btn" disabled={busy || low || balance === null || !!same} onClick={async () => { setBusy(true); setErr(null); try { await onKeep(pic, name); } catch (x) { setErr(nice(x)); setBusy(false); } }}>{busy ? "Keeping…" : "Keep it"}</button>
          <button className="cp-btn-ghost" disabled={busy} onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Not now</button>
        </div>
      </section>
    </div>
  );
}

// ── someone's page: what they kept, their guestbook, what they resonated with ─
function Person(c: Ctx & { addr: Hex }) {
  const prof = useContext(Profiles)[c.addr];
  const isMe = c.me?.addr20 === c.addr;
  const [acts, setActs] = useState<null | Awaited<ReturnType<Ctx["api"]["activity"]>>>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true; setActs(null); setFailed(false);
    const go = () => c.api.activity(c.addr, 500).then(a => {
      if (!live) return;
      setActs(a);
      // every entry this address made is theirs: no need to ask the node one by one
      const m: Record<string, Hex> = {};
      for (const x of a) if (x.kind === "proposal" && x.proposal_id) m[String(x.proposal_id).toLowerCase()] = c.addr;
      c.learnAuthors(m);
    }).catch(() => { if (live) setFailed(true); });
    go(); const t = setInterval(go, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [c.addr]); // eslint-disable-line react-hooks/exhaustive-deps

  const kept = c.entries.filter(e => e.author === c.addr);
  const gbTopic = guestbookTopic(c.addr);
  const guestbook = c.all.filter(e => e.topic === gbTopic && e.kind !== "profile");
  useEffect(() => { c.needAuthors(guestbook.filter(e => !e.pending).map(e => e.id)); }, [guestbook.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const liked = acts ? [...new Set(acts.filter(x => x.kind === "attestation" && x.proposal_id).map(x => String(x.proposal_id).toLowerCase()))].map(id => c.byId.get(id)).filter((e): e is Entry => !!e) : [];
  useEffect(() => { c.needAuthors(liked.map(e => e.id)); }, [liked.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState("");
  const left = room(text.trim());
  const [copied, setCopied] = useState(false);
  return (
    <main className="cp-main">
      <header style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
        <Avatar addr={c.addr} pic={prof?.pic} size={84} label={prof?.name ? `${prof.name}'s picture` : "Picture"} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: "1 1 260px" }}>
          <h1 className="cp-topic-title" style={{ fontSize: 40 }}>{prof?.name || short(c.addr)}</h1>
          <span className="cp-who" style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>{c.addr}</span>
          <div className="cp-meta">
            {acts && <span>{kept.length} kept</span>}
            {acts && <span>{liked.length} resonated with</span>}
            {guestbook.length > 0 && <span>{guestbook.length} in the guestbook</span>}
            <button className="cp-btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => { navigator.clipboard?.writeText(window.location.href); setCopied(true); }}>{copied ? "Link copied" : "Copy link to this page"}</button>
          </div>
        </div>
      </header>
      {isMe && <p className="cp-notice" style={{ margin: 0 }}>This is your page as everyone sees it. <a href="#/">Back to writing</a></p>}
      {failed && <p className="cp-notice" style={{ margin: 0 }}>The node didn't answer for this page. It may be busy; it tries again in a minute.</p>}

      <section className="cp-list" aria-labelledby="kept">
        <h2 id="kept" className="cp-h2">Kept</h2>
        {kept.length === 0 ? <p className="cp-empty">{acts || failed ? "Nothing kept yet." : "Reading the chain…"}</p> :
          kept.map(e => <EntryItem key={e.id} e={e} resonance={c.resonance[e.id]} />)}
      </section>

      <section className="cp-list" aria-labelledby="gb">
        <h2 id="gb" className="cp-h2">Guestbook</h2>
        {guestbook.length === 0 && <p className="cp-empty" style={{ marginBottom: 16 }}>Nobody has signed it yet.</p>}
        {guestbook.map(e => <EntryItem key={e.id} e={e} showAuthor showTopic={false} resonance={c.resonance[e.id]} />)}
        {!isMe && (
          <div className="cp-write" style={{ marginTop: 20 }}>
            <label htmlFor="gb-text" className="cp-hint" style={{ fontSize: 14 }}>Sign the guestbook</label>
            <textarea id="gb-text" className="small" value={text} onChange={e => setText(e.target.value)} placeholder="Leave a line. It stays here for good." />
            <div className="cp-row" style={{ justifyContent: "flex-end" }}>
              {text && <Left left={left} />}
              <button className="cp-btn" disabled={!text.trim() || left < 0} onClick={() => c.startKeep(text.trim(), gbTopic, undefined, () => setText(""))}>Sign it</button>
            </div>
          </div>
        )}
      </section>

      <section className="cp-list" aria-labelledby="liked">
        <h2 id="liked" className="cp-h2">Resonated with</h2>
        {liked.length === 0 ? <p className="cp-empty">{acts || failed ? "Nothing yet." : "Reading the chain…"}</p> :
          liked.map(e => <EntryItem key={e.id} e={e} showAuthor resonance={c.resonance[e.id]} />)}
      </section>
    </main>
  );
}

// a topic, or for a guestbook entry, whose guestbook it is in
function TopicLink({ topic }: { topic: string }) {
  const owner = guestbookOwner(topic);
  const p = useContext(Profiles)[owner ?? ""];
  if (owner) return <a className="topic" href={hrefPerson(owner)}>in the guestbook of {p?.name || short(owner)}</a>;
  return <a className="topic" href={hrefTopic(topic)}>{topic}</a>;
}

function TopUpHereFor({ addr }: { addr: Hex }) {
  // the profile dialog has the address; the key is the connected one
  const k = useContext(KeyCtx);
  return k && k.addr20 === addr ? <TopUpHere me={k} /> : null;
}
const KeyCtx = createContext<CsdKey | null>(null);

// ── documents ───────────────────────────────────────────────────────────────
type Doc = { bytes: Uint8Array; type: string; name: string };
const kb = (n: number) => n < 1024 ? `${n} bytes` : `${(n / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`;

// How much more fits. The chain counts bytes: plain letters are one each, letters like æ, ø and
// å are two, and an emoji is four, so the number can drop by more than one per character
function Left({ left }: { left: number }) {
  const tip = "Counted in bytes: most letters are one, letters like æ, ø and å are two, an emoji is four.";
  return <span className={`cp-hint${left < 0 ? " over" : ""}`} title={tip}>{left < 0 ? `${-left} too long` : `${left} left`}</span>;
}

// The document an entry points at, read from Arweave and checked against the entry's fingerprint
function DocBody({ e }: { e: Entry }) {
  const [doc, setDoc] = useState<null | { text: string; bytes: number; matches: boolean }>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { if (e.docId && e.hash) fetchDoc(e.docId, e.hash).then(setDoc).catch(() => setErr(true)); }, [e.docId, e.hash]);
  const url = `${GATEWAY}/${e.docId}`;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="cp-meta">
        {doc ? (doc.matches
          ? <span>This is exactly the file that was published ({kb(doc.bytes)}).</span>
          : <span className="over" style={{ color: "#9B2C1F" }}>Warning: this file doesn&apos;t match the fingerprint in the entry. What the gateway served is not what was published.</span>)
          : err ? <span>The file couldn&apos;t be loaded from Arweave right now.</span> : e.pending ? <span>Stored on Arweave; it can take a few minutes to show everywhere.</span> : <span>Loading the file from Arweave…</span>}
        <a href={url} target="_blank" rel="noreferrer noopener">Open the file</a>
      </div>
      {doc && <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 20 }}>{doc.matches ? <Markdown text={doc.text} /> : null}</div>}
    </section>
  );
}

// Publishing a document: a Markdown or text file, its title, and the topic it belongs to
function DocWriter({ c, topic }: { c: Ctx; topic: string }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const pick = async (f: File | undefined) => {
    setErr(null); setDoc(null);
    if (!f) return;
    const type = contentTypeOf(f.name);
    if (!type) return setErr("For now, documents are Markdown (.md) or plain text (.txt) files.");
    if (f.size > FREE_BYTES) return setErr(`This file is ${kb(f.size)}. For now, documents can be up to ${kb(FREE_BYTES)}, which Arweave stores for free.`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const h = /^#\s+(.+)$/m.exec(text);
    setTitle(t => t || (h ? h[1].trim() : f.name.replace(/\.[^.]+$/, "")).slice(0, 200));
    setDoc({ bytes, type, name: f.name });
  };
  const left = docRoom(title.trim());
  return (
    <div className="cp-file">
      <label className="cp-hint" style={{ fontSize: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        A thesis, an essay, notes: any Markdown or text file up to {kb(FREE_BYTES)}.
        <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={e => pick(e.target.files?.[0])} />
      </label>
      {doc && <span className="cp-hint">{doc.name}, {kb(doc.bytes.length)}</span>}
      {err && <span className="cp-hint over">{err}</span>}
      <label className="cp-topic" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>Title
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What it is called" style={{ width: "100%", borderRadius: 8, fontSize: 16, padding: "10px 12px" }} />
      </label>
      <div className="cp-row" style={{ justifyContent: "flex-end" }}>
        {title && <Left left={left} />}
        <button className="cp-btn" disabled={!doc || !title.trim() || left < 0 || !topicOk(topic)} onClick={() => doc && c.startKeep(title.trim(), topic, undefined, () => { setDoc(null); setTitle(""); }, doc)}>Publish it</button>
      </div>
    </div>
  );
}
