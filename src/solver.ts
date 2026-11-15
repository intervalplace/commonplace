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
  notebook?: { page: string; headline: string; tried?: string; stalled?: string; next?: string; reached?: { score: number; verified?: boolean | null; has_solution?: boolean } | null }[];
};
export type Attempt = { idea: string; result: string };
export type ProgramReply = { code: string; idea: string; start?: string };
export type PageDraft = { headline: string; tried: string; stalled: string; next: string };

export const cut = (x: unknown, n: number) => { const t = String(x ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };

// The request for one program. `small`: a model with a small context window (a local one), for
// which the quoted files are trimmed harder
export function programPrompt(p: SolverProblem, tried: Attempt[], small = false): string {
  const room = (n: number) => (small ? Math.round(n / 3) : n);
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
    (p.recent?.length ? `Recent results by agents: ${p.recent.map(r => `${r.score}: ${r.note}`).join("; ")}\n` : "") +
    (p.notebook?.length ? `\nThe problem's notebook: what other agents tried that didn't set a record, newest first. Don't repeat their dead ends; build on the most promising lead.\n${p.notebook.slice(0, small ? 3 : 8).map(g =>
      `- page ${g.page}${g.reached ? ` (reached ${g.reached.score}${g.reached.verified ? ", verified" : ""}${g.reached.has_solution ? ", solution attached" : ""})` : ""}: ${g.headline}\n  tried: ${cut(g.tried, 700)}\n  stalled: ${cut(g.stalled, 400)}\n  next: ${cut(g.next, 400)}`).join("\n")}\n` : "") +
    (tried.length ? `Your attempts this run: ${tried.map(t => `${t.idea} -> ${t.result}`).join("; ")}\n` : "") +
    `\nWrite a JavaScript program defining function solve(best) that returns a solution string in the problem's format, ` +
    `aiming to beat the record. It runs in a sandbox with no network or files for at most 60 seconds, so it may search or optimise ` +
    `(use a seeded random generator, not Math.random, so results are repeatable). Build on what has worked. ` +
    `Answer with one line "IDEA: <the idea in under 150 characters>", then, if your program should start from a notebook page's attached solution instead of the record, a line "START: <page id>", then the program in a \`\`\`js block.`
  );
}

export function parseProgram(text: string): ProgramReply | null {
  const code = /```(?:js|javascript)?\n([\s\S]*?)```/.exec(text)?.[1];
  // the idea, cut at a word if it's long, so a result's note never ends mid-word
  const full = /IDEA:\s*(.+)/.exec(text)?.[1]?.trim() ?? "an improvement";
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
    tried: tried.map(t => `${t.idea}: ${t.result}`).join("\n").slice(0, 4000),
    stalled: valid.length ? "The valid programs didn't improve on the record." : "The programs didn't produce valid solutions: see the verifier's reasons above.",
    next: "Start from the record's solution and make small, verified changes; read the verifier's reasons for what was rejected.",
  };
}

// Models on an OpenAI-compatible server (LM Studio, Ollama, llama.cpp, vLLM, or a hosted one)
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
  let out = "", buf = "";
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
      if (data === "[DONE]") return out;
      try { const j = JSON.parse(data); const d = j.choices?.[0]?.delta?.content ?? ""; if (d) { out += d; o.onText?.(out); } } catch {}
    }
  }
  return out;
}
