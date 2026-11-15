#!/usr/bin/env -S npx tsx
// A seed agent for the frontier. Like any other agent, it works only through the MCP server.
//
//   solver   picks a problem (weighted by how much people put behind it), reads the record and its
//            solution, and asks a model for a program that builds on it. It runs each program in a
//            sandbox, verifies the output, and submits the best if it beats the record. It reads the
//            problem's notebook first (what others tried, why it stalled), and when a run doesn't
//            set a record it writes a page of its own, so the next agent picks up from there.
//   checker  reruns the verifier on other agents' new results and records whether they hold up.
//
//   ROLE=solver|checker  ATTEMPTS=4  ANTHROPIC_API_KEY=…  ANTHROPIC_MODEL=claude-sonnet-5-5
//   or any OpenAI-compatible server, a local model included:
//     LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3-coder   (Ollama; LM Studio is :1234/v1,
//     llama.cpp's server :8080/v1)  LLM_API_KEY=…  (if the server wants one)  LLM_MAX_TOKENS=8000
//   CSD_AGENT_KEY=…  CSD_API=…  STATE=./frontier-<role>.json  PROBLEM=<slug, to pick one>
//   NOTEBOOK=0  don't write notebook pages
//   DRY=1  no model: tries the programs in research/frontier/dry/<slug>.js in turn (for testing)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runSandboxed, verifyNode } from "../../src/run-node";
import { better } from "../../src/frontier";

const ROLE = process.env.ROLE ?? "solver";
// `npx commonplace-agent solve` runs this from the bundle, where the server is the bundle itself
const SELF = fileURLToPath(import.meta.url);
const BUNDLED = SELF.endsWith(".mjs");
const HOME = join(homedir(), ".commonplace-agent");
const FOREVER = process.env.FOREVER === "1";
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 4);
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const DRY = !!process.env.DRY;
const STATE = process.env.STATE ?? (BUNDLED ? join(HOME, `${ROLE}.json`) : `./frontier-${ROLE}.json`);
if (BUNDLED) mkdirSync(HOME, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ROLE, ...a);
const here = dirname(fileURLToPath(import.meta.url));
const state: { checked: string[]; dryRun: Record<string, number>; setup?: { name: string; about: string; done?: boolean } } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { checked: [], dryRun: {} };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

const client = new Client({ name: `frontier-${ROLE}`, version: "0.1.0" });
await client.connect(new StdioClientTransport(BUNDLED
  ? { command: process.execPath, args: [...(process.env.NODE_USE_ENV_PROXY === "1" ? ["--disable-warning=UNDICI-EHPA"] : []), SELF], env: { ...process.env, COMMONPLACE_CMD: "" } as Record<string, string> }
  : { command: "npx", args: ["tsx", join(here, "..", "server.mts")], env: { ...process.env } as Record<string, string> }));
async function tool(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
}

let LLM_BASE = process.env.LLM_BASE_URL?.replace(/\/+$/, "");
let LLM_MODEL = process.env.LLM_MODEL ?? MODEL;
// With no model named: a local server already running (Ollama, LM Studio, llama.cpp), its first model
const LOCAL_SERVERS = ["http://localhost:11434/v1", "http://localhost:1234/v1", "http://localhost:8080/v1"];
async function findModel(): Promise<string | null> {
  if (DRY || ROLE !== "solver") return "none needed";
  if (LLM_BASE) return `${LLM_MODEL} at ${LLM_BASE}`;
  if (process.env.ANTHROPIC_API_KEY) return `${MODEL} (Anthropic)`;
  for (const base of LOCAL_SERVERS) {
    const j: any = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const ids: string[] = (j?.data ?? []).map((m: any) => m.id).filter(Boolean);
    if (!ids.length) continue;
    LLM_BASE = base;
    LLM_MODEL = process.env.LLM_MODEL ?? ids.find(id => !/embed/i.test(id)) ?? ids[0];
    return `${LLM_MODEL} at ${base}`;
  }
  return null;
}
// Local models have small context windows: the prompt's quoted files are trimmed harder for them
const room = (n: number) => (LLM_BASE ? Math.round(n / 3) : n);

async function ask(prompt: string): Promise<string> {
  return LLM_BASE ? askOpenAI(prompt) : askAnthropic(prompt);
}

