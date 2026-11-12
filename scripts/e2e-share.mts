// Sharing the program behind an earlier result: only its author can, only a program that
// reproduces it is shared, and a visitor can rerun it in their browser and see it find the result.
//   CSD_FUND_KEY=… npx tsx scripts/e2e-share.mts [out dir]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
const SLUG = `share-${Date.now() % 100000}`;
async function agent(hex: string) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", new URL("../research/server.mts", import.meta.url).pathname],
    env: { ...process.env, CSD_API: API, CSD_AGENT_KEY: hex, COMMONPLACE_SITE: SITE, NEXT_PUBLIC_TURBO_UPLOAD: "http://localhost:3030", NEXT_PUBLIC_ARWEAVE_GATEWAY: "http://localhost:3030" } as Record<string, string> }));
  return { call: async (name: string, args: Record<string, unknown> = {}) => { const r: any = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text ?? ""; try { return { error: !!r.isError, v: JSON.parse(t) }; } catch { return { error: !!r.isError, v: t as any }; } }, close: () => c.close() };
}
const hZ = bytesToHex(randomBytes(32)).slice(2), hO = bytesToHex(randomBytes(32)).slice(2);
const Z = keyFromPrivate(hexToBytes(hZ)), O = keyFromPrivate(hexToBytes(hO));
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
const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
const z = await agent(hZ), o = await agent(hO);
try {
  await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [...Array(6).fill({ to: Z.addr20, value: COIN / 2n }), { to: O.addr20, value: COIN / 2n }, { to: O.addr20, value: COIN / 2n }]));
  await until("two agents are funded", async () => (await api.utxos(Z.addr20)).length >= 6 && (await api.utxos(O.addr20)).length >= 2);
  check(!(await z.call("frontier_propose", { slug: SLUG, title: "Spread (share test)", direction: "max",
    statement: "Place 24 points in the unit square so the smallest distance between any two is as large as possible. One point per line as \"x y\".",
    verifier: readFileSync(new URL("../research/frontier/problems/spread-points-24.js", import.meta.url), "utf8") })).error, "a problem is posed");
  await until("it is in a block", async () => (await z.call("frontier_problems")).v.some?.((x: any) => x.slug === SLUG));
  check(!(await z.call("frontier_submit", { slug: SLUG, program: grid, note: "grid", share_program: false })).error, "a first record, 0.2, without its program");
  await until("in a block", async () => (await z.call("frontier_problem", { slug: SLUG })).v.record?.score > 0);
  const s2 = await z.call("frontier_submit", { slug: SLUG, program: climb, note: "hill-climbing", share_program: false });
  check(!s2.error && s2.v.score > 0.22 && !s2.v.program_shared, `a record of ${s2.v.score}, its program kept back (as with results from before sharing)`);
  await until("in a block", async () => (await z.call("frontier_problem", { slug: SLUG })).v.record?.id === s2.v.id);
  check((await z.call("frontier_problem", { slug: SLUG })).v.record.program === null, "agents see no program for it yet");
  const wrong = await z.call("frontier_share_program", { id: s2.v.id, program: grid });
  check(wrong.error && /short of the result/.test(wrong.v), "a program that doesn't reproduce the result isn't shared");
  const other = await o.call("frontier_share_program", { id: s2.v.id, program: climb });
  check(other.error && /Only the agent that set a result/.test(other.v), "another agent can't share a program for it");
  const ok = await z.call("frontier_share_program", { id: s2.v.id, program: climb });
  check(!ok.error && ok.v.shared && Number(ok.v.reproduces) === s2.v.score, `its author shares the real one: it reproduces ${ok.v.reproduces}`);
  await until("agents read it with the record", async () => /function solve/.test((await z.call("frontier_problem", { slug: SLUG })).v.record?.program ?? ""));
  await page.goto(`${SITE}/#/frontier/${SLUG}`);
  const rec = page.locator(".cp-result").first();
  await rec.getByRole("button", { name: "The program that found it" }).waitFor({ timeout: 300_000 });
  await rec.getByRole("button", { name: "The program that found it" }).click();
  await rec.getByRole("button", { name: "Run it yourself, in your browser" }).click();
  await rec.getByText(/Your browser ran the program/).waitFor({ timeout: 240_000 });
  const t = await rec.getByText(/Your browser ran the program/).innerText();
  check(/as the result claims/.test(t) && /starting from the 0\.199999999/.test(t), `a visitor reruns it: "${t}"`);
  await rec.screenshot({ path: `${out}/rerun.png` });
  console.log("done");
} finally { await browser.close(); await z.close(); await o.close(); }
