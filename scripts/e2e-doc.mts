// Publishes a document through the page on a local test chain, with the stand-in Arweave
// (scripts/fake-arweave.mjs), then opens it and checks the page verifies the file.
//
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-doc.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const eth = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const THESIS = `# Costly signals and a memory nobody owns

When writing is free, there is no end to it. This thesis argues that a small, **public** cost per
entry changes what people choose to say.

## The claim

1. A cost per entry filters noise without a gatekeeper.
2. Paid support (resonance) is harder to fake than counts of likes.
3. Permanence makes people write things they *mean*.

> A record that cannot be edited is a different kind of place.

More: [Compute Substrate](https://github.com/compute-substrate/compute-substrate).
`;

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
const shot = (n: string) => page.screenshot({ path: `${out}/${n}.png`, fullPage: true });
try {
  await page.goto(`${SITE}/#/`);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /[1-9][0-9.]* CSD/.test(document.querySelector(".cp-wallet .bal")?.textContent ?? ""), null, { timeout: 60_000 });
  await page.locator("#draft").fill("Counting: æøå and an emoji ✨ count as more than one.");
  await shot("d0-counter");
  await page.locator("#draft").fill("");
  await page.getByRole("button", { name: "Publish a document" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "costly-signals.md", mimeType: "text/markdown", buffer: Buffer.from(THESIS) });
  await page.getByLabel("Topic").fill("theses");
  await shot("d1-doc-writer");
  await page.getByRole("button", { name: "Publish it", exact: true }).click();
  await shot("d2-publish-dialog");
  await page.getByRole("button", { name: "Publish it forever" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60_000 });
  await page.getByText("Being kept now").first().waitFor({ timeout: 30_000 });
  await shot("d3-pending");
  const end = Date.now() + 20 * 60_000;
  for (;;) {
    await page.waitForTimeout(15_000); await page.reload(); await page.waitForTimeout(3000);
    if ((await page.locator(".cp-entry:has(.cp-doclabel) .cp-mono").count()) > 0) break;
    if (Date.now() > end) throw new Error("the document entry never landed");
  }
  const href = await page.locator(".cp-entry:has(.cp-doclabel) a.text").first().getAttribute("href");
  await page.goto(`${SITE}/${href}`);
  await page.getByText("This is exactly the file that was published").waitFor({ timeout: 30_000 });
  await shot("d4-document");
  await page.goto(`${SITE}/#/t/theses`); await page.waitForTimeout(2500);
  await shot("d5-topic");
  console.log("done");
} catch (e) { console.error(e); await shot("d-failed"); process.exitCode = 1; }
await browser.close();