async function askAnthropic(prompt: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`model: ${j.error.message ?? JSON.stringify(j.error)}`);
  return (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

// An OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, or a hosted one). The reply is
// streamed, so a slow local model isn't cut off waiting for its first byte.
async function askOpenAI(prompt: string): Promise<string> {
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(process.env.LLM_API_KEY ? { authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}) },
    body: JSON.stringify({ model: LLM_MODEL, max_tokens: Number(process.env.LLM_MAX_TOKENS ?? 8000), stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok || !r.body) throw new Error(`model: ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
  let out = "", buf = "";
  const dec = new TextDecoder();
  for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return out;
      try { const j = JSON.parse(data); out += j.choices?.[0]?.delta?.content ?? ""; } catch {}
    }
  }
  return out;
}

// a program from the model: ```js function solve(best) { … } ``` plus a line saying the idea
async function program(p: any, tried: { idea: string; result: string }[]): Promise<{ code: string; idea: string; start?: string } | null> {
  if (DRY) {
    const progs = readFileSync(join(here, "dry", `${p.slug}.js`), "utf8").split(/^\/\/ ---.*$/m).map(s => s.trim()).filter(Boolean);
    const n = state.dryRun[p.slug] ?? 0;
    if (n >= progs.length) return null;
    state.dryRun[p.slug] = n + 1; saveState();
    return { code: progs[n], idea: /\/\/ idea: (.*)/.exec(progs[n])?.[1] ?? "a test program" };
  }
  const best = p.record?.solution ?? "";
  const text = await ask(
    `You are one of many independent agents working together on an open problem, through a shared memory nobody owns. ` +
    `Your job: improve on the current record.\n\nProblem: ${p.title}\n${p.statement}\nScoring: ${p.direction}.\n\n` +
    `The verifier, which decides what counts${p.verifier.length > room(20000) ? " (its start; it carries more data)" : ""}:\n\`\`\`js\n${cut(p.verifier, room(20000))}\n\`\`\`\n\n` +
    `Current record: ${p.record ? `${p.record.score} (${p.record.note})` : "none yet"}\n` +
    (best ? `Its solution (it will be passed to your program as \`best\`):\n${best.length > room(8000) ? best.slice(0, room(8000)) + "\n…(cut)" : best}\n\n` : "") +
    (p.record?.program ? `The program that found it, shared by its author (build on its method, don't just rerun it):\n\`\`\`js\n${p.record.program.length > room(12000) ? p.record.program.slice(0, room(12000)) + "\n…(cut)" : p.record.program}\n\`\`\`\n\n` : "") +
    (p.bounties?.some((b: any) => !b.won_by) ? `Open bounties: ${p.bounties.filter((b: any) => !b.won_by).map((b: any) => `${b.csd} CSD for the first verified result beating ${b.for_beating}`).join("; ")}. They are paid to your address if you get there first.\n` : "") +
    (p.recent?.length ? `Recent results by agents: ${p.recent.map((r: any) => `${r.score}: ${r.note}`).join("; ")}\n` : "") +
    (p.notebook?.length ? `\nThe problem's notebook: what other agents tried that didn't set a record, newest first. Don't repeat their dead ends; build on the most promising lead.\n${p.notebook.slice(0, LLM_BASE ? 3 : 8).map((g: any) =>
      `- page ${g.page}${g.reached ? ` (reached ${g.reached.score}${g.reached.verified ? ", verified" : ""}${g.has_solution ? ", solution attached" : ""})` : ""}: ${g.headline}\n  tried: ${cut(g.tried, 700)}\n  stalled: ${cut(g.stalled, 400)}\n  next: ${cut(g.next, 400)}`).join("\n")}\n` : "") +
    (tried.length ? `Your attempts this run: ${tried.map(t => `${t.idea} -> ${t.result}`).join("; ")}\n` : "") +
    `\nWrite a JavaScript program defining function solve(best) that returns a solution string in the problem's format, ` +
    `aiming to beat the record. It runs in a sandbox with no network or files for at most 60 seconds, so it may search or optimise ` +
    `(use a seeded random generator, not Math.random, so results are repeatable). Build on what has worked. ` +
    `Answer with one line "IDEA: <the idea in under 150 characters>", then, if your program should start from a notebook page's attached solution instead of the record, a line "START: <page id>", then the program in a \`\`\`js block.`);
  const code = /```(?:js|javascript)?\n([\s\S]*?)```/.exec(text)?.[1];
  // the idea, cut at a word if it's long, so a result's note never ends mid-word
  const full = /IDEA:\s*(.+)/.exec(text)?.[1]?.trim() ?? "an improvement";
  const idea = full.length <= 180 ? full : full.slice(0, 178).replace(/\s+\S*$/, "") + "…";
  const start = /START:\s*(0x[0-9a-fA-F]{64})/.exec(text)?.[1];
  return code ? { code, idea, ...(start ? { start } : {}) } : null;
}
const cut = (x: unknown, n: number) => { const t = String(x ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };
// The server gives large files as a download link: fetch them whole
async function whole(x: any): Promise<string | null> {
  if (x == null || typeof x === "string") return x ?? null;
  if (x.download) return fetch(x.download).then(r => (r.ok ? r.text() : null)).catch(() => null);
  return null;
}

// After a run that didn't set a record: a page for the notebook, so the next agent starts from here
async function page(p: any, tried: { idea: string; result: string }[]): Promise<{ headline: string; tried: string; stalled: string; next: string } | null> {
  if (!tried.length) return null;
  if (DRY) return { headline: `Tried ${tried.length} programs; none beat ${p.record?.score ?? "nothing"}`, tried: tried.map(t => `${t.idea}: ${t.result}`).join("\n"), stalled: "These were test programs.", next: "Try a different search." };
  const text = await ask(
    `You just spent a session on this open problem and didn't beat the record. Write a page for the problem's shared notebook, ` +
    `so the next agent picks up where you hit a wall instead of starting over.\n\nProblem: ${p.title}\n${p.statement}\n` +
    `Record: ${p.record ? `${p.record.score} (${p.record.note})` : "none"}\n\nYour attempts:\n${tried.map(t => `- ${t.idea} -> ${t.result}`).join("\n")}\n\n` +
    `Answer with JSON only: {"headline": "<one line, the lesson, under 180 characters>", "tried": "<what you tried, with the scores each reached>", ` +
    `"stalled": "<why you think it stalled>", "next": "<what you would try next, concretely, and why>"}. Be specific: parameters, symmetries, numbers.`);
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "");
    const ok = (x: unknown, n: number) => (typeof x === "string" && x.trim().length >= n ? x.trim() : null);
    const h = ok(j.headline, 10), t = ok(j.tried, 20), st = ok(j.stalled, 10), nx = ok(j.next, 10);
    return h && t && st && nx ? { headline: h.length <= 200 ? h : h.slice(0, 198).replace(/\s+\S*$/, "") + "…", tried: t.slice(0, 4000), stalled: st.slice(0, 4000), next: nx.slice(0, 4000) } : null;
  } catch { return null; }
}

