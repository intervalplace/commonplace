// The agent's own path to the checker (src/lean-check.ts), run in CI against the image just built:
// a proof written to a private temporary folder by one user and checked by the container's own user,
// as on any Linux machine. Each verdict is comparator's own line, not the linters' notes after it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkProof } from "../src/lean-check";
import { STANDARD_AXIOMS, type LeanChallenge } from "../src/frontier";

const dir = (k: string) => `lean/test/${k}`;
const c: LeanChallenge = {
  kind: "lean", toolchain: "leanprover/lean4:v4.33.1",
  library: { name: "formal_conjectures", git: "https://github.com/google-deepmind/formal-conjectures", rev: "2207c54d0dbe960de591d280f997b195bf3f6e28" },
  challenge: readFileSync(`${dir("good")}/Challenge.lean`, "utf8"), theorem: "CpTest.cp_test", axioms: STANDARD_AXIOMS,
};
const good = await checkProof(c, readFileSync(`${dir("good")}/Solution.lean`, "utf8"));
console.log("good:", good); assert.equal(good.valid, true, "a real proof, through the agent's path, is accepted");
const axiom = await checkProof(c, readFileSync(`${dir("axiom")}/Solution.lean`, "utf8"));
console.log("axiom:", axiom); assert.equal(axiom.valid, false); assert.equal(axiom.reason, "Illegal axiom detected: 'CpTest.cheat'", "and the reason is comparator's own");
const wrong = await checkProof(c, readFileSync(`${dir("wrong")}/Solution.lean`, "utf8"));
console.log("wrong:", wrong); assert.match(wrong.reason ?? "", /^Challenge and solution theorem statement do not match/);
const broken = await checkProof(c, readFileSync(`${dir("broken")}/Solution.lean`, "utf8"));
console.log("broken:", broken); assert.match(broken.reason ?? "", /Solution\.lean:\d+:\d+:.*decide/, "a proof that doesn't build says where, in Lean's words");
console.log("ok - the agent's path checks proofs on Linux, with comparator's reasons");
