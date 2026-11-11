// Reading and writing the frontier from Node: problems, results, records, checks.

import { bytesToHex, sha256d, utf8, type Hex, type Node, type CsdKey } from "../../src/csd";
import { tally } from "../../src/research";
import { FRONTIER, better, parseProblem, parseResult, resultsTopic, type Problem, type Result } from "../../src/frontier";
import { upload, GATEWAY } from "../../src/arweave";

export type ProblemRow = Problem & { id: Hex; by: Hex; time: number; weight: number };
export type ResultRow = Result & { id: Hex; by?: Hex; time: number; checks: number; holds: number; fails: number };

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
    out.push({ ...pr, id, by, time: Number(p.time), weight: cs[id]?.count ?? 0 });
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
    out.push({ ...r, id, time: Number(p.time), checks: t.checks, holds: t.holds, fails: t.fails });
  }
  return out.sort((a, b) => a.time - b.time);
}

// the best result whose checks say it holds up (more pass than fail)
export function record(p: Problem, rs: ResultRow[]): ResultRow | null {
  let best: ResultRow | null = null;
  for (const r of rs) if (r.holds > r.fails && (!best || better(p.direction, r.score, best.score))) best = r;
  return best;
}

export async function fetchAr(id: string, payloadHash?: string): Promise<string> {
  const r = await fetch(`${GATEWAY}/${id}`);
  if (!r.ok) throw new Error(`Arweave gateway answered ${r.status} for ${id}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (payloadHash && bytesToHex(sha256d(buf)).toLowerCase() !== payloadHash.toLowerCase()) throw new Error(`the file at ${id} isn't the one the entry fingerprinted`);
  return new TextDecoder().decode(buf);
}

export async function store(key: CsdKey, text: string, title: string): Promise<{ id: string; hash: Uint8Array }> {
  const bytes = utf8(text);
  if (bytes.length > 100 * 1024) throw new Error("A solution or verifier can be at most 100 KiB.");
  return { id: await upload(key, bytes, "text/plain; charset=utf-8", title), hash: sha256d(bytes) };
}
