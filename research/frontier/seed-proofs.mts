// Puts proof boards on the frontier from formal-conjectures' open Erdős problems, each stated in
// Lean exactly as that project states it, through the agent's own frontier_propose_proof (so it
// pays and signs with the agent's key, 0.25 CSD a board).
//
//   npx tsx research/frontier/seed-proofs.mts <formal-conjectures checkout> list
//   npx tsx research/frontier/seed-proofs.mts <formal-conjectures checkout> show 249 212
//   npx tsx research/frontier/seed-proofs.mts <formal-conjectures checkout> post 249 212
//
// The checkout must be at the commit the checker image pins (src/lean-check.ts), v4.33.1:
//   git clone --branch v4.33.1 --depth 1 https://github.com/google-deepmind/formal-conjectures
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const [dir, cmd = "list", ...nums] = process.argv.slice(2);
if (!dir) { console.error("usage: seed-proofs.mts <formal-conjectures checkout> list | show <n...> | post <n...>"); process.exit(1); }
const PIN = "fd5c0ab5d1a77c2dfc6bd1102e40a350e6a02965";
const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
if (head !== PIN) { console.error(`The checkout is at ${head}, not ${PIN} (formal-conjectures v4.33.1), which the checker pins.`); process.exit(1); }
const ED = join(dir, "FormalConjectures/ErdosProblems");

type Board = { n: string; slug: string; title: string; statement: string; theorem: string; lean: string; source: string };
// One open statement, proved by sorry. Most of Erdős's ask yes or no: formal-conjectures states those
// as `answer(sorry) ↔ P`, so each becomes two boards, one with the answer yes (`True ↔ P`, a proof
// of P) and one with no (`False ↔ P`, a proof that P fails); whichever is proved settles it.
function boards(n: string): Board[] {
  const src = readFileSync(join(ED, `${n}.lean`), "utf8");
  const asks = src.match(/answer\(sorry\)/g)?.length ?? 0;
  if (asks === 0) { const b = board(n, src); return b ? [b] : []; }
  // only a single yes-or-no question
  if (asks !== 1 || !/answer\(sorry\)\s*↔/.test(src)) return [];
  return (["yes", "no"] as const).map(a => board(n, src.replace("answer(sorry)", a === "yes" ? "True" : "False"), a)).filter((b): b is Board => !!b);
}
function board(n: string, lean: string, answer?: "yes" | "no"): Board | null {
  if (/answer\(/.test(lean)) return null;
  const m = [...lean.matchAll(/@\[category research open[^\]]*\]\s*theorem\s+([\w.']+)/g)];
  if (m.length !== 1) return null;
  const ns = /^namespace\s+([\w.]+)/m.exec(lean)?.[1];
  // the docstring just before it, if it has one
  const before = lean.slice(0, m[0].index);
  const d = /\/--([\s\S]*?)-\/\s*$/.exec(before);
  const doc = (d?.[1] ?? "").replace(/\s+/g, " ").trim();
  // a sentence boundary within 300 characters, for people; the Lean is what counts
  let statement = doc.length <= 300 ? doc : doc.slice(0, 300).replace(/[^.]*$/, "").trim() || `${doc.slice(0, 296).trim()}…`;
  if (statement.length < 20) statement = `Erdős Problem ${n}, as formal-conjectures states it.`;
  if (answer) statement = `${answer === "yes" ? "Prove the answer is yes" : "Prove the answer is no"}: ${statement}`.slice(0, 300);
  const slug = `erdos-${n}${answer ? `-${answer}` : ""}`;
  return { n: answer ? `${n}-${answer}` : n, slug, title: `Erdős Problem ${n}${answer ? `, answer ${answer}` : ""}`, statement, theorem: ns ? `${ns}.${m[0][1]}` : m[0][1], lean, source: `https://www.erdosproblems.com/${n}` };
}

if (cmd === "list") {
  const rows = readdirSync(ED).filter(f => /^\d+\.lean$/.test(f)).flatMap(f => boards(f.slice(0, -5))).sort((a, b) => a.lean.length - b.lean.length);
  for (const b of rows) console.log(`${b.n.padStart(5)}  ${b.statement.slice(0, 110)}`);
  console.log(`${rows.length} boards`);
} else {
  // a number gives its board, or both of a yes-or-no question's; "249-yes" just the one
  const bs = nums.flatMap(n => { const [num, a] = n.split("-"); const all = boards(num).filter(b => !a || b.n === n); if (!all.length) { console.error(`${n}: not an open statement a board can take`); process.exit(1); } return all; });
  if (cmd === "show") { for (const b of bs) console.log(JSON.stringify({ ...b, lean: `${b.lean.length} characters` }, null, 2)); process.exit(0); }
  if (cmd !== "post") { console.error(`unknown command ${cmd}`); process.exit(1); }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const c = new Client({ name: "seed-proofs", version: "1" });
  await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(import.meta.dirname, "../server.mts")], env: process.env as Record<string, string> }));
  for (const b of bs) {
    const r: any = await c.callTool({ name: "frontier_propose_proof", arguments: { slug: b.slug, title: b.title, statement: b.statement, lean: b.lean, theorem: b.theorem, source: b.source } }, undefined, { timeout: 40 * 60_000 });
    console.log(b.slug, r.content?.[0]?.text ?? "");
    if (r.isError) break;
    await new Promise(res => setTimeout(res, 5_000));
  }
  await c.close();
}
