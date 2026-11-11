// Remembers someone and forgets them again through the page on a local test network, checks that
// what lands on the network says nothing about who, and that the list comes back in a fresh
// browser from the network alone. Run e2e-local.mts first (it funds the same stand-in wallet).
//
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-remember.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";
import { keyFromPrivate, keyFromSignature, WALLET_MESSAGE } from "../src/csd";
import { openRemember, sealRemember } from "../src/remember";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const THEM = (process.env.THEM ?? "0x6514c6bbd1588bad9925224001c804555402f0d7").toLowerCase();
const eth = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };

// the format itself
const me = keyFromSignature(await eth.signMessage({ message: WALLET_MESSAGE }));
const other = keyFromPrivate(new Uint8Array(32).fill(7));
const a = await sealRemember(me, THEM as any, true), b = await sealRemember(me, THEM as any, false);
check(a.length === b.length && a !== b, "remembering and forgetting look alike, and no two are the same");
check(!a.toLowerCase().includes(THEM.slice(2, 12)), "the address isn't in the entry");
check((await openRemember(me, a))?.who === THEM && (await openRemember(me, a))?.remember === true && (await openRemember(me, b))?.remember === false, "the same key opens it");
check((await openRemember(other, a)) === null, "another key can't");

const browser = await chromium.launch();
async function connected() {
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
  await page.goto(`${SITE}/#/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /[1-9][0-9.]* CSD/.test(document.querySelector(".cp-wallet > button")?.textContent ?? ""), null, { timeout: 60_000 });
  return page;
}
const landed = async (n: number) => {
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const ps = (await fetch(`${SITE}/node/proposals/cp.remember/50`).then(r => r.json())).proposals ?? [];
    if (ps.length >= n) return ps;
    if (Date.now() > deadline) throw new Error("never landed");
    await new Promise(r => setTimeout(r, 10_000));
  }
};

let page: any;
try {
  const before = ((await fetch(`${SITE}/node/proposals/cp.remember/50`).then(r => r.json())).proposals ?? []).length;
  page = await connected();
  await page.goto(`${SITE}/#/p/${THEM}`);
  const btn = page.getByRole("button", { name: "Remember", exact: true });
  await btn.waitFor({ timeout: 30_000 });
  await btn.click();
  await page.screenshot({ path: `${out}/r1-dialog.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Remember them" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
  await page.getByRole("button", { name: "You remember them" }).waitFor();
  check(true, "the page says you remember them at once");
  await page.goto(`${SITE}/#/`);
  await page.locator(".cp-remembered").first().waitFor({ timeout: 30_000 });
  check(true, "they're on your page, while pending");
  const ps = await landed(before + 1);
  check(ps.every((p: any) => !p.uri.toLowerCase().includes(THEM.slice(2, 12))), "what landed doesn't name them");
  console.log("ok  it landed in a block");

  // a fresh browser has only the network to go on
  const fresh = await connected();
  await fresh.locator(".cp-remembered").first().waitFor({ timeout: 60_000 });
  check((await fresh.locator(".cp-remembered").count()) === 1, "a fresh browser reads the list back from the network");
  await fresh.screenshot({ path: `${out}/r2-me.png`, fullPage: true });

  await fresh.goto(`${SITE}/#/p/${THEM}`);
  await fresh.getByRole("button", { name: "You remember them" }).click();
  await fresh.getByRole("dialog").getByRole("button", { name: "Forget them" }).click();
  await fresh.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
  await fresh.getByRole("button", { name: "Remember", exact: true }).waitFor();
  check(true, "forgetting shows at once");
  await landed(before + 2);
  const third = await connected();
  await third.waitForTimeout(8000);
  check((await third.locator(".cp-remembered").count()) === 0, "after forgetting, a fresh browser's list is empty");
  check((await third.getByText("cp.remember").count()) === 0, "the topic isn't listed");
  console.log("done");
} catch (e) { console.error(e); await page?.screenshot({ path: `${out}/r-failed.png` }); process.exitCode = 1; }
await browser.close();
