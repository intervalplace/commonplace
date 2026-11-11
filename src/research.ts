// The research memory: findings kept by agents (or people) and checked by others.
//
// A finding is an entry under a topic `research.<subject>`, with `uri`
//   cp:finding:<source url>\n<claim>\n> <quote>
// where the quote is the passage in the source that the claim rests on (it may be left out), and
// `payload_hash` = sha256d(everything after "cp:finding:"). Commonplace shows it like any entry.
//
// A check is an attestation on a finding: score 100 if it holds up, 0 if it doesn't, and a
// confidence from 0 to 100. Its fee (0.05 CSD at least) is its weight. Anyone checking can read
// the source and see whether the quote is there and the claim follows from it; a wrong check is
// public and kept for good, under the checker's key.

import { EPOCH_LEN, MAX_URI_BYTES, sha256d, utf8, type Hex } from "./csd";
import { KEEP_EPOCHS } from "./entries";

export const RESEARCH = "research.";
export const FINDING = "cp:finding:";
export const HOLDS = 100, FAILS = 0;
export const isResearch = (topic: string) => topic.startsWith(RESEARCH) && topic.length > RESEARCH.length;
export const subjectOf = (topic: string) => topic.slice(RESEARCH.length);
export const topicFor = (subject: string) => RESEARCH + subject.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "");

export type Finding = { source: string; claim: string; quote?: string };

export function findingUri(f: Finding): string {
  const claim = f.claim.replace(/\s+/g, " ").trim();
  const quote = f.quote?.replace(/\s+/g, " ").trim();
  return `${FINDING}${f.source.trim()}\n${claim}${quote ? `\n> ${quote}` : ""}`;
}

export function parseFinding(uri: string): Finding | null {
  if (!uri.startsWith(FINDING)) return null;
  const [source, claim, ...rest] = uri.slice(FINDING.length).split("\n");
  if (!/^https?:\/\/\S+$/.test(source ?? "") || !claim) return null;
  const q = rest.join(" ").replace(/^>\s?/, "").trim();
  return { source, claim, quote: q || undefined };
}

// what's wrong with a finding before it's kept, or null if it's fine
export function findingProblem(f: Finding): string | null {
  if (!/^https?:\/\/\S+$/.test(f.source.trim())) return "The source must be an http(s) link.";
  if (f.claim.trim().length < 10) return "The claim is too short to mean anything.";
  if (/\n/.test(f.claim)) return "The claim must be one line.";
  const over = utf8(findingUri(f)).length - MAX_URI_BYTES;
  if (over > 0) return `It is ${over} bytes too long: a finding holds 512 bytes with its source and quote. Shorten the quote or the claim.`;
  return null;
}

export function findingArgs(f: Finding, topic: string, height: number) {
  const uri = findingUri(f);
  return { kind: "propose" as const, domain: topic, payloadHash: sha256d(utf8(uri.slice(FINDING.length))), uri, expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS };
}

export function checkArgs(id: Hex, holds: boolean, confidence: number) {
  return { kind: "attest" as const, proposalId: id, score: holds ? HOLDS : FAILS, confidence: Math.max(0, Math.min(100, Math.round(confidence))) };
}

// from a topic's attestation totals: how many checked, and how many said it holds up. A resonance
// from Commonplace (score 1) counts as a reader's mark, not a check.
export function tally(count: number, scoreSum: number) {
  const holds = Math.floor(scoreSum / HOLDS);
  const marks = scoreSum % HOLDS; // score-1 resonances, as long as there are fewer than 100
  const checks = Math.max(0, count - marks);
  return { checks, holds: Math.min(holds, checks), fails: Math.max(0, checks - holds), marks };
}
