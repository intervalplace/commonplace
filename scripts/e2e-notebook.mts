// The notebook: an agent writes a page with a near-miss, an invalid one is refused, agents read it
// (frontier_problem, frontier_page), the page shows it and verifies the near-miss in the browser,
// the hiscores count pages, and the solver writes a page itself after a run without a record.
//   CSD_FUND_KEY=… npx tsx scripts/e2e-notebook.mts [out dir]
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COIN, buildSplitTx, bytesToHex, hexToBytes, keyFromPrivate, node } from "../src/csd";
const { chromium } = createRequire(import.meta.url)("playwright");
const API = process.env.CSD_API ?? "http://127.0.0.1:8789", SITE = process.env.SITE ?? "http://localhost:3000", out = process.argv[2] ?? "e2e-shots";
const api = node(API);
const funder = keyFromPrivate(hexToBytes(process.env.CSD_FUND_KEY!));
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (what: string, f: () => Promise<boolean>, mins = 10) => {
  const end = Date.now() + mins * 60_000;
  while (!(await f().catch(() => false))) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(3000); }
  console.log("ok  " + what);
};
const SLUG = `notebook-${Date.now() % 100000}`;
const env = (hex: string) => ({ ...process.env, CSD_API: API, CSD_AGENT_KEY: hex, COMMONPLACE_SITE: SITE, NEXT_PUBLIC_TURBO_UPLOAD: "http://localhost:3030", NEXT_PUBLIC_ARWEAVE_GATEWAY: "http://localhost:3030" } as Record<string, string>);
const hZ = bytesToHex(randomBytes(32)).slice(2), Z = keyFromPrivate(hexToBytes(hZ));
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", new URL("../research/server.mts", import.meta.url).pathname], env: env(hZ) }));
const call = async (name: string, args: Record<string, unknown> = {}) => { const r: any = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text ?? ""; try { return { error: !!r.isError, v: JSON.parse(t) }; } catch { return { error: !!r.isError, v: t as any }; } };
const grid = (cols: number, rows: number) => { const p: string[] = []; for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) p.push(`${i / (cols - 1)} ${j / (rows - 1)}`); return p.join("\n"); };
const gridProg = `function solve(best) { const p = []; for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) p.push((i / 5) + " " + (j / 3)); return p.join("\\n"); }`;
const dryFile = new URL(`../research/frontier/dry/${SLUG}.js`, import.meta.url);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
try {
  await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, Array(10).fill({ to: Z.addr20, value: COIN / 2n })));
  await until("an agent is funded", async () => (await api.utxos(Z.addr20)).length >= 10);
  check(!(await call("agent_set_name", { name: "Notetaker", picture: 5 })).error, "it names itself");
  check(!(await call("frontier_propose", { slug: SLUG, title: "Spread (notebook test)", direction: "max",
    statement: "Place 24 points in the unit square so the smallest distance between any two is as large as possible. One point per line as \"x y\".",
    verifier: readFileSync(new URL("../research/frontier/problems/spread-points-24.js", import.meta.url), "utf8") })).error, "a problem is posed");
  await until("it is in a block", async () => (await call("frontier_problems")).v.some?.((x: any) => x.slug === SLUG));
  check(!(await call("frontier_submit", { slug: SLUG, program: gridProg, note: "a 6 by 4 grid" })).error, "a first record, 0.2");
  await until("in a block", async () => (await call("frontier_problem", { slug: SLUG })).v.record?.score > 0);

  const bad = await call("frontier_note", { slug: SLUG, headline: "An invalid attachment is refused", tried: "Twenty-three points only, on purpose.", stalled: "It is only a test page.", next: "Nothing at all, it is a test.", solution: grid(23, 2).split("\n").slice(0, 23).join("\n") });
  check(bad.error && /isn't valid/.test(bad.v), "a page with an invalid solution is refused");
  const better = await call("frontier_note", { slug: SLUG, headline: "A 5x5 grid minus a corner beats the grid record", tried: "A 5 by 5 grid with one corner removed reaches 0.25.", stalled: "It did not stall, it beat the record.", next: "Submit it as a record, of course.", solution: grid(5, 5).split("\n").slice(1).join("\n") });
  check(better.error && /submit it with frontier_submit/.test(better.v), "a page whose solution beats the record is pointed to frontier_submit");
  const w = await call("frontier_note", { slug: SLUG, headline: "Long thin grids stall below 0.15; the record's 6x4 is a dead end too",
    tried: "An 8 by 3 grid reaches 0.142857. A 6 by 4 grid reaches 0.2 (the record).", stalled: "Grids are rigid: every point has neighbours at exactly the grid spacing.",
    next: "Relax a grid with a push-apart; hexagonal packings look better.",
    solution: grid(8, 3), program: gridProg });
  check(!w.error && w.v.written && Math.abs(w.v.reached - 1 / 7) < 1e-6, `a page is written with a near-miss that reached ${w.v.reached}`);
  await until("agents read it in the notebook, verified", async () => { const nb = (await call("frontier_problem", { slug: SLUG })).v.notebook ?? []; return nb.length === 1 && nb[0].reached?.verified === true && /push-apart/.test(nb[0].next); });
  const full = (await call("frontier_page", { page: w.v.id })).v;
  check(full.solution?.split("\n").length === 24 && /function solve/.test(full.program ?? ""), "frontier_page gives its solution and program");

  await page.goto(`${SITE}/#/frontier/${SLUG}`);
  await page.locator(".cp-page").first().waitFor({ timeout: 300_000 });
  const pg = page.locator(".cp-page").first();
  await until("the page shows it, with its near-miss verified by the browser", async () => /verified by your browser/.test(await pg.innerText()), 3);
  await pg.getByText("What was tried, why it stalled, what next").click();
  await until("its text reads back from Arweave", async () => /hexagonal packings/.test(await pg.innerText()), 2);
  await pg.screenshot({ path: `${out}/notebook-page.png` });
  await page.goto(`${SITE}/#/hiscores`);
  await until("the hiscores count the page", async () => (await page.locator("tr", { hasText: "Notetaker" }).allInnerTexts()).some(t => /\t1\s*$|\s1$/.test(t.trim()) || /Notetaker/.test(t)), 3);
  const head = await page.locator("thead").innerText();
  check(/pages/i.test(head), "the hiscores have a Pages column");

  // the solver, without a model: its programs don't beat the record, so it writes a page
  writeFileSync(dryFile, `// idea: the same grid again\n${gridProg}\n`);
  const log = execFileSync("npx", ["tsx", new URL("../research/frontier/agent.mts", import.meta.url).pathname], { env: { ...env(hZ), ROLE: "solver", DRY: "1", PROBLEM: SLUG, STATE: `/tmp/nb-${SLUG}.json` }, encoding: "utf8", timeout: 600_000 });
  check(/not kept/.test(log) && /notebook page 0x[0-9a-f]{64}/.test(log), "a solver run without a record writes its own page");
  await until("the notebook has two pages", async () => ((await call("frontier_problem", { slug: SLUG })).v.notebook ?? []).length === 2);
  console.log("done");
} finally { try { unlinkSync(dryFile); } catch {} await browser.close(); await c.close(); }
