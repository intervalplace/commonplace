// The frontier end to end on a local test network with a stand-in Arweave: seed problems, two
// solvers where the second builds on the first's record, a false claim slipped in directly, a
// checker that reruns every verifier, and the page showing the record climbing and verifying
// results in the browser.
//
//   node scripts/fake-arweave.mjs 3030 &
//   NEXT_PUBLIC_CSD_API=/node NEXT_PUBLIC_TURBO_UPLOAD=http://localhost:3030 NEXT_PUBLIC_ARWEAVE_GATEWAY=http://localhost:3030 npm run build
//   CSD_FUND_KEY=… NODE_PATH=$(npm root -g) npx tsx research/frontier/test-local.mts [out dir]

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

process.env.NEXT_PUBLIC_TURBO_UPLOAD ??= "http://localhost:3030";
process.env.NEXT_PUBLIC_ARWEAVE_GATEWAY ??= "http://localhost:3030";
const { COIN, MIN_FEE_PROPOSE, buildAppTx, buildSplitTx, bytesToHex, hexToBytes, keyFromPrivate, node } = await import("../../src/csd");
const F = await import("./lib");
const { frontierArgs, resultUri, resultsTopic } = await import("../../src/frontier");

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)("playwright");
const API = process.env.CSD_API ?? "http://127.0.0.1:8789", SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const api = node(API);
const funder = keyFromPrivate(hexToBytes(process.env.CSD_FUND_KEY!));
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (what: string, f: () => Promise<boolean>) => {
  const end = Date.now() + 25 * 60_000;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5000); }
  console.log("ok  " + what);
};
const NET = "sorting-network-16";

const hex = () => bytesToHex(randomBytes(32)).slice(2);
const [hS, hA, hB, hC] = [hex(), hex(), hex(), hex()];
const [S, A, B, C] = [hS, hA, hB, hC].map(h => keyFromPrivate(hexToBytes(h)));
const env = (h: string, extra: Record<string, string> = {}) => ({ ...process.env, CSD_API: API, CSD_AGENT_KEY: h, DRY: "1", COMMONPLACE_SITE: SITE, ...extra }) as Record<string, string>;
const agent = (role: string, h: string, extra: Record<string, string>) =>
  execFileSync("npx", ["tsx", join(here, "agent.mts")], { env: env(h, { ROLE: role, STATE: join(out, `fr-${role}-${h.slice(0, 6)}.json`), ...extra }), encoding: "utf8" });

// fund four agents with a few coins each
await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [S, A, B, C].flatMap(k => [k, k, k, k].map(x => ({ to: x.addr20, value: COIN / 2n })))));
await until("four agents funded", async () => (await Promise.all([S, A, B, C].map(k => api.utxos(k.addr20)))).every(u => u.length >= 4));

// seed the problems
const seed = execFileSync("npx", ["tsx", join(here, "seed.mts")], { env: env(hS), encoding: "utf8" });
check((seed.match(/ kept/g) ?? []).length === 3, "three problems are put on the frontier");
await until("they're in a block", async () => (await F.problems(api)).length >= 3);

// solver A: nothing to build on yet
let log = agent("solver", hA, { PROBLEM: NET, ATTEMPTS: "1" });
check(/new record 120 \(was none\)/.test(log), "the first solver sets a record: 120 comparators");
await until("in a block", async () => (await F.results(api, NET)).length >= 1);
// the checker reruns the verifier
log = agent("checker", hC, {});
check(/holds sorting-network-16/.test(log), "the checker runs the verifier and confirms it");
await until("the check is in a block", async () => (await F.results(api, NET)).some(r => r.holds === 1));

// solver B builds on it: its first idea only ties, its second beats the record
log = agent("solver", hB, { PROBLEM: NET, ATTEMPTS: "2" });
check(/new record 63 \(was 120\)/.test(log), "a second solver, building on the first, lowers the record to 63");
// someone claims 50 for the same network, straight onto the network, past the submit check
const batcher = await F.fetchAr((await F.results(api, NET).then(rs => rs[0])).solution); // any stored solution will do
const stored = await F.store(S, batcher, "false claim");
await api.submit(buildAppTx(await api.utxos(S.addr20), S, frontierArgs(resultsTopic(NET), resultUri({ score: 50, solution: stored.id, note: "trust me" }), stored.hash, (await api.tip()).height), MIN_FEE_PROPOSE));
await until("both are in a block", async () => (await F.results(api, NET)).length >= 3);
log = agent("checker", hC, {});
check(/holds sorting-network-16 .* claimed 63/.test(log) && /doesn't hold sorting-network-16 .* claimed 50/.test(log), "the checker confirms 63 and catches the false 50");
await until("those checks are in a block", async () => (await F.results(api, NET)).filter(r => r.checks).length >= 3);
const ps = await F.problems(api), p = ps.find(x => x.slug === NET)!;
const rec = F.record(p, await F.results(api, NET));
check(rec?.score === 63, "the record is 63: the false claim doesn't count");

// the solver refuses to submit what doesn't beat the record
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "..", "server.mts")], env: env(hA) }));
const again: any = await c.callTool({ name: "frontier_submit", arguments: { slug: NET, solution: batcher, note: "the same again" } });
check(again.isError && /Only improvements/.test(again.content[0].text), "submitting what doesn't beat the record is refused, before any fee");
const bad: any = await c.callTool({ name: "frontier_submit", arguments: { slug: NET, solution: "0 1\n2 3", note: "too short" } });
check(bad.isError && /isn't valid/.test(bad.content[0].text), "an invalid solution is refused with the verifier's reason");
await c.close();

// the page
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
await page.goto(`${SITE}/#/frontier`);
await page.locator(".cp-problem").nth(2).waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/fr1-frontier.png`, fullPage: true });
await page.goto(`${SITE}/#/frontier/${NET}`);
await page.locator(".cp-result").nth(2).waitFor({ timeout: 60_000 });
await page.getByText(/The record over time: 63/).waitFor({ timeout: 120_000 });
check(true, "the problem page shows the record at 63");
const row = (score: string) => page.locator(".cp-result", { has: page.locator(".score", { hasText: new RegExp(`^${score}$`) }) });
await row("63").getByRole("button", { name: "Verify in your browser" }).click();
await row("63").getByText("as claimed").waitFor({ timeout: 30_000 });
await row("50").getByRole("button", { name: "Verify in your browser" }).click();
await row("50").getByText(/not 50 as claimed/).waitFor({ timeout: 30_000 });
check(true, "your browser confirms 63 and shows the 50 is false");
await page.screenshot({ path: `${out}/fr2-problem.png`, fullPage: true });
await browser.close();
console.log("done");
