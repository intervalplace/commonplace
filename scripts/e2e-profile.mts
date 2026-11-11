// Picks a picture and a name through the page on a local test chain, waits for it to be kept,
// and takes screenshots. Run e2e-local.mts first (it funds the same stand-in wallet).
//
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-profile.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const eth = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
const shot = (n: string) => page.screenshot({ path: `${out}/${n}.png`, fullPage: true });
try {
  await page.goto(`${SITE}/#/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /[1-9][0-9.]* CSD/.test(document.querySelector(".cp-wallet > button")?.textContent ?? ""), null, { timeout: 60_000 });
  await shot("p1-me-before");
  await page.getByRole("button", { name: /Choose a picture and name|Change/ }).click();
  await page.getByLabel("Moon").check({ force: true });
  await page.getByPlaceholder("Leave empty to go without one").fill("hank");
  await shot("p2-dialog");
  await page.getByRole("dialog").getByRole("button", { name: "Keep it", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
  await shot("p3-me-pending");
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    await page.waitForTimeout(15_000);
    await page.goto(`${SITE}/#/t/the%20internet`); await page.waitForTimeout(3000);
    if ((await page.getByText("hank").count()) > 0 && (await fetch(`${SITE}/node/proposals/50`).then(r => r.json())).proposals.some((p: any) => p.domain === "cp.profile")) break;
    if (Date.now() > deadline) throw new Error("profile never landed");
  }
  await shot("p4-topic-with-profile");
  await page.goto(`${SITE}/#/`); await page.waitForTimeout(2000);
  await shot("p5-me-after");
  console.log("done");
} catch (e) { console.error(e); await shot("p-failed"); process.exitCode = 1; }
await browser.close();
