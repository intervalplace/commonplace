// Drives the built site in a browser against a local test-chain node: connects a stand-in
// wallet, funds the writing key, keeps an entry, resonates, replies, and takes screenshots.
//
//   node scripts/serve-local.mjs 3000 http://127.0.0.1:8789 &
//   CSD_FUND_KEY=<hex key holding test CSD> npx tsx scripts/e2e-local.mts [out dir]
//
// Test chains only: everything it writes is permanent.

import { createRequire } from "node:module";
type Page = any;
// the browser comes from the machine's own Playwright (NODE_PATH=$(npm root -g))
const { chromium } = createRequire(import.meta.url)("playwright");
import { privateKeyToAccount } from "viem/accounts";
import { hexToBytes, keyFromPrivate, node, signTx, COIN, type Hex, type Tx } from "../src/csd";

const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const api = node(process.env.CSD_API ?? "http://127.0.0.1:8789");
const funder = keyFromPrivate(hexToBytes(process.env.CSD_FUND_KEY!));
const eth = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const until = async (what: string, pred: () => Promise<boolean>, ms = 20 * 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred().catch(() => false)) return; await new Promise(r => setTimeout(r, 3000)); }
  throw new Error(`timed out: ${what}`);
};

async function fund(to: Hex, amount: bigint) {
  const coins = (await api.utxos(funder.addr20)).sort((a, b) => (b.value > a.value ? 1 : -1));
  const fee = 10_000n; let total = 0n; const picked = [];
  for (const c of coins) { if (total >= amount + fee) break; picked.push(c); total += c.value; }
  const tx: Tx = { version: 1, locktime: 0, app: { kind: "none" }, inputs: picked.map(c => ({ txid: c.txid, vout: c.vout, scriptSig: new Uint8Array(0) })),
    outputs: [{ value: amount, addr20: to }, ...(total > amount + fee ? [{ value: total - amount - fee, addr20: funder.addr20 }] : [])] };
  return api.submit(signTx(tx, funder));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
await ctx.exposeBinding("__sign", async (_s, hex: Hex) => eth.signMessage({ message: { raw: hex } }));
// a plain string, so the bundler adds nothing to the code that runs in the page
await ctx.addInitScript(`(() => {
  const addr = ${JSON.stringify(eth.address)};
  const provider = { request: async ({ method, params }) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
    if (method === "personal_sign") return window.__sign(params[0]);
    throw new Error("unsupported " + method);
  } };
  const info = { uuid: "e2e", name: "Test Wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "test.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`);

const page: Page = await ctx.newPage();
process.on("uncaughtException", async e => { console.error(e); await page.screenshot({ path: `${out}/failed.png`, fullPage: true }).catch(() => {}); process.exit(1); });
page.on("pageerror", e => log("page error:", e.message));
const shot = (name: string) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

await page.goto(`${SITE}/#/`);
await page.waitForTimeout(1500);
await shot("01-me-signed-out");

await page.getByRole("button", { name: "Sign in" }).click();
await page.getByRole("button", { name: "Test Wallet" }).click();
await page.locator(".cp-menu .addr").waitFor(); // the menu now shows the writing key
const addr = (await page.locator(".cp-menu .addr").textContent())!.trim() as Hex;
log("writing key", addr);
await shot("02-wallet-menu");
await page.locator(".cp-wallet > button").click();

log("funding", await fund(addr, 2n * COIN));
await until("funds confirmed", async () => (await api.utxos(addr)).length > 0);
log("funded");
await page.reload(); // the key is remembered for the tab, so no second signature
await until("balance shown", async () => /[1-9][0-9.]* CSD/.test((await page.locator(".cp-wallet > button").textContent()) ?? ""), 60_000);
await page.keyboard.press("Escape");

await page.locator("#draft").fill("Platforms rent you a room. I want to write on the wall of the building nobody owns.");
await page.getByLabel("Topic").fill("the internet");
await page.getByRole("button", { name: "Keep it", exact: true }).click();
await shot("03-keep-dialog");
await page.getByRole("button", { name: "Keep it forever" }).click();
await page.getByText("Being kept now").first().waitFor({ timeout: 30_000 });
await shot("04-me-pending");
await page.goto(`${SITE}/#/everyone`); await page.waitForTimeout(1500);
await shot("05-everyone-pending");

await page.goto(`${SITE}/#/`);
await until("entry mined", async () => (await page.locator(".cp-entry .cp-mono").count()) > 0 || (await page.reload().then(() => page.waitForTimeout(2500)).then(() => page.locator(".cp-entry .cp-mono").count())) > 0);
await shot("06-me-kept");
const href = await page.locator(".cp-entry a.text").first().getAttribute("href");
await page.goto(`${SITE}/${href}`); await page.waitForTimeout(1500);
await page.getByRole("button", { name: "Resonate" }).click();
await page.getByRole("button", { name: "You resonated" }).waitFor({ timeout: 30_000 });
await page.locator("#reply").fill("Personal websites were this, until hosting them became a chore and finding them became impossible.");
await page.getByRole("button", { name: "Keep it", exact: true }).click();
await page.getByRole("button", { name: "Keep it forever" }).click();
await page.getByText("Being kept now").first().waitFor({ timeout: 30_000 });
await shot("07-entry-with-pending-reply");

await until("reply and resonance in a block", async () => {
  await page.reload(); await page.waitForTimeout(3000);
  return (await page.getByText(/1 resonated/).count()) > 0 && (await page.locator(".cp-replies .cp-mono").count()) > 0;
});
await shot("08-entry-kept");
await page.goto(`${SITE}/#/t/the%20internet`); await page.waitForTimeout(2500);
await shot("09-topic");
await page.goto(`${SITE}/#/topics`); await page.waitForTimeout(1500);
await shot("10-topics");
await page.goto(`${SITE}/#/everyone`); await page.waitForTimeout(2500);
await page.locator(".cp-sky button.dot").first().click();
await shot("11-everyone");
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${SITE}/#/`); await page.waitForTimeout(1500);
await shot("12-phone-me");
await browser.close();
log("done");
