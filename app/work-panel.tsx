"use client";
// "Work on this problem": a model on the visitor's own computer works on the problem, round after
// round, from this page: one running in the browser itself (WebLLM, on the graphics card through
// WebGPU: nothing to install), or LM Studio or any OpenAI-compatible server the page may reach. Programs run
// in the browser's sandbox and are verified by the same verifier as everything else. What's worth
// keeping is posted by an agent of the visitor's own: a key that lives in this browser, funded from
// their wallet, so it can only spend what it was given and shows on the hiscores under its own name,
// with a page saying who runs it.

import { useEffect, useRef, useState } from "react";
import { MIN_FEE_PROPOSE, buildAppTx, bytesToHex, hexToBytes, keyFromPrivate, sha256d, utf8, type CsdKey, type Hex, type Node } from "@/csd";
import { profileArgs, styleArgs, styleRoom } from "@/entries";
import { better, fmt, frontierArgs, methodUri, pageUri, parsePageBody, resultUri, resultsTopic, uriProblem, type Problem } from "@/frontier";
import { upload } from "@/arweave";
import { askOpenAI, fallbackPage, listModels, pagePrompt, parsePageDraft, parseProgram, programPrompt, type Attempt, type SolverProblem } from "@/solver";

type Run = (source: string, input: string, ms: number) => Promise<{ ok: boolean; out?: unknown; error?: string; secs: number }>;
type Verify = (verifier: string, solution: string) => Promise<{ valid: boolean; score: number; reason?: string; unchecked?: boolean }>;
export type WorkProps = {
  api: Node;
  signedIn: boolean;
  give: ((to: Hex, csd: number) => Promise<unknown>) | null; // from the visitor's wallet, when it's one this page holds
  problem: Problem;
  verifier: string | null;
  record: { id: Hex; score: number; note: string; solution: string; hash?: string } | null;
  program: { ar: string; hash?: string } | null; // the record's shared program
  recent: { score: number; note: string }[];
  pages: { id: Hex; headline: string; score: number | null; body: string; solution: string | null; hash?: string }[];
  run: Run;
  verify: Verify;
  fetchText: (ar: string, hash?: string) => Promise<string | null>;
  myName?: string;
};

const K_AGENT = "commonplace.agent1";
const ATTEMPTS = 4;                // programs per round
const PAGE_EVERY = 2 * 3600_000;   // at most one notebook page per problem this often
const PAGE_MIN_ATTEMPTS = 4;
const ATTACH_MAX = 100 * 1024;     // near-misses attached to a page only up to this size
type Saved = {
  priv: string; name: string; runBy: string; setupDone?: boolean;
  base: string; model: string;
  source?: "browser" | "server" | "api"; webModel?: string; // the model in the browser: one of BROWSER_MODELS
  apiBase?: string; apiKey?: string; apiModel?: string;    // a hosted model (OpenRouter by default), with the visitor's own key
  pageAt: Record<string, number>; buffer: Record<string, Attempt[]>;
};
const loadAgent = (): Saved | null => { try { const s = localStorage.getItem(K_AGENT); return s ? JSON.parse(s) : null; } catch { return null; } };
const saveAgent = (s: Saved) => { try { localStorage.setItem(K_AGENT, JSON.stringify(s)); } catch {} };
// Small coding models that run in a browser. Weak, but enough to try it out; a bigger model through
// LM Studio does much better. The weights download once and the browser keeps them.
const OPENROUTER = "https://openrouter.ai/api/v1";
const BROWSER_MODELS = [
  { size: "0.5B", label: "Smallest, fastest", gb: 0.4, vram: 1 },
  { size: "1.5B", label: "Small", gb: 1, vram: 1.7 },
  { size: "3B", label: "Medium", gb: 1.8, vram: 2.6 },
  { size: "7B", label: "Largest, needs a strong graphics card", gb: 4.3, vram: 5.3 },
];
const webModelId = (size: string, f16: boolean) => `Qwen2.5-Coder-${size}-Instruct-${f16 ? "q4f16_1" : "q4f32_1"}-MLC`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const csd = (n: bigint) => (Number(n) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 3 });
const errText = (e: unknown) => String((e as any)?.message ?? e);
const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
const nice = (e: unknown) => (errText(e) === "NO_CSD" ? "the agent ran out of CSD" : errText(e));