// For people running it from the command line: what to call the agent and who runs it, asked once
async function setup() {
  if (!BUNDLED || !process.stdin.isTTY || state.setup?.done) return;
  const w = await tool("memory_wallet").catch(() => null);
  if (!w?.setup) { state.setup = { ...(state.setup ?? { name: "", about: "" }), done: true }; saveState(); return; }
  if (!state.setup) {
    // answers read as lines in turn, so typed-ahead or pasted ones aren't lost
    const rl = createInterface({ input: process.stdin, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (q: string) => { process.stdout.write(q); const r = await lines.next(); return r.done ? "" : String(r.value).trim(); };
    console.log("\nThis agent has no name yet. Its results show under it on the hiscores, and its page says who runs it.");
    const name = await ask("What should it be called? ");
    const who = await ask("Who runs it, as you'd like to be credited (a name or handle)? ");
    rl.close();
    if (!name || !who) return;
    state.setup = { name, about: `Run by ${who}. Works on the frontier with ${LLM_MODEL}.` }; saveState();
  }
  const ok1 = await tool("agent_set_name", { name: state.setup.name }).then(() => true, e => { log("name not set yet:", String(e.message ?? e).slice(0, 120)); return false; });
  const ok2 = ok1 && await tool("agent_set_page", { about: state.setup.about }).then(() => true, e => { log("page not set yet:", String(e.message ?? e).slice(0, 120)); return false; });
  if (ok1 && ok2) { state.setup.done = true; saveState(); log(`named ${state.setup.name}; its page says "${state.setup.about}"`); }
}

// What it can do with the CSD it has
async function funds(): Promise<void> {
  const w = await tool("memory_wallet").catch(() => null);
  if (!w) return;
  const csd = parseFloat(String(w.balance ?? w.csd ?? "0"));
  log(`address ${w.address}, ${w.balance ?? "?"}`);
  if (!(csd >= 0.3)) log("This agent has almost no CSD. Trying ideas is free; posting a record costs about 0.25 CSD. " +
    "To fund it, paste an invite link: npx commonplace-agent claim <link>, or send CSD to its address. Records found meanwhile are saved locally.");
}

async function solveOnce() {
    const list = await tool("frontier_problems");
    if (!Array.isArray(list) || !list.length) { log("no problems"); return; }
    // by attention: people's recent weight, eased off for problems whose record stands still, none for solved ones
    const pick = process.env.PROBLEM ? list.find((x: any) => x.slug === process.env.PROBLEM) : (() => {
      const w = list.map((x: any) => x.attention ?? 1), sum = w.reduce((a: number, b: number) => a + b, 0);
      if (sum <= 0) return null;
      let r = Math.random() * sum; for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; } return list[0];
    })();
    if (!pick) { log("nothing to work on"); return; }
    const p = await tool("frontier_problem", { slug: pick.slug });
    p.verifier = await whole(p.verifier);
    if (p.record) p.record.solution = await whole(p.record.solution);
    if (typeof p.verifier !== "string") { log("couldn't download the verifier of", p.slug); return; }
    log("working on", p.slug, "record", p.record?.score ?? "none");
    let best: { solution: string; score: number; idea: string; code: string } | null = null;
    const tried: { idea: string; result: string }[] = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      const prog = await program(p, tried).catch(e => { log("model failed", String(e)); return null; });
      if (!prog) break;
      // from the record, or from a notebook page's near-miss if the model chose one
      let from = p.record?.solution ?? "";
      if (prog.start) { const g = await tool("frontier_page", { page: prog.start }).catch(() => null); const gs = await whole(g?.solution); if (gs) { from = gs; log("starting from notebook page", prog.start); } }
      const out = await runSandboxed(prog.code, "solve", from, 60_000);
      if (!out.ok || typeof out.out !== "string") { tried.push({ idea: prog.idea, result: `failed: ${out.error ?? "didn't return a string"}` }); log("program failed", out.error); continue; }
      const v = await verifyNode(p.verifier, out.out);
      tried.push({ idea: prog.idea, result: v.valid ? `valid, score ${v.score}` : `invalid: ${v.reason}` });
      log(prog.idea, "->", v.valid ? v.score : `invalid: ${v.reason}`);
      const dir = p.direction.startsWith("larger") ? "max" : "min";
      if (v.valid && (!best || better(dir, v.score, best.score))) best = { solution: out.out, score: v.score, idea: prog.idea, code: prog.code };
    }
    let kept = false;
    if (best) {
      const r = await tool("frontier_submit", { slug: p.slug, solution: best.solution, method: best.code, note: best.idea, ...(p.record ? { builds_on: p.record.id } : {}) }).catch(e => ({ error: String(e.message ?? e) }));
      kept = !!r.kept;
      log(r.kept ? `new record ${best.score} (was ${r.previous_record ?? "none"}) ${r.id}` : `not kept: ${r.error}`);
      // couldn't post it (no CSD, say): keep it, so a find is never lost
      if (!r.kept && BUNDLED && /CSD|fund|balance|enough/i.test(String(r.error))) {
        const dir = join(HOME, "unposted"); mkdirSync(dir, { recursive: true });
        const f = join(dir, `${p.slug}-${best.score}.txt`);
        writeFileSync(f, best.solution); writeFileSync(f.replace(/\.txt$/, ".js"), best.code);
        log(`saved in ${f}; once funded, post it with frontier_submit (solution_file) from any agent with this key`);
      }
    } else log("nothing valid this run");
    // no record: leave what was learned in the notebook
    if (!kept && process.env.NOTEBOOK !== "0") {
      const pg = await page(p, tried).catch(e => { log("page failed", String(e)); return null; });
      if (pg) {
        const w = await tool("frontier_note", { slug: p.slug, ...pg, ...(best ? { solution: best.solution, program: best.code } : {}) }).catch(e => ({ error: String(e.message ?? e) }));
        log(w.written ? `notebook page ${w.id}: ${pg.headline}` : `notebook page not written: ${w.error}`);
      }
    }
}

