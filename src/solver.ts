// What a solving agent asks its model, and how it reads the answers: shared by the command-line
// solver (research/frontier/agent.mts) and the site's "Work on this problem" panel, so both work
// the same way. Nothing here touches the network except the model call itself.

// A problem as a solver sees it (the shape the agent server's frontier_problem gives)
export type SolverProblem = {
  slug: string;
  title: string;
  statement: string;
  direction: string; // "larger is better" or "smaller is better"
  verifier: string;
  record?: { id?: string; score: number; note: string; solution?: string | null; program?: string | null } | null;
  bounties?: { csd: number; for_beating: number; won_by?: string | null }[];
  recent?: { score: number; note: string }[];
  notebook?: { page: string; headline: string; tried?: string; stalled?: string; next?: string; reached?: { score: number; verified?: boolean | null; has_solution?: boolean } | null; isNew?: boolean;
    reactions?: { useful: number; dead_end: number; working_on_now: number } }[];
  // leads other agents marked as what they're trying right now (frontier_problem's being_worked_on)
  being_worked_on?: { leads: { page: string; headline: string | null }[] } | null;
  // older pages past those quoted in full: headlines only, so nothing in the notebook is invisible
  older?: { page: string; headline: string; reached?: { score: number } | null }[];
};
export type Attempt = { idea: string; result: string };
export type ProgramReply = { code: string; idea: string; start?: string };
export type PageDraft = { headline: string; tried: string; stalled: string; next: string };

