// A second person visits someone's page on a local test chain: signs the guestbook, and the
// page shows what its owner kept and resonated with. Run e2e-local.mts and e2e-profile.mts first.
//
//   NODE_PATH=$(npm root -g) CSD_FUND_KEY=<key holding test CSD> npx tsx scripts/e2e-pages.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";
import { COIN, hexToBytes, keyFromPrivate, keyFromSignature, node, signTx, utf8, bytesToHex, WALLET_MESSAGE, type Hex, type Tx } from "../src/csd";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const api = node(process.env.CSD_API ?? "http://127.0.0.1:8789");
const funder = keyFromPrivate(hexToBytes(process.env.CSD_FUND_KEY!));
const owner = keyFromSignature(await privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").signMessage({ message: { raw: bytesToHex(utf8(WALLET_MESSAGE)) } })).addr20;
const visitor = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const visitorKey = keyFromSignature(await visitor.signMessage({ message: { raw: bytesToHex(utf8(WALLET_MESSAGE)) } }));

async function fund(to: Hex, amount: bigint) {
  const coins = (await api.utxos(funder.addr20)).sort((a, b) => (b.value > a.value ? 1 : -1));
  const fee = 10_000n; let total = 0n; const picked = [];
  for (const c of coins) { if (total >= amount + fee) break; picked.push(c); total += c.value; }
  const tx: Tx = { version: 1, locktime: 0, app: { kind: "none" }, inputs: picked.map(c => ({ txid: c.txid, vout: c.vout, scriptSig: new Uint8Array(0) })),
    outputs: [{ value: amount, addr20: to }, ...(total > amount + fee ? [{ value: total - amount - fee, addr20: funder.addr20 }] : [])] };
  return api.submit(signTx(tx, funder));
}
if (!(await api.utxos(visitorKey.addr20)).length) {
  console.log("funding visitor", await fund(visitorKey.addr20, 2n * COIN));
  while (!(await api.utxos(visitorKey.addr20)).length) await new Promise(r => setTimeout(r, 5000));
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.exposeBinding("__sign", async (_s: unknown, hex: Hex) => visitor.signMessage({ message: { raw: hex } }));
await ctx.addInitScript(`(() => {
  const addr = ${JSON.stringify(visitor.address)};
  const provider = { request: async ({ method, params }) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
    if (method === "personal_sign") return window.__sign(params[0]);
    throw new Error("unsupported " + method);
  } };
  const info = { uuid: "e2e2", name: "Visitor Wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "visitor.wallet" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`);
const page = await ctx.newPage();
const shot = (n: string) => page.screenshot({ path: `${out}/${n}.png`, fullPage: true });
try {
  await page.goto(`${SITE}/#/t/the%20internet`); await page.waitForTimeout(3000);
  await page.locator(".cp-whois").first().click();            // a name opens that person's page
  await page.waitForURL(/#\/p\/0x/);
  await page.getByText(/resonated with/).first().waitFor();
  await page.waitForTimeout(2000);
  await shot("q1-person-page");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Visitor Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /[1-9][0-9.]* CSD/.test(document.querySelector(".cp-wallet > button")?.textContent ?? ""), null, { timeout: 60_000 });
  await page.locator("#gb-text").fill("Found your page through the internet topic. Nice wall.");
  await page.getByRole("button", { name: "Sign it" }).click();
  await shot("q2-sign-dialog");
  await page.getByRole("button", { name: "Keep it forever" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
  await page.getByText("Being kept now").first().waitFor({ timeout: 30_000 });
  await shot("q3-guestbook-pending");
  const end = Date.now() + 20 * 60_000;
  for (;;) {
    await page.waitForTimeout(15_000);
    await page.reload(); await page.waitForTimeout(4000);
    if ((await page.locator("#gb ~ .cp-entry .cp-mono, .cp-list:has(#gb) .cp-entry .cp-mono").count()) > 0) break;
    if (Date.now() > end) throw new Error("guestbook entry never landed");
  }
  await shot("q4-guestbook-kept");
  console.log("owner", owner, "visitor", visitorKey.addr20, "done");
} catch (e) { console.error(e); await shot("q-failed"); process.exitCode = 1; }
await browser.close();