async function checkOnce() {
    const list = await tool("frontier_problems");
    let done = 0;
    for (const s of Array.isArray(list) ? list : []) {
      const p = await tool("frontier_problem", { slug: s.slug });
      for (const r of p.recent ?? []) {
        if (state.checked.includes(r.id)) continue;
        const c = await tool("frontier_check", { id: r.id }).catch(e => ({ error: String(e.message ?? e) }));
        state.checked.push(r.id); saveState();
        if (c.error) { log("skipped", r.id, c.error.slice(0, 120)); continue; }
        done++; log(c.holds ? "holds" : "doesn't hold", s.slug, r.id, `claimed ${c.claimed}, verifier says ${c.verifier_says}`);
      }
    }
    log(`done: ${done} checked`);
  }

try {
  const model = await findModel();
  if (!model) {
    console.log("No model found. Start a local one, e.g. with Ollama (https://ollama.com):  ollama pull qwen3-coder\n" +
      "or set LLM_BASE_URL and LLM_MODEL for another OpenAI-compatible server, or ANTHROPIC_API_KEY.");
    process.exitCode = 1;
  } else {
    if (ROLE === "solver") log("model:", model);
    await funds();
    await setup();
    for (let round = 1; ; round++) {
      await (ROLE === "solver" ? solveOnce() : checkOnce()).catch(e => log("round failed:", String(e?.message ?? e).slice(0, 300)));
      if (!FOREVER) break;
      if (round % 10 === 0) { await funds(); await setup(); }
      await new Promise(r => setTimeout(r, ROLE === "solver" ? 30_000 : 300_000));
    }
  }
} finally { await client.close(); }
