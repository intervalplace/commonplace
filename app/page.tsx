"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { COIN, MIN_FEE_ATTEST, MIN_FEE_PROPOSE, EPOCH_LEN, buildAppTx, buildSendTx, buildSplitTx, MIN_SEND, SEND_FEE, bytesToHex, hexToBytes, keyFromPrivate, node, txid as txidOf, type CsdKey, type Hex } from "@/csd";
import { BACKGROUNDS, DEFAULT_TOPIC, NAME_MAX, PROFILE_TOPIC, STYLE_TOPIC, TYPEFACES, cleanName, styleArgs, styleRoom, type PageStyle, docArgs, docRoom, guestbookOwner, guestbookTopic, isReserved, linkHref, normTopic, parseEntry, profileArgs, proposeArgs, room, topicOk, type Entry } from "@/entries";
import { Avatar, PICTURES } from "@/avatars";
import { tally } from "@/research";
type Resonance = { count: number; weight: number; scoreSum?: number };
import { REMEMBER_TOPIC, openRemember, rememberArgs, sealRemember } from "@/remember";
import { fundFor, inviteKey, inviteLink, keyFromCode } from "@/invite";
import { FREE_BYTES, GATEWAY, contentTypeOf, fetchDoc, upload } from "@/arweave";
import { Markdown } from "@/markdown";
import hiddenList from "../moderation/hidden.json";
import { sha256d } from "@/csd";
import { K_PAYER, TopUpBox, type EthWallet } from "@/topup";
import { usdPerCsd } from "@/market";
import { deriveKey, discoverWallets, type WalletInfo } from "@/wallet";
import { NoPrf, makePasskey, passkeysHere, signInWithPasskey } from "@/passkey";
import { cairnConnect, cairnSubmit, discoverCairn, type CairnMe, type CairnProvider } from "@/cairn";
// who is writing: a key this page holds (from a wallet signature or a passkey), or a Cairn account,
// whose key stays in Cairn
type Me = CsdKey | CairnMe;
const local = (k: Me | null | undefined): k is CsdKey => !!k && "priv" in k;

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
const K_SESSION = "commonplace.key1", K_DRAFT = "commonplace.draft1", K_PENDING = "commonplace.pending1", K_AUTHORS = "commonplace.authors1", K_MINE = "commonplace.resonated1", K_WAITING = "commonplace.waiting1";
// written but not kept yet: stays in this browser until there is a key with CSD to keep it with
type Waiting = { text: string; topic: string; replyTo?: Hex; at: number };

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
type Route = { view: "me" } | { view: "topics" } | { view: "topic"; topic: string } | { view: "entry"; id: Hex } | { view: "everyone" } | { view: "person"; addr: Hex } | { view: "about" } | { view: "invite"; code: string };
function parseRoute(h: string): Route {
  const p = h.replace(/^#\/?/, "").split("/");
  if (p[0] === "topics") return { view: "topics" };
  if (p[0] === "t" && p[1]) return { view: "topic", topic: decodeURIComponent(p.slice(1).join("/")) };
  if (p[0] === "e" && /^0x[0-9a-f]{64}$/i.test(p[1] ?? "")) return { view: "entry", id: p[1].toLowerCase() as Hex };
  if (p[0] === "everyone") return { view: "everyone" };
  if (p[0] === "about") return { view: "about" };
  if (p[0] === "invite" && /^[A-Za-z0-9_-]{40,48}$/.test(p[1] ?? "")) return { view: "invite", code: p[1] };
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
  // resonance: the node's all-time list holds only the network's 50 most attested proposals,
  // which other apps fill, so each Commonplace topic's recent attestations are counted too
  const [allTime, setAllTime] = useState<Record<string, { count: number; weight: number }>>({});
  const [recent, setRecent] = useState<Record<string, { count: number; scoreSum: number }>>({});
  const [loaded, setLoaded] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  // every topic on chain with its count (the newest-500 list can't hold them all), and entries
  // read per topic beyond that list
  const [domains, setDomains] = useState<{ domain: string; proposals: number; attestations: number }[]>([]);
  const [older, setOlder] = useState<Map<string, Entry>>(new Map());
  const reading = useRef(new Set<string>());
  const loadTopic = useCallback(async (d: string) => {
    if (reading.current.has(d)) return;
    reading.current.add(d);
    try {
      const es = (await api.proposalsIn(d, 500)).map(parseEntry);
      setOlder(prev => { const next = new Map(prev); for (const e of es) next.set(e.id, e); return next; });
    } catch { reading.current.delete(d); }
  }, [api]);
  const [authors, setAuthors] = useState<Record<string, Hex>>({});
  useEffect(() => { setPending(load(K_PENDING, [])); setAuthors(load(K_AUTHORS, {})); }, []);

  const refresh = useCallback(async () => {
    try {
      const [t, ps] = await Promise.all([api.tip(), api.proposals(500)]);
      setHeight(t.height);
      api.domains().then(setDomains).catch(() => {});
      const es = ps.map(parseEntry).sort((a, b) => b.height - a.height || (a.id < b.id ? -1 : 1));
      setChain(es);
      api.resonance().then(setAllTime).catch(() => {});
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
  const [key, setKeyState] = useState<Me | null>(null);
  const setKey = useCallback((k: Me | null) => {
    setKeyState(k);
    try { k ? sessionStorage.setItem(K_SESSION, local(k) ? bytesToHex(k.priv) : `cairn:${k.addr20}`) : sessionStorage.removeItem(K_SESSION); } catch {}
  }, []);
  useEffect(() => {
    let h: string | null = null;
    try { h = sessionStorage.getItem(K_SESSION); } catch {}
    if (!h) return;
    if (!h.startsWith("cairn:")) { try { setKeyState(keyFromPrivate(hexToBytes(h))); } catch {} return; }
    // Cairn answers without asking while it's unlocked and on the same account
    const want = h.slice(6);
    let done = false;
    const stop = discoverCairn(async c => {
      if (done) return; done = true;
      try { const a = await cairnConnect(c); if (a === want) setKeyState({ addr20: a, cairn: c }); else setKey(null); } catch { setKey(null); }
    });
    const t = setTimeout(stop, 4000);
    return () => { stop(); clearTimeout(t); };
  }, [setKey]);
  // Cairn says when it locks or switches accounts; then this page stops writing as that account
  useEffect(() => {
    if (!key || local(key) || !key.cairn.on) return;
    const c = key.cairn, off = () => setKey(null);
    c.on!("accountsChanged", off); c.on!("disconnect", off);
    return () => { c.removeListener?.("accountsChanged", off); c.removeListener?.("disconnect", off); };
  }, [key, setKey]);
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
    if (!key) throw new Error("Sign in first.");
    if (!local(key)) { const id = await cairnSubmit(key.cairn, app, fee); setTimeout(refreshBalance, 1500); return id; }
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
    const ids = new Set(chain.map(e => e.id));
    const merged = [...chain, ...[...older.values()].filter(e => !ids.has(e.id))];
    const withAuthor = merged.map(e => HIDDEN.has(e.id)
      ? { ...e, author: authors[e.id], hidden: HIDDEN.get(e.id) || "listed in this site's hidden entries", text: "", docId: undefined }
      : { ...e, author: authors[e.id] });
    const mine = pending.map(p => ({ ...p, author: key?.addr20 ?? p.author }));
    return [...mine, ...withAuthor];
  }, [chain, older, pending, authors, key]);
  const entries = useMemo(() => all.filter(e => e.kind !== "profile" && !isReserved(e.topic)), [all]);
  // each key's newest profile entry (pending ones first, so a change shows at once)
  const profiles = useMemo(() => {
    const out: Record<string, Profile> = {};
    for (const e of all) if (e.kind === "profile" && e.author && !out[e.author]) out[e.author] = { pic: e.pic ?? 0, name: e.name ?? "" };
    return out;
  }, [all]);
  useEffect(() => { needAuthors(chain.filter(e => e.kind === "profile").map(e => e.id)); }, [chain, needAuthors]);
  // each key's newest page style, not counting any this site hides
  const styles = useMemo(() => {
    const best: Record<string, Entry> = {};
    for (const e of all) if (e.kind === "style" && e.style && e.author && e.hidden === undefined) {
      const b = best[e.author];
      if (!b || (e.pending && !b.pending) || (!!e.pending === !!b.pending && e.height > b.height)) best[e.author] = e;
    }
    return Object.fromEntries(Object.entries(best).map(([a, e]) => [a, e.style!])) as Record<string, PageStyle>;
  }, [all]);
  useEffect(() => { needAuthors(all.filter(e => e.kind === "style" && !e.pending).map(e => e.id)); }, [all, needAuthors]);
  const byId = useMemo(() => new Map(entries.map(e => [e.id, e])), [entries]);

  // which topics to count: those with a Commonplace entry and, by /domains, any attestations;
  // each at most every two minutes, since the node walks back through blocks to answer
  const counted = useRef(new Map<string, number>());
  useEffect(() => {
    if (!domains.length) return;
    const ours = new Set(all.filter(e => e.kind !== "link" && e.kind !== "profile").map(e => e.topic));
    const attested = new Map(domains.map(d => [d.domain, d.attestations]));
    const due = [...ours].filter(d => (attested.get(d) ?? 0) > 0 && Date.now() - (counted.current.get(d) ?? 0) > 120_000);
    if (!due.length) return;
    due.forEach(d => counted.current.set(d, Date.now()));
    (async () => {
      for (let i = 0; i < due.length; i += 4) {
        const got = await Promise.all(due.slice(i, i + 4).map(d => api.checksIn(d).catch(() => { counted.current.delete(d); return {}; })));
        setRecent(prev => Object.assign({ ...prev }, ...got));
      }
    })();
  }, [all, domains, height, api]);
  // the all-time figure wherever there is one; otherwise the recent count, each at least the
  // minimum fee (the recent list has no weights)
  const resonance = useMemo(() => {
    const out: Record<string, Resonance> = {};
    for (const [id, r] of Object.entries(recent)) if (r.count > 0) out[id] = { count: r.count, weight: r.count * Number(MIN_FEE_ATTEST), scoreSum: r.scoreSum };
    for (const [id, a] of Object.entries(allTime)) out[id] = { ...a, scoreSum: out[id]?.scoreSum };
    return out;
  }, [recent, allTime]);

  // my own page needs to know which entries are mine
  useEffect(() => { if (key && chain.length) needAuthors(chain.map(e => e.id)); }, [key, chain, needAuthors]);

  useEffect(() => { document.body.classList.toggle("night", route.view === "everyone"); }, [route]);

  // keeping an entry, or resonating with one
  const [keeping, setKeeping] = useState<null | { text: string; topic: string; replyTo?: Hex; doc?: Doc; done: () => void }>(null);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  useEffect(() => { setWaiting(load(K_WAITING, [] as Waiting[])); }, []);
  const putWaiting = (f: (w: Waiting[]) => Waiting[]) => setWaiting(prev => { const next = f(prev); save(K_WAITING, next); return next; });
  const [keepingWaiting, setKeepingWaiting] = useState(false);
  const [resonated, setResonated] = useState<Record<string, true>>({});
  useEffect(() => setResonated(load(K_MINE, {})), []);

  const keep = async (text: string, topic: string, replyTo?: Hex, doc?: Doc, step?: (s: string) => void) => {
    if (!key) throw new Error("Sign in first.");
    // a document: the file goes to Arweave first, then the entry that points at it
    let docId: string | undefined;
    if (doc && !local(key)) throw new Error("Documents are signed by the writing key in this page, which Cairn keeps to itself. Sign in with a passkey or wallet to publish one.");
    if (doc && local(key)) { step?.("Storing the file on Arweave…"); docId = await upload(key, doc.bytes, doc.type, text); step?.("Keeping the entry…"); }
    const t = await api.tip();
    const args = doc && docId ? docArgs(docId, text, topic, sha256d(doc.bytes), t.height) : proposeArgs(text, topic, t.height, replyTo);
    const id = await send(args, MIN_FEE_PROPOSE);
    const p: Pending = { id, topic: normTopic(topic), text, kind: doc ? "doc" : replyTo ? "reply" : "note", docId, replyTo, height: t.height + 1, time: Math.floor(Date.now() / 1000), pending: true, author: key.addr20, sentAt: Date.now() };
    setPending(prev => { const next = [p, ...prev]; save(K_PENDING, next); return next; });
    return id;
  };
  const keepProfile = async (pic: number, name: string) => {
    if (!key) throw new Error("Sign in first.");
    const t = await api.tip();
    const id = await send(profileArgs(pic, name, t.height), MIN_FEE_PROPOSE);
    const p: Pending = { id, topic: PROFILE_TOPIC, text: cleanName(name), kind: "profile", pic, name: cleanName(name), height: t.height + 1, time: Math.floor(Date.now() / 1000), pending: true, author: key.addr20, sentAt: Date.now() };
    setPending(prev => { const next = [p, ...prev]; save(K_PENDING, next); return next; });
  };
  const keepStyle = async (st: PageStyle) => {
    if (!key) throw new Error("Sign in first.");
    const t = await api.tip();
    const id = await send(styleArgs(st, t.height), MIN_FEE_PROPOSE);
    const p: Pending = { id, topic: STYLE_TOPIC, text: st.bio, kind: "style", style: st, height: t.height + 1, time: Math.floor(Date.now() / 1000), pending: true, author: key.addr20, sentAt: Date.now() };
    setPending(prev => { const next = [p, ...prev]; save(K_PENDING, next); return next; });
  };
  // the people this key remembers: its own encrypted entries, read back and opened here
  const [remembered, setRemembered] = useState<Set<string> | null>(null);
  const unread = useRef(new Map<string, { who: Hex; yes: boolean }>()); // sent, not seen in a block yet
  const readRemembered = useCallback(async () => {
    if (!local(key)) { setRemembered(null); return; }
    try {
      const acts = await api.activity(key.addr20, 500);
      const ours = acts.filter(a => a.kind === "proposal" && a.domain === REMEMBER_TOPIC && a.uri).sort((a, b) => a.height - b.height);
      const set = new Set<string>();
      for (const a of ours) {
        unread.current.delete(String(a.proposal_id).toLowerCase());
        const r = await openRemember(key, a.uri!);
        if (r) { if (r.remember) set.add(r.who); else set.delete(r.who); }
      }
      for (const { who, yes } of unread.current.values()) { if (yes) set.add(who); else set.delete(who); }
      setRemembered(set);
    } catch {}
  }, [api, key]);
  useEffect(() => { setRemembered(null); unread.current.clear(); readRemembered(); const t = setInterval(readRemembered, 120_000); return () => clearInterval(t); }, [readRemembered]);
  const rememberPerson = async (who: Hex, yes: boolean) => {
    if (!local(key)) throw new Error("Sign in with a passkey or wallet first.");
    const t = await api.tip();
    const id = await send(rememberArgs(await sealRemember(key, who, yes), t.height), MIN_FEE_PROPOSE);
    unread.current.set(id.toLowerCase(), { who: who.toLowerCase() as Hex, yes });
    setRemembered(prev => { const next = new Set(prev ?? []); if (yes) next.add(who.toLowerCase()); else next.delete(who.toLowerCase()); return next; });
  };
  const [editingProfile, setEditingProfile] = useState(false);
  const [eth, setEth] = useState<EthWallet | null>(null);
  const resonate = async (id: Hex) => {
    await send({ kind: "attest", proposalId: id, score: 1, confidence: 1 }, MIN_FEE_ATTEST);
    setResonated(prev => { const next = { ...prev, [id]: true as const }; save(K_MINE, next); return next; });
  };

  const ctx: Ctx = { route, entries, byId, height, loaded, netError, resonance, me: key, balance, authors, needAuthors, resonated, resonate, all, api, learnAuthors, domains, loadTopic, styles, keepStyle, remembered, rememberPerson, startKeep: (text, topic, replyTo, done, doc) => setKeeping({ text, topic, replyTo, done, doc }),
    waiting, unwait: (at: number) => putWaiting(w => w.filter(x => x.at !== at)), keepWaiting: () => setKeepingWaiting(true), editProfile: () => setEditingProfile(true) };

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
      {route.view === "about" && <About />}
      {route.view === "invite" && <Invite code={route.code} keyState={[key, setKey]} />}
      <footer className="cp-foot">
        <span>Kept on Compute Substrate. No account, no server, no owner.</span>
        <a href="#/about">About</a>
        <span>Node: {base.replace(/^https?:\/\//, "")}</span>
        {height > 0 && <span>Block {height.toLocaleString("en-US")}</span>}
        {height > 0 && <span title="The network ranks every topic anew each epoch of 30 blocks">Epoch {epochOf(height).toLocaleString("en-US")}, ends in {epochEnds(height)}</span>}
      </footer>
      {keeping && (
        <KeepDialog
          {...keeping} keyState={[key, setKey]} balance={balance}
          onKeep={async step => { await keep(keeping.text, keeping.topic, keeping.replyTo, keeping.doc, step); keeping.done(); setKeeping(null); }}
          onLater={keeping.doc ? undefined : () => { putWaiting(w => [...w, { text: keeping.text, topic: normTopic(keeping.topic), replyTo: keeping.replyTo, at: Date.now() }]); keeping.done(); setKeeping(null); }}
          onClose={() => setKeeping(null)}
        />
      )}
      {keepingWaiting && (
        <WaitingDialog waiting={waiting} keyState={[key, setKey]} balance={balance}
          onKeepOne={async (w, step) => { await keep(w.text, w.topic, w.replyTo, undefined, step); putWaiting(ws => ws.filter(x => x.at !== w.at)); }}
          onClose={() => setKeepingWaiting(false)} />
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
  resonance: Record<string, { count: number; weight: number }>; me: Me | null; balance: bigint | null;
  authors: Record<string, Hex>; needAuthors: (ids: Hex[]) => void; resonated: Record<string, true>; resonate: (id: Hex) => Promise<void>;
  startKeep: (text: string, topic: string, replyTo: Hex | undefined, done: () => void, doc?: Doc) => void;
  waiting: Waiting[]; unwait: (at: number) => void; keepWaiting: () => void;
  editProfile: () => void;
  all: Entry[]; api: ReturnType<typeof node>; learnAuthors: (m: Record<string, Hex>) => void;
  domains: { domain: string; proposals: number; attestations: number }[]; loadTopic: (d: string) => void;
  styles: Record<string, PageStyle>; keepStyle: (s: PageStyle) => Promise<void>;
  remembered: Set<string> | null; rememberPerson: (who: Hex, yes: boolean) => Promise<void>;
};

// ── header: the zoom, and the wallet ────────────────────────────────────────
function Header({ route, keyState, balance }: { route: Route; keyState: [Me | null, (k: Me | null) => void]; balance: bigint | null }) {
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

function WalletButton({ keyState: [key, setKey], balance }: { keyState: [Me | null, (k: Me | null) => void]; balance: bigint | null }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"send" | "key" | "invite" | null>(null);
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
        {key ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><WalletPic addr={key.addr20} />{short(key.addr20)}{balance !== null && <span className="bal">{csd(balance)} CSD</span>}</span> : "Sign in"}
      </button>
      {open && (
        <div className="cp-menu">
          {key ? <KeyInfo k={key} balance={balance} onForget={() => { setKey(null); setOpen(false); }} onSend={() => { setOpen(false); setDialog("send"); }} onShowKey={() => { setOpen(false); setDialog("key"); }} onInvite={() => { setOpen(false); setDialog("invite"); }} /> : <Connect onKey={k => { setKey(k); }} />}
        </div>
      )}
      {local(key) && dialog === "send" && <SendDialog k={key} onClose={() => setDialog(null)} />}
      {local(key) && dialog === "key" && <KeyDialog k={key} onClose={() => setDialog(null)} />}
      {local(key) && dialog === "invite" && <InviteDialog k={key} onClose={() => setDialog(null)} />}
    </div>
  );
}

// buying CSD with USDC needs the writing key to prove it owns the address, which Cairn can't do here
function TopUpFor({ me }: { me: Me }) {
  if (local(me)) return <TopUpHere me={me} />;
  return <span className="cp-hint">Add CSD to your Cairn account from Cairn or another wallet, or open an invite link someone made for you.</span>;
}

function KeyInfo({ k, balance, onForget, onSend, onShowKey, onInvite }: { k: Me; balance: bigint | null; onForget: () => void; onSend: () => void; onShowKey: () => void; onInvite: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <span>Your writing key holds <strong>{balance === null ? "…" : csd(balance)} CSD</strong>. Each entry costs 0.25 CSD and each resonance 0.05 CSD.</span>
      <span>To add CSD from another wallet, send it to:</span>
      <span className="addr">{k.addr20}</span>
      <button className="choice" onClick={() => { navigator.clipboard?.writeText(k.addr20); setCopied(true); }}>{copied ? "Copied" : "Copy address"}</button>
      <hr style={{ border: "none", borderTop: "1px solid var(--rule)", margin: "4px 0", width: "100%" }} />
      {local(k) ? (
        <>
          <TopUpHere me={k} compact />
          <hr style={{ border: "none", borderTop: "1px solid var(--rule)", margin: "4px 0", width: "100%" }} />
          <button className="choice" onClick={onInvite}>Make invite links</button>
          <button className="choice" onClick={onSend}>Send CSD elsewhere</button>
          <button className="choice" onClick={onShowKey}>Show writing key</button>
        </>
      ) : (
        <span className="cp-hint">This is your Cairn account. Cairn keeps its key and asks you to approve each entry and resonance. Sending CSD and making invite links happen in Cairn.</span>
      )}
      <button className="choice" onClick={onForget}>{local(k) ? "Disconnect" : "Sign out"}</button>
    </>
  );
}

// ── what CSD is worth: read once per visit from the open market's best offer ─
let pricePromise: Promise<number | null> | null = null;
function usePrice(): number | null {
  const [p, setP] = useState<number | null>(null);
  useEffect(() => { (pricePromise ??= usdPerCsd().catch(() => null)).then(setP); }, []);
  return p;
}
// ", about 1.3 cents" for an amount in CSD units, or nothing while the price is unknown
function inUsd(units: bigint, price: number | null): string {
  if (!price) return "";
  const cents = (Number(units) / Number(COIN)) * price * 100;
  if (cents < 1) return `, about ${cents.toFixed(2).replace(/0$/, "")} cents`;
  if (cents < 10) return `, about ${cents.toFixed(1).replace(/\.0$/, "")} cents`;
  if (cents < 100) return `, about ${Math.round(cents)} cents`;
  return `, about $${(cents / 100).toFixed(2)}`;
}

// ── taking CSD out ──────────────────────────────────────────────────────────
const exact = (v: bigint) => { const w = v / COIN, f = (v % COIN).toString().padStart(8, "0").replace(/0+$/, ""); return f ? `${w}.${f}` : `${w}`; };
function parseCsd(s: string): bigint | null {
  const m = s.trim().replace(",", ".").match(/^(\d*)(?:\.(\d{0,8}))?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return BigInt(m[1] || "0") * COIN + BigInt((m[2] ?? "").padEnd(8, "0") || "0");
}
const NOT_ETH = "This must be a Compute Substrate address, not an Ethereum one. They look the same, but CSD sent to an Ethereum address is lost for good.";

function useEscape(onClose: () => void, busy = false) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [busy, onClose]);
}

// ── invite links: CSD in a link, for whoever opens it first ─────────────────
const GIFTS = [50_000_000n, 100_000_000n, 200_000_000n, 500_000_000n]; // 0.5, 1, 2 and 5 CSD
const K_INVITES = "commonplace.invites1"; // per writing key, the next invite number, in case the network hasn't shown the last ones yet
type InviteRow = { n: number; link: string; holds: bigint; used: boolean };

function InviteDialog({ k, onClose }: { k: CsdKey; onClose: () => void }) {
  const pay = useContext(Pay);
  const price = usePrice();
  const [gift, setGift] = useState(GIFTS[1]);
  const [count, setCount] = useState(1);
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [next, setNext] = useState(0);
  const [made, setMade] = useState<string[] | null>(null);
  const [avail, setAvail] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEscape(onClose, !!busy);
  const stored = () => (load(K_INVITES, {} as Record<string, number>))[k.addr20] ?? 0;
  // the invites this key has made: numbered from 0, until one the network has never seen
  const scan = useCallback(async () => {
    if (!pay.api) return;
    const out: InviteRow[] = [];
    const upto = stored();
    for (let n = 0; n < 200; n++) {
      const ik = inviteKey(k, n);
      const [acts, us] = await Promise.all([pay.api.activity(ik.addr20, 5).catch(() => []), pay.api.utxos(ik.addr20, true).catch(() => [])]);
      if (!acts.length && !us.length && n >= upto) break;
      const holds = us.reduce((s, u) => s + u.value, 0n);
      out.push({ n, link: inviteLink(ik), holds, used: holds === 0n && acts.length > 0 });
    }
    setRows(out); setNext(out.length);
    pay.api.utxos(k.addr20).then(us => setAvail(us.reduce((s, u) => s + u.value, 0n))).catch(() => setAvail(0n));
  }, [pay.api, k]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { scan(); }, [scan]);
  const cost = fundFor(gift) * BigInt(count) + SEND_FEE;
  const short_ = avail !== null && avail < cost;
  const copy = (t: string, what: string) => { navigator.clipboard?.writeText(t); setCopied(what); };
  const make = async () => {
    if (!pay.api || rows === null) return;
    setBusy("make"); setErr(null);
    try {
      const keys = Array.from({ length: count }, (_, i) => inviteKey(k, next + i));
      const tx = buildSplitTx(await pay.api.utxos(k.addr20), k, keys.map(ik => ({ to: ik.addr20, value: fundFor(gift) })));
      await pay.api.submit(tx);
      const all = load(K_INVITES, {} as Record<string, number>); all[k.addr20] = next + count; save(K_INVITES, all);
      setMade(keys.map(inviteLink)); pay.refresh(); scan();
    } catch (x) { setErr(nice(x)); } finally { setBusy(null); }
  };
  const takeBack = async (r: InviteRow) => {
    if (!pay.api) return;
    setBusy(`back${r.n}`); setErr(null);
    try {
      const ik = inviteKey(k, r.n);
      await pay.api.submit(buildSendTx(await pay.api.utxos(ik.addr20), ik, k.addr20, "all"));
      pay.refresh(); setRows(rs => rs && rs.map(x => x.n === r.n ? { ...x, holds: 0n, used: true } : x));
    } catch (x) { setErr(nice(x)); } finally { setBusy(null); }
  };
  const open_ = (rows ?? []).filter(r => r.holds > 0n);
  return (
    <div className="cp-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="inv-title">
        <h2 id="inv-title">{made ? (made.length === 1 ? "Your invite link" : "Your invite links") : "Make invite links"}</h2>
        {made ? (
          <>
            <p className="cp-hint" style={{ margin: 0 }}>Each link carries {csd(gift)} CSD. Whoever opens one first can take it onto their own writing key and start writing. It works once the CSD is in a block, in a minute or two.</p>
            <div className="cp-links">{made.map(l => <span key={l} className="cp-mono">{l}</span>)}</div>
            <div className="actions">
              <button className="cp-btn" onClick={() => copy(made.join("\n"), "made")}>{copied === "made" ? "Copied" : made.length === 1 ? "Copy the link" : `Copy all ${made.length} links`}</button>
              <button className="cp-btn-ghost" onClick={() => setMade(null)} style={{ fontSize: 16, padding: "13px 20px" }}>Back</button>
            </div>
          </>
        ) : (
          <>
            <ul>
              <li>Each link carries some CSD. Whoever opens it first can move it to their own writing key and keep entries with it, with nothing to buy.</li>
              <li>Anyone who sees a link can use it, so share it where you mean to: post a few, or send one to a friend.</li>
              <li>The links are made from your writing key, so you can find them here on any device, and take back any nobody used.</li>
            </ul>
            <div role="group" aria-label="Each link carries" className="cp-field">
              <span className="cp-h2" aria-hidden="true">Each link carries</span>
              <div className="cp-modes">{GIFTS.map(g => <button key={String(g)} type="button" aria-pressed={gift === g} onClick={() => setGift(g)}>{csd(g)} CSD</button>)}</div>
            </div>
            <div role="group" aria-label="How many links" className="cp-field">
              <span className="cp-h2" aria-hidden="true">How many links</span>
              <div className="cp-modes">{[1, 3, 5, 10].map(n => <button key={n} type="button" aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}</div>
            </div>
            <div className="facts"><span>{count} {count === 1 ? "link" : "links"}, enough for about {Number(gift / MIN_FEE_PROPOSE)} {gift / MIN_FEE_PROPOSE === 1n ? "entry" : "entries"} each</span><span>Costs {csd(cost)} CSD{inUsd(cost, price)}</span></div>
            {short_ && <p className="cp-notice" style={{ margin: 0 }}>This writing key has {csd(avail!)} CSD ready, and these take {csd(cost)}.</p>}
            {err && <p className="err">{err}</p>}
            <div className="actions">
              <button className="cp-btn" disabled={!!busy || rows === null || avail === null || short_} onClick={make}>{busy === "make" ? "Making…" : count === 1 ? "Make the link" : `Make ${count} links`}</button>
              <button className="cp-btn-ghost" disabled={!!busy} onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Close</button>
            </div>
            {rows && rows.length > 0 && (
              <div className="cp-invites">
                <span className="cp-h2">Links you have made</span>
                <span className="cp-hint">{rows.length - open_.length} used or taken back, {open_.length} still waiting{open_.length ? ":" : "."}</span>
                {open_.map(r => (
                  <div key={r.n} className="cp-invite">
                    <span>{csd(r.holds)} CSD</span>
                    <button type="button" className="cp-linkbtn" onClick={() => copy(r.link, `l${r.n}`)}>{copied === `l${r.n}` ? "Copied" : "Copy link"}</button>
                    <button type="button" className="cp-linkbtn" disabled={!!busy} onClick={() => takeBack(r)}>{busy === `back${r.n}` ? "Taking back…" : "Take it back"}</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// someone opened an invite link
function Invite({ code, keyState }: { code: string; keyState: [Me | null, (k: Me | null) => void] }) {
  const pay = useContext(Pay);
  const [me, setMe] = keyState;
  const ik = useMemo(() => keyFromCode(code), [code]);
  const [holds, setHolds] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [taken, setTaken] = useState<bigint | null>(null);
  const look = useCallback(() => {
    if (!pay.api || !ik) return;
    pay.api.utxos(ik.addr20).then(us => setHolds(us.reduce((s, u) => s + u.value, 0n))).catch(() => setHolds(0n));
  }, [pay.api, ik]);
  useEffect(() => { look(); }, [look]);
  const gift = holds !== null && holds > SEND_FEE ? holds - SEND_FEE : 0n;
  const take = async () => {
    if (!pay.api || !ik || !me) return;
    setBusy(true); setErr(null);
    try {
      const tx = buildSendTx(await pay.api.utxos(ik.addr20), ik, me.addr20, "all");
      await pay.api.submit(tx);
      setTaken(tx.outputs[0].value); pay.refresh();
    } catch (x) { setErr(nice(x)); look(); } finally { setBusy(false); }
  };
  return (
    <main className="cp-main cp-invitepage">
      {!ik ? (
        <p className="cp-empty">This link isn&apos;t a working invite. Check it was copied whole.</p>
      ) : taken !== null ? (
        <>
          <h1 className="cp-topic-title">It&apos;s yours</h1>
          <p className="lead">{csd(taken)} CSD is on its way to your writing key, and arrives in a minute or two. That&apos;s enough to keep about {Number(taken / MIN_FEE_PROPOSE)} {taken / MIN_FEE_PROPOSE === 1n ? "entry" : "entries"}.</p>
          <a className="cp-btn" style={{ alignSelf: "flex-start", textDecoration: "none" }} href="#/">Start writing</a>
        </>
      ) : holds === null ? (
        <p className="cp-empty">Opening the invite…</p>
      ) : gift === 0n ? (
        <>
          <h1 className="cp-topic-title">This invite has been used</h1>
          <p className="lead">Someone opened it first, or it was taken back. If it was made a moment ago, it may not be in a block yet: <button type="button" className="cp-linkbtn" onClick={look}>look again</button> in a minute.</p>
          <a className="cp-out" style={{ textAlign: "left" }} href="#/about">What is Commonplace?</a>
        </>
      ) : (
        <>
          <h1 className="cp-topic-title">You&apos;ve been given {csd(gift)} CSD</h1>
          <p className="lead">
            Someone made this link so you could try Commonplace without buying anything. It&apos;s enough to keep about {Number(gift / MIN_FEE_PROPOSE)} {gift / MIN_FEE_PROPOSE === 1n ? "entry" : "entries"}: things you write that stay
            on the network for good, with the time you wrote them, and that nobody can edit or remove.
          </p>
          <p className="cp-hint" style={{ margin: 0 }}>Whoever opens a link first can take what it carries, so take it now if you mean to use it. <a href="#/about">What is Commonplace?</a></p>
          {!me ? (
            <div className="cp-menu" style={{ position: "static", width: "auto", boxShadow: "none" }}><Connect onKey={setMe} /></div>
          ) : (
            <div className="actions" style={{ display: "flex", gap: 12 }}>
              <button className="cp-btn" disabled={busy} onClick={take}>{busy ? "Taking it…" : "Take it"}</button>
            </div>
          )}
          {me && <p className="cp-hint" style={{ margin: 0 }}>It goes to your writing key, <span className="cp-mono">{short(me.addr20)}</span>.</p>}
          {err && <p className="err">{err}</p>}
        </>
      )}
    </main>
  );
}

function SendDialog({ k, onClose }: { k: CsdKey; onClose: () => void }) {
  const pay = useContext(Pay);
  const [avail, setAvail] = useState<bigint | null>(null);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; value: bigint } | null>(null);
  useEscape(onClose, busy);
  useEffect(() => { pay.api?.utxos(k.addr20).then(us => setAvail(us.reduce((s, u) => s + u.value, 0n))).catch(() => setAvail(0n)); }, [pay.api, k.addr20]);
  const dest = to.trim().toLowerCase();
  const value = all ? (avail === null ? null : avail - SEND_FEE) : parseCsd(amt);
  const problem =
    !dest ? null
    : !/^0x[0-9a-f]{40}$/.test(dest) ? "A Compute Substrate address is 0x followed by 40 letters and digits."
    : dest === k.addr20.toLowerCase() ? "That's this writing key itself."
    : pay.eth && dest === pay.eth.account.toLowerCase() ? "That's your Ethereum address, not a Compute Substrate one. CSD sent there would be lost for good."
    : value === null ? null
    : value < MIN_SEND ? "The smallest send is 0.01 CSD."
    : avail !== null && value + SEND_FEE > avail ? `This key has ${exact(avail)} CSD ready to send, and a send costs 0.001 CSD.`
    : null;
  const ready = !!dest && value !== null && !problem && avail !== null;
  const go = async () => {
    if (!pay.api) return;
    setBusy(true); setErr(null);
    try {
      const tx = buildSendTx(await pay.api.utxos(k.addr20), k, dest as Hex, all ? "all" : value!);
      const id = await pay.api.submit(tx);
      setSent({ id, value: tx.outputs[0].value }); pay.refresh();
    } catch (x) { setErr(nice(x)); } finally { setBusy(false); }
  };
  return (
    <div className="cp-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="send-title">
        <h2 id="send-title">{sent ? "Sent" : confirm ? "Send it?" : "Send CSD elsewhere"}</h2>
        {sent ? (
          <>
            <p className="cp-hint" style={{ margin: 0 }}>{exact(sent.value)} CSD is on its way to <span className="cp-mono" style={{ wordBreak: "break-all", color: "var(--ink)" }}>{dest}</span>. It arrives once it&apos;s in a block, in a minute or two.</p>
            <span className="cp-mono" style={{ wordBreak: "break-all" }}>Transaction {sent.id}</span>
            <div className="actions"><button className="cp-btn" onClick={onClose}>Done</button></div>
          </>
        ) : confirm ? (
          <>
            <div className="facts" style={{ flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
              <span>Amount <span style={{ color: "var(--ink)" }}>{exact(value!)} CSD</span>, plus 0.001 CSD for the network</span>
              <span>To <span className="cp-mono" style={{ wordBreak: "break-all", color: "var(--ink)" }}>{dest}</span></span>
            </div>
            <p className="cp-notice" style={{ margin: 0 }}>{NOT_ETH} A send can&apos;t be undone.</p>
            {err && <p className="err">{err}</p>}
            <div className="actions">
              <button className="cp-btn" disabled={busy} onClick={go}>{busy ? "Sending…" : "Send it"}</button>
              <button className="cp-btn-ghost" disabled={busy} onClick={() => setConfirm(false)} style={{ fontSize: 16, padding: "13px 20px" }}>Back</button>
            </div>
          </>
        ) : (
          <>
            <p className="cp-hint" style={{ margin: 0 }}>
              {avail === null ? "Checking what this key holds…" : <>This key has <strong style={{ color: "var(--ink)" }}>{exact(avail)} CSD</strong> ready to send. CSD from a send still being kept is ready once it&apos;s in a block.</>}
            </p>
            <label className="cp-field">
              <span>To a Compute Substrate address</span>
              <input value={to} onChange={e => setTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" className="cp-mono" />
            </label>
            <label className="cp-field">
              <span>Amount in CSD</span>
              <span style={{ display: "flex", gap: 8 }}>
                <input value={all ? (value !== null && value > 0n ? exact(value) : "0") : amt} onChange={e => { setAll(false); setAmt(e.target.value); }} inputMode="decimal" placeholder="0.00" style={{ flex: 1 }} />
                <button type="button" className="cp-btn-ghost" onClick={() => setAll(true)} disabled={!avail} aria-pressed={all}>Send all</button>
              </span>
            </label>
            <p className="cp-hint" style={{ margin: 0 }}>{NOT_ETH}</p>
            {problem && <p className="err">{problem}</p>}
            <p className="cp-hint" style={{ margin: 0 }}>To turn CSD back into USDC, send it to your own CSD wallet and sell it on <a href="https://covenant.market" target="_blank" rel="noopener">covenant.market</a>.</p>
            <div className="actions">
              <button className="cp-btn" disabled={!ready} onClick={() => setConfirm(true)}>Continue</button>
              <button className="cp-btn-ghost" onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function KeyDialog({ k, onClose }: { k: CsdKey; onClose: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  useEscape(onClose);
  const hex = bytesToHex(k.priv);
  return (
    <div className="cp-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="key-title">
        <h2 id="key-title">Your writing key</h2>
        <ul>
          <li>Anyone who sees this key can spend its CSD and write as you. Never paste it into a site or send it to anyone.</li>
          <li>Use it to bring this key into a Compute Substrate wallet you trust, such as the csd command-line wallet (<span className="cp-mono">--privkey</span>).</li>
          <li>You don&apos;t need to save it: your Ethereum wallet makes the same key again on any device.</li>
        </ul>
        {shown ? (
          <>
            <span className="cp-mono" style={{ wordBreak: "break-all", color: "var(--ink)", fontSize: 13, padding: 12, border: "1px solid var(--line)", borderRadius: 8 }}>{hex}</span>
            <div className="actions">
              <button className="cp-btn" onClick={() => { navigator.clipboard?.writeText(hex); setCopied(true); }}>{copied ? "Copied" : "Copy it"}</button>
              <button className="cp-btn-ghost" onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Done</button>
            </div>
          </>
        ) : (
          <div className="actions">
            <button className="cp-btn" onClick={() => setShown(true)}>Show it</button>
            <button className="cp-btn-ghost" onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Cancel</button>
          </div>
        )}
      </section>
    </div>
  );
}

function Connect({ onKey }: { onKey: (k: Me) => void }) {
  const pay = useContext(Pay);
  const [wallets, setWallets] = useState<WalletInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => discoverWallets(setWallets), []);
  const [cairn, setCairn] = useState<CairnProvider | null>(null);
  useEffect(() => discoverCairn(setCairn), []);
  const useCairn = async () => {
    if (!cairn) return;
    setBusy("cairn"); setErr(null);
    try { onKey({ addr20: await cairnConnect(cairn), cairn }); }
    catch (e: any) { setErr(String(e?.message ?? e)); }
    finally { setBusy(null); }
  };
  const go = async (w: WalletInfo) => {
    setBusy(w.id); setErr(null);
    try { const r = await deriveKey(w); pay.setEth({ wallet: w, account: r.account }); try { sessionStorage.setItem(K_PAYER, w.id); } catch {} onKey(r.key); } catch (e: any) { setErr(e?.message?.includes("rejected") ? "The wallet didn't sign." : String(e?.message ?? e)); } finally { setBusy(null); }
  };
  const [canPasskey, setCanPasskey] = useState(false);
  useEffect(() => { setCanPasskey(passkeysHere()); }, []);
  const passkey = async (make: boolean) => {
    setBusy(make ? "make" : "passkey"); setErr(null);
    try { onKey(make ? await makePasskey() : await signInWithPasskey()); }
    catch (e: any) {
      setErr(e instanceof NoPrf ? "This browser or passkey can't make a writing key yet. Recent Chrome, Safari, Edge and Firefox can, with a passkey saved in their password manager. Or use a wallet."
        : e?.name === "NotAllowedError" || e?.name === "AbortError" ? "The passkey wasn't used."
        : e?.name === "InvalidStateError" ? "That passkey already exists. Choose Use your passkey."
        : String(e?.message ?? e));
    } finally { setBusy(null); }
  };
  return (
    <>
      {cairn && (
        <>
          <span>Cairn Wallet is installed. Write as your Cairn account: Cairn keeps the key and asks before each entry.</span>
          <button className="choice" disabled={!!busy} onClick={useCairn}>{busy === "cairn" ? "Approve in Cairn…" : "Cairn Wallet"}</button>
          <hr style={{ border: "none", borderTop: "1px solid var(--rule)", margin: "4px 0", width: "100%" }} />
        </>
      )}
      {canPasskey && (
        <>
          <span>Write with a passkey: Face ID, Touch ID, Windows Hello or your phone. It makes your writing key, and nothing is sent anywhere.</span>
          <button className="choice" disabled={!!busy} onClick={() => passkey(false)}>{busy === "passkey" ? "Check your passkey…" : "Use your passkey"}</button>
          <button className="choice" disabled={!!busy} onClick={() => passkey(true)}>{busy === "make" ? "Check your passkey…" : "New here? Make a passkey"}</button>
          <span className="cp-hint">Make one once; after that, use it. Each passkey is its own writing key, and it works on this site. Your writing key can also be shown and kept elsewhere, from the wallet menu.</span>
          <hr style={{ border: "none", borderTop: "1px solid var(--rule)", margin: "4px 0", width: "100%" }} />
          <span>Or with an Ethereum wallet.</span>
        </>
      )}
      <span>Your wallet signs one message (twice, to check it&apos;s stable). That signature becomes your writing key. Nothing is sent anywhere.</span>
      {wallets === null ? <span>Looking for wallets…</span> : wallets.length === 0 ? <span>No browser wallet has answered yet. If one is installed, check that it&apos;s unlocked and allowed on this site, then <button type="button" className="cp-linkbtn" onClick={() => location.reload()}>reload the page</button>. Otherwise install one, such as MetaMask or Rabby.</span> :
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
// how a finding's checks stand, from its attestations' scores (see src/research.ts)
function checksLine(r?: Resonance): string | null {
  if (!r || r.scoreSum === undefined) return null;
  const t = tally(r.count, r.scoreSum);
  if (!t.checks) return "Not checked yet";
  return `Checked by ${t.checks}: ${t.holds ? `${t.holds} ${t.holds === 1 ? "says" : "say"} it holds up` : "none say it holds up"}${t.fails ? `, ${t.fails} ${t.fails === 1 ? "says" : "say"} it doesn't` : ""}`;
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function EntryItem({ e, resonance, showAuthor, showTopic = true }: { e: Entry; resonance?: Resonance; showAuthor?: boolean; showTopic?: boolean }) {
  const href = e.kind === "link" ? linkHref(e.text) : null;
  return (
    <article className="cp-entry">
      {e.kind === "doc" && <span className="cp-doclabel">Document</span>}
      {e.kind === "finding" && <span className="cp-doclabel">Finding</span>}
      {e.hidden !== undefined ? <a className="cp-hint" href={hrefEntry(e.id)}>Not shown on this site: {e.hidden}.</a>
        : e.pending ? <p>{e.text}</p> : <a className="text" href={hrefEntry(e.id)}>{e.text}</a>}
      <div className="cp-meta">
        {showAuthor && e.author && <Who addr={e.author} />}
        {showTopic && <TopicLink topic={e.topic} />}
        {e.kind === "reply" && e.replyTo && showTopic && <a href={hrefEntry(e.replyTo)}>in reply</a>}
        {e.pending ? <span className="cp-pending">Being kept now, waiting for the next block</span> : <span>{when(e.time)}</span>}
        {!e.pending && <span className="cp-mono">block {e.height.toLocaleString("en-US")}</span>}
        {e.kind === "finding" ? !e.pending && <span>{checksLine(resonance) ?? (resonance?.count ? `${resonance.count} resonated` : "Not checked yet")}</span>
          : resonance && resonance.count > 0 && <span>{resonance.count} resonated</span>}
        {e.finding && <a href={e.finding.source} target="_blank" rel="noreferrer noopener">Source: {hostOf(e.finding.source)}</a>}
        {href && <a href={href} target="_blank" rel="noreferrer noopener">Open link</a>}
        {!e.pending && <CopyLink id={e.id} />}
      </div>
    </article>
  );
}

// A link to one entry that works for anyone, on whatever address this site was opened from
function CopyLink({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    const url = `${location.origin}${location.pathname}${hrefEntry(id)}`;
    try { await navigator.clipboard.writeText(url); } catch { window.prompt("Copy this link", url); return; }
    setDone(true); setTimeout(() => setDone(false), 1800);
  };
  return <button type="button" className="cp-linkbtn" onClick={copy} aria-live="polite">{done ? "Link copied" : "Copy link"}</button>;
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
            {(!c.me || local(c.me)) && <button type="button" aria-pressed={mode === "doc"} onClick={() => setMode("doc")}>Publish a document</button>}
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

      {c.waiting.length > 0 && (
        <section className="cp-list cp-waiting" aria-labelledby="waiting">
          <div className="cp-row">
            <h2 id="waiting" className="cp-h2">Waiting to be kept</h2>
            <button className="cp-btn" onClick={c.keepWaiting}>{c.waiting.length === 1 ? "Keep it" : `Keep all ${c.waiting.length}`}</button>
          </div>
          {c.waiting.map(w => (
            <article key={w.at} className="cp-entry">
              <p className="text">{w.text}</p>
              <div className="cp-meta">
                <span>{guestbookOwner(w.topic) ? `In ${short(guestbookOwner(w.topic)!)}'s guestbook` : w.replyTo ? `A reply in ${w.topic}` : w.topic}</span>
                <span>Written {when(Math.floor(w.at / 1000))}</span>
                <button type="button" className="cp-linkbtn" onClick={() => c.unwait(w.at)}>Remove</button>
              </div>
            </article>
          ))}
          <p className="cp-hint" style={{ margin: 0 }}>Only in this browser until you keep {c.waiting.length === 1 ? "it" : "them"}. Nobody else can see {c.waiting.length === 1 ? "it" : "them"} yet.</p>
        </section>
      )}

      <section className="cp-list" aria-label="Your page">
        {!c.me ? (
          <p className="cp-empty">Your page is everything you have kept. Just start writing: you can keep what you write now, or save it here and keep it later.</p>
        ) : mine.length === 0 ? (
          <p className="cp-empty">Nothing kept yet. The first thing you keep starts your page, and it stays there for as long as the network runs.</p>
        ) : mine.map(e => <EntryItem key={e.id} e={e} resonance={c.resonance[e.id]} />)}
      </section>

      {c.me && c.remembered && c.remembered.size > 0 && <Remembered c={c} people={[...c.remembered]} />}

      <a className="cp-out" href="#/everyone">Zoom out and see your page among everyone's</a>
    </main>
  );
}

// the people you remember, each with the last thing they kept, newest first
function Remembered({ c, people }: { c: Ctx; people: string[] }) {
  const [latest, setLatest] = useState<Record<string, Entry | null>>({});
  const key = people.slice().sort().join();
  useEffect(() => {
    let live = true;
    (async () => {
      for (let i = 0; i < people.length && live; i += 4) {
        const got = await Promise.all(people.slice(i, i + 4).map(async a => {
          try {
            const acts = await c.api.activity(a as Hex, 50);
            const es = acts.filter(x => x.kind === "proposal" && x.proposal_id && x.domain && !isReserved(x.domain))
              .map(x => parseEntry({ proposal_id: x.proposal_id!, height: x.height, time: x.time, domain: x.domain!, payload_hash: x.payload_hash ?? ("0x" as Hex), uri: x.uri ?? "" }))
              .filter(e => e.kind !== "link" && !HIDDEN.has(e.id))
              .sort((x, y) => y.height - x.height);
            return [a, es[0] ?? null] as const;
          } catch { return [a, null] as const; }
        }));
        if (live) setLatest(prev => ({ ...prev, ...Object.fromEntries(got) }));
      }
    })();
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = people.map(a => ({ a, e: latest[a] })).sort((x, y) => (y.e?.time ?? 0) - (x.e?.time ?? 0));
  return (
    <section className="cp-list" aria-labelledby="remembered">
      <h2 id="remembered" className="cp-h2">People you remember</h2>
      {rows.map(({ a, e }) => (
        <div key={a} className="cp-remembered">
          <Who addr={a} />
          {e ? (
            <a className="cp-lately" href={hrefEntry(e.id)}>
              {e.kind === "doc" ? "Published " : e.kind === "reply" ? "Replied: " : ""}{e.text.length > 160 ? e.text.slice(0, 160).trimEnd() + "…" : e.text}
              <span className="when">{when(e.time)}</span>
            </a>
          ) : e === null ? <span className="cp-hint">Nothing kept lately.</span> : <span className="cp-hint">Reading…</span>}
        </div>
      ))}
      <p className="cp-hint" style={{ margin: "12px 0 0" }}>Only you can see this list. Nobody on it has been told.</p>
    </section>
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

// every topic: from the node's list of all of them, with what has been read so far for the dates
// Other apps write to the same network. A topic is Commonplace's once any entry in it is one
// (its uri starts "cp:"); a topic that has only ever held other apps' proposals is theirs.
const fromHere = (e: Entry) => e.kind !== "link";
function allTopics(c: Ctx) {
  const ours = new Set(c.entries.filter(fromHere).map(e => e.topic));
  const seen = new Map(topicStats(c.entries).map(t => [t.topic, { ...t, ours: ours.has(t.topic) }]));
  for (const d of c.domains) if (!isReserved(d.domain)) {
    const s = seen.get(d.domain);
    seen.set(d.domain, { topic: d.domain, count: Math.max(d.proposals, s?.count ?? 0), last: s?.last ?? 0, ours: ours.has(d.domain) });
  }
  return [...seen.values()];
}

function Topics(c: Ctx) {
  const every = allTopics(c);
  const ts = every.filter(t => t.ours).sort((a, b) => b.last - a.last || b.count - a.count);
  const apps = every.filter(t => !t.ours).sort((a, b) => b.count - a.count);
  const [q, setQ] = useState("");
  const find = q.trim().toLowerCase();
  // every topic whose name holds the words typed, Commonplace's first, closest first
  const found = !find ? [] : every.filter(t => find.split(/\s+/).every(w => t.topic.includes(w)))
    .sort((a, b) => Number(b.ours) - Number(a.ours) || Number(b.topic.startsWith(find)) - Number(a.topic.startsWith(find)) || b.count - a.count);
  const start = normTopic(q);
  const exact = every.some(t => t.topic === start);
  return (
    <main className="cp-main">
      <div>
        <h1 className="cp-topic-title" style={{ fontSize: 44 }}>Topics</h1>
        <p className="cp-hint" style={{ fontSize: 15, marginTop: 10 }}>Anyone can start one by writing under it. Most recently written in first.</p>
      </div>
      <input className="cp-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a topic" aria-label="Find a topic" autoComplete="off" spellCheck={false} />
      {find ? (
        <nav aria-label="Topics found" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {found.map(t => <a key={t.topic} className="cp-topiclink" href={hrefTopic(t.topic)}>{t.topic}<span>{t.count.toLocaleString("en-US")} {t.count === 1 ? "entry" : "entries"}{!t.ours ? ", another app" : t.last ? `, ${when(t.last)}` : ""}</span></a>)}
          {found.length === 0 && <p className="cp-empty" style={{ margin: 0 }}>No topic by that name yet.</p>}
          {!exact && start && !isReserved(start) && topicOk(start) && <a className="cp-out" style={{ textAlign: "left" }} href={hrefTopic(start)}>Start “{start}” by writing the first entry in it</a>}
        </nav>
      ) : !c.loaded ? <p className="cp-empty">Reading the network…</p> : ts.length === 0 ? <p className="cp-empty">No topics yet. Whatever you write first names the first one.</p> : (
        <nav aria-label="Topics" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ts.map(t => <a key={t.topic} className="cp-topiclink" href={hrefTopic(t.topic)}>{t.topic}<span>{t.count.toLocaleString("en-US")} {t.count === 1 ? "entry" : "entries"}{t.last ? `, ${when(t.last)}` : ""}</span></a>)}
        </nav>
      )}
      {!find && c.loaded && apps.length > 0 && (
        <details className="cp-apps">
          <summary>Other apps on Compute Substrate: {apps.length} {apps.length === 1 ? "topic" : "topics"}</summary>
          <p className="cp-hint" style={{ margin: "10px 0 14px" }}>The network is shared. These topics hold what other apps have written to it, shown as they are. Write in one here and it becomes a Commonplace topic too.</p>
          <nav aria-label="Topics from other apps" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {apps.map(t => <a key={t.topic} className="cp-topiclink" href={hrefTopic(t.topic)}>{t.topic}<span>{t.count.toLocaleString("en-US")}</span></a>)}
          </nav>
        </details>
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
  useEffect(() => { c.loadTopic(c.topic); }, [c.topic]); // eslint-disable-line react-hooks/exhaustive-deps
  const everyOther = allTopics(c).filter(t => t.topic !== c.topic);
  const others = everyOther.filter(t => t.ours).sort((a, b) => b.count - a.count);
  const appTopics = everyOther.length - others.length;
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
                The network ranks each topic anew every epoch (30 blocks, about an hour), by what was paid to resonate.
                {nowEntries.length === 0 ? " Nothing here has been resonated with this epoch or the last." : ""}
              </p>
              {nowEntries.map(e => <EntryItem key={e.id} e={e} resonance={c.resonance[e.id]} showAuthor showTopic={false} />)}
            </section>
          )}
          <section className="cp-list" aria-labelledby="all">
            <h2 id="all" className="cp-h2">Newest first</h2>
            {list.length === 0 ? <p className="cp-empty">{c.loaded ? "Nothing here yet. Write under this topic and you're its first entry." : "Reading the network…"}</p> :
              list.map(e => <EntryItem key={e.id} e={e} resonance={c.resonance[e.id]} showAuthor showTopic={false} />)}
          </section>
        </main>
        <aside aria-labelledby="near">
          <h2 id="near" className="cp-h2">Other topics</h2>
          {others.length === 0 ? <p className="cp-hint">None yet.</p> : others.map(t => <a key={t.topic} className="cp-topiclink" href={hrefTopic(t.topic)}>{t.topic}<span>{t.count}</span></a>)}
          {appTopics > 0 && <a className="cp-hint" href="#/topics" style={{ display: "block", marginTop: 14 }}>And {appTopics} {appTopics === 1 ? "topic" : "topics"} from other apps</a>}
        </aside>
      </div>
    </div>
  );
}

// ── one entry, and what was written in reply ────────────────────────────────
function EntryView(c: Ctx & { id: Hex }) {
  const price = usePrice();
  const e = c.byId.get(c.id);
  const replies = c.entries.filter(r => r.replyTo === c.id).sort((a, b) => a.height - b.height);
  const parent = e?.replyTo ? c.byId.get(e.replyTo) : undefined;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expires, setExpires] = useState<number | null>(null);
  useEffect(() => { setExpires(null); c.api.proposal(c.id).then(p => p && setExpires(Number(p.expires_epoch))).catch(() => {}); }, [c.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { c.needAuthors([c.id, ...replies.filter(r => !r.pending).map(r => r.id)]); }, [c.id, replies.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!e) return <main className="cp-main"><p className="cp-empty">{c.loaded ? "This entry isn't on the network this node follows, or not yet." : "Reading the network…"}</p></main>;
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
          {e.pending ? <span className="cp-pending">Being kept now</span> : <><span>{when(e.time)}</span><span className="cp-mono">block {e.height.toLocaleString("en-US")}</span><CopyLink id={e.id} /></>}
        </div>
        {e.kind === "doc" && <span className="cp-doclabel">Document</span>}
        {e.kind === "finding" && <span className="cp-doclabel">Finding</span>}
        {e.hidden !== undefined ? (
          <p className="cp-notice" style={{ margin: 0 }}>This site doesn&apos;t show this entry: {e.hidden}. It is still on Compute Substrate, and other clients can show it. <a href={HIDDEN_POLICY} target="_blank" rel="noreferrer noopener">What this site doesn&apos;t show, and why</a></p>
        ) : <>
          <p className="cp-big">{e.text}</p>
          {e.finding && <>
            {e.finding.quote && <blockquote className="cp-quote">{e.finding.quote}</blockquote>}
            <a href={e.finding.source} target="_blank" rel="noreferrer noopener">Read the source on {hostOf(e.finding.source)}</a>
            {!e.pending && <p className="cp-hint" style={{ margin: 0 }}>{checksLine(r) ?? "Not checked yet"}. A finding is kept by an agent or a person in the research memory, and checked by others who read the source. <a href="https://github.com/intervalplace/commonplace/tree/main/research" target="_blank" rel="noreferrer noopener">How it works</a></p>}
          </>}
          {href && <a href={href} target="_blank" rel="noreferrer noopener">Open link</a>}
          {e.kind === "doc" && <DocBody e={e} />}
        </>}
        {!e.pending && (
          <div className="cp-row" style={{ justifyContent: "flex-start" }}>
            <button className="cp-btn-line" disabled={busy || !c.me || mineAlready || closed} onClick={async () => { setBusy(true); setErr(null); try { await c.resonate(e.id); } catch (x: any) { setErr(nice(x)); } finally { setBusy(false); } }}>
              {mineAlready ? "You resonated" : busy ? "Sending…" : "Resonate"}
            </button>
            <span className="cp-hint">{r?.count ? `${r.count} resonated. ` : ""}{closed ? "" : c.me ? `Each costs 0.05 CSD${inUsd(MIN_FEE_ATTEST, price)}, and is public. ` : "Sign in to resonate. "}{openLine}</span>
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
  const [apps, setApps] = useState(false);
  const ours = useMemo(() => new Set(c.entries.filter(fromHere).map(e => e.topic)), [c.entries]);
  // since the first entry means every topic, not just the newest entries: read each one
  // (only Commonplace's own, unless other apps are asked for too)
  useEffect(() => {
    if (range !== "all") return;
    let live = true;
    (async () => {
      const ds = c.domains.filter(d => !isReserved(d.domain) && (apps || ours.has(d.domain))).map(d => d.domain);
      for (let i = 0; i < ds.length && live; i += 4) await Promise.all(ds.slice(i, i + 4).map(d => c.loadTopic(d)));
    })();
    return () => { live = false; };
  }, [range, apps, c.domains.length, ours.size]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = Date.now() / 1000;
  const shown = c.entries.filter(e => (apps || fromHere(e)) && (range === "all" || now - e.time < 86400));
  const topics = topicStats(shown).sort((a, b) => b.count - a.count);
  const BANDS = 8;
  const bands = topics.slice(0, BANDS).map(t => t.topic);
  const hasElse = topics.length > BANDS;
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
          <button aria-pressed={apps} onClick={() => { setApps(a => !a); setPicked(null); }} title="Other apps write to the same network. Off, the sky shows only what people kept here."
            style={{ fontSize: 13, padding: "8px 12px", borderRadius: 8, background: "transparent", color: apps ? "var(--star)" : "var(--night-muted)", border: `1px solid ${apps ? "var(--star)" : "#3A4260"}` }}>
            Other apps too
          </button>
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
        {shown.length === 0 && <div className="cp-sky-empty">{c.loaded ? (range === "day" ? "Nothing was kept in the last 24 hours. It's quiet tonight." : "The sky is empty. The first entry kept will be its first star.") : "Reading the network…"}</div>}
        <div className="axis"><span>{shown.length ? when(t0) : ""}</span><span>now</span></div>
      </div>
      {topics.length > 0 && (
        <nav aria-label="Every topic in the sky" style={{ marginTop: 20, display: "flex", flexWrap: "wrap", gap: "8px 18px", fontSize: 14 }}>
          <span style={{ color: "var(--night-muted)" }}>{shown.length.toLocaleString("en-US")} entries in {topics.length} topics{hasElse ? `; the ${BANDS} largest have their own row, the rest share "elsewhere"` : ""}:</span>
          {topics.map(t => <a key={t.topic} href={hrefTopic(t.topic)} style={{ color: "var(--star)", textDecoration: "none" }}>{t.topic} <span style={{ color: "var(--night-muted)" }}>{t.count.toLocaleString("en-US")}</span></a>)}
        </nav>
      )}
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
  if (m.includes("SEND_TOO_SMALL")) return "The smallest send is 0.01 CSD.";
  if (m.includes("BAD_ADDRESS")) return "That isn't a Compute Substrate address.";
  if (m.includes("NOT_ENOUGH_CSD")) return "Your writing key doesn't hold enough CSD for this.";
  if (/rejected|denied/i.test(m)) return "The wallet didn't sign.";
  if (m.startsWith("NODE_") || /fetch/i.test(m)) return "The CSD node didn't answer. Try again in a moment.";
  return m;
}

function KeepDialog({ text, topic, replyTo, doc, keyState, balance, onKeep, onLater, onClose }: {
  text: string; topic: string; replyTo?: Hex; doc?: Doc; keyState: [Me | null, (k: Me | null) => void]; balance: bigint | null;
  onKeep: (step: (s: string) => void) => Promise<void>; onLater?: () => void; onClose: () => void;
}) {
  const [step, setStep] = useState<string | null>(null);
  const [key, setKey] = keyState;
  const price = usePrice();
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
        <a className="cp-hint" href="#/about" target="_blank" rel="noopener" style={{ marginTop: -8 }}>What being kept for good means</a>
        <div className="facts"><span>{guestbookOwner(normTopic(topic)) ? <>In the guestbook of <span className="cp-mono" style={{ color: "var(--ink)" }}>{short(guestbookOwner(normTopic(topic))!)}</span></> : <>Topic <span style={{ color: "var(--ink)" }}>{normTopic(topic)}</span></>}</span><span>Costs 0.25 CSD{inUsd(MIN_FEE_PROPOSE, price)}</span></div>
        {!key ? (
          <div className="cp-menu" style={{ position: "static", width: "auto", boxShadow: "none" }}><Connect onKey={setKey} /></div>
        ) : short_ ? (
          <div className="cp-notice" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <span>Your writing key needs a little CSD first: it holds {csd(balance!)} and an entry takes 0.25. Your draft stays here while you add some.</span>
            <TopUpFor me={key} />
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
        {onLater && (!key || short_) && !busy && (
          <p className="cp-hint" style={{ margin: 0 }}>
            Not ready to connect or pay? <button type="button" className="cp-linkbtn" onClick={onLater}>Save it to keep later</button>. It waits on your page,
            in this browser only, and nothing is public until you keep it.
          </p>
        )}
      </section>
    </div>
  );
}

// keeping everything that has been waiting, one entry after another
function WaitingDialog({ waiting, keyState, balance, onKeepOne, onClose }: {
  waiting: Waiting[]; keyState: [Me | null, (k: Me | null) => void]; balance: bigint | null;
  onKeepOne: (w: Waiting, step: (s: string) => void) => Promise<void>; onClose: () => void;
}) {
  const [key, setKey] = keyState;
  const price = usePrice();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [list] = useState(waiting); // what was waiting when this opened
  useEscape(onClose, busy);
  const cost = MIN_FEE_PROPOSE * BigInt(list.length);
  const short_ = balance !== null && balance < cost;
  const n = list.length;
  return (
    <div className="cp-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="wait-title">
        <h2 id="wait-title">Keep {n === 1 ? "it" : `all ${n}`} forever?</h2>
        <ul>
          <li>Anyone, anywhere, will be able to read {n === 1 ? "it" : "them"}.</li>
          <li>Nobody can edit or remove {n === 1 ? "it" : "them"}, including you.</li>
          <li>Each is kept with the time it is kept now, not when you wrote it.</li>
        </ul>
        <div className="facts"><span>{n} {n === 1 ? "entry" : "entries"}</span><span>Costs {csd(cost)} CSD{inUsd(cost, price)}</span></div>
        {!key ? (
          <div className="cp-menu" style={{ position: "static", width: "auto", boxShadow: "none" }}><Connect onKey={setKey} /></div>
        ) : short_ ? (
          <div className="cp-notice" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <span>Your writing key holds {csd(balance!)} CSD and these take {csd(cost)}. They keep waiting while you add some.</span>
            <TopUpFor me={key} />
          </div>
        ) : null}
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button className="cp-btn" disabled={!key || busy || short_ || balance === null} onClick={async () => {
            setBusy(true); setErr(null);
            try {
              for (let i = 0; i < n; i++) await onKeepOne(list[i], s => setStep(n > 1 ? `${i + 1} of ${n}: ${s}` : s));
              onClose();
            } catch (x) { setErr(nice(x)); setBusy(false); setStep(null); }
          }}>{busy ? (step ?? "Keeping…") : n === 1 ? "Keep it forever" : `Keep all ${n} forever`}</button>
          <button className="cp-btn-ghost" disabled={busy} onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Not yet</button>
        </div>
      </section>
    </div>
  );
}

// ── what this is ────────────────────────────────────────────────────────────
const REPO = "https://github.com/intervalplace/commonplace";
function About() {
  useEffect(() => { window.scrollTo(0, 0); }, []);
  return (
    <main className="cp-main cp-about">
      <h1 className="cp-topic-title" style={{ fontSize: 44 }}>About</h1>
      <p className="lead">
        For centuries people kept commonplace books: notebooks of passages worth remembering, things they had worked
        out, lines they wanted to keep. This one is also a shared memory. What you keep is on your page, among everyone
        else&apos;s under the same topic, and zoomed out, all of it at once.
      </p>
      <section>
        <h2>How it is different</h2>
        <p>
          Most places you write online belong to someone. They decide what is shown and in what order, they can change
          the rules, and when they close, what you wrote goes with them. Here, entries come in the order they were
          written, or by how much people resonated with them, in the open. Nothing is ranked for you by anyone&apos;s
          algorithm, there are no ads and no tracking, and what you write isn&apos;t stored by this site at all, so it
          has nothing to take with it.
        </p>
      </section>
      <section>
        <h2>What you write is kept for good</h2>
        <p>
          Each entry is written to Compute Substrate, a proof-of-work network of many independent computers, with
          the time it was written. Nobody can edit it, remove it or backdate it. That includes you, the people who made
          this site, and anyone who asks them to. Write what you would be glad to have kept.
        </p>
      </section>
      <section>
        <h2>Nobody runs it</h2>
        <p>
          There is no account, no server and no company. This site is a single static page. It reads from a Compute
          Substrate node, and it writes with a key your browser makes from your passkey or from one signature by your
          wallet. The same passkey or wallet makes the same key on any device, so there is nothing to back up, and
          nothing leaves the page.
        </p>
      </section>
      <section>
        <h2>What it costs</h2>
        <p>
          Keeping an entry costs 0.25 CSD. Resonating with one, a public sign that it meant something to you, costs
          0.05 CSD. The fees go to the miners who keep the network running; nobody earns from what you write. Every epoch,
          about an hour, the network ranks each topic&apos;s entries by resonance. If you have no CSD, someone can give you
          some with an invite link, or the page can buy a little with USDC on the open CSD/USDC market, with no gas.
        </p>
      </section>
      <section>
        <h2>Longer writing</h2>
        <p>
          Documents, in Markdown or plain text up to 105 KiB, are stored on Arweave, which also keeps files for good.
          The entry holds the file&apos;s fingerprint, so every reader&apos;s page checks it is exactly the file that
          was published. Text only, by design.
        </p>
      </section>
      <section>
        <h2>What this site doesn&apos;t show</h2>
        <p>
          This site hides very few entries: only clearly illegal content, only when someone reports it, and never for
          words or opinions. Every hidden entry is listed publicly with its reason. Hidden entries stay on the network,
          and other apps can show them. <a href={HIDDEN_POLICY} target="_blank" rel="noopener">The rules and the list</a>.
        </p>
      </section>
      <section>
        <h2>One way in</h2>
        <p>
          Commonplace is a reference app: one way into a memory that doesn&apos;t depend on it. The format is open, so
          anyone can build another app that reads and writes the same entries. If this site goes away, everything
          written here stays. Nobody promises to run this one forever.
        </p>
        <p><a href={REPO} target="_blank" rel="noopener">The source, the format and every release</a></p>
      </section>
    </main>
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
  const price = usePrice();
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
          <li>Your picture and name are kept like an entry: public, and kept on the network for good.</li>
          <li>You can change them later. The newest one is the one people see, and the old ones stay on the record.</li>
          <li>Names aren&apos;t unique, so your address always shows beside yours.</li>
        </ul>
        <div className="facts"><span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}><Avatar addr={addr} pic={pic} size={28} />{cleanName(name) || "No name"}</span><span>Costs 0.25 CSD{inUsd(MIN_FEE_PROPOSE, price)}</span></div>
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
  // their newest entry stands in for a status: it was simply the last thing they kept
  const lately = kept.filter(e => !e.pending && e.hidden === undefined).reduce<Entry | null>((a, e) => (!a || e.height > a.height ? e : a), null);
  const gbTopic = guestbookTopic(c.addr);
  const guestbook = c.all.filter(e => e.topic === gbTopic && e.kind !== "profile");
  useEffect(() => { c.needAuthors(guestbook.filter(e => !e.pending).map(e => e.id)); }, [guestbook.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const liked = acts ? [...new Set(acts.filter(x => x.kind === "attestation" && x.proposal_id).map(x => String(x.proposal_id).toLowerCase()))].map(id => c.byId.get(id)).filter((e): e is Entry => !!e) : [];
  useEffect(() => { c.needAuthors(liked.map(e => e.id)); }, [liked.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState("");
  const left = room(text.trim());
  const [copied, setCopied] = useState(false);

  // how the page looks: the key's newest style entry, or while its owner edits, the draft
  useEffect(() => { c.loadTopic(STYLE_TOPIC); c.loadTopic(PROFILE_TOPIC); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [styling, setStyling] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const known = !!c.remembered?.has(c.addr);
  const [draft, setDraft] = useState<PageStyle | null>(null);
  const style = (styling && draft) || c.styles[c.addr];
  usePageStyle(style);
  const pinned = style?.pin ? c.byId.get(style.pin) : undefined;
  useEffect(() => {
    // a pinned entry from a topic that isn't loaded yet: find its topic and read it
    if (!style?.pin || pinned) return;
    c.api.proposal(style.pin).then(p => { if (p?.domain && !p.domain.startsWith("cp.")) c.loadTopic(p.domain); }).catch(() => {});
  }, [style?.pin, !!pinned]); // eslint-disable-line react-hooks/exhaustive-deps
  const showPin = pinned && pinned.hidden === undefined && pinned.kind !== "link";

  return (
    <main className="cp-main">
      <header style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
        <Avatar addr={c.addr} pic={prof?.pic} size={84} label={prof?.name ? `${prof.name}'s picture` : "Picture"} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, flex: "1 1 260px" }}>
          <h1 className="cp-topic-title" style={{ fontSize: 40 }}>{prof?.name || short(c.addr)}</h1>
          <span className="cp-who" style={{ color: "var(--muted)", overflowWrap: "anywhere" }}>{c.addr}</span>
          {lately && (
            <a className="cp-lately" href={hrefEntry(lately.id)}>
              <span className="label">Lately</span>
              {lately.kind === "doc" ? "Published " : lately.kind === "reply" ? "Replied: " : ""}{lately.text.length > 160 ? lately.text.slice(0, 160).trimEnd() + "…" : lately.text}
              <span className="when">{when(lately.time)}</span>
            </a>
          )}
          <div className="cp-meta">
            {acts && <span>{kept.length} kept</span>}
            {acts && <span>{liked.length} resonated with</span>}
            {guestbook.length > 0 && <span>{guestbook.length} in the guestbook</span>}
            <button className="cp-btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => { navigator.clipboard?.writeText(window.location.href); setCopied(true); }}>{copied ? "Link copied" : "Copy link to this page"}</button>
            {c.me && !isMe && c.remembered && (
              <button className="cp-btn-ghost" style={{ padding: "6px 10px", fontSize: 12 }} aria-pressed={known} onClick={() => setRemembering(true)}>{known ? "You remember them" : "Remember"}</button>
            )}
          </div>
        </div>
      </header>
      {style?.bio && <p className="cp-bio">{style.bio}</p>}
      {showPin && (
        <section className="cp-pin" aria-labelledby="pinned">
          <h2 id="pinned" className="cp-h2">Pinned</h2>
          <EntryItem e={pinned} showAuthor={pinned.author !== c.addr} resonance={c.resonance[pinned.id]} />
        </section>
      )}
      {isMe && (
        <p className="cp-notice cp-row" style={{ margin: 0 }}>
          <span>This is your page as everyone sees it. <a href="#/">Back to writing</a></span>
          <button className="cp-btn-ghost" onClick={() => { setDraft(c.styles[c.addr] ?? { bg: "paper", type: "serif", bio: "" }); setStyling(true); }}>Style your page</button>
        </p>
      )}
      {remembering && c.me && (
        <RememberDialog who={c.addr} name={prof?.name} known={known} balance={c.balance}
          onKeep={async () => { await c.rememberPerson(c.addr, !known); setRemembering(false); }} onClose={() => setRemembering(false)} />
      )}
      {styling && draft && c.me && (
        <StyleDialog me={c.me.addr20} balance={c.balance} draft={draft} setDraft={setDraft} current={c.styles[c.addr]} kept={kept.filter(e => !e.pending && e.hidden === undefined && e.kind !== "link")}
          onKeep={async st => { await c.keepStyle(st); setStyling(false); }} onClose={() => setStyling(false)} />
      )}
      {failed && <p className="cp-notice" style={{ margin: 0 }}>The node didn't answer for this page. It may be busy; it tries again in a minute.</p>}

      <section className="cp-list" aria-labelledby="kept">
        <h2 id="kept" className="cp-h2">Kept</h2>
        {kept.length === 0 ? <p className="cp-empty">{acts || failed ? "Nothing kept yet." : "Reading the network…"}</p> :
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
        {liked.length === 0 ? <p className="cp-empty">{acts || failed ? "Nothing yet." : "Reading the network…"}</p> :
          liked.map(e => <EntryItem key={e.id} e={e} showAuthor resonance={c.resonance[e.id]} />)}
      </section>
    </main>
  );
}

// ── remembering someone: kept encrypted, so only you can read who ──────────
function RememberDialog({ who, name, known, balance, onKeep, onClose }: {
  who: Hex; name?: string; known: boolean; balance: bigint | null; onKeep: () => Promise<void>; onClose: () => void;
}) {
  const price = usePrice();
  const me = useContext(KeyCtx);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEscape(onClose, busy);
  const low = balance !== null && balance < MIN_FEE_PROPOSE;
  const them = name || short(who);
  return (
    <div className="cp-backdrop" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="cp-dialog" role="dialog" aria-modal="true" aria-labelledby="rm-title">
        <h2 id="rm-title">{known ? `Forget ${them}?` : `Remember ${them}`}</h2>
        {known ? (
          <ul>
            <li>They leave your list of people you remember. They won&apos;t know, as they didn&apos;t know you remembered them.</li>
            <li>Forgetting is kept the same way, encrypted, so it looks no different from remembering to anyone but you.</li>
          </ul>
        ) : (
          <ul>
            <li>They go on your list of people you remember, and what they keep shows on your page for you.</li>
            <li>Only you can read it. It is kept encrypted with a key made from your wallet, the same way your writing key is.</li>
            <li>They aren&apos;t told, and nobody can see who you remember or how many. Anyone can see that you kept something encrypted, and when.</li>
            <li>It is kept on the network for good, so it comes back on any device where you connect this wallet, with or without this site.</li>
          </ul>
        )}
        <div className="facts"><span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}><Who addr={who} /></span><span>Costs 0.25 CSD{inUsd(MIN_FEE_PROPOSE, price)}</span></div>
        {low && me && <div className="cp-notice" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <span>Your writing key needs a little CSD first: it holds {csd(balance!)} and this takes 0.25.</span>
          <TopUpHereFor addr={me.addr20} />
        </div>}
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button className="cp-btn" disabled={busy || low || balance === null} onClick={async () => { setBusy(true); setErr(null); try { await onKeep(); } catch (x) { setErr(nice(x)); setBusy(false); } }}>{busy ? "Keeping…" : known ? "Forget them" : "Remember them"}</button>
          <button className="cp-btn-ghost" disabled={busy} onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Not now</button>
        </div>
      </section>
    </div>
  );
}

// A page's look is a few names from a fixed list, applied as classes on the body for as long as
// the page is open (globals.css has each one). Names this version doesn't know show as the default.
function usePageStyle(st?: PageStyle) {
  const bg = st && (BACKGROUNDS as readonly string[]).includes(st.bg) ? st.bg : "paper";
  const type = st && (TYPEFACES as readonly string[]).includes(st.type) ? st.type : "serif";
  useEffect(() => {
    const cls = [`st-${bg}`, `ty-${type}`];
    document.body.classList.add(...cls);
    return () => document.body.classList.remove(...cls);
  }, [bg, type]);
}

const BG_NAMES: Record<string, string> = { paper: "Paper", night: "Night sky", grid: "Graph paper", notebook: "Notebook", kraft: "Kraft", print: "Faded print", moss: "Moss", tiles: "Tiles" };
const TYPE_NAMES: Record<string, string> = { serif: "Serif", mono: "Typewriter", sans: "Plain" };

// ── styling your page: shown beside the page, which changes as you choose ───
function StyleDialog({ me, balance, draft, setDraft, current, kept, onKeep, onClose }: {
  me: Hex; balance: bigint | null; draft: PageStyle; setDraft: (s: PageStyle) => void; current?: PageStyle; kept: Entry[];
  onKeep: (s: PageStyle) => Promise<void>; onClose: () => void;
}) {
  const price = usePrice();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEscape(onClose, busy);
  const set = (p: Partial<PageStyle>) => setDraft({ ...draft, ...p });
  const left = styleRoom({ ...draft, bio: draft.bio.trim() });
  const low = balance !== null && balance < MIN_FEE_PROPOSE;
  const clean = { ...draft, bio: draft.bio.trim() };
  const same = current ? current.bg === clean.bg && current.type === clean.type && (current.pin ?? "") === (clean.pin ?? "") && current.bio === clean.bio
    : clean.bg === "paper" && clean.type === "serif" && !clean.pin && !clean.bio;
  return (
    <div className="cp-backdrop cp-side">
      <section className="cp-dialog" role="dialog" aria-modal="false" aria-labelledby="st-title">
        <h2 id="st-title">Your page</h2>
        <fieldset className="cp-fs">
          <legend className="cp-h2">Background</legend>
          <div className="cp-swatches">
            {BACKGROUNDS.map(b => (
              <label key={b} className="cp-swatch" data-on={draft.bg === b || undefined}>
                <input type="radio" name="bg" value={b} checked={draft.bg === b} onChange={() => set({ bg: b })} />
                <span className={`sw sw-${b}`} aria-hidden="true" />
                <span>{BG_NAMES[b]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="cp-fs">
          <legend className="cp-h2">Typeface</legend>
          <div className="cp-modes">
            {TYPEFACES.map(t => <button key={t} type="button" aria-pressed={draft.type === t} className={`tf-${t}`} onClick={() => set({ type: t })}>{TYPE_NAMES[t]}</button>)}
          </div>
        </fieldset>
        <label className="cp-field">
          <span className="cp-h2">Pinned at the top</span>
          <select value={draft.pin ?? ""} onChange={e => set({ pin: (e.target.value || undefined) as Hex | undefined })}>
            <option value="">Nothing pinned</option>
            {draft.pin && !kept.some(e => e.id === draft.pin) && <option value={draft.pin}>The entry pinned now</option>}
            {kept.map(e => <option key={e.id} value={e.id}>{(e.kind === "doc" ? "Document: " : "") + (e.text.length > 70 ? e.text.slice(0, 70).trimEnd() + "…" : e.text)}</option>)}
          </select>
        </label>
        <label className="cp-field">
          <span className="cp-h2">A few lines about you</span>
          <textarea value={draft.bio} rows={4} onChange={e => set({ bio: e.target.value })} placeholder="Who you are, what you write about. Or leave it empty." />
          {draft.bio && <Left left={left} />}
        </label>
        <ul>
          <li>Your page&apos;s look is kept like an entry: public, and on the network for good. The newest one is the one people see.</li>
        </ul>
        <div className="facts"><span>Costs 0.25 CSD{inUsd(MIN_FEE_PROPOSE, price)}</span></div>
        {low && <div className="cp-notice" style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <span>Your writing key needs a little CSD first: it holds {csd(balance!)} and this takes 0.25.</span>
          <TopUpHereFor addr={me} />
        </div>}
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button className="cp-btn" disabled={busy || low || balance === null || same || left < 0} onClick={async () => { setBusy(true); setErr(null); try { await onKeep(clean); } catch (x) { setErr(nice(x)); setBusy(false); } }}>{busy ? "Keeping…" : "Keep it"}</button>
          <button className="cp-btn-ghost" disabled={busy} onClick={onClose} style={{ fontSize: 16, padding: "13px 20px" }}>Not now</button>
        </div>
      </section>
    </div>
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
  return k && k.addr20 === addr ? <TopUpFor me={k} /> : null;
}
const KeyCtx = createContext<Me | null>(null);

// ── documents ───────────────────────────────────────────────────────────────
type Doc = { bytes: Uint8Array; type: string; name: string };
const kb = (n: number) => n < 1024 ? `${n} bytes` : `${(n / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`;

// How much more fits. The chain counts bytes: plain letters are one each, letters like æ, ø and
// å are two, and an emoji is four, so the number can drop by more than one per character
const MAX_ENTRY_BYTES = 509; // a uri holds 512 bytes, less the "cp:" prefix
function Left({ left, what = "" }: { left: number; what?: string }) {
  const tip = "Counted in bytes: most letters are one, letters like æ, ø and å are two, an emoji is four.";
  return <span className={`cp-hint${left < 0 ? " over" : ""}`} title={tip}>{left < 0 ? `${-left} too long` : `${left} left${what ? " " + what : ""}`}</span>;
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
  const autoTitle = useRef("");
  const pick = async (f: File | undefined) => {
    setErr(null); setDoc(null);
    if (!f) return;
    const type = contentTypeOf(f.name);
    if (!type) return setErr("For now, documents are Markdown (.md) or plain text (.txt) files.");
    if (f.size > FREE_BYTES) return setErr(`This file is ${kb(f.size)}. For now, documents can be up to ${kb(FREE_BYTES)}, which Arweave stores for free.`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const h = /^#\s+(.+)$/m.exec(text);
    const guess = (h ? h[1].trim() : f.name.replace(/\.[^.]+$/, "")).slice(0, 200);
    const prev = autoTitle.current;
    autoTitle.current = guess;
    setTitle(t => (!t || t === prev ? guess : t));
    setDoc({ bytes, type, name: f.name });
  };
  const left = docRoom(title.trim());
  const docFits = !!doc && room(new TextDecoder().decode(doc.bytes).trim()) >= 0;
  return (
    <div className="cp-file">
      <label className="cp-hint" style={{ fontSize: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        A thesis, an essay, notes: any Markdown or text file up to {kb(FREE_BYTES)}.
        <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" onChange={e => pick(e.target.files?.[0])} />
      </label>
      {doc && <span className="cp-hint">{doc.name}, {kb(doc.bytes.length)}. {docFits ? "This would fit in an ordinary entry, which keeps the words themselves on Compute Substrate. Documents are for writing longer than an entry holds." : `That's ${doc.bytes.length >= 2 * MAX_ENTRY_BYTES ? `about ${Math.round(doc.bytes.length / MAX_ENTRY_BYTES)} entries' worth` : "more than an entry holds"}. The file itself goes to Arweave, and only its title and fingerprint go on Compute Substrate.`}</span>}
      {err && <span className="cp-hint over">{err}</span>}
      <label className="cp-topic" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>Title
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="What it is called" style={{ width: "100%", borderRadius: 8, fontSize: 16, padding: "10px 12px" }} />
      </label>
      <div className="cp-row" style={{ justifyContent: "flex-end" }}>
        {title && <Left left={left} what="for the title" />}
        <button className="cp-btn" disabled={!doc || !title.trim() || left < 0 || !topicOk(topic)} onClick={() => doc && c.startKeep(title.trim(), topic, undefined, () => { setDoc(null); setTitle(""); }, doc)}>Publish it</button>
      </div>
    </div>
  );
}