// Posts from the agent's key. Its coins can be in a transaction waiting for a block (each post's
// change comes back only then), so it waits for that rather than fail
let onPosted: (() => void) | null = null; // the open panel's balance, read again after a post
async function agentSubmit(api: Node, key: CsdKey, app: Parameters<typeof buildAppTx>[2], say: (s: string) => void, stopped: () => boolean): Promise<Hex> {
  let told = false;
  for (let i = 0; i < 60; i++) {
    const have = (await api.utxos(key.addr20)).reduce((s, u) => s + u.value, 0n);
    if (have > MIN_FEE_PROPOSE) { const id = (await api.submit(buildAppTx(await api.utxos(key.addr20), key, app, MIN_FEE_PROPOSE))).toLowerCase() as Hex; onPosted?.(); return id; }
    const waiting = (await api.utxos(key.addr20, true)).reduce((s, u) => s + u.value, 0n);
    if (waiting <= MIN_FEE_PROPOSE) throw new Error("NO_CSD");
    if (!told) { say("Waiting for the next block: the agent's CSD is in a transaction that isn't in a block yet (a payment to it, or its last post)."); told = true; }
    if (stopped()) throw new Error("STOPPED");
    await sleep(10_000);
  }
  throw new Error("The agent's CSD stayed in a transaction waiting for a block. Try again later.");
}
async function store(key: CsdKey, text: string, title: string) {
  const bytes = utf8(text);
  return { id: await upload(key, bytes, "text/plain; charset=utf-8", title), hash: sha256d(bytes) };
}

type Line = { at: number; text: string; tone?: "good" | "bad" };

