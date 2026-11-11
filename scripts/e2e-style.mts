// Styles the stand-in wallet's page through the page on a local test network: background,
// typeface, a pinned entry and a few lines about it. Checks the preview, waits for the style to be
// kept, then opens the page without a wallet, as anyone else would see it. Run e2e-local.mts first
// (it funds the same stand-in wallet).
//
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-style.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const eth = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const BIO = "I write here about networks, old websites and whatever I was thinking on the walk home.";

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
const shot = (p: any, n: string, full = false) => p.screenshot({ path: `${out}/${n}.png`, fullPage: full });
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
try {
  await page.goto(`${SITE}/#/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /[1-9][0-9.]* CSD/.test(document.querySelector(".cp-wallet > button")?.textContent ?? ""), null, { timeout: 60_000 });
  const mine = await page.getByRole("link", { name: "Your page as others see it" }).getAttribute("href");
  await page.goto(`${SITE}/${mine}`);
  await page.locator(".cp-entry").first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Style your page" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByText("Tiles", { exact: true }).click();
  await dlg.getByRole("button", { name: "Typewriter" }).click();
  const firstEntry = await dlg.locator("select option").nth(1).getAttribute("value");
  await dlg.locator("select").selectOption(firstEntry!);
  await dlg.locator("textarea").fill(BIO);
  check(await page.evaluate(() => document.body.classList.contains("st-tiles") && document.body.classList.contains("ty-mono")), "the page previews the choice while the dialog is open");
  check((await page.locator(".cp-pin .cp-entry").count()) === 1, "the pinned entry previews");
  await shot(page, "s1-editing");
  await dlg.getByRole("button", { name: "Not now" }).click();
  check(await page.evaluate(() => !document.body.classList.contains("st-tiles")), "closing without keeping puts the page back");
  await page.getByRole("button", { name: "Style your page" }).click();
  await dlg.getByText("Tiles", { exact: true }).click();
  await dlg.getByRole("button", { name: "Typewriter" }).click();
  await dlg.locator("select").selectOption(firstEntry!);
  await dlg.locator("textarea").fill(BIO);
  await dlg.getByRole("button", { name: "Keep it", exact: true }).click();
  await dlg.waitFor({ state: "detached", timeout: 30_000 });
  check(await page.evaluate(() => document.body.classList.contains("st-tiles")), "the kept style shows at once, while pending");
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    if ((await fetch(`${SITE}/node/proposals/cp.style/50`).then(r => r.json())).proposals?.some((p: any) => p.uri.includes(BIO))) break;
    if (Date.now() > deadline) throw new Error("style never landed");
    await page.waitForTimeout(10_000);
  }
  console.log("ok  the style landed in a block");
  // anyone else: a fresh browser with no wallet
  const other = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await other.goto(`${SITE}/${mine}`);
  await other.locator(".cp-bio").waitFor({ timeout: 60_000 });
  check((await other.locator(".cp-bio").innerText()).trim() === BIO, "a visitor sees the lines about you");
  check(await other.evaluate(() => document.body.classList.contains("st-tiles") && document.body.classList.contains("ty-mono")), "a visitor sees the background and typeface");
  await other.locator(".cp-pin .cp-entry").waitFor({ timeout: 30_000 });
  check(true, "a visitor sees the pinned entry");
  await shot(other, "s2-visitor");
  await other.goto(`${SITE}/#/topics`); await other.waitForTimeout(1000);
  check(await other.evaluate(() => !document.body.className.includes("st-")), "leaving the page drops its style");
  check((await other.getByText("cp.style").count()) === 0, "the style topic isn't listed among topics");
  await other.setViewportSize({ width: 390, height: 844 });
  await other.goto(`${SITE}/${mine}`); await other.locator(".cp-bio").waitFor();
  await shot(other, "s3-visitor-phone");
  console.log("done");
} catch (e) { console.error(e); await shot(page, "s-failed"); process.exitCode = 1; }
await browser.close();
