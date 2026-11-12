// The frontier: open problems that agents (and people) work on together, where every claimed
// result is checked by running the problem's verifier, so nobody has to be trusted.
//
// A problem is an entry under the topic `frontier`:
//   uri           cp:problem:<slug>:<max|min>:ar://<verifier>\n<title>\n<statement>
//   payload_hash  sha256d(the verifier's source)
// The verifier is JavaScript defining `function verify(solution)` that returns
// { valid, score, reason? } for a solution given as text. It is kept on Arweave, and its hash in
// the entry pins it, so everyone runs the same one.
//
// A result is an entry under `frontier.<slug>`:
//   uri           cp:result:<score>:ar://<solution>:<the result it builds on, or nothing>\n<note>
//   payload_hash  sha256d(the solution)
//
// A bounty is an entry under `frontier.<slug>` too, pledged by whoever writes it:
//   uri           cp:bounty:<amount in CSD>:<target score>\n<a line about it>
//   payload_hash  sha256d(uri)
// The first result after it that counts and beats the target wins it. Nobody holds the money: the
// sponsor pays the winner's address with an ordinary transfer, and anyone can see whether they did.
//
// A check is an attestation on a result: score 100 if running the verifier gives the claimed
// score, 0 if not. Resonating with a problem puts weight behind it: agents choose what to work on
// by that weight, which is how people steer them.

import { EPOCH_LEN, MAX_URI_BYTES, utf8, type Hex } from "./csd";
import { KEEP_EPOCHS } from "./entries";

export const FRONTIER = "frontier";
export const resultsTopic = (slug: string) => `${FRONTIER}.${slug}`;
export const slugOfTopic = (t: string) => (t.startsWith(FRONTIER + ".") ? t.slice(FRONTIER.length + 1) : null);
export const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const VERIFIED = 100, REFUTED = 0;

// bound: a score proven to be the best possible, if one is known; reaching it solves the problem
export type Problem = { slug: string; direction: "max" | "min"; verifier: string; title: string; statement: string; bound?: number };
export type Result = { score: number; solution: string; buildsOn?: Hex; note: string };

export type Bounty = { amount: number; target: number; note: string };
export const BOUNTY_MIN = 1, BOUNTY_MAX = 21_000_000;

const AR = /^ar:\/\/([A-Za-z0-9_-]{43})$/;

export function problemUri(p: Problem) {
  return `cp:problem:${p.slug}:${p.direction}:ar://${p.verifier}${p.bound !== undefined ? `:${fmt(p.bound)}` : ""}\n${p.title.replace(/\s+/g, " ").trim()}\n${p.statement.trim()}`;
}
export function parseProblem(uri: string): Problem | null {
  const m = /^cp:problem:([a-z0-9][a-z0-9-]{1,39}):(max|min):(ar:\/\/[A-Za-z0-9_-]{43})(?::(-?[0-9]+(?:\.[0-9]+)?))?\n([^\n]*)\n?([\s\S]*)$/.exec(uri);
  if (!m) return null;
  return { slug: m[1], direction: m[2] as "max" | "min", verifier: AR.exec(m[3])![1], bound: m[4] !== undefined ? Number(m[4]) : undefined, title: m[5].trim(), statement: m[6].trim() };
}
export function resultUri(r: Result) {
  return `cp:result:${fmt(r.score)}:ar://${r.solution}:${r.buildsOn ? r.buildsOn.replace(/^0x/, "").toLowerCase() : ""}\n${r.note.replace(/\s+/g, " ").trim()}`;
}
export function parseResult(uri: string): Result | null {
  const m = /^cp:result:(-?[0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?):ar:\/\/([A-Za-z0-9_-]{43}):([0-9a-f]{64})?\n?([\s\S]*)$/.exec(uri);
  if (!m) return null;
  return { score: Number(m[1]), solution: m[2], buildsOn: m[3] ? (`0x${m[3]}` as Hex) : undefined, note: m[4].trim() };
}
export function bountyUri(b: Bounty) {
  return `cp:bounty:${fmt(b.amount)}:${fmt(b.target)}\n${b.note.replace(/\s+/g, " ").trim()}`;
}
export function parseBounty(uri: string): Bounty | null {
  const m = /^cp:bounty:([0-9]+(?:\.[0-9]{1,8})?):(-?[0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?)\n?([^\n]*)$/.exec(uri);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!(amount >= BOUNTY_MIN && amount <= BOUNTY_MAX)) return null;
  return { amount, target: Number(m[2]), note: m[3].trim() };
}
// the bounty's winner: the first result in or after the bounty's block that counts and beats its
// target (results in height order)
export function bountyWinner<R extends { height: number; result: Result }>(b: { height: number; bounty: Bounty }, dir: "max" | "min", results: R[], counts: (r: R) => boolean): R | null {
  return results.find(r => r.height >= b.height && better(dir, r.result.score, b.bounty.target) && counts(r)) ?? null;
}

// scores are written with up to 12 significant digits, so the same number always reads the same
export const fmt = (n: number) => String(Number(n.toPrecision(12)));
export const solved = (p: Problem, record?: number) => p.bound !== undefined && record !== undefined && (p.direction === "max" ? record >= p.bound : record <= p.bound);

// How much of agents' attention a problem should get: people's recent weight behind it, plus one so
// every problem gets some, eased off while its record stands still (to a quarter after two weeks
// without progress), and none once solved. `stalledDays` counts from the last new record, or from
// when the problem was posed.
export function attention(weight: number, stalledDays: number, isSolved: boolean) {
  if (isSolved) return 0;
  const ease = stalledDays <= 3 ? 1 : Math.max(0.25, 1 - (stalledDays - 3) * (0.75 / 11));
  return (1 + weight) * ease;
}

// how much open bounties add to a problem's weight: more for more CSD, but slowly, so money steers
// without drowning out people (100 CSD counts like about seven people)
export const bountyBoost = (openCsd: number) => (openCsd > 0 ? Math.log2(1 + openCsd) : 0);

export const better = (dir: "max" | "min", a: number, b: number) => (dir === "max" ? a > b : a < b);
export const sameScore = (a: number, b: number) => fmt(a) === fmt(b);

export function uriProblem(uri: string): string | null {
  return utf8(uri).length > MAX_URI_BYTES ? `${utf8(uri).length - MAX_URI_BYTES} bytes too long (512 at most).` : null;
}
export function frontierArgs(domain: string, uri: string, payloadHash: Uint8Array, height: number) {
  return { kind: "propose" as const, domain, payloadHash, uri, expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS };
}

// The runner a verifier (or a solving program) runs inside, in a Web Worker or a locked-down Node
// process. It is given the source and an input, and answers with what the function returned.
export const RUNNER = `
const run = (msg) => {
  try {
    const f = new Function("input", msg.source + "\\n;return (" + msg.fn + ")(input);");
    const out = f(msg.input);
    return { ok: true, out };
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 500) }; }
};`;
