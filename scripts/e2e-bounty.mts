// Bounties end to end: an agent poses a problem and sets a record; a person (passkey) pledges a
// bounty past it in the page; agents see it; the agent beats the target and wins it; the page shows
// it won and unpaid, the pledger pays from the page, and it shows paid, with the win on the hiscores.
//   CSD_FUND_KEY=… NODE_PATH=$(npm root -g) npx tsx scripts/e2e-bounty.mts [out dir]
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
const until = async (what: string, f: () => Promise<boolean>, mins = 15) => {
  const end = Date.now() + mins * 60_000;
  while (!(await f().catch(() => false))) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(4000); }
  console.log("ok  " + what);
};
const SLUG = `spread-bounty-${Date.now() % 100000}`;
const hZ = bytesToHex(randomBytes(32)).slice(2), Z = keyFromPrivate(hexToBytes(hZ));
const c = new Client({ name: "t", version: "0" });
await c.connect(new StdioClientTransport({ command: "npx", args: ["tsx", new URL("../research/server.mts", import.meta.url).pathname],
  env: { ...process.env, CSD_API: API, CSD_AGENT_KEY: hZ, COMMONPLACE_SITE: SITE, NEXT_PUBLIC_TURBO_UPLOAD: "http://localhost:3030", NEXT_PUBLIC_ARWEAVE_GATEWAY: "http://localhost:3030" } as Record<string, string> }));
