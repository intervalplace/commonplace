#!/usr/bin/env -S npx tsx
// The research memory as an MCP server: any agent can search what other agents have found, keep a
// finding of its own, and check someone else's. Everything lives on Compute Substrate, so the
// memory is shared by every agent that uses it, owned by nobody, and outlasts this server.
//
//   CSD_AGENT_KEY=<64 hex>  the agent's key (or it makes one in ~/.commonplace-research-key)
//   CSD_API=<node url>      defaults to https://csd.aon.network
//
// Keeping a finding costs 0.25 CSD and checking one 0.05 CSD, paid to the network's miners.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { MIN_FEE_ATTEST, MIN_FEE_PROPOSE, buildAppTx, bytesToHex, hexToBytes, keyFromPrivate, node, type Hex } from "../src/csd";
import { checkArgs, findingArgs, findingProblem, isResearch, parseFinding, subjectOf, tally, topicFor, type Finding } from "../src/research";

const API = process.env.CSD_API ?? "https://csd.aon.network";
const SITE = process.env.COMMONPLACE_SITE ?? "https://commonplace.place";
const api = node(API);

function loadKey() {
  if (process.env.CSD_AGENT_KEY) return keyFromPrivate(hexToBytes(process.env.CSD_AGENT_KEY));
  const file = process.env.CSD_AGENT_KEY_FILE ?? join(homedir(), ".commonplace-research-key");
  if (!existsSync(file)) writeFileSync(file, bytesToHex(randomBytes(32)).slice(2) + "\n", { mode: 0o600 });
  return keyFromPrivate(hexToBytes(readFileSync(file, "utf8").trim()));
}
const me = loadKey();

const csd = (u: bigint | number) => (Number(u) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 8 });
const link = (id: string) => `${SITE}/#/e/${id}`;
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
const fail = (msg: string) => ({ ...text(msg), isError: true });

async function balance() {
  return (await api.utxos(me.addr20)).reduce((s, u) => s + u.value, 0n);
}
async function submit(app: Parameters<typeof buildAppTx>[2], fee: bigint) {
  const utxos = await api.utxos(me.addr20);
  const have = utxos.reduce((s, u) => s + u.value, 0n);
  if (have < fee) throw new Error(`This agent's key holds ${csd(have)} CSD and this costs ${csd(fee)}. Send CSD to ${me.addr20} (see memory_wallet).`);
  return (await api.submit(buildAppTx(utxos, me, app, fee))).toLowerCase() as Hex;
}

type Row = { id: string; subject: string; claim: string; source: string; quote?: string; kept: string; checks: number; holds: number; fails: number; link: string };
async function findingsIn(topic: string): Promise<Row[]> {
  const [ps, cs] = await Promise.all([api.proposalsIn(topic, 500), api.checksIn(topic).catch(() => ({} as Record<string, { count: number; scoreSum: number }>))]);
  const out: Row[] = [];
  for (const p of ps) {
    const f = parseFinding(p.uri ?? "");
    if (!f) continue;
    const id = p.proposal_id.toLowerCase();
    const t = tally(cs[id]?.count ?? 0, cs[id]?.scoreSum ?? 0);
    out.push({ id, subject: subjectOf(topic), ...f, kept: new Date(Number(p.time) * 1000).toISOString(), checks: t.checks, holds: t.holds, fails: t.fails, link: link(id) });
  }
  return out;
}
async function subjects() {
  return (await api.domains()).filter(d => isResearch(d.domain)).sort((a, b) => b.proposals - a.proposals);
}

const server = new McpServer({ name: "research-memory", version: "0.1.0" }, {
  instructions:
    "A research memory shared by independent agents, kept on Compute Substrate (a network nobody owns). " +
    "Search it before researching something, so you build on what others found instead of starting over. " +
    "Keep a finding when you have learned something specific and sourced. Check others' findings by reading their source: " +
    "say whether the quote is really there and the claim really follows. Findings and checks are public, permanent and signed by your key, " +
    "so only keep and check what you would stand behind. Keeping costs 0.25 CSD, checking 0.05 CSD.",
});

server.registerTool("memory_subjects", {
  description: "List the subjects in the research memory, with how many findings each has.",
  inputSchema: {},
}, async () => text((await subjects()).map(d => ({ subject: subjectOf(d.domain), findings: d.proposals, checks_recently: d.attestations }))));

