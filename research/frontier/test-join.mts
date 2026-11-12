// A newcomer's agent joins from the packaged commonplace-agent with nothing but an invite link:
// it claims the CSD, reads the frontier, tries ideas for free, and submits a program's solution,
// which then shows in the page's live feed. Run after test-local.mts, on the same local network.
//
//   (cd packages/commonplace-agent && node build.mjs && npm pack)
//   CSD_FUND_KEY=… NODE_PATH=$(npm root -g) npx tsx research/frontier/test-join.mts [out dir]

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COIN, buildSplitTx, hexToBytes, keyFromPrivate, node } from "../../src/csd";
import { inviteCode } from "../../src/invite";

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

// a fresh problem to work on (the stand-in Arweave forgets files when it restarts)
const SLUG = `spread-test-${Date.now() % 100000}`;
{
  const poser = new Client({ name: "poser", version: "0" });
  await poser.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "..", "server.mts")],
    env: { ...process.env, CSD_API: API, CSD_AGENT_KEY: process.env.CSD_FUND_KEY!, NEXT_PUBLIC_TURBO_UPLOAD: "http://localhost:3030", NEXT_PUBLIC_ARWEAVE_GATEWAY: "http://localhost:3030" } as Record<string, string> }));
  const r: any = await poser.callTool({ name: "frontier_propose", arguments: { slug: SLUG, title: "24 points spread in a square (test)", direction: "max",
    statement: "Place 24 points in the unit square so the smallest distance between any two is as large as possible. One point per line as \"x y\".",
    verifier: (await import("node:fs")).readFileSync(join(here, "problems/spread-points-24.js"), "utf8") } });
  check(!r.isError, "a problem is posed");
  await poser.close();
}

// someone makes an invite link carrying 1 CSD
const invite = keyFromPrivate(randomBytes(32));
await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [{ to: invite.addr20, value: COIN }]));
const link = `${SITE}/#/invite/${inviteCode(invite)}`;
await until("an invite link is ready", async () => (await api.utxos(invite.addr20)).length > 0);

// a newcomer installs the package, as npx would, into an empty home
const home = mkdtempSync(join(tmpdir(), "newcomer-"));
execFileSync("npm", ["install", "--prefix", home, "--no-audit", "--no-fund", join(here, "../../packages/commonplace-agent/commonplace-agent-0.1.4.tgz")], { stdio: "ignore" });
const c = new Client({ name: "newcomer", version: "0" });
await c.connect(new StdioClientTransport({ command: join(home, "node_modules/.bin/commonplace-agent"),
  env: { PATH: process.env.PATH!, HOME: home, CSD_API: API, COMMONPLACE_SITE: SITE, NEXT_PUBLIC_TURBO_UPLOAD: "http://localhost:3030", NEXT_PUBLIC_ARWEAVE_GATEWAY: "http://localhost:3030" } }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? ""; let v: any; try { v = JSON.parse(t); } catch { v = t; }
  return { error: !!r.isError, v };
};
const tools = (await c.listTools()).tools.map(t => t.name);
check(["wallet_claim_invite", "frontier_try", "frontier_submit", "memory_search"].every(t => tools.includes(t)), "the packaged agent offers every tool");
const w0 = (await call("memory_wallet")).v;
check(w0.balance === "0 CSD", "a new agent starts with a fresh key and nothing on it");
const claim = await call("wallet_claim_invite", { link });
check(!claim.error && /1 CSD|0.999/.test(claim.v.claimed), "it claims the invite link");
check((await call("wallet_claim_invite", { link })).error, "the same link can't be claimed twice");
await until("the CSD arrives", async () => (await api.utxos(w0.address)).length > 0);

const ps = (await call("frontier_problems")).v;
check(Array.isArray(ps) && ps.length >= 3, "it reads the frontier's problems");
const grid = `function solve(best) { const p = []; for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) p.push((i / 5) + " " + (j / 3)); return p.join("\\n"); }`;
await until("the problem is in a block", async () => (await call("frontier_problems")).v.some?.((x: any) => x.slug === SLUG));
const tried = (await call("frontier_try", { slug: SLUG, program: grid })).v;
check(tried.valid && tried.score === 0.199999999, "trying a program is free and says what it scores");
const wrong = (await call("frontier_try", { slug: SLUG, solution: "0.5 0.5" })).v;
check(wrong.valid === false && /24 points/.test(wrong.reason), "a wrong solution comes back with the verifier's reason");
const sub = await call("frontier_submit", { slug: SLUG, program: grid, note: "a 6 by 4 grid" });
check(!sub.error && sub.v.kept, "it submits a program's solution as the first record");
await c.close();

await until("it's in a block", async () => (await api.proposalsIn("frontier." + SLUG, 10)).length > 0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
await page.goto(`${SITE}/#/frontier`);
await page.getByText("Submitted 0.199999999, waiting to be checked").or(page.getByText(/0\.199999999/)).first().waitFor({ timeout: 120_000 });
check(true, "the live feed shows the newcomer's result");
await page.screenshot({ path: `${out}/j1-frontier.png`, fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${out}/j2-phone.png`, fullPage: true });
await browser.close();
console.log("done");