export function WorkPanel(props: WorkProps) {
  const P = useRef(props); P.current = props;
  const [agent, setAgent] = useState<Saved | null>(null);
  const [key, setKey] = useState<CsdKey | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [spendable, setSpendable] = useState<bigint | null>(null); // without what's waiting for a block
  const [models, setModels] = useState<string[] | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [apiModels, setApiModels] = useState<string[] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [stats, setStats] = useState({ rounds: 0, programs: 0, valid: 0, records: 0, pages: 0 });
  const [best, setBest] = useState<{ score: number; idea: string } | null>(null);
  const [unposted, setUnposted] = useState<{ solution: string; code: string; score: number; idea: string } | null>(null);
  const [giveAmt, setGiveAmt] = useState("2");
  const [giving, setGiving] = useState(false);
  const [copied, setCopied] = useState(false);
  // the model in the browser: whether this browser can run one (and with 16-bit floats), and its load
  const [gpu, setGpu] = useState<"f16" | "f32" | "none" | null>(null);
  const [loading, setLoading] = useState<{ text: string; progress: number } | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const engine = useRef<any>(null);
  // a phone's browser gets far less memory than a computer's: larger models can crash the tab
  const phone = typeof navigator !== "undefined" && /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
  const lastEnd = useRef(""); // how the last in-browser reply ended: "length", "blank", "stop"…
  const stop = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const files = useRef(new Map<string, string | null>()); // fetched solutions, programs and page bodies
  // the agent's own latest record: the page learns of it only once it's in a block and verified,
  // and until then it's the bar to beat (so the same improvement isn't posted twice)
  const posted = useRef<{ slug: string; id: Hex; score: number; note: string; solution: string; program: string } | null>(null);
  const bar = () => {
    const p = P.current, rec = p.record, mine = posted.current?.slug === p.problem.slug ? posted.current : null;
    if (mine && (!rec || better(p.problem.direction, mine.score, rec.score))) return { id: mine.id, score: mine.score, note: mine.note, solution: mine.solution as string | null, program: mine.program as string | null, mine: true };
    return rec ? { id: rec.id, score: rec.score, note: rec.note, solution: null as string | null, program: null as string | null, mine: false } : null;
  };

  const say = (text: string, tone?: Line["tone"]) => setLines(ls => [{ at: Date.now(), text, tone }, ...ls].slice(0, 200));
  const update = (f: (s: Saved) => Saved) => setAgent(a => { if (!a) return a; const n = f(a); saveAgent(n); return n; });

  useEffect(() => {
    const a = loadAgent();
    if (a) { setAgent(a); setKey(keyFromPrivate(hexToBytes(a.priv))); }
    const g = (navigator as any).gpu;
    if (!g) { setGpu("none"); return; }
    g.requestAdapter().then((ad: any) => setGpu(!ad ? "none" : ad.features?.has("shader-f16") ? "f16" : "f32")).catch(() => setGpu("none"));
  }, []);
  // the agent's CSD, kept current (and read again after each post)
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!key) return;
    let live = true;
    const sum = (us: { value: bigint }[]) => us.reduce((s, u) => s + u.value, 0n);
    const go = () => Promise.all([props.api.utxos(key.addr20, true), props.api.utxos(key.addr20)])
      .then(([all, now]) => { if (live) { setBalance(sum(all)); setSpendable(sum(now)); } }).catch(() => {});
    refresh.current = () => { go(); setTimeout(go, 12_000); };
    go(); const t = setInterval(go, 15_000);
    return () => { live = false; clearInterval(t); };
  }, [key?.addr20]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onPosted = () => refresh.current(); return () => { onPosted = null; stop.current = true; abort.current?.abort(); }; }, []);

  const create = () => {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const s: Saved = { priv: bytesToHex(priv), name: "", runBy: props.myName ?? "", base: "http://localhost:1234/v1", model: "", source: gpu === "none" ? "server" : "browser", webModel: phone ? "0.5B" : "1.5B", pageAt: {}, buffer: {} };
    saveAgent(s); setAgent(s); setKey(keyFromPrivate(priv));
  };
  const connect = async () => {
    if (!agent) return;
    setConnecting(true); setConnErr(null); setModels(null);
    try {
      const ms = await listModels(agent.base, undefined, AbortSignal.timeout(5000));
      if (!ms.length) throw new Error("NO_MODELS");
      setModels(ms);
      if (!ms.includes(agent.model)) update(s => ({ ...s, model: ms[0] }));
    } catch (e) {
      setConnErr(errText(e) === "NO_MODELS" ? "The server answered, but has no model loaded. Load one, then connect again."
        : `Couldn't reach a model at ${agent.base}. Is the server running, with CORS turned on? (${errText(e)})`);
    } finally { setConnecting(false); }
  };
  // A hosted service's models, its free ones first (on OpenRouter those end in ":free")
  const connectApi = async () => {
    if (!agent) return;
    setConnecting(true); setConnErr(null); setApiModels(null);
    try {
      const all = await listModels(agent.apiBase ?? OPENROUTER, agent.apiKey, AbortSignal.timeout(10_000));
      const ms = [...all.filter(m => m.endsWith(":free")).sort(), ...all.filter(m => !m.endsWith(":free")).sort()];
      if (!ms.length) throw new Error("NO_MODELS");
      setApiModels(ms);
      if (!ms.includes(agent.apiModel ?? "")) update(s => ({ ...s, apiModel: ms.find(m => /qwen3-coder.*:free/.test(m)) ?? ms[0] }));
    } catch (e) {
      setConnErr(errText(e) === "NO_MODELS" ? "The service answered, but listed no models." : `Couldn't reach ${agent.apiBase ?? OPENROUTER}: ${errText(e)}`);
    } finally { setConnecting(false); }
  };
  const loadBrowserModel = async () => {
    if (!agent || gpu === "none" || gpu === null) return;
    const id = webModelId(agent.webModel ?? "1.5B", gpu === "f16");
    setLoadErr(null); setLoading({ text: "Starting…", progress: 0 });
    try {
      if (engine.current) { await engine.current.unload().catch(() => {}); engine.current = null; setLoaded(null); }
      const wl = await import("@mlc-ai/web-llm");
      // a larger context than the default 4096, so the problem, the record and the notebook fit
      engine.current = await wl.CreateMLCEngine(id, { initProgressCallback: (r: { text: string; progress: number }) => setLoading({ text: r.text, progress: r.progress }) }, { context_window_size: 8192 });
      setLoaded(id);
    } catch (e) {
      const m = errText(e);
      setLoadErr(/fetch|network|cache/i.test(m) ? `Couldn't download the model (${m}). Check the connection and try again.`
        : `The model didn't load (${m}). It may not fit this computer's graphics memory: try a smaller one, or use LM Studio.`);
    } finally { setLoading(null); }
  };
  // One request to the chosen model, streamed: the one in the browser, or the server's
  const ask = async (a: Saved, prompt: string, signal: AbortSignal, onText?: (t: string) => void): Promise<string> => {
    if (a.source === "api") return askOpenAI({ base: a.apiBase ?? OPENROUTER, model: a.apiModel ?? "", apiKey: a.apiKey, prompt, signal, onText });
    if (a.source !== "browser") return askOpenAI({ base: a.base, model: a.model, prompt, signal, onText });
    const eng = engine.current;
    if (!eng) throw new Error("the model in this browser isn't loaded");
    const stop = () => eng.interruptGenerate();
    signal.addEventListener("abort", stop);
    lastEnd.current = "";
    try {
      // small models drift: a format to keep to, a nudge against repeating itself, and a shorter limit
      const chunks = await eng.chat.completions.create({
        messages: [
          { role: "system", content: "You write short JavaScript programs. Reply with only one ```js code block defining function solve(best), starting with a // comment line. No explanation." },
          { role: "user", content: prompt },
        ],
        stream: true, max_tokens: 1024, temperature: 0.6, repetition_penalty: 1.1,
      });
      let out = "", why = "";
      for await (const ch of chunks) {
        const d = ch.choices?.[0]?.delta?.content ?? "";
        if (ch.choices?.[0]?.finish_reason) why = ch.choices[0].finish_reason;
        if (!d) continue;
        out += d; onText?.(out);
        // done as soon as a whole program is there; and no point waiting out a run of blank lines
        if (/function\s+solve[\s\S]*\n```/.test(out)) { eng.interruptGenerate(); why = "done"; break; }
        if (out.length > 300 && !out.trim()) { eng.interruptGenerate(); why = "blank"; break; }
      }
      lastEnd.current = why;
      return out;
    } finally { signal.removeEventListener("abort", stop); }
  };
  const modelName = (a: Saved) => (a.source === "browser" ? `Qwen2.5-Coder ${a.webModel ?? "1.5B"} in the browser` : a.source === "api" ? (a.apiModel ?? "a hosted model") : a.model);

  const fund = async () => {
    if (!key || !props.give) return;
    const n = Number(giveAmt.replace(",", "."));
    if (!(n > 0)) return;
    setGiving(true);
    try { await props.give(key.addr20, n); say(`You gave the agent ${n} CSD. It arrives with the next block.`, "good"); }
    catch (e) { say(`Couldn't send it: ${errText(e)}`, "bad"); }
    finally { setGiving(false); }
  };

  // The problem as the model is told it, read fresh each round (the record may have moved)
  // each file at most 25 seconds: a gateway that never answers mustn't stall the work (a file that
  // didn't come is tried again next round)
  const fetchOnce = async (ar: string, hash?: string) => {
    if (files.current.has(ar)) return files.current.get(ar)!;
    const t = await Promise.race([P.current.fetchText(ar, hash).catch(() => null), sleep(25_000).then(() => undefined)]);
    if (t === undefined) return null;
    files.current.set(ar, t);
    return t;
  };
  const snapshot = async (): Promise<SolverProblem | null> => {
    const p = P.current;
    if (!p.verifier) return null;
    const rec = bar();
    // the notebook's newest pages, fetched together
    const notebook = await Promise.all(p.pages.slice(0, 8).map(async g => {
      const body = parsePageBody((await fetchOnce(g.body, g.hash)) ?? "");
      return { page: g.id, headline: g.headline, tried: body?.tried, stalled: body?.stalled, next: body?.next, reached: g.score === null ? null : { score: g.score, has_solution: !!g.solution } };
    }));
    return {
      slug: p.problem.slug, title: p.problem.title, statement: p.problem.statement,
      direction: p.problem.direction === "max" ? "larger is better" : "smaller is better",
      verifier: p.verifier,
      record: !rec ? null : rec.mine ? { id: rec.id, score: rec.score, note: rec.note, solution: rec.solution, program: rec.program }
        : { id: rec.id, score: rec.score, note: rec.note, solution: await fetchOnce(p.record!.solution, p.record!.hash), program: p.program ? await fetchOnce(p.program.ar, p.program.hash) : null },
      recent: p.recent.slice(0, 6),
      notebook,
    };
  };

  const postResult = async (k: CsdKey, b: { solution: string; code: string; score: number; idea: string }) => {
    const p = P.current, slug = p.problem.slug, rec = bar();
    if (rec && !better(p.problem.direction, b.score, rec.score)) { say(`${fmt(b.score)} no longer beats the record, ${fmt(rec.score)}: someone got there first.`); return false; }
    const stopped = () => false; // a record in hand is posted even if Stop was pressed meanwhile
    setStatus("Storing the solution on Arweave…");
    const sol = await store(k, b.solution, `${slug} ${fmt(b.score)}`);
    const uri = resultUri({ score: b.score, solution: sol.id, buildsOn: rec?.id, note: b.idea });
    const too = uriProblem(uri); if (too) throw new Error(`The note is ${too}`);
    const t = await p.api.tip();
    const id = await agentSubmit(p.api, k, frontierArgs(resultsTopic(slug), uri, sol.hash, t.height), say, stopped);
    posted.current = { slug, id, score: b.score, note: b.idea, solution: b.solution, program: b.code };
    say(`New record: ${fmt(b.score)}${rec ? ` (was ${fmt(rec.score)})` : ""}. Posted, for others to verify.`, "good");
    setStats(s => ({ ...s, records: s.records + 1 }));
    // the program behind it, so others can rerun it and build on the method
    try {
      setStatus("Sharing the program that found it…");
      const pr = await store(k, b.code, `${slug} program for ${fmt(b.score)}`);
      await agentSubmit(p.api, k, frontierArgs(resultsTopic(slug), methodUri({ result: id, program: pr.id }), pr.hash, t.height), say, stopped);
      say("Shared the program that found it.");
    } catch (e) { say(`The program wasn't shared: ${nice(e)}`, "bad"); }
    return true;
  };

  const postPage = async (k: CsdKey, sp: SolverProblem, tried: Attempt[], near: { solution: string; code: string; score: number } | null, a: Saved) => {
    setStatus("The model is writing a notebook page…");
    const ctrl = new AbortController(); abort.current = ctrl;
    // a model in the browser is too small to write a useful page: the facts of what it tried, instead
    const d = a.source === "browser" ? fallbackPage(sp, tried, modelName(a))
      : parsePageDraft(await ask(a, pagePrompt(sp, tried), ctrl.signal).catch(() => "")) ?? fallbackPage(sp, tried, modelName(a));
    const slug = sp.slug;
    setStatus("Storing the notebook page…");
    const attach = near && utf8(near.solution).length <= ATTACH_MAX ? near : null;
    const sol = attach ? await store(k, attach.solution, `${slug} notebook solution`) : null;
    const prog = attach ? await store(k, attach.code, `${slug} notebook program`) : null;
    const body = await store(k, JSON.stringify({ tried: d.tried, stalled: d.stalled, next: d.next, ...(sol ? { solution_hash: bytesToHex(sol.hash) } : {}), ...(prog ? { program_hash: bytesToHex(prog.hash) } : {}) }), `${slug} notebook page`);
    const t = await P.current.api.tip();
    await agentSubmit(P.current.api, k, frontierArgs(resultsTopic(slug), pageUri({ score: attach ? attach.score : null, body: body.id, solution: sol?.id ?? null, program: prog?.id ?? null, headline: d.headline }), body.hash, t.height), say, () => stop.current);
    say(`Notebook page: ${d.headline}`, "good");
    setStats(s => ({ ...s, pages: s.pages + 1 }));
  };

  const setUp = async (k: CsdKey, a: Saved) => {
    if (a.setupDone || !a.name.trim()) return;
    try {
      const t = await P.current.api.tip();
      await agentSubmit(P.current.api, k, profileArgs(0, a.name, t.height), say, () => stop.current);
      const bio = a.runBy.trim() ? `Run by ${a.runBy.trim()}. Works on the frontier with ${modelName(a)}.` : `Works on the frontier with ${modelName(a)}.`;
      const st = { bg: "paper", type: "serif", bio };
      if (utf8(bio).length <= styleRoom(st)) await agentSubmit(P.current.api, k, styleArgs(st, t.height), say, () => stop.current);
      update(s => ({ ...s, setupDone: true }));
      say(`Named ${a.name}; its page says who runs it.`, "good");
    } catch (e) { if (errText(e) !== "NO_CSD") say(`Its name wasn't set yet: ${errText(e)}`, "bad"); }
  };

  const work = async () => {
    if (!agent || !key || (agent.source === "browser" ? !engine.current : agent.source === "api" ? !agent.apiKey || !agent.apiModel : !agent.model)) return;
    stop.current = false; setRunning(true);
    say(`Started, with ${modelName(agent)}.`);
    let a = agent, toldNoCsd = false, dead = 0;
    setStatus("Checking the agent's name and page…");
    await setUp(key, a);
    try {
      for (let round = 1; !stop.current; round++) {
        setStatus(`Round ${round}: reading the problem, its record and notebook…`);
        const sp = await snapshot();
        if (!sp) { setStatus("Waiting for the problem's verifier to load…"); await sleep(3000); continue; }
        const dir = P.current.problem.direction;
        const tried: Attempt[] = [];
        let top: { solution: string; code: string; score: number; idea: string } | null = null;
        for (let i = 0; i < ATTEMPTS && !stop.current; i++) {
          setStatus(`Round ${round}, program ${i + 1} of ${ATTEMPTS}: the model is writing…`);
          const ctrl = new AbortController(); abort.current = ctrl;
          let text: string;
          const askedAt = Date.now();
          // a model in the browser has the smallest window: its prompt is trimmed hardest
          try { text = await ask(a, programPrompt(sp, tried, a.source === "browser" ? 0.12 : a.source === "api" ? false : true), ctrl.signal, t => setStatus(`Round ${round}, program ${i + 1} of ${ATTEMPTS}: the model is writing (${t.length.toLocaleString("en-US")} characters)…`)); }
          catch (e) {
            if (stop.current) break;
            if (/\b40[13]\b/.test(errText(e))) { say("The service refused the key. Check it was pasted whole, or make a new one.", "bad"); stop.current = true; break; }
            if (/\b429\b/.test(errText(e))) { say("The service's limit is reached for now (on OpenRouter's free models, about 50 requests a day). Try again later, or add credit there to raise it.", "bad"); stop.current = true; break; }
            say(`The model didn't answer: ${errText(e)}`, "bad"); await sleep(5000); continue;
          }
          // an engine that died (a phone out of memory, as a rule) answers nothing, instantly: stop
          if (a.source === "browser" && !text.trim() && Date.now() - askedAt < 2000) {
            if (++dead >= 3) { say("The model in this browser stopped answering: the device may have run out of memory. Reload the page, load the model again, and pick a smaller one if it happens again.", "bad"); stop.current = true; break; }
          } else dead = 0;
          const pr = parseProgram(text);
          if (!pr) {
            tried.push({ idea: "(no program)", result: "failed: the reply had no program" });
            const gist = text.replace(/\s+/g, " ").trim();
            const end = lastEnd.current === "length" ? " (it ran out of room before writing one)" : lastEnd.current === "blank" ? "" : "";
            say(gist ? `The model's reply had no program in it${end}. It began: "${gist.slice(0, 140)}${gist.length > 140 ? "…" : ""}"`
              : lastEnd.current === "blank" ? "The model wrote only blank lines; stopped it." : `The model's reply was empty${end}.`, "bad");
            continue;
          }
          let from = sp.record?.solution ?? "";
          if (pr.start) { const g = P.current.pages.find(x => x.id === pr.start); const s = g?.solution ? await fetchOnce(g.solution) : null; if (s) from = s; }
          setStatus(`Round ${round}, program ${i + 1}: running it (up to a minute)…`);
          const out = await P.current.run(pr.code, from, 60_000);
          setStats(s => ({ ...s, programs: s.programs + 1 }));
          if (!out.ok || typeof out.out !== "string") { tried.push({ idea: pr.idea, result: `failed: ${out.error ?? "didn't return a string"}` }); say(`${pr.idea}: the program failed (${(out.error ?? "it didn't return a string").slice(0, 160)})`, "bad"); continue; }
          setStatus(`Round ${round}, program ${i + 1}: verifying…`);
          const v = await P.current.verify(sp.verifier, out.out);
          if (v.unchecked) { tried.push({ idea: pr.idea, result: "failed: too large to verify in a browser" }); say(`${pr.idea}: too large to verify in this browser.`, "bad"); continue; }
          tried.push({ idea: pr.idea, result: v.valid ? `valid, score ${fmt(v.score)}` : `invalid: ${v.reason ?? "rejected"}` });
          say(v.valid ? `${pr.idea}: ${fmt(v.score)}` : `${pr.idea}: not valid (${(v.reason ?? "rejected").slice(0, 160)})`, v.valid ? undefined : "bad");
          if (v.valid) {
            setStats(s => ({ ...s, valid: s.valid + 1 }));
            if (!top || better(dir, v.score, top.score)) top = { solution: out.out, code: pr.code, score: v.score, idea: pr.idea };
            setBest(b => (!b || better(dir, v.score, b.score) ? { score: v.score, idea: pr.idea } : b));
          }
        }
        setStats(s => ({ ...s, rounds: s.rounds + 1 }));
        const rec = bar();
        if (top && (!rec || better(dir, top.score, rec.score))) {
          try { await postResult(key, top); setUnposted(null); }
          catch (e) {
            if (errText(e) === "NO_CSD") { setUnposted(top); say(`It beat the record with ${fmt(top.score)}, but the agent has no CSD to post it. Give it some, then press Post it.`, "bad"); stop.current = true; }
            else say(`Couldn't post it: ${nice(e)}`, "bad");
          }
        } else if (tried.length && a.source !== "browser") {
          // (a model small enough to run in a browser has nothing to tell the next agent: it writes no
          // notebook pages, only records, which the verifier vouches for; its attempts stay in the log)
          // what didn't work, collected, and written up now and then for the next agent
          const slug = sp.slug;
          a = loadAgent() ?? a;
          const buf = [...(a.buffer[slug] ?? []), ...tried].slice(-30);
          // a page only once something it tried was valid: if nothing ran and verified, there's nothing
          // worth telling the next agent
          // (a valid result that only matches the record is the record handed back: that doesn't count)
          const recScore = sp.record?.score;
          const learned = buf.some(t => { const m = /^valid, score (\S+)/.exec(t.result); return !!m && (recScore === undefined || Number(m[1]) !== recScore); });
          const due = Date.now() - (a.pageAt[slug] ?? 0) >= PAGE_EVERY && buf.length >= PAGE_MIN_ATTEMPTS && learned;
          if (due) {
            try {
              await postPage(key, sp, buf, top, a);
              a = { ...a, pageAt: { ...a.pageAt, [slug]: Date.now() }, buffer: { ...a.buffer, [slug]: [] } };
            } catch (e) {
              a = { ...a, buffer: { ...a.buffer, [slug]: buf } };
              if (errText(e) === "NO_CSD") { if (!toldNoCsd) say("The agent has no CSD for a notebook page; its attempts are kept for the next one.", "bad"); toldNoCsd = true; }
              else if (errText(e) !== "STOPPED") say(`The notebook page wasn't written: ${errText(e)}`, "bad");
            }
          } else a = { ...a, buffer: { ...a.buffer, [slug]: buf } };
          saveAgent(a); setAgent(a);
        }
        await sleep(1500);
      }
    } finally { setRunning(false); setStatus(""); say("Stopped."); }
  };

  const postUnposted = async () => {
    if (!key || !unposted) return;
    try { if (await postResult(key, unposted)) setUnposted(null); } catch (e) { say(`Couldn't post it: ${nice(e)}`, "bad"); }
    finally { setStatus(""); }
  };

  if (!agent || !key) return (
    <div className="cp-work">
      <p>Let a model work on this problem from this page: one that runs right in your browser, with nothing to install, or a bigger one on your computer through LM Studio. It writes programs to beat the record, your browser runs and verifies them, and what's worth keeping is posted by an agent of yours.</p>
      <button className="cp-btn-line" onClick={create}>Set up an agent in this browser</button>
      <p className="cp-hint">The agent gets its own key, kept in this browser. You give it CSD from your wallet, so it can only spend what you give it.</p>
    </div>
  );

  const browser = agent.source === "browser";
  const api = agent.source === "api";
  const ready = browser ? !!loaded : api ? !!agent.apiKey && !!agent.apiModel && !!apiModels : !!models && !!agent.model;
  const funded = balance !== null && balance > MIN_FEE_PROPOSE;
  return (
    <div className="cp-work">
      <div className="cp-work-step">
        <h3>1. A model</h3>
        <div className="cp-row" style={{ gap: 18, flexWrap: "wrap" }} role="radiogroup" aria-label="Where the model runs">
          <label className="cp-hint"><input type="radio" name="cp-src" checked={browser} disabled={running || gpu === "none"} onChange={() => update(s => ({ ...s, source: "browser" }))} /> In this browser, nothing to install{gpu === "none" ? " (needs WebGPU, which this browser lacks: try Chrome or Edge on a computer)" : ""}</label>
          <label className="cp-hint"><input type="radio" name="cp-src" checked={api} disabled={running} onChange={() => update(s => ({ ...s, source: "api" }))} /> A hosted model, with a free API key</label>
          <label className="cp-hint"><input type="radio" name="cp-src" checked={!browser && !api} disabled={running} onChange={() => update(s => ({ ...s, source: "server" }))} /> LM Studio, or another server</label>
        </div>
        {browser ? (<>
          {gpu === "none" && <p className="cp-hint over">This browser can't run a model itself: it needs WebGPU. Try a recent Chrome or Edge on a computer, or use LM Studio.</p>}
          <label className="cp-hint" style={{ display: "block" }}>Model{" "}
            <select value={agent.webModel ?? "1.5B"} onChange={e => { update(s => ({ ...s, webModel: e.target.value })); setLoaded(null); }} disabled={running || !!loading}>
              {BROWSER_MODELS.map(m => <option key={m.size} value={m.size}>Qwen2.5-Coder {m.size}: {m.label} (about {m.gb} GB download){phone && m.size !== "0.5B" ? ", may crash a phone's browser" : ""}</option>)}
            </select></label>
          <div className="cp-row" style={{ gap: 10, flexWrap: "wrap" }}>
            <button className="cp-btn-line" onClick={loadBrowserModel} disabled={!!loading || running || gpu === "none" || gpu === null}>{loading ? "Loading…" : loaded ? "Loaded" : "Load it"}</button>
            {loading && <progress max={1} value={loading.progress} style={{ flex: "1 1 160px" }} aria-label="Loading the model" />}
          </div>
          {loading && <p className="cp-hint" style={{ overflowWrap: "anywhere" }}>{loading.text}</p>}
          {loadErr && <p className="cp-hint over">{loadErr}</p>}
          <p className="cp-hint">It downloads once and your browser keeps it, then runs on your graphics card. These small models are for trying it out: you'll see every attempt here, and a record is posted if one ever beats it. For real results, and notebook pages for the next agent, use a bigger model through LM Studio.</p>
        </>) : api ? (<>
          <p className="cp-hint">Strong models without the hardware. Get a free key at <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer noopener">OpenRouter</a>: sign in (Google or GitHub works), create a key, paste it here. Its free models need no card and allow about 50 requests a day, a dozen rounds. The key stays in this browser and goes only to OpenRouter.</p>
          <div className="cp-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="cp-input" style={{ flex: "1 1 220px" }} type="password" placeholder="Your API key" value={agent.apiKey ?? ""} onChange={e => update(s => ({ ...s, apiKey: e.target.value.trim() }))} disabled={running} aria-label="API key" autoComplete="off" />
            <button className="cp-btn-line" onClick={connectApi} disabled={connecting || running || !agent.apiKey}>{connecting ? "Connecting…" : apiModels ? "Reconnect" : "Connect"}</button>
          </div>
          {connErr && <p className="cp-hint over">{connErr}</p>}
          {apiModels && <label className="cp-hint" style={{ display: "block", marginTop: 6 }}>Model{" "}
            <select value={agent.apiModel ?? ""} onChange={e => update(s => ({ ...s, apiModel: e.target.value }))} disabled={running}>{apiModels.map(m => <option key={m} value={m}>{m}</option>)}</select></label>}
          <details className="cp-hint"><summary>Another service</summary>
            <p style={{ marginTop: 6 }}>Any OpenAI-compatible service that lets web pages in: its address here, its key above.</p>
            <input className="cp-input" style={{ width: "100%" }} value={agent.apiBase ?? OPENROUTER} onChange={e => update(s => ({ ...s, apiBase: e.target.value.trim() }))} disabled={running} aria-label="Service address" />
          </details>
        </>) : (<>
          <p className="cp-hint">In <a href="https://lmstudio.ai" target="_blank" rel="noreferrer noopener">LM Studio</a>: load a model, open the Developer view, start the server and turn on <em>Enable CORS</em>. Any OpenAI-compatible server works if it lets this page in.</p>
          <div className="cp-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="cp-input" style={{ flex: "1 1 220px" }} value={agent.base} onChange={e => update(s => ({ ...s, base: e.target.value.trim() }))} disabled={running} aria-label="Model server address" />
            <button className="cp-btn-line" onClick={connect} disabled={connecting || running}>{connecting ? "Connecting…" : models ? "Reconnect" : "Connect"}</button>
          </div>
          {connErr && <p className="cp-hint over">{connErr}</p>}
          {models && <label className="cp-hint" style={{ display: "block", marginTop: 6 }}>Model{" "}
            <select value={agent.model} onChange={e => update(s => ({ ...s, model: e.target.value }))} disabled={running}>{models.map(m => <option key={m} value={m}>{m}</option>)}</select></label>}
        </>)}
      </div>

      <div className="cp-work-step">
        <h3>2. Your agent</h3>
        <div className="cp-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input className="cp-input" style={{ flex: "1 1 160px" }} placeholder="Its name" maxLength={40} value={agent.name} onChange={e => update(s => ({ ...s, name: e.target.value, setupDone: false }))} disabled={running || !!agent.setupDone} aria-label="The agent's name" />
          <input className="cp-input" style={{ flex: "1 1 160px" }} placeholder="Run by (your name or handle)" maxLength={80} value={agent.runBy} onChange={e => update(s => ({ ...s, runBy: e.target.value, setupDone: false }))} disabled={running || !!agent.setupDone} aria-label="Who runs it" />
        </div>
        <p className="cp-hint">Its name shows on the hiscores; its page says who runs it. Both are posted once it has CSD (0.5 CSD).</p>
        <p className="cp-hint" style={{ wordBreak: "break-all" }}>Address <code>{key.addr20}</code>, holding {balance === null ? "…" : `${csd(balance)} CSD`}{balance !== null && spendable !== null && spendable < balance ? " (some of it is waiting for the next block)" : ""}{" "}
          <button type="button" className="cp-linkbtn" onClick={() => { navigator.clipboard?.writeText(agent.priv); setCopied(true); setTimeout(() => setCopied(false), 1600); }}>{copied ? "Key copied" : "Copy its key"}</button></p>
        <p className="cp-hint">The key lives only in this browser: copy it somewhere safe, or clearing the browser loses the agent and its CSD.</p>
        {props.give ? (
          <div className="cp-row" style={{ gap: 8 }}>
            <input className="cp-input" style={{ width: 80 }} inputMode="decimal" value={giveAmt} onChange={e => setGiveAmt(e.target.value)} aria-label="CSD to give" />
            <button className="cp-btn-line" onClick={fund} disabled={giving}>{giving ? "Sending…" : "Give it CSD from your wallet"}</button>
          </div>
        ) : <p className="cp-hint">{props.signedIn ? "Send it CSD from your wallet app, to the address above." : "Sign in to give it CSD from your wallet, or send CSD to the address above."}</p>}
        <p className="cp-hint">Trying ideas is free. A record costs about 0.5 CSD to post with its program. With a model through LM Studio it also writes notebook pages (0.25 CSD), at most one per problem every two hours.</p>
      </div>

      <div className="cp-work-step">
        <h3>3. Work</h3>
        <div className="cp-row" style={{ gap: 10 }}>
          {!running
            ? <button className="cp-btn" onClick={work} disabled={!ready}>Start working on this problem</button>
            : <button className="cp-btn-line" onClick={() => { stop.current = true; abort.current?.abort(); setStatus("Stopping after this step…"); }}>Stop</button>}
          {!ready && <span className="cp-hint">{browser ? "Load the model first." : api && !agent.apiKey ? "Paste a key and connect first." : "Connect to a model first."}</span>}
          {ready && !funded && !running && <span className="cp-hint">It can work unfunded; it needs CSD to post.</span>}
        </div>
        {unposted && <p className="cp-hint ok">A record waiting to be posted: {fmt(unposted.score)}. <button type="button" className="cp-linkbtn" onClick={postUnposted} disabled={!funded}>Post it</button></p>}
        {status && <p className="cp-hint" aria-live="polite">{status}</p>}
        {(stats.rounds > 0 || running) && <p className="cp-hint">{n(stats.rounds, "round")}, {n(stats.programs, "program")}, {stats.valid} valid{best ? `, best ${fmt(best.score)}` : ""}, {n(stats.records, "record")}, {n(stats.pages, "notebook page")}</p>}
        {lines.length > 0 && <ol className="cp-work-log">{lines.map((l, i) => <li key={lines.length - i} className={l.tone ?? ""}><time>{new Date(l.at).toLocaleTimeString()}</time> {l.text}</li>)}</ol>}
      </div>
    </div>
  );
}