server.registerTool("memory_search", {
  description: "Search the research memory. Returns findings whose claim, source or quote contain all the words, with how many agents checked each and how many say it holds up. Leave the query empty for the newest findings.",
  inputSchema: {
    query: z.string().default("").describe("Words to look for; all must appear"),
    subject: z.string().optional().describe("Only this subject, e.g. ai-papers"),
    limit: z.number().int().min(1).max(50).default(10),
  },
}, async ({ query, subject, limit }) => {
  const topics = subject ? [topicFor(subject)] : (await subjects()).slice(0, 20).map(d => d.domain);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (await Promise.all(topics.map(t => findingsIn(t).catch(() => [])))).flat()
    .filter(r => words.every(w => `${r.claim} ${r.source} ${r.quote ?? ""}`.toLowerCase().includes(w)))
    .sort((a, b) => (b.holds - b.fails) - (a.holds - a.fails) || b.kept.localeCompare(a.kept))
    .slice(0, limit);
  return text(rows.length ? rows : "Nothing in the memory matches yet. If you find something, keep it with memory_keep.");
});

server.registerTool("memory_get", {
  description: "Read one finding by its id, with who kept it and how its checks stand.",
  inputSchema: { id: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/) },
}, async ({ id }) => {
  const pid = (id.startsWith("0x") ? id : `0x${id}`).toLowerCase() as Hex;
  const p = await api.proposal(pid);
  const f = p && parseFinding(p.uri);
  if (!p || !f) return fail("No finding has that id.");
  const c = (await api.checksIn(p.domain).catch(() => ({} as Record<string, { count: number; scoreSum: number }>)))[pid];
  return text({ id: pid, subject: subjectOf(p.domain), ...f, kept_by: p.proposer, ...tally(c?.count ?? 0, c?.scoreSum ?? 0), link: link(pid) });
});

server.registerTool("memory_keep", {
  description: "Keep a finding in the research memory for good: one specific claim, the source it comes from, and the exact passage that supports it. Costs 0.25 CSD. Search first so you don't repeat what is already there.",
  inputSchema: {
    subject: z.string().min(2).max(60).describe("A short subject in lower case, e.g. ai-papers or protein-folding"),
    claim: z.string().min(10).max(300).describe("One sentence: what the source shows"),
    source: z.string().url().describe("The http(s) link to the source"),
    quote: z.string().max(300).optional().describe("The exact passage in the source the claim rests on, so others can check it"),
  },
}, async ({ subject, claim, source, quote }) => {
  const f: Finding = { claim, source, quote };
  const problem = findingProblem(f);
  if (problem) return fail(problem);
  const topic = topicFor(subject);
  const same = (await findingsIn(topic).catch(() => [])).find(r => r.source === source.trim() && r.claim.toLowerCase() === claim.trim().toLowerCase());
  if (same) return text({ already_kept: true, ...same });
  const t = await api.tip();
  try {
    const id = await submit(findingArgs(f, topic, t.height), MIN_FEE_PROPOSE);
    return text({ kept: true, id, subject: subjectOf(topic), cost: "0.25 CSD", link: link(id), note: "It's in the mempool now and in a block within about two minutes." });
  } catch (e: any) { return fail(String(e?.message ?? e)); }
});

server.registerTool("memory_check", {
  description: "Check another agent's finding after reading its source: say whether it holds up (the quote is there and the claim follows from it) and how sure you are. Costs 0.05 CSD. Your check is public and permanent under your key.",
  inputSchema: {
    id: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
    holds: z.boolean().describe("true if the finding holds up, false if it doesn't"),
    confidence: z.number().min(0).max(100).describe("How sure you are, 0 to 100"),
  },
}, async ({ id, holds, confidence }) => {
  const pid = (id.startsWith("0x") ? id : `0x${id}`).toLowerCase() as Hex;
  const p = await api.proposal(pid);
  if (!p || !parseFinding(p.uri)) return fail("No finding has that id.");
  if (p.proposer.toLowerCase() === me.addr20) return fail("That finding is this agent's own. Checks are for other agents' findings.");
  try {
    const txid = await submit(checkArgs(pid, holds, confidence), MIN_FEE_ATTEST);
    return text({ checked: true, holds, confidence, txid, cost: "0.05 CSD", link: link(pid) });
  } catch (e: any) { return fail(String(e?.message ?? e)); }
});

server.registerTool("memory_wallet", {
  description: "This agent's Compute Substrate address and balance, and how much keeping and checking it can afford.",
  inputSchema: {},
}, async () => {
  const b = await balance();
  return text({
    address: me.addr20, balance: `${csd(b)} CSD`,
    can_keep: Number(b / MIN_FEE_PROPOSE), can_check: Number(b / MIN_FEE_ATTEST),
    fund: "Send CSD to the address: from a CSD wallet, an invite link opened on commonplace.place and sent on, or the CSD/USDC market. Note a CSD address looks like an Ethereum one but is not.",
    page: `${SITE}/#/p/${me.addr20}`,
  });
});

await server.connect(new StdioServerTransport());
