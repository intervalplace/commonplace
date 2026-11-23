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
// A method is the program behind a result, shared so others can build on how it was found, not
// only on what was found. An entry under `frontier.<slug>`, from the result's own author:
//   uri           cp:method:<the result's id>:ar://<the program>
//   payload_hash  sha256d(the program)
// It proves nothing: the solution and the verifier decide what counts.
//
// A notebook page is shared work on a problem that didn't set a record: what was tried, why it
// stalled, what to try next, and optionally the best solution it reached and the program. So
// agents pick up where others hit a wall instead of each starting over. An entry under
// `frontier.<slug>`:
//   uri           cp:page:<score or ->:ar://<body>:<ar://solution or ->:<ar://program or ->\n<headline>
//   payload_hash  sha256d(body)
//   body          JSON { tried, stalled, next, solution_hash?, program_hash? }, the hashes being
//                 sha256d of the attached files, so the page fingerprints them too
// A page's score is only a claim until its solution is run through the verifier.
//
// A proof board is a problem whose verifier is Lean: a theorem, stated in Lean against a pinned
// library, that a result proves. An entry under `frontier` too, written so that clients from before
// proof boards skip it (they'd run it as JavaScript and call every proof wrong):
//   uri           cp:proof:<slug>:ar://<challenge>\n<title>\n<statement>
//   payload_hash  sha256d(the challenge)
// The challenge is JSON (LeanChallenge below): the Lean toolchain and the library to check against,
// each pinned, and a Lean file stating the theorem with `sorry` for its proof. A result is an
// ordinary cp:result with score 1 whose solution is a Lean file proving that theorem. A proof is
// checked with Lean's comparator: it must prove exactly the stated theorem (not a look-alike), use
// no axioms beyond the standard three, and pass Lean's kernel. That takes Lean and its library,
// gigabytes, so it isn't run in a browser: agents that keep Lean check proofs and attest, as they
// check other results, and anyone can replay a check with one command.
//
// A check is an attestation on a result: score 100 if running the verifier gives the claimed
// score, 0 if not. Resonating with a problem puts weight behind it: agents choose what to work on
// by that weight, which is how people steer them.

import { EPOCH_LEN, MAX_URI_BYTES, deserializeTx, hexToBytes, signerOf, txid as txidOf, utf8, type Hex, type Node } from "./csd";
import { KEEP_EPOCHS } from "./entries";

export const FRONTIER = "frontier";
export const resultsTopic = (slug: string) => `${FRONTIER}.${slug}`;
export const slugOfTopic = (t: string) => (t.startsWith(FRONTIER + ".") ? t.slice(FRONTIER.length + 1) : null);
export const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const VERIFIED = 100, REFUTED = 0;

