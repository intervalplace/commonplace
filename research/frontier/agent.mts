#!/usr/bin/env -S npx tsx
// A seed agent for the frontier. Like any other agent, it works only through the MCP server.
//
//   solver   picks a problem (weighted by how much people put behind it), reads the record and its
//            solution, and asks a model for a program that builds on it. It runs each program in a
//            sandbox, verifies the output, and submits the best if it beats the record.
//   checker  reruns the verifier on other agents' new results and records whether they hold up.
//
//   ROLE=solver|checker  ATTEMPTS=4  ANTHROPIC_API_KEY=…  ANTHROPIC_MODEL=claude-sonnet-5-5
//   CSD_AGENT_KEY=…  CSD_API=…  STATE=./frontier-<role>.json  PROBLEM=<slug, to pick one>
//   DRY=1  no model: tries the programs in research/frontier/dry/<slug>.js in turn (for testing)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runSandboxed, verifyNode } from "../../src/run-node";
import { better } from "../../src/frontier";

const ROLE = process.env.ROLE ?? "solver";
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 4);
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const DRY = !!process.env.DRY;
const STATE = process.env.STATE ?? `./frontier-${ROLE}.json`;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ROLE, ...a);
const here = dirname(fileURLToPath(import.meta.url));
const state: { checked: string[]; dryRun: Record<string, number> } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { checked: [], dryRun: {} };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

const client = new Client({ name: `frontier-${ROLE}`, version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "..", "server.mts")], env: { ...process.env } as Record<string, string> }));
async function tool(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
}

async function ask(prompt: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
  });
  const j: any = await r.json();
  return (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

// a program from the model: ```js function solve(best) { … } ``` plus a line saying the idea
async function program(p: any, tried: { idea: string; result: string }[]): Promise<{ code: string; idea: string } | null> {
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
    `The verifier, which decides what counts:\n\`\`\`js\n${p.verifier}\n\`\`\`\n\n` +
    `Current record: ${p.record ? `${p.record.score} (${p.record.note})` : "none yet"}\n` +
    (best ? `Its solution (it will be passed to your program as \`best\`):\n${best.length > 8000 ? best.slice(0, 8000) + "\n…(cut)" : best}\n\n` : "") +
    (p.recent?.length ? `Recent attempts by agents: ${p.recent.map((r: any) => `${r.score}: ${r.note}`).join("; ")}\n` : "") +
    (tried.length ? `Your attempts this run: ${tried.map(t => `${t.idea} -> ${t.result}`).join("; ")}\n` : "") +
    `\nWrite a JavaScript program defining function solve(best) that returns a solution string in the problem's format, ` +
    `aiming to beat the record. It runs in a sandbox with no network or files for at most 60 seconds, so it may search or optimise ` +
    `(use a seeded random generator, not Math.random, so results are repeatable). Build on what has worked. ` +
    `Answer with one line "IDEA: <the idea in under 150 characters>" followed by the program in a \`\`\`js block.`);
  const code = /```(?:js|javascript)?\n([\s\S]*?)```/.exec(text)?.[1];
  // the idea, cut at a word if it's long, so a result's note never ends mid-word
  const full = /IDEA:\s*(.+)/.exec(text)?.[1]?.trim() ?? "an improvement";
  const idea = full.length <= 180 ? full : full.slice(0, 178).replace(/\s+\S*$/, "") + "…";
  return code ? { code, idea } : null;
}

try {
  if (ROLE === "solver") {
    const list = await tool("frontier_problems");
    if (!Array.isArray(list) || !list.length) { log("no problems"); process.exit(0); }
    // by attention: people's recent weight, eased off for problems whose record stands still, none for solved ones
    const pick = process.env.PROBLEM ? list.find((x: any) => x.slug === process.env.PROBLEM) : (() => {
      const w = list.map((x: any) => x.attention ?? 1), sum = w.reduce((a: number, b: number) => a + b, 0);
      if (sum <= 0) return null;
      let r = Math.random() * sum; for (let i = 0; i < list.length; i++) { r -= w[i]; if (r <= 0) return list[i]; } return list[0];
    })();
    if (!pick) { log("nothing to work on"); process.exit(0); }
    const p = await tool("frontier_problem", { slug: pick.slug });
    log("working on", p.slug, "record", p.record?.score ?? "none");
    let best: { solution: string; score: number; idea: string } | null = null;
    const tried: { idea: string; result: string }[] = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      const prog = await program(p, tried).catch(e => { log("model failed", String(e)); return null; });
      if (!prog) break;
      const out = await runSandboxed(prog.code, "solve", p.record?.solution ?? "", 60_000);
      if (!out.ok || typeof out.out !== "string") { tried.push({ idea: prog.idea, result: `failed: ${out.error ?? "didn't return a string"}` }); log("program failed", out.error); continue; }
      const v = await verifyNode(p.verifier, out.out);
      tried.push({ idea: prog.idea, result: v.valid ? `valid, score ${v.score}` : `invalid: ${v.reason}` });
      log(prog.idea, "->", v.valid ? v.score : `invalid: ${v.reason}`);
      const dir = p.direction.startsWith("larger") ? "max" : "min";
      if (v.valid && (!best || better(dir, v.score, best.score))) best = { solution: out.out, score: v.score, idea: prog.idea };
    }
    if (best) {
      const r = await tool("frontier_submit", { slug: p.slug, solution: best.solution, note: best.idea, ...(p.record ? { builds_on: p.record.id } : {}) }).catch(e => ({ error: String(e.message ?? e) }));
      log(r.kept ? `new record ${best.score} (was ${r.previous_record ?? "none"}) ${r.id}` : `not kept: ${r.error}`);
    } else log("nothing valid this run");
  } else {
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
} finally { await client.close(); }
