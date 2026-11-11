// The research memory end to end on a local test network: two seed agents (a finder and a
// checker) talking to the memory through the MCP server, a finding whose quote isn't in its source,
// and how Commonplace shows the result. Uses DRY agents and a fixed arXiv feed, so no model or
// network access is needed besides the local node.
//
//   CSD_FUND_KEY=<key holding test CSD> NODE_PATH=$(npm root -g) npx tsx research/test/local.mts [out dir]

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COIN, buildSplitTx, bytesToHex, hexToBytes, keyFromPrivate, node } from "../../src/csd";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)("playwright");
const API = process.env.CSD_API ?? "http://127.0.0.1:8789", SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const api = node(API);
const funder = keyFromPrivate(hexToBytes(process.env.CSD_FUND_KEY!));
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SUBJECT = `test-${Date.now() % 100000}`;
const FEED = join(here, "arxiv-fixture.xml");

const hexA = bytesToHex(randomBytes(32)).slice(2), hexB = bytesToHex(randomBytes(32)).slice(2);
const A = keyFromPrivate(hexToBytes(hexA)), B = keyFromPrivate(hexToBytes(hexB));
const until = async (what: string, f: () => Promise<boolean>) => {
  const end = Date.now() + 25 * 60_000;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5000); }
  console.log("ok  " + what);
};
const nextBlock = async (what: string) => {
  const h = (await api.tip()).height;
  const end = Date.now() + 25 * 60_000;
  while ((await api.tip()).height <= h) { if (Date.now() > end) throw new Error(`no block: ${what}`); await sleep(5000); }
  console.log("ok  " + what);
};
const env = (hex: string, extra: Record<string, string> = {}) => ({ ...process.env, CSD_API: API, CSD_AGENT_KEY: hex, ARXIV_FEED: FEED, SUBJECT, DRY: "1", COMMONPLACE_SITE: SITE, ...extra }) as Record<string, string>;
const runAgent = (role: string, hex: string, perRun = 3) =>
  execFileSync("npx", ["tsx", join(here, "..", "agent.mts")], { env: { ...env(hex), ROLE: role, PER_RUN: String(perRun), STATE: join(out, `state-${role}.json`) }, encoding: "utf8" });
async function mcp(hex: string) {
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "..", "server.mts")], env: env(hex) }));
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await c.callTool({ name, arguments: args });
      const t = r.content?.[0]?.text ?? "";
      let v: any; try { v = JSON.parse(t); } catch { v = t; }
      return { error: !!r.isError, v };
    },
    close: () => c.close(),
  };
}

// fund the two agents
await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [A, A, A, A, B, B, B, B].map(k => ({ to: k.addr20, value: COIN / 2n }))));
{ const end = Date.now() + 25 * 60_000;
  while (!(await api.utxos(A.addr20)).length || !(await api.utxos(B.addr20)).length) { if (Date.now() > end) throw new Error("never funded"); await sleep(5000); }
  console.log("ok  two agents funded"); }

const a = await mcp(hexA);
const tools = (await (a as any).call("memory_wallet")).v;
check(tools.address === A.addr20 && tools.can_keep === 8, "the server knows its agent's key and what it can afford");
check(typeof (await a.call("memory_search", { subject: SUBJECT })).v === "string", "an empty memory says so");

// the finder keeps two findings, then a third on the next run without repeating
let log = runAgent("finder", hexA, 2);
check((log.match(/ kept 0x/g) ?? []).length === 2, "the finder keeps two findings from the feed");
await until("they're in a block", async () => (await api.proposalsIn("research." + SUBJECT, 50)).length >= 2);
log = runAgent("finder", hexA, 3);
check((log.match(/ kept 0x/g) ?? []).length === 1, "the next run keeps only the paper not yet in the memory");
// a finding whose quote isn't in its source
const bad = await a.call("memory_keep", { subject: SUBJECT, claim: "Retrieval removes all errors on long questions.", source: "https://arxiv.org/abs/9901.00002", quote: "Retrieval removes all errors." });
check(!bad.error && bad.v.kept, "a finding with a made-up quote can be kept too (the checkers will catch it)");
const tooLong = await a.call("memory_keep", { subject: SUBJECT, claim: "x".repeat(300), source: "https://arxiv.org/abs/9901.00002", quote: "y".repeat(300) });
check(tooLong.error && /too long/.test(tooLong.v), "a finding over 512 bytes is refused with how much to cut");
await until("all four are in a block", async () => (await api.proposalsIn("research." + SUBJECT, 50)).length >= 4);
const dup = await a.call("memory_keep", { subject: SUBJECT, claim: "Retrieval removes all errors on long questions.", source: "https://arxiv.org/abs/9901.00002" });
check(dup.v.already_kept === true, "keeping the same finding twice returns the one already there");
const own = await a.call("memory_check", { id: bad.v.id, holds: true, confidence: 90 });
check(own.error && /own/.test(own.v), "an agent can't check its own findings");

// the checker reads every source
log = runAgent("checker", hexB, 10);
check((log.match(/ holds 0x/g) ?? []).length === 3 && (log.match(/doesn't hold 0x/g) ?? []).length === 1, "the checker passes the three real findings and fails the made-up quote");
await until("the checks are in a block", async () => Object.values(await api.checksIn("research." + SUBJECT)).reduce((n, c) => n + c.count, 0) >= 4);
const g = await a.call("memory_get", { id: bad.v.id });
check(g.v.checks === 1 && g.v.fails === 1 && g.v.holds === 0, "the made-up finding reads as checked once, not holding up");
const s = await a.call("memory_search", { subject: SUBJECT, query: "memory" });
check(Array.isArray(s.v) && s.v.length === 1 && s.v[0].holds === 1, "searching finds the finding about shared memory, checked and holding up");
await a.close();

// and Commonplace shows them
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.goto(`${SITE}/#/t/${encodeURIComponent("research." + SUBJECT)}`);
await page.getByText("Finding").first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/r1-topic.png`, fullPage: true });
await page.goto(`${SITE}/#/e/${bad.v.id}`);
await page.getByText("Read the source on arxiv.org").waitFor({ timeout: 30_000 });
await page.getByText(/Checked by 1/).waitFor({ timeout: 120_000 }).catch(() => {});
const body = await page.locator("main").innerText();
check(body.includes("Retrieval removes all errors.") && /Checked by 1: none say it holds up, 1 says it doesn't/.test(body), "Commonplace shows the quote and that the check failed it");
await page.screenshot({ path: `${out}/r2-finding.png`, fullPage: true });
await browser.close();
console.log("done");
