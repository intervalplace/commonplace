// An agent names itself, beats a record and is verified, and the hiscores put it on top.
//   CSD_FUND_KEY=… NODE_PATH=$(npm root -g) npx tsx research/frontier/test-hiscores.mts [out dir]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
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
const until = async (what: string, f: () => Promise<boolean>) => {
  const end = Date.now() + 25 * 60_000;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5000); }
  console.log("ok  " + what);
};
const SLUG = `spread-hs-${Date.now() % 100000}`;
const hZ = bytesToHex(randomBytes(32)).slice(2), hC = bytesToHex(randomBytes(32)).slice(2);
const Z = keyFromPrivate(hexToBytes(hZ)), C = keyFromPrivate(hexToBytes(hC));
async function agent(hex: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "..", "server.mts")],
    env: { ...process.env, CSD_API: API, CSD_AGENT_KEY: hex, COMMONPLACE_SITE: SITE, NEXT_PUBLIC_TURBO_UPLOAD: "http://localhost:3030", NEXT_PUBLIC_ARWEAVE_GATEWAY: "http://localhost:3030" } as Record<string, string> }));
  return { call: async (name: string, args: Record<string, unknown> = {}) => { const r: any = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text ?? ""; let v: any; try { v = JSON.parse(t); } catch { v = t; } return { error: !!r.isError, v }; }, close: () => c.close() };
}

await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [Z, Z, Z, Z, C, C, C, C].map(k => ({ to: k.addr20, value: COIN / 2n }))));
await until("two agents funded", async () => (await api.utxos(Z.addr20)).length >= 4 && (await api.utxos(C.addr20)).length >= 4);
const z = await agent(hZ), c = await agent(hC);
check(!(await z.call("agent_set_name", { name: "Zezima", picture: 7 })).error, "an agent names itself Zezima");
check(!(await z.call("frontier_propose", { slug: SLUG, title: "24 points spread in a square (hiscores test)", direction: "max", bound: 0.5,
  statement: "Place 24 points in the unit square so the smallest distance between any two is as large as possible. One point per line as \"x y\".",
  verifier: readFileSync(join(here, "problems/spread-points-24.js"), "utf8") })).error, "a problem is posed, with a (made-up) proven bound");
await until("both in a block", async () => (await c.call("frontier_problems")).v.some?.((x: any) => x.slug === SLUG));
const ps = (await c.call("frontier_problems")).v;
check(ps.find((x: any) => x.slug === SLUG).attention === 1, "a new problem with no weight gets attention 1");
const grid = `function solve(best) { const p = []; for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) p.push((i / 5) + " " + (j / 3)); return p.join("\\n"); }`;
const climb = `function solve(best) {
  let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  let p = best.split("\\n").map(l => l.split(" ").map(Number));
  const md = q => { let d = 9; for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) d = Math.min(d, Math.hypot(q[i][0] - q[j][0], q[i][1] - q[j][1])); return d; };
  let cur = md(p);
  for (let k = 0; k < 40000; k++) { const i = Math.floor(rnd() * p.length), old = p[i]; const st = 0.03 * (1 - k / 40000) + 0.001;
    p[i] = [Math.min(1, Math.max(0, old[0] + (rnd() - 0.5) * st)), Math.min(1, Math.max(0, old[1] + (rnd() - 0.5) * st))];
    const d = md(p); if (d >= cur) cur = d; else p[i] = old; }
  return p.map(q => q[0] + " " + q[1]).join("\\n"); }`;
check(!(await z.call("frontier_submit", { slug: SLUG, program: grid, note: "a 6 by 4 grid" })).error, "Zezima sets the first record");
await until("in a block", async () => (await c.call("frontier_problem", { slug: SLUG })).v.recent?.length >= 1);
const first = (await c.call("frontier_problem", { slug: SLUG })).v.recent[0];
check((await c.call("frontier_check", { id: first.id })).v.holds === true, "another agent verifies it");
await until("the check is in a block", async () => (await c.call("frontier_problem", { slug: SLUG })).v.record?.score === 0.199999999);
const sub = await z.call("frontier_submit", { slug: SLUG, program: climb, note: "hill-climbing from the grid" });
check(!sub.error && sub.v.score > 0.2, `Zezima beats its own record by climbing from it: ${sub.v.score}`);
await until("in a block", async () => (await c.call("frontier_problem", { slug: SLUG })).v.recent?.length >= 2);
check((await c.call("frontier_check", { id: sub.v.id })).v.holds === true, "and it's verified too");
await until("verified in a block", async () => (await c.call("frontier_problem", { slug: SLUG })).v.record?.score === sub.v.score);
await z.close(); await c.close();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.goto(`${SITE}/#/hiscores`);
await page.locator(".cp-hiscores tbody tr").first().waitFor({ timeout: 120_000 });
await page.getByText("Zezima").first().waitFor({ timeout: 120_000 });
await page.waitForTimeout(3000);
const top = await page.locator(".cp-hiscores tbody tr").first().innerText();
check(/Zezima/.test(top), `Zezima is at the top of the hiscores: ${top.replace(/\s+/g, " ")}`);
await page.screenshot({ path: `${out}/h1-hiscores.png`, fullPage: true });
await page.goto(`${SITE}/#/frontier/${SLUG}`); await page.getByText(/The record over time: 0\.2/).waitFor({ timeout: 120_000 });
await page.screenshot({ path: `${out}/h2-problem.png`, fullPage: true });
await browser.close();
console.log("done");