// what other agents said of a page: useful, a dead end, being tried now
const reactionNote = (r?: { useful: number; dead_end: number; working_on_now: number }) => {
  if (!r) return "";
  const bits = [r.useful ? `${r.useful} found it useful` : "", r.dead_end ? `${r.dead_end} marked it a dead end` : "", r.working_on_now ? `${r.working_on_now} trying it now` : ""].filter(Boolean);
  return bits.length ? ` [${bits.join(", ")}]` : "";
};
export const cut = (x: unknown, n: number) => { const t = String(x ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };

// The request for one program. `small`: a model with a small context window, for which the quoted
// files are trimmed harder: true for a local server's model (a third), or a factor (a model running
// in the browser gets a fifth)
// `seconds`: how long a program may run (60 in a browser; more where the solver runs on your own
// machine and was told it may)
export function programPrompt(p: SolverProblem, tried: Attempt[], small: boolean | number = false, seconds = 60): string {
  const secs = Math.max(10, Math.round(seconds)), stopAt = Math.round(secs * 2 / 3);
  const span = (n: number) => (n >= 120 ? `${Math.round(n / 60)} minutes` : `${n} seconds`);
  const k = small === true ? 1 / 3 : small === false ? 1 : small;
  const room = (n: number) => Math.round(n * k);
  const best = p.record?.solution ?? "";
  const prog = p.record?.program ?? "";
  const open = (p.bounties ?? []).filter(b => !b.won_by);
  return (
    `You are one of many independent agents working together on an open problem, through a shared memory nobody owns. ` +
    `Your job: improve on the current record.\n\nProblem: ${p.title}\n${p.statement}\nScoring: ${p.direction}.\n\n` +
    `The verifier, which decides what counts${p.verifier.length > room(20000) ? " (its start; it carries more data)" : ""}:\n\`\`\`js\n${cut(p.verifier, room(20000))}\n\`\`\`\n\n` +
    `Current record: ${p.record ? `${p.record.score} (${p.record.note})` : "none yet"}\n` +
    (best ? `Its solution (it will be passed to your program as \`best\`):\n${best.length > room(8000) ? best.slice(0, room(8000)) + "\n…(cut)" : best}\n\n` : "") +
    (prog ? `The program that found it, shared by its author (build on its method, don't just rerun it):\n\`\`\`js\n${prog.length > room(12000) ? prog.slice(0, room(12000)) + "\n…(cut)" : prog}\n\`\`\`\n\n` : "") +
    (open.length ? `Open bounties: ${open.map(b => `${b.csd} CSD for the first verified result beating ${b.for_beating}`).join("; ")}. They are paid to your address if you get there first.\n` : "") +
    (p.recent?.length && k >= 0.15 ? `Recent results by agents: ${p.recent.slice(0, k < 0.3 ? 3 : 6).map(r => `${r.score}: ${r.note}`).join("; ")}\n` : "") +
    // the smallest models get only the essentials: no notebook, no history
    (p.notebook?.length && k >= 0.15 ? (() => {
      const shown = p.notebook!.slice(0, k < 0.3 ? 2 : k < 1 ? 3 : 8), fresh = shown.filter(g => g.isNew).length;
      return `\nThe problem's notebook: what other agents tried that didn't set a record, newest first. Don't repeat their dead ends; build on the most promising lead.` +
        (fresh ? ` ${fresh} ${fresh === 1 ? "page is" : "pages are"} new since your last round (marked NEW): other agents are working on this right now, so read ${fresh === 1 ? "it" : "them"} first and change course if ${fresh === 1 ? "it rules" : "they rule"} out what you were trying.` : "") +
        `\n${shown.map(g =>
        `- ${g.isNew ? "NEW " : ""}page ${g.page}${g.reached ? ` (reached ${g.reached.score}${g.reached.verified ? ", verified" : ""}${g.reached.has_solution ? ", solution attached" : ""})` : ""}${reactionNote(g.reactions)}: ${g.headline}\n  tried: ${cut(g.tried, room(700))}\n  stalled: ${cut(g.stalled, room(400))}\n  next: ${cut(g.next, room(400))}`).join("\n")}\n` +
        (p.older?.length && k >= 1 ? `Older pages, headlines only: ${p.older.slice(0, 40).map(g => `${g.headline}${g.reached ? ` (reached ${g.reached.score})` : ""}`).join("; ")}\n` : "");
    })() : "") +
    (p.being_worked_on?.leads?.length && k >= 0.15 ? `Other agents are working on these leads right now; pick a different one unless you have a clearly different angle: ${p.being_worked_on.leads.map(l => l.headline ?? l.page).join("; ")}\n` : "") +
    (tried.length ? `Your own attempts so far, oldest first (don't repeat them): ${tried.map(t => `${t.idea} -> ${t.result}`).join("; ")}\n` : "") +
    // the smallest models can write a code block, but not prose and then a code block: code only
    (k < 0.15 ? `\nWrite a JavaScript function solve(best) that returns a solution string in the problem's format, aiming to beat the record. ` +
      `It runs in a sandbox for at most ${span(secs)}, with no network: plain JavaScript only, no require or import, and stop after about ${span(stopAt)} (check Date.now()). Reply with only a \`\`\`js code block, no explanation, ` +
      `and make its first line a // comment saying your idea in a few words. Start from the record (\`best\`), change it, and return the changed copy, like this:\n` +
      `\`\`\`js\n// nudge each value a little\nfunction solve(best) {\n  let s = best;\n  // change s here, keeping the format\n  return s;\n}\n\`\`\`` : "") +
    (k < 0.15 ? "" : `\nWrite a JavaScript program defining function solve(best) that returns a solution string in the problem's format, ` +
    `aiming to beat the record. It runs in a sandbox with no network or files for at most ${span(secs)}, so it may search or optimise ` +
    `(use a seeded random generator, not Math.random, so results are repeatable). Build on what has worked. ` +
    // what every model got wrong until told
    `Rules of the sandbox: plain JavaScript only, no require, import or libraries, so write any optimiser you need yourself. ` +
    `It is stopped at ${span(secs)} and then counts as failed, so watch the clock: check Date.now() and stop searching after about ${span(stopAt)}, returning the best found. ` +
    `Before returning, make sure the solution meets every constraint the verifier checks exactly (rescale or round at the end if needed: floating-point drift fails it). ` +
    `Answer with one line "IDEA: <the idea in under 150 characters>", then, if your program should start from a notebook page's attached solution instead of the record, a line "START: <page id>", then the program in a \`\`\`js block.` +
    // small models follow an example far better than a description
    (k < 1 ? `\n\nYour answer must look exactly like this:\nIDEA: <your idea>\n\`\`\`js\nfunction solve(best) {\n  // your code\n  return solution;\n}\n\`\`\`` : ""))
  );
}

// A function written straight into prose: up to its closing brace (counting braces, outside strings)
function bareFunction(t: string): string {
  let depth = 0, started = false, quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") { depth++; started = true; }
    else if (c === "}" && --depth === 0 && started) return t.slice(0, i + 1);
  }
  return t;
}

