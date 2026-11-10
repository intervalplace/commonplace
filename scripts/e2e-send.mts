// Sends CSD out of the writing key through the page on a local test chain, after checking the
// form refuses the connected Ethereum address, then opens the writing key dialog.
//
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-send.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const NODE = process.env.CSD_API ?? "http://127.0.0.1:8789";
const out = process.argv[2] ?? "e2e-shots";
const eth = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const DEST = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(20)), b => b.toString(16).padStart(2, "0")).join("");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.exposeBinding("__sign", async (_s: unknown, hex: `0x${string}`) => eth.signMessage({ message: { raw: hex } }));
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
const page = await ctx.newPage();
page.on("pageerror", (e: any) => console.log("page error:", e.message));
const shot = (n: string) => page.screenshot({ path: `${out}/${n}.png` });
try {
  await page.goto(`${SITE}/#/`);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  await page.waitForFunction(() => /[1-9][0-9.,]* CSD/.test(document.querySelector(".cp-wallet .bal")?.textContent ?? ""), null, { timeout: 60_000 });
  await shot("s0-menu");
  await page.getByRole("button", { name: "Send CSD elsewhere" }).click();
  await page.getByText("ready to send").waitFor();
  await page.getByLabel("To a Compute Substrate address").fill(eth.address);
  await page.getByLabel("Amount in CSD").fill("0.5");
  await page.getByText("That's your Ethereum address").waitFor();
  await shot("s1-refuses-eth");
  await page.getByLabel("To a Compute Substrate address").fill(DEST);
  await page.getByRole("button", { name: "Send all" }).click();
  await shot("s2-send-all");
  await page.getByLabel("Amount in CSD").fill("0.5");
  await page.getByRole("button", { name: "Continue" }).click();
  await shot("s3-confirm");
  await page.getByRole("button", { name: "Send it" }).click();
  await page.getByText("is on its way").waitFor({ timeout: 30_000 });
  await shot("s4-sent");
  await page.getByRole("button", { name: "Done" }).click();
  const end = Date.now() + 15 * 60_000;
  for (;;) {
    const r = await (await fetch(`${NODE}/utxos/${DEST.slice(2)}`)).json();
    const got = (r.utxos ?? []).reduce((s: number, u: any) => s + Number(u.value), 0);
    if (got) { console.log("arrived:", got / 1e8, "CSD"); if (got !== 50_000_000) throw new Error("wrong amount " + got); break; }
    if (Date.now() > end) throw new Error("the send never landed");
    await new Promise(r => setTimeout(r, 10_000));
  }
  await page.locator(".cp-wallet > button").click();
  await page.getByRole("button", { name: "Show writing key" }).click();
  await page.getByRole("button", { name: "Show it" }).click();
  await shot("s5-key");
  console.log("done");
} catch (e) { console.error(e); await shot("s-failed"); process.exitCode = 1; }
await browser.close();
