// Reading and writing the frontier from Node: problems, results, records, checks.

import { bytesToHex, sha256d, utf8, type Hex, type Node, type CsdKey } from "../../src/csd";
import { tally } from "../../src/research";
import { FRONTIER, better, parseProblem, parseResult, resultsTopic, sameScore, type Problem, type Result } from "../../src/frontier";
import { verifyNode } from "../../src/run-node";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { upload, fromGateways } from "../../src/arweave";

export type ProblemRow = Problem & { id: Hex; by: Hex; time: number; weight: number; hash: string };
export type ResultRow = Result & { id: Hex; by?: Hex; time: number; checks: number; holds: number; fails: number; hash: string };

export async function problems(api: Node): Promise<ProblemRow[]> {
  const [ps, cs] = await Promise.all([api.proposalsIn(FRONTIER, 500), api.checksIn(FRONTIER).catch(() => ({} as Record<string, { count: number }>))]);
  const out: ProblemRow[] = [];
  const seen = new Set<string>();
  for (const p of ps.sort((a, b) => Number(a.height) - Number(b.height))) {
    const pr = parseProblem(p.uri ?? "");
    if (!pr || seen.has(pr.slug)) continue; // the first problem with a slug keeps it
    seen.add(pr.slug);
    const id = p.proposal_id.toLowerCase() as Hex;
    const by = (await api.proposal(id))?.proposer?.toLowerCase() as Hex;
    out.push({ ...pr, id, by, time: Number(p.time), weight: cs[id]?.count ?? 0, hash: p.payload_hash });
  }
  return out;
}

export async function results(api: Node, slug: string): Promise<ResultRow[]> {
  const topic = resultsTopic(slug);
  const [ps, cs] = await Promise.all([api.proposalsIn(topic, 500), api.checksIn(topic).catch(() => ({} as Record<string, { count: number; scoreSum: number }>))]);
  const out: ResultRow[] = [];
  for (const p of ps) {
    const r = parseResult(p.uri ?? "");
    if (!r) continue;
    const id = p.proposal_id.toLowerCase() as Hex;
    const t = tally(cs[id]?.count ?? 0, cs[id]?.scoreSum ?? 0);
    out.push({ ...r, id, time: Number(p.time), checks: t.checks, holds: t.holds, fails: t.fails, hash: p.payload_hash });
  }
  return out.sort((a, b) => a.time - b.time);
}

// Each agent verifies results itself, by running the problem's verifier on the solution: what
// counts as the record is what it has seen verify, not what checks say (one person with many keys
// could stack checks). Results never change, so verdicts are kept on disk for good.
const VERDICTS = join(homedir(), ".commonplace-agent-verdicts.json");
let verdicts: Record<string, { ok: boolean; score: number }> | null = null;
const verifierText = new Map<string, Promise<string>>();
export async function verified(p: ProblemRow, r: ResultRow): Promise<boolean> {
  verdicts ??= (() => { try { return JSON.parse(readFileSync(VERDICTS, "utf8")); } catch { return {}; } })();
  const known = verdicts![r.id];
  if (known) return known.ok;
  let v = verifierText.get(p.id);
  if (!v) { v = fetchAr(p.verifier, p.hash); verifierText.set(p.id, v); v.catch(() => verifierText.delete(p.id)); }
  let ok = false, score = NaN;
  try {
    const out = await verifyNode(await v, await fetchAr(r.solution, r.hash));
    ok = out.valid && sameScore(out.score, r.score); score = out.score;
  } catch { return r.holds > r.fails; } // a gateway that didn't answer: fall back to the checks this time
  verdicts![r.id] = { ok, score };
  try { writeFileSync(VERDICTS, JSON.stringify(verdicts)); } catch {}
  return ok;
}
export async function verifiedRecords(p: ProblemRow, rs: ResultRow[]): Promise<ResultRow[]> {
  const out: ResultRow[] = [];
  for (const r of rs) if ((!out.length || better(p.direction, r.score, out[out.length - 1].score)) && await verified(p, r)) out.push(r);
  return out;
}
export async function verifiedRecord(p: ProblemRow, rs: ResultRow[]): Promise<ResultRow | null> {
  const recs = await verifiedRecords(p, rs);
  return recs[recs.length - 1] ?? null;
}

// the records over time: each result whose checks hold up that beat the one before
export function records(p: Problem, rs: ResultRow[]): ResultRow[] {
  const out: ResultRow[] = [];
  for (const r of rs) if (r.holds > r.fails && (!out.length || better(p.direction, r.score, out[out.length - 1].score))) out.push(r);
  return out;
}

// the best result whose checks say it holds up (more pass than fail)
export function record(p: Problem, rs: ResultRow[]): ResultRow | null {
  let best: ResultRow | null = null;
  for (const r of rs) if (r.holds > r.fails && (!best || better(p.direction, r.score, best.score))) best = r;
  return best;
}

export async function fetchAr(id: string, payloadHash?: string): Promise<string> {
  const r = await fromGateways(id).catch(e => { throw new Error(`No Arweave gateway has ${id} yet (${e.message}); a new upload can take a few minutes to appear.`); });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (payloadHash && bytesToHex(sha256d(buf)).toLowerCase() !== payloadHash.toLowerCase()) throw new Error(`the file at ${id} isn't the one the entry fingerprinted`);
  return new TextDecoder().decode(buf);
}

export async function store(key: CsdKey, text: string, title: string): Promise<{ id: string; hash: Uint8Array }> {
  const bytes = utf8(text);
  if (bytes.length > 100 * 1024) throw new Error("A solution or verifier can be at most 100 KiB.");
  return { id: await upload(key, bytes, "text/plain; charset=utf-8", title), hash: sha256d(bytes) };
}
