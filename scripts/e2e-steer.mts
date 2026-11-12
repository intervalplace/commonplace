// Shared programs and bounty steering, on the local network:
// an agent's record comes with the program that found it (agents and the page can read it);
// a bounty counts as weight only as far as its pledger holds the CSD; and a pledger who leaves a
// won bounty unpaid stops counting at all.
//   CSD_FUND_KEY=… NODE_PATH=$(npm root -g) npx tsx scripts/e2e-steer.mts [out dir]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COIN, MIN_FEE_PROPOSE, buildAppTx, buildSplitTx, bytesToHex, hexToBytes, keyFromPrivate, node, sha256d, utf8 } from "../src/csd";
import { bountyUri, frontierArgs, resultsTopic } from "../src/frontier";
const { chromium } = createRequire(import.meta.url)("playwright");
const API = process.env.CSD_API ?? "http://127.0.0.1:8789", SITE = process.env.SITE ?? "http://localhost:3000", out = process.argv[2] ?? "e2e-shots";
const api = node(API);
const funder = keyFromPrivate(hexToBytes(process.env.CSD_FUND_KEY!));
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (what: string, f: () => Promise<boolean>, mins = 20) => {
  const end = Date.now() + mins * 60_000;
  while (!(await f().catch(() => false))) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(5000); }
  console.log("ok  " + what);
};
const n = Date.now() % 100000, A = `steer-a-${n}`, B = `steer-b-${n}`;
const hZ = bytesToHex(randomBytes(32)).slice(2), Z = keyFromPrivate(hexToBytes(hZ));
const P = keyFromPrivate(randomBytes(32));
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", new URL("../research/server.mts", import.meta.url).pathname],
  env: { ...process.env, CSD_API: API, CSD_AGENT_KEY: hZ, COMMONPLACE_SITE: SITE, NEXT_PUBLIC_TURBO_UPLOAD: "http://localhost:3030", NEXT_PUBLIC_ARWEAVE_GATEWAY: "http://localhost:3030" } as Record<string, string> }));
const call = async (name: string, args: Record<string, unknown> = {}) => { const r: any = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text ?? ""; try { return { error: !!r.isError, v: JSON.parse(t) }; } catch { return { error: !!r.isError, v: t as any }; } };
const row = async (slug: string) => (await call("frontier_problems")).v.find?.((x: any) => x.slug === slug);
const pledge = async (slug: string, amount: number, target: number) => {
  const t = await api.tip(), uri = bountyUri({ amount, target, note: "test" });
  return api.submit(buildAppTx(await api.utxos(P.addr20), P, frontierArgs(resultsTopic(slug), uri, sha256d(utf8(uri)), t.height), MIN_FEE_PROPOSE));
};
const verifier = readFileSync(new URL("../research/frontier/problems/spread-points-24.js", import.meta.url), "utf8");
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
try {
  await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [...Array(10).fill({ to: Z.addr20, value: COIN / 2n }), { to: P.addr20, value: COIN / 2n }, { to: P.addr20, value: COIN / 2n }]));
  await until("an agent and a pledger are funded", async () => (await api.utxos(Z.addr20)).length >= 10 && (await api.utxos(P.addr20)).length >= 2);
  for (const slug of [A, B]) check(!(await call("frontier_propose", { slug, title: `Spread (steer test ${slug.slice(6, 7)})`, direction: "max",
    statement: "Place 24 points in the unit square so the smallest distance between any two is as large as possible. One point per line as \"x y\".", verifier })).error, `problem ${slug} is posed`);
  await until("both are in a block", async () => !!(await row(A)) && !!(await row(B)));

  // a record with its program
  const s1 = await call("frontier_submit", { slug: A, program: grid, note: "a 6 by 4 grid" });
  check(!s1.error && /^0x[0-9a-f]{64}$/.test(s1.v.program_shared ?? ""), "a record is kept with its program shared");
  check(!(await call("frontier_submit", { slug: B, program: grid, note: "a 6 by 4 grid" })).error, "and one on the other problem");
  await until("agents read the program behind the record", async () => /function solve/.test((await call("frontier_problem", { slug: A })).v.record?.program ?? ""));
  await page.goto(`${SITE}/#/frontier/${A}`);
  await page.getByRole("button", { name: "The program that found it" }).waitFor({ timeout: 300_000 });
  await page.getByRole("button", { name: "The program that found it" }).click();
  await page.locator(".cp-program").waitFor({ timeout: 60_000 });
  check(/function solve/.test(await page.locator(".cp-program").innerText()), "the page shows the program, read back from Arweave");
  await page.locator(".cp-result").first().screenshot({ path: `${out}/program.png` });

  // bounties: 100 CSD pledged by a key holding about 1 CSD counts as what it holds
  await pledge(A, 100, 0.22);
  await until("the pledge on A is in a block", async () => (await row(A))?.open_bounties?.length === 1);
  const held = Number((await api.utxos(P.addr20, true)).reduce((s, u) => s + u.value, 0n)) / 1e8;
  const ra = await row(A);
  check(Math.abs(ra.bounties_backed_csd - held) < 0.02, `a 100 CSD bounty counts only the ${held} CSD its pledger holds (${ra.bounties_backed_csd})`);
  // it would count like 1 + held / 0.05 people; problems with bounties get at most what all others get together
  const others = (await call("frontier_problems")).v.filter((x: any) => !x.open_bounties).reduce((t: number, x: any) => t + x.attention, 0);
  const uncapped = 1 + held / 0.05;
  check(Math.abs(ra.attention - Math.min(uncapped, others)) < 0.1, `so it draws ${ra.attention}: as much as ${uncapped.toFixed(1)} people, capped at half of all attention (the others add up to ${others.toFixed(2)})`);
  await pledge(B, 100, 0.3);
  await until("a second pledge, on B, is in a block", async () => (await row(B))?.open_bounties?.length === 1);
  const [a2, b2] = [await row(A), await row(B)];
  check(Math.abs(a2.bounties_backed_csd + b2.bounties_backed_csd - Number((await api.utxos(P.addr20, true)).reduce((s, u) => s + u.value, 0n)) / 1e8) < 0.02, "two bounties share what the pledger holds");

  // the agent wins A's bounty; it goes unpaid, so the pledger's other bounty stops counting
  const won = await call("frontier_submit", { slug: A, program: climb, note: "hill-climbing" });
  check(!won.error && won.v.score > 0.22, `the agent wins the bounty on A with ${won.v.score}`);
  await until("A's bounty shows as won", async () => !!(await call("frontier_problem", { slug: A })).v.bounties?.[0]?.won_by);
  await until("unpaid, the pledger's bounty on B counts for nothing", async () => (await row(B))?.bounties_backed_csd === 0);
  await page.goto(`${SITE}/#/frontier`);
  await until("the frontier page still loads and lists both", async () => (await page.locator(`a.cp-problem[href="#/frontier/${A}"]`).count()) === 1 && (await page.locator(`a.cp-problem[href="#/frontier/${B}"]`).count()) === 1, 3);
  console.log("done");
} finally { await browser.close(); await c.close(); }
