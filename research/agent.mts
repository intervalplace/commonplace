#!/usr/bin/env -S npx tsx
// A seed agent for the research memory. It reaches the memory only through the MCP server, the
// same way any other agent would.
//
//   finder   reads the newest papers in an arXiv category and keeps one finding per paper: the
//            claim it thinks matters most, with the exact sentence from the abstract it rests on
//   checker  reads other agents' findings, fetches each source, looks for the quoted passage, and
//            asks whether the claim follows; then checks it, holds up or not
//
//   ROLE=finder|checker  SUBJECT=ai-papers  ARXIV_CAT=cs.AI  PER_RUN=3
//   ANTHROPIC_API_KEY=…  ANTHROPIC_MODEL=claude-sonnet-5-5
//   CSD_AGENT_KEY=…      CSD_API=…   STATE=./agent-state.json
//   DRY=1                no language model: the first sentence is the claim (for testing)
//
// Run it from cron, e.g. a finder once a day and a checker every few hours, each with its own key.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROLE = process.env.ROLE ?? "finder";
const SUBJECT = process.env.SUBJECT ?? "ai-papers";
const CAT = process.env.ARXIV_CAT ?? "cs.AI";
const PER_RUN = Number(process.env.PER_RUN ?? 3);
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const DRY = !!process.env.DRY;
const STATE = process.env.STATE ?? `./agent-state-${ROLE}.json`;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ROLE, ...a);

type State = { checked: string[] };
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { checked: [] };
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

// ── the memory, through the MCP server ──────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: `seed-${ROLE}`, version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "server.mts")], env: { ...process.env } as Record<string, string> }));
async function tool(name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(t);
  try { return JSON.parse(t); } catch { return t; }
}

// ── sources ─────────────────────────────────────────────────────────────────
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
type Paper = { url: string; title: string; abstract: string };
function parseAtom(xml: string): Paper[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const get = (tag: string) => clean((new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(m[1])?.[1] ?? "").replace(/<[^>]+>/g, ""));
    const id = get("id").replace(/^http:/, "https:").replace(/v\d+$/, "");
    return { url: id, title: get("title"), abstract: get("summary") };
  }).filter(p => p.url && p.abstract);
}
async function newestPapers(): Promise<Paper[]> {
  if (process.env.ARXIV_FEED) return parseAtom(readFileSync(process.env.ARXIV_FEED, "utf8"));
  const r = await fetch(`https://export.arxiv.org/api/query?search_query=cat:${encodeURIComponent(CAT)}&sortBy=submittedDate&sortOrder=descending&max_results=25`);
  return parseAtom(await r.text());
}
// the text a source says: an arXiv abstract, or any page with its markup stripped
async function sourceText(url: string): Promise<string> {
  const ax = /arxiv\.org\/abs\/([^\s?#]+)/.exec(url);
  if (process.env.ARXIV_FEED && ax) return parseAtom(readFileSync(process.env.ARXIV_FEED, "utf8")).find(p => p.url === url)?.abstract ?? "";
  if (ax) { const p = parseAtom(await (await fetch(`https://export.arxiv.org/api/query?id_list=${ax[1]}`)).text())[0]; return p ? `${p.title}. ${p.abstract}` : ""; }
  const html = await (await fetch(url)).text();
  return clean(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " "));
}

// ── the model ───────────────────────────────────────────────────────────────
async function ask(prompt: string): Promise<any> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
  });
  const j: any = await r.json();
  const t: string = j.content?.[0]?.text ?? "";
  const m = /\{[\s\S]*\}/.exec(t);
  if (!m) throw new Error(`model gave no JSON: ${JSON.stringify(j).slice(0, 300)}`);
  return JSON.parse(m[0]);
}

async function propose(p: Paper): Promise<{ claim: string; quote: string } | null> {
  if (DRY) { const first = p.abstract.split(/(?<=\.)\s/)[0]; return { claim: first.slice(0, 240), quote: first.slice(0, 200) }; }
  const out = await ask(
    `You are a research agent adding to a shared, permanent research memory that other agents will check.\n` +
    `Paper: ${p.title}\nAbstract: ${p.abstract}\n\n` +
    `State the single most important specific, checkable finding of this paper as one plain sentence (max 240 characters), ` +
    `and copy the exact passage from the abstract it rests on (max 200 characters, verbatim). If there is no specific finding, say so.\n` +
    `Answer only with JSON: {"claim": "...", "quote": "..."} or {"none": true}`);
  return out.none ? null : { claim: clean(out.claim), quote: clean(out.quote) };
}

async function judge(claim: string, quote: string | undefined, text: string): Promise<{ holds: boolean; confidence: number; why: string }> {
  const quoted = !quote || clean(text).toLowerCase().includes(clean(quote).toLowerCase());
  if (!quoted) return { holds: false, confidence: 95, why: "the quoted passage isn't in the source" };
  if (DRY) return { holds: true, confidence: 60, why: "the quote is in the source (dry run: not read further)" };
  const out = await ask(
    `You are checking another agent's finding for a shared research memory. Be strict: a check is public and permanent.\n` +
    `Source text: ${text.slice(0, 12000)}\n\nFinding: ${claim}\nQuoted passage: ${quote ?? "(none)"}\n\n` +
    `Does the finding follow from the source, without overstating it? Answer only with JSON: {"holds": true|false, "confidence": 0-100, "why": "one sentence"}`);
  return { holds: !!out.holds, confidence: Math.max(0, Math.min(100, Number(out.confidence) || 50)), why: clean(String(out.why ?? "")) };
}

// ── the run ─────────────────────────────────────────────────────────────────
try {
  const w = await tool("memory_wallet");
  log("key", w.address, "holds", w.balance);
  if (ROLE === "finder") {
    const seen = await tool("memory_search", { subject: SUBJECT, limit: 50 });
    const known = new Set(Array.isArray(seen) ? seen.map((r: any) => r.source) : []);
    let kept = 0;
    for (const p of await newestPapers()) {
      if (kept >= PER_RUN) break;
      if (known.has(p.url)) continue;
      const f = await propose(p).catch(e => { log("model failed", String(e)); return null; });
      if (!f) continue;
      const r = await tool("memory_keep", { subject: SUBJECT, claim: f.claim, source: p.url, quote: f.quote }).catch(e => { log("not kept:", String(e.message ?? e)); return null; });
      if (r?.kept) { kept++; log("kept", r.id, f.claim); }
    }
    log(`done: ${kept} kept`);
  } else {
    const rows = await tool("memory_search", { subject: SUBJECT, limit: 50 });
    let done = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
      if (done >= PER_RUN) break;
      if (state.checked.includes(r.id)) continue;
      const full = await tool("memory_get", { id: r.id });
      if (full.kept_by?.toLowerCase() === w.address.toLowerCase()) { state.checked.push(r.id); continue; }
      const text = await sourceText(r.source).catch(() => "");
      if (!text) { log("couldn't read", r.source); continue; }
      const v = await judge(r.claim, r.quote, text);
      await tool("memory_check", { id: r.id, holds: v.holds, confidence: v.confidence });
      state.checked.push(r.id); saveState(); done++;
      log(v.holds ? "holds" : "doesn't hold", r.id, v.why);
    }
    log(`done: ${done} checked`);
  }
} finally { await client.close(); }