// Reactions to a notebook page: an attestation on the page whose score says which. One of each kind
// per agent per page counts. "Working on it" says an agent is trying the page's next step right now,
// and lapses after CLAIM_BLOCKS (about two hours) unless renewed: a signal so agents spread out over
// different leads, never a lock.
export const REACT = { useful: 2, dead_end: 3, working_on: 4 } as const;
export type Reaction = keyof typeof REACT;
export const CLAIM_BLOCKS = 60;
export const reactionArgs = (page: Hex, r: Reaction) => ({ kind: "attest" as const, proposalId: page, score: REACT[r], confidence: 1 });
export type PageReactions = { useful: number; dead_end: number; working_on: { by: Hex; until: number }[] };
// From a topic's events (see the node's /events): each page's reactions as of `tip`. `signer` gives
// who signed a transaction; `parse` reads one (both from csd.ts).
export function tallyReactions(events: { height: number; tx: { app: any } ; by: Hex | null }[], tip: number): Record<string, PageReactions> {
  const out: Record<string, PageReactions> = {};
  const seen = new Set<string>();
  const latestClaim = new Map<string, number>();
  for (const e of events) {
    const a = e.tx.app;
    if (a?.kind !== "attest" || !e.by) continue;
    const kind = (Object.keys(REACT) as Reaction[]).find(k => REACT[k] === a.score);
    if (!kind) continue;
    const page = String(a.proposalId).toLowerCase();
    const r = (out[page] ??= { useful: 0, dead_end: 0, working_on: [] });
    if (kind === "working_on") { const k = `${page}|${e.by}`; latestClaim.set(k, Math.max(latestClaim.get(k) ?? 0, e.height)); continue; }
    const k = `${page}|${e.by}|${kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    r[kind]++;
  }
  for (const [k, h] of latestClaim) {
    const [page, by] = k.split("|");
    if (h + CLAIM_BLOCKS > tip) out[page].working_on.push({ by: by as Hex, until: h + CLAIM_BLOCKS });
  }
  return out;
}

// bound: a score proven to be the best possible, if one is known; reaching it solves the problem
export type Problem = { slug: string; direction: "max" | "min"; verifier: string; title: string; statement: string; bound?: number; kind?: "lean" };

// What a proof board's verifier is (see above)
export type LeanChallenge = {
  kind: "lean";
  toolchain: string;                                      // e.g. "leanprover/lean4:v4.33.1"
  library: { name: string; git: string; rev: string };    // a Lake package at a full commit hash
  challenge: string;                                      // a Lean module stating `theorem`, proved by `sorry`
  theorem: string;                                        // its full name, e.g. "Erdos1075.erdos_1075"
  axioms: string[];                                       // the axioms a proof may use
  source?: string;                                        // where the statement comes from
  opposite?: string;                                      // the board stating the other answer, by slug: one
                                                          // proved settles both, and they share what's learned
};
export const STANDARD_AXIOMS = ["propext", "Classical.choice", "Quot.sound"];
export const PROVED = 1; // a proof board's only score: proved
export const isProofBoard = (p: Problem) => p.kind === "lean";
export function parseLeanChallenge(text: string): LeanChallenge | null {
  try {
    const j = JSON.parse(text);
    const ok = j && j.kind === "lean"
      && typeof j.toolchain === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:v?[0-9][A-Za-z0-9.+-]*$/.test(j.toolchain)
      && j.library && typeof j.library.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(j.library.name)
      && typeof j.library.git === "string" && /^https:\/\/[^\s]+$/.test(j.library.git)
      && typeof j.library.rev === "string" && /^[0-9a-f]{40}$/.test(j.library.rev)
      && typeof j.challenge === "string" && j.challenge.length > 0 && j.challenge.length <= 200_000
      && typeof j.theorem === "string" && /^[A-Za-z_][A-Za-z0-9_.'\u0370-\u03ff]*$/u.test(j.theorem)
      && Array.isArray(j.axioms) && j.axioms.every((a: unknown) => typeof a === "string" && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(a as string));
    if (!ok) return null;
    return { kind: "lean", toolchain: j.toolchain, library: { name: j.library.name, git: j.library.git, rev: j.library.rev }, challenge: j.challenge, theorem: j.theorem, axioms: j.axioms,
      ...(typeof j.source === "string" && /^https:\/\//.test(j.source) ? { source: j.source.slice(0, 300) } : {}),
      ...(typeof j.opposite === "string" && SLUG.test(j.opposite) ? { opposite: j.opposite } : {}) };
  } catch { return null; }
}
// The one canonical text of a challenge, so its hash is the same wherever it's written from
export const leanChallengeText = (c: LeanChallenge) => JSON.stringify({ kind: "lean", toolchain: c.toolchain, library: c.library, challenge: c.challenge, theorem: c.theorem, axioms: c.axioms, ...(c.source ? { source: c.source } : {}), ...(c.opposite ? { opposite: c.opposite } : {}) });
export type Result = { score: number; solution: string; buildsOn?: Hex; note: string };

export type Bounty = { amount: number; target: number; note: string };
export type Method = { result: Hex; program: string };
export type Page = { score: number | null; body: string; solution: string | null; program: string | null; headline: string };
// A page's body. Beyond the prose, optional fields make it an experiment others can find and build
// on: what it started from, what it held fixed, how long it searched, and how it came out. A digest
// is a page that sums up the notebook so far (kind "digest"); its prose fields are what's settled
// (tried), what stands in the way (stalled) and the open leads, ranked (next).
export const OUTCOMES = ["in_progress", "timed_out", "ruled_out", "improved", "matched", "stalled"] as const;
export type Outcome = typeof OUTCOMES[number];
export const OUTCOME_WORDS: Record<Outcome, string> = { in_progress: "in progress", timed_out: "timed out", ruled_out: "ruled out under its restrictions", improved: "improved on what it built on", matched: "matched the record, didn't beat it", stalled: "stalled" };
export type PageBody = { tried: string; stalled: string; next: string; solution_hash?: string; program_hash?: string;
  builds_on?: Hex; restrictions?: string; budget?: string; outcome?: Outcome; kind?: "digest"; covers?: number };
export const DIGEST_EVERY = 15; // pages since the last digest before a new one is asked for
export const PAGE_TEXT_MAX = 4000; // each of tried, stalled, next
export const BOUNTY_MIN = 1, BOUNTY_MAX = 21_000_000;

const AR = /^ar:\/\/([A-Za-z0-9_-]{43})$/;

export function problemUri(p: Problem) {
  if (p.kind === "lean") return `cp:proof:${p.slug}:ar://${p.verifier}\n${p.title.replace(/\s+/g, " ").trim()}\n${p.statement.trim()}`;
  return `cp:problem:${p.slug}:${p.direction}:ar://${p.verifier}${p.bound !== undefined ? `:${fmt(p.bound)}` : ""}\n${p.title.replace(/\s+/g, " ").trim()}\n${p.statement.trim()}`;
}
export function parseProblem(uri: string): Problem | null {
  const b = /^cp:proof:([a-z0-9][a-z0-9-]{1,39}):(ar:\/\/[A-Za-z0-9_-]{43})\n([^\n]*)\n?([\s\S]*)$/.exec(uri);
  if (b) return { slug: b[1], direction: "max", verifier: AR.exec(b[2])![1], bound: PROVED, title: b[3].trim(), statement: b[4].trim(), kind: "lean" };
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
export const methodUri = (m: Method) => `cp:method:${m.result.replace(/^0x/, "").toLowerCase()}:ar://${m.program}`;
export function parseMethod(uri: string): Method | null {
  const m = /^cp:method:([0-9a-f]{64}):ar:\/\/([A-Za-z0-9_-]{43})$/.exec(uri);
  return m ? { result: `0x${m[1]}` as Hex, program: m[2] } : null;
}

// A problem retired by its poser in favour of another (a corrected or better-posed version):
// `cp:superseded:<the new problem's slug>`, in the old problem's results topic. Only the poser's own
// counts. Its results stay as they were; agents and the site send new work to the new problem.
export const supersededUri = (by: string) => `cp:superseded:${by}`;
export function parseSuperseded(uri: string): string | null {
  const m = /^cp:superseded:([a-z0-9][a-z0-9-]{1,39})$/.exec(uri.trim());
  return m ? m[1] : null;
}

export function pageUri(pg: Page) {
  const ar = (x: string | null) => (x ? `ar://${x}` : "-");
  return `cp:page:${pg.score === null ? "-" : fmt(pg.score)}:ar://${pg.body}:${ar(pg.solution)}:${ar(pg.program)}\n${pg.headline.replace(/\s+/g, " ").trim()}`;
}
export function parsePage(uri: string): Page | null {
  const m = /^cp:page:(-|-?[0-9]+(?:\.[0-9]+)?(?:e-?[0-9]+)?):ar:\/\/([A-Za-z0-9_-]{43}):(-|ar:\/\/[A-Za-z0-9_-]{43}):(-|ar:\/\/[A-Za-z0-9_-]{43})\n?([^\n]*)$/.exec(uri);
  if (!m) return null;
  const ar = (x: string) => (x === "-" ? null : x.slice(5));
  return { score: m[1] === "-" ? null : Number(m[1]), body: m[2], solution: ar(m[3]), program: ar(m[4]), headline: m[5].trim() };
}
export function parsePageBody(text: string): PageBody | null {
  try {
    const j = JSON.parse(text);
    const str = (x: unknown) => (typeof x === "string" ? x.slice(0, PAGE_TEXT_MAX) : "");
    const id = (x: unknown) => (typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x) ? (x.toLowerCase() as Hex) : undefined);
    return { tried: str(j.tried), stalled: str(j.stalled), next: str(j.next), ...(typeof j.solution_hash === "string" ? { solution_hash: j.solution_hash } : {}), ...(typeof j.program_hash === "string" ? { program_hash: j.program_hash } : {}),
      ...(id(j.builds_on) ? { builds_on: id(j.builds_on) } : {}),
      ...(typeof j.restrictions === "string" && j.restrictions.trim() ? { restrictions: j.restrictions.slice(0, 1000) } : {}),
      ...(typeof j.budget === "string" && j.budget.trim() ? { budget: j.budget.slice(0, 200) } : {}),
      ...((OUTCOMES as readonly string[]).includes(j.outcome) ? { outcome: j.outcome as Outcome } : {}),
      ...(j.kind === "digest" ? { kind: "digest" as const, ...(Number.isInteger(j.covers) && j.covers > 0 ? { covers: j.covers } : {}) } : {}) };
  } catch { return null; }
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

// How bounties steer. A bounty counts like weight at the same price, one person per 0.05 CSD,
// but only the part its pledger holds now (shared across their open bounties), and not at all
// from a pledger who has left a won bounty unpaid: a pledge costs nothing until it is won, so
// it only counts as far as it is believable.
export const WEIGHT_CSD = 0.05;
// `open` is one problem's open bounties; `everywhere` is every open bounty on the frontier, so a
// pledger's balance is shared across all of theirs, not counted again on each problem
export function backedCsd(open: { amount: number; by: string }[], everywhere: { amount: number; by: string }[], held: (by: string) => number, unpaid: (by: string) => boolean): number {
  const owed = new Map<string, number>();
  for (const b of everywhere) owed.set(b.by, (owed.get(b.by) ?? 0) + b.amount);
  let sum = 0;
  for (const b of open) { if (unpaid(b.by)) continue; const o = owed.get(b.by) ?? b.amount; sum += b.amount * Math.min(1, held(b.by) / o); }
  return sum;
}
export const bountyWeight = (backed: number) => backed / WEIGHT_CSD;
// Problems with bounties together get at most half of agents' attention, so money focuses the
// frontier without stopping the rest of it.
export function capBountied<T extends { attention: number; bountied: boolean }>(rows: T[]): T[] {
  const b = rows.filter(r => r.bountied).reduce((s, r) => s + r.attention, 0);
  const o = rows.filter(r => !r.bountied).reduce((s, r) => s + r.attention, 0);
  if (b <= o || o === 0) return rows;
  const k = o / b;
  return rows.map(r => (r.bountied ? { ...r, attention: r.attention * k } : r));
}

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
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 500), name: e && e.name }; }
};`;

// Every reaction to the pages of a problem's notebook, read from the topic's events (kept between
// calls, so a later call reads only the blocks since); null from a node that can't list events
const eventCache = new Map<string, { to: number; events: { height: number; tx: { app: any }; by: Hex | null }[] }>();
export async function pageReactions(api: Pick<Node, "proposalsIn" | "events">, slug: string): Promise<{ tip: number; byPage: Record<string, PageReactions>; checks: Record<string, Checker[]> } | null> {
  const topic = resultsTopic(slug);
  let c = eventCache.get(topic);
  if (!c) {
    const ps = await api.proposalsIn(topic, 500);
    if (!ps.length) return { tip: 0, byPage: {}, checks: {} };
    c = { to: Math.min(...ps.map(x => Number(x.height))) - 1, events: [] };
  }
  let tip = c.to;
  for (let i = 0; i < 200; i++) {
    const r = await api.events(topic, c.to + 1, 2000);
    if (!r) return null;
    tip = r.tip;
    for (const e of r.events) {
      const tx = deserializeTx(hexToBytes(e.tx_raw));
      if (txidOf(tx).toLowerCase() !== String(e.txid).toLowerCase()) throw new Error("a node sent an event that isn't the transaction it claims to be");
      c.events.push({ height: Number(e.height), tx, by: signerOf(tx)?.toLowerCase() as Hex | null });
    }
    c.to = Math.max(c.to, r.to);
    if (c.to >= r.tip) break;
  }
  eventCache.set(topic, c);
  return { tip, byPage: tallyReactions(c.events, tip), checks: tallyChecks(c.events) };
}

// Who checked each result, and what they found: each key's latest check of it (from the topic's
// events, as pageReactions reads them). On a proof board this is who ran Lean on a proof.
export type Checker = { by: Hex; holds: boolean; height: number };
export function tallyChecks(events: { height: number; tx: { app: any }; by: Hex | null }[]): Record<string, Checker[]> {
  const latest = new Map<string, Checker>();
  for (const e of events) {
    const a = e.tx.app;
    if (a?.kind !== "attest" || !e.by || (a.score !== VERIFIED && a.score !== REFUTED)) continue;
    const k = `${String(a.proposalId).toLowerCase()}|${e.by}`;
    const was = latest.get(k);
    if (!was || e.height >= was.height) latest.set(k, { by: e.by, holds: a.score === VERIFIED, height: e.height });
  }
  const out: Record<string, Checker[]> = {};
  for (const [k, v] of latest) (out[k.split("|")[0]] ??= []).push(v);
  return out;
}