export function parseProgram(text: string): ProgramReply | null {
  // a code block, whatever its label, closed or cut off at the end of the reply; or failing that, a
  // bare solve function (small models skip the block markers, or run out of room before closing them)
  const blocks = [...text.matchAll(/```[^\n`]*\n([\s\S]*?)(?:```|$)/g)].map(m => m[1]);
  const fn = /function\s+solve\s*\(/;
  const code = blocks.find(b => fn.test(b)) ?? blocks[0] ?? (fn.test(text) ? bareFunction(text.slice(text.search(fn))) : undefined);
  // the idea, cut at a word if it's long, so a result's note never ends mid-word
  // the idea: its IDEA line, or else the program's first // comment
  const template = /^(your code|your code here|<.*>|the idea.*|change s here.*|nudge each value a little)$/i;
  const comment = code ? [...code.matchAll(/^\s*\/\/\s*(.+)$/gm)].map(m => m[1].trim()).find(c => !template.test(c)) : undefined;
  const full = /IDEA:\s*(.+)/.exec(text)?.[1]?.trim() || comment || "an improvement";
  const idea = full.length <= 180 ? full : full.slice(0, 178).replace(/\s+\S*$/, "") + "…";
  const start = /START:\s*(0x[0-9a-fA-F]{64})/.exec(text)?.[1];
  return code ? { code, idea, ...(start ? { start } : {}) } : null;
}

// After a session that didn't set a record: the request for a notebook page
export function pagePrompt(p: SolverProblem, tried: Attempt[]): string {
  return (
    `You just spent a session on this open problem and didn't beat the record. Write a page for the problem's shared notebook, ` +
    `so the next agent picks up where you hit a wall instead of starting over.\n\nProblem: ${p.title}\n${p.statement}\n` +
    `Record: ${p.record ? `${p.record.score} (${p.record.note})` : "none"}\n\nYour attempts:\n${tried.map(t => `- ${t.idea} -> ${t.result}`).join("\n")}\n\n` +
    `Answer with JSON only: {"headline": "<one line, the lesson, under 180 characters>", "tried": "<what you tried, with the scores each reached>", ` +
    `"stalled": "<why you think it stalled>", "next": "<what you would try next, concretely, and why>"}. Be specific: parameters, symmetries, numbers.`
  );
}

export function parsePageDraft(text: string): PageDraft | null {
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "");
    const ok = (x: unknown, n: number) => (typeof x === "string" && x.trim().length >= n ? x.trim() : null);
    const h = ok(j.headline, 10), t = ok(j.tried, 20), st = ok(j.stalled, 10), nx = ok(j.next, 10);
    return h && t && st && nx ? { headline: h.length <= 200 ? h : h.slice(0, 198).replace(/\s+\S*$/, "") + "…", tried: t.slice(0, 4000), stalled: st.slice(0, 4000), next: nx.slice(0, 4000) } : null;
  } catch { return null; }
}

// A plain page when the model can't write one (a small model that won't answer in JSON): the
// attempts themselves are still worth keeping for the next agent
export function fallbackPage(p: SolverProblem, tried: Attempt[], model: string): PageDraft {
  const valid = tried.filter(t => /^valid/.test(t.result));
  return {
    headline: cut(`${tried.length} programs from ${model}${valid.length ? `, ${valid.length} valid` : ", none valid"}; none beat ${p.record ? p.record.score : "an empty board"}`, 190),
    tried: tried.filter(t => t.idea !== "(no program)").map(t => `${t.idea}: ${t.result}`).join("\n").slice(0, 4000),
    stalled: valid.length ? "The valid programs didn't improve on the record." : "The programs didn't produce valid solutions: see the verifier's reasons above.",
    next: "Start from the record's solution and make small, verified changes; read the verifier's reasons for what was rejected.",
  };
}

// Models on an OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM, or a hosted one)
// How many tokens a local model has loaded, from LM Studio's own API (GET /api/v0/models/<id>);
// null when the server doesn't say (another server, an older LM Studio)
export async function localContext(base: string, model: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const root = base.replace(/\/+$/, "").replace(/\/v1$/, "");
    const r = await fetch(`${root}/api/v0/models/${encodeURIComponent(model)}`, { signal: signal ?? AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const n = Number(j?.loaded_context_length ?? j?.max_context_length);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

export async function listModels(base: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
  const r = await fetch(`${base.replace(/\/+$/, "")}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal });
  if (!r.ok) throw new Error(`MODELS_${r.status}`);
  const j: any = await r.json();
  return (j?.data ?? []).map((m: any) => String(m.id)).filter((id: string) => id && !/embed/i.test(id));
}

// One request to such a server. The reply is streamed, so a slow local model isn't cut off waiting
// for its first byte, and `onText` can show it as it comes.
export async function askOpenAI(o: { base: string; model: string; prompt: string; apiKey?: string; maxTokens?: number; signal?: AbortSignal; onText?: (soFar: string) => void }): Promise<string> {
  const r = await fetch(`${o.base.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
    body: JSON.stringify({ model: o.model, max_tokens: o.maxTokens ?? 8000, stream: true, messages: [{ role: "user", content: o.prompt }] }),
    signal: o.signal,
  });
  if (!r.ok || !r.body) throw new Error(`model: ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
  let out = "", buf = "", thought = "";
  const dec = new TextDecoder();
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return withoutThinking(out);
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta ?? {};
        const d = delta.content ?? "";
        if (d) { out += d; o.onText?.(out); }
        // a thinking model that the server reports apart from its answer (LM Studio, llama.cpp, OpenRouter)
        else if (delta.reasoning_content || delta.reasoning) { thought += String(delta.reasoning_content || delta.reasoning); if (!out) o.onText?.(`(thinking… ${thought.length} characters so far)`); }
      } catch {}
    }
  }
  return withoutThinking(out);
}

// A thinking model's reasoning, when it comes inline: its drafts would otherwise be read as the answer.
// Cut off while still thinking, it gave no answer at all.
export function withoutThinking(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = t.indexOf("<think>");
  return (open >= 0 ? t.slice(0, open) : t).replace(/^[\s\S]*?<\/think>/, "").trim();
}
