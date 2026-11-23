// Proof boards' records: written and read back, a challenge's one canonical text, and boards that
// older clients (which read only cp:problem) skip rather than run as JavaScript.
import assert from "node:assert/strict";
import { PROVED, STANDARD_AXIOMS, leanChallengeText, parseLeanChallenge, parseProblem, problemUri, solved, type LeanChallenge } from "../src/frontier";

const ok = (c: unknown, m: string) => { assert.ok(c, m); console.log("ok -", m); };

const challenge: LeanChallenge = {
  kind: "lean", toolchain: "leanprover/lean4:v4.33.1",
  library: { name: "formal_conjectures", git: "https://github.com/google-deepmind/formal-conjectures", rev: "2207c54d0dbe960de591d280f997b195bf3f6e28" },
  challenge: "module\n\npublic import FormalConjecturesUtil\n\nnamespace Erdos1075\n\ntheorem erdos_1075 : True := by\n  sorry\n\nend Erdos1075\n",
  theorem: "Erdos1075.erdos_1075", axioms: STANDARD_AXIOMS, source: "https://www.erdosproblems.com/1075",
};
const text = leanChallengeText(challenge);
ok(JSON.stringify(parseLeanChallenge(text)) === JSON.stringify(challenge), "a challenge reads back as written");
ok(leanChallengeText(parseLeanChallenge(text)!) === text, "and its text is the same whoever writes it");
ok(parseLeanChallenge(JSON.stringify({ ...challenge, library: { ...challenge.library, rev: "v4.33.1" } })) === null, "a library pinned by a tag, not a commit: refused");
ok(parseLeanChallenge(JSON.stringify({ ...challenge, theorem: "foo; rm -rf /" })) === null, "a theorem name that isn't one: refused");
ok(parseLeanChallenge("function verify(s) { return { valid: true, score: 1 } }") === null, "a JavaScript verifier isn't a challenge");

const ar = "a".repeat(43);
const uri = problemUri({ slug: "erdos-1075", direction: "max", verifier: ar, title: "Erdős Problem 1075", statement: "Dense hypergraphs contain dense subgraphs.", bound: PROVED, kind: "lean" });
ok(uri.startsWith("cp:proof:erdos-1075:ar://"), "a board is written as cp:proof");
const p = parseProblem(uri)!;
ok(p.kind === "lean" && p.slug === "erdos-1075" && p.verifier === ar && p.direction === "max" && p.bound === PROVED, "and read back as a proof board");
ok(!solved(p, undefined) && solved(p, PROVED), "proved once a proof counts");
// what clients before proof boards matched problems with
const old = /^cp:problem:([a-z0-9][a-z0-9-]{1,39}):(max|min):(ar:\/\/[A-Za-z0-9_-]{43})(?::(-?[0-9]+(?:\.[0-9]+)?))?\n([^\n]*)\n?([\s\S]*)$/;
ok(!old.test(uri), "older clients don't see it as a problem, so they never run it as JavaScript");
const js = parseProblem(problemUri({ slug: "packing", direction: "min", verifier: ar, title: "A packing", statement: "Pack it tighter than anyone." }))!;
ok(js.kind === undefined && js.direction === "min", "ordinary problems are unchanged");

// without Docker (or the image), a proof can't be checked here: that's said, never called wrong
import { verifyNode } from "../src/run-node";
const v = await verifyNode(text, challenge.challenge);
if (v.unavailable) ok(!v.valid && /Docker|image/.test(v.reason ?? ""), `no Lean here: unavailable, not refused (${v.reason})`);
else ok(!v.valid && /sorry/i.test(v.reason ?? ""), "with Lean here: a sorry proof is refused");

// a yes-or-no question as two boards, each naming the other
const yes = { ...challenge, opposite: "erdos-1075-no" };
ok(parseLeanChallenge(leanChallengeText(yes))?.opposite === "erdos-1075-no", "a board names its other answer");
ok(parseLeanChallenge(JSON.stringify({ ...yes, opposite: "Not A Slug" }))?.opposite === undefined, "and only by a slug");