const call = async (name: string, args: Record<string, unknown> = {}) => { const r: any = await c.callTool({ name, arguments: args }); const t = r.content?.[0]?.text ?? ""; try { return { error: !!r.isError, v: JSON.parse(t) }; } catch { return { error: !!r.isError, v: t as any }; } };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const page = await ctx.newPage();
try {
  await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [Z, Z, Z, Z].map(k => ({ to: k.addr20, value: COIN / 2n }))));
  await until("the agent is funded", async () => (await api.utxos(Z.addr20)).length >= 4);
  check(!(await call("agent_set_name", { name: "Bountyhunter", picture: 3 })).error, "the agent names itself");
  check(!(await call("frontier_propose", { slug: SLUG, title: "24 points spread (bounty test)", direction: "max",
    statement: "Place 24 points in the unit square so the smallest distance between any two is as large as possible. One point per line as \"x y\".",
    verifier: readFileSync(new URL("../research/frontier/problems/spread-points-24.js", import.meta.url), "utf8") })).error, "it poses a problem");
  await until("the problem is in a block", async () => (await call("frontier_problems")).v.some?.((x: any) => x.slug === SLUG));
  const grid = `function solve(best) { const p = []; for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) p.push((i / 5) + " " + (j / 3)); return p.join("\\n"); }`;
  check(!(await call("frontier_submit", { slug: SLUG, program: grid, note: "a 6 by 4 grid" })).error, "it sets a first record, 0.2");
  await until("the record is in a block", async () => (await call("frontier_problem", { slug: SLUG })).v.recent?.length >= 1);

  // a person signs in with a passkey and pledges a bounty past the record
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  await page.goto(`${SITE}/#/frontier/${SLUG}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New here? Make a passkey" }).click();
  await page.locator(".cp-menu .addr").waitFor({ timeout: 30_000 });
  const S = (await page.locator(".cp-menu .addr").innerText()).trim().toLowerCase() as `0x${string}`;
  await page.keyboard.press("Escape");
  await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [{ to: S, value: 3n * COIN }, { to: S, value: 3n * COIN }]));
  await until("the person is funded", async () => (await api.utxos(S)).length >= 2);
  await page.getByText("Held by").first().waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Pledge a bounty" }).click();
  await page.getByLabel("Amount, in CSD").fill("2");
  await page.getByLabel(/For the first result above/).fill("0.1");
  check(await page.getByText(/already beats that/).count() > 0, "a target the record already beats is refused");
  await page.getByLabel(/For the first result above/).fill("0.22");
  await page.getByLabel(/A line about it/).fill("Get past 0.22");
  await page.getByRole("button", { name: "Pledge it" }).click();
  await page.getByText(/Pledged\. It shows here/).waitFor({ timeout: 60_000 });
  check(true, "a bounty of 2 CSD past 0.22 is pledged");
  await until("it shows on the problem page, open, with the pledger able to pay", async () => (await page.locator(".cp-bounty").count()) === 1 && /Open\. The pledger holds enough/.test(await page.locator(".cp-bounty").innerText()), 5);
  await page.locator(".cp-bounties").screenshot({ path: `${out}/bounty-open.png` });
  await page.goto(`${SITE}/#/frontier`);
  await until("the problem's card shows the bounty", async () => /Bounty: 2 CSD/.test(await page.locator(`a.cp-problem[href="#/frontier/${SLUG}"]`).innerText()), 3);
  await until("the feed shows the new bounty", async () => (await page.getByText("New bounty: 2 CSD for beating 0.22").count()) > 0, 3);
  const ps = (await call("frontier_problems")).v.find((x: any) => x.slug === SLUG);
  check(ps.open_bounties?.[0]?.csd === 2 && ps.open_bounties[0].for_beating === 0.22, "agents see the open bounty");
  check(ps.attention > 1, "and it draws their attention");

  // the agent beats the target
  const climb = `function solve(best) {
    let s = 12345; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    let p = best.split("\\n").map(l => l.split(" ").map(Number));
    const md = q => { let d = 9; for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) d = Math.min(d, Math.hypot(q[i][0] - q[j][0], q[i][1] - q[j][1])); return d; };
    let cur = md(p);
    for (let k = 0; k < 40000; k++) { const i = Math.floor(rnd() * p.length), old = p[i]; const st = 0.03 * (1 - k / 40000) + 0.001;
      p[i] = [Math.min(1, Math.max(0, old[0] + (rnd() - 0.5) * st)), Math.min(1, Math.max(0, old[1] + (rnd() - 0.5) * st))];
      const d = md(p); if (d >= cur) cur = d; else p[i] = old; }
    return p.map(q => q[0] + " " + q[1]).join("\\n"); }`;
  const sub = await call("frontier_submit", { slug: SLUG, program: climb, note: "hill-climbing from the grid" });
  check(!sub.error && sub.v.score > 0.22, `the agent beats the target with ${sub.v.score}`);
  await page.goto(`${SITE}/#/frontier/${SLUG}`);
  await until("the page shows it won, by the agent, not paid yet", async () => { const t = await page.locator(".cp-bounty").innerText(); return /Won by/.test(t) && /Bountyhunter/.test(t) && /Not paid yet/.test(t); }, 8);
  const pb = (await call("frontier_problem", { slug: SLUG })).v.bounties?.[0];
  check(!!pb?.won_by && pb.won_by.score === sub.v.score, "agents see who won it");
  check(!(await call("frontier_problems")).v.find((x: any) => x.slug === SLUG).open_bounties, "and it's no longer open");
  await page.locator(".cp-bounties").screenshot({ path: `${out}/bounty-won.png` });

  // the pledger pays from the page
  await page.getByRole("button", { name: "Pay 2 CSD to the winner" }).click();
  await page.getByText(/Sent\. It shows as paid/).waitFor({ timeout: 60_000 });
  check(true, "the pledger pays from the page");
  await until("the agent got the 2 CSD", async () => (await api.utxos(Z.addr20, true)).some(u => u.value === 2n * COIN), 20);
  await page.reload();
  await until("the bounty shows paid", async () => /Paid/.test(await page.locator(".cp-bounty").innerText()) && !/Not paid/.test(await page.locator(".cp-bounty").innerText()), 10);
  await page.locator(".cp-bounties").screenshot({ path: `${out}/bounty-paid.png` });
  await page.goto(`${SITE}/#/hiscores`);
  await until("the hiscores show what it won", async () => { const row = page.locator("tr", { hasText: "Bountyhunter" }); return (await row.count()) > 0 && /2 CSD/.test(await row.innerText()); }, 3);
  await page.screenshot({ path: `${out}/bounty-hiscores.png` });
  console.log("done");
} finally { await browser.close(); await c.close(); }
