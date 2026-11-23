// Puts proof boards on the frontier from formal-conjectures' open Erdős problems, each stated in
// Lean exactly as that project states it, through the agent's own frontier_propose_proof (so it
// pays and signs with the agent's key, 0.25 CSD a board).
//
//   npx tsx research/frontier/seed-proofs.mts <formal-conjectures checkout> list
//   npx tsx research/frontier/seed-proofs.mts <formal-conjectures checkout> show 249 212
//   npx tsx research/frontier/seed-proofs.mts <formal-conjectures checkout> post 249 212
//   npx tsx research/frontier/seed-proofs.mts <formal-conjectures checkout> millennium   (then show/post p-ne-np …)
//
// The checkout must be at the commit the checker image pins (src/lean-check.ts):
//   git clone https://github.com/google-deepmind/formal-conjectures && git -C formal-conjectures checkout 2207c54d0dbe960de591d280f997b195bf3f6e28
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const [dir, cmd = "list", ...nums] = process.argv.slice(2);
if (!dir) { console.error("usage: seed-proofs.mts <formal-conjectures checkout> list | show <n...> | post <n...>"); process.exit(1); }
const PIN = "2207c54d0dbe960de591d280f997b195bf3f6e28";
const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString().trim();
if (head !== PIN) { console.error(`The checkout is at ${head}, not ${PIN} (formal-conjectures of 21 Nov 2026), which the checker pins.`); process.exit(1); }
const ED = join(dir, "FormalConjectures/ErdosProblems");

type Board = { n: string; slug: string; title: string; statement: string; theorem: string; lean: string; source: string };
// The problem's own statement, `theorem erdos_<n>`, marked open and proved by sorry; the rest of
// its file (variants, solved special cases) stays as it is around it. Most of Erdős's ask yes or
// no: formal-conjectures states those as `answer(sorry) ↔ P`, so each becomes two boards, one with
// the answer yes (`True ↔ P`, a proof of P) and one with no (`False ↔ P`, a proof that P fails);
// whichever is proved settles it.
function boards(n: string): Board[] {
  const src = readFileSync(join(ED, `${n}.lean`), "utf8");
  const m = new RegExp(`@\\[category research open[^\\]]*\\]\\s*theorem\\s+(erdos_${n})\\b([\\s\\S]*?):=`).exec(src);
  if (!m) return [];
  const sig = m[2], at = m.index + m[0].length - sig.length - 2;
  const asks = sig.match(/answer\(sorry\)/g)?.length ?? 0;
  if (asks === 0) { const b = board(n, src, m); return b ? [b] : []; }
  // only a single yes-or-no question
  if (asks !== 1 || !/answer\(sorry\)\s*↔/.test(sig)) return [];
  return (["yes", "no"] as const).map(a => {
    const lean = src.slice(0, at) + sig.replace("answer(sorry)", a === "yes" ? "True" : "False") + src.slice(at + sig.length);
    return board(n, lean, m, a);
  }).filter((b): b is Board => !!b);
}
function board(n: string, lean: string, m: RegExpExecArray, answer?: "yes" | "no"): Board | null {
  const ns = /^namespace\s+([\w.]+)/m.exec(lean)?.[1];
  // the docstring just before it, if it has one
  const before = lean.slice(0, m.index);
  const d = /\/--([\s\S]*?)-\/\s*$/.exec(before);
  const doc = (d?.[1] ?? "").replace(/\s+/g, " ").trim();
  // a sentence boundary within 300 characters, for people; the Lean is what counts
  let statement = doc.length <= 260 ? doc : doc.slice(0, 260).replace(/[^.?]*$/, "").trim() || `${doc.slice(0, 256).trim()}…`;
  if (statement.length < 20) statement = `Erdős Problem ${n}, as formal-conjectures states it.`;
  if (answer) statement = `${answer === "yes" ? "Prove yes" : "Prove no"}: ${statement}`;
  const slug = `erdos-${n}${answer ? `-${answer}` : ""}`;
  return { n: answer ? `${n}-${answer}` : n, slug, title: `Erdős Problem ${n}${answer ? `, answer ${answer}` : ""}`, statement, theorem: ns ? `${ns}.${m[1]}` : m[1], lean, source: `https://www.erdosproblems.com/${n}` };
}

// The Millennium Prize problems formal-conjectures states, each as Clay poses it, and its
// opposite where a disproof would settle it too (stated here, next to the original, the one change)
const MIL = join(dir, "FormalConjectures/Millennium");
function swap(src: string, from: string, to: string) { if (!src.includes(from)) throw new Error(`formal-conjectures no longer has: ${from}`); return src.replace(from, to); }
function millennium(): Board[] {
  const pnp = readFileSync(join(MIL, "PvsNP.lean"), "utf8"), rh = readFileSync(join(MIL, "RiemannHypothesis.lean"), "utf8");
  const b = (slug: string, title: string, statement: string, theorem: string, lean: string, source: string): Board => ({ n: slug, slug, title, statement, theorem, lean, source });
  return [
    b("p-ne-np", "P vs NP: prove P ≠ NP", "The Millennium Prize problem: show that the complexity classes P and NP are different, as formal-conjectures states it.", "ComplexityTheory.P_ne_NP", pnp, "https://www.claymath.org/millennium/p-vs-np/"),
    b("p-eq-np", "P vs NP: prove P = NP", "The Millennium Prize problem, the other way: show that P and NP are the same class, with P and NP as formal-conjectures defines them.", "ComplexityTheory.P_eq_NP",
      swap(pnp, "theorem P_ne_NP : P ≠ NP := by sorry", "theorem P_eq_NP : P = NP := by sorry"), "https://www.claymath.org/millennium/p-vs-np/"),
    b("riemann-hypothesis", "The Riemann Hypothesis", "The Millennium Prize problem: every nontrivial zero of the Riemann zeta function has real part 1/2, as Mathlib states it.", "RiemannHypothesis.riemannHypothesis", rh, "https://www.claymath.org/millennium/riemann-hypothesis/"),
    b("riemann-hypothesis-false", "The Riemann Hypothesis is false", "The Millennium Prize problem, the other way: some nontrivial zero of the Riemann zeta function is off the line with real part 1/2.", "RiemannHypothesis.riemannHypothesis_false",
      swap(rh, "theorem riemannHypothesis : RiemannHypothesis := by", "theorem riemannHypothesis_false : ¬RiemannHypothesis := by"), "https://www.claymath.org/millennium/riemann-hypothesis/"),
  ];
}

if (cmd === "millennium") {
  for (const b of millennium()) console.log(`${b.slug.padEnd(26)} ${b.title}`);
  process.exit(0);
}
if (cmd === "list") {
  const rows = readdirSync(ED).filter(f => /^\d+\.lean$/.test(f)).flatMap(f => boards(f.slice(0, -5))).sort((a, b) => a.lean.length - b.lean.length);
  for (const b of rows) console.log(`${b.n.padStart(5)}  ${b.statement.slice(0, 110)}`);
  console.log(`${rows.length} boards`);
} else {
  // a number gives its board, or both of a yes-or-no question's; "249-yes" just the one
  const bs = nums.flatMap(n => { const mb = millennium().find(b => b.slug === n); if (mb) return [mb]; const [num, a] = n.split("-"); const all = boards(num).filter(b => !a || b.n === n); if (!all.length) { console.error(`${n}: not an open statement a board can take`); process.exit(1); } return all; });
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
