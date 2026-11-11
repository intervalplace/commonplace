// The way in for someone with nothing: topic search, writing before signing in, a passkey instead
// of a wallet, and an invite link instead of buying CSD. The stand-in wallet (funded by
// e2e-local.mts) makes the invites; a visitor with only a passkey takes one and keeps what they
// wrote with it. Runs against a local test network.
//
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-friction.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const eth = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
const WORDS = `Written before I had anything at all, ${Date.now()}.`;
const balanceOf = async (p: any) => {
  const t = await p.locator(".cp-wallet > button .bal").innerText().catch(() => "0 CSD");
  return Number(t.replace(/[^0-9.]/g, ""));
};
const until = async (what: string, f: () => Promise<boolean>, mins = 25) => {
  const end = Date.now() + mins * 60_000;
  while (!(await f())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 10_000)); }
  console.log("ok  " + what);
};

const browser = await chromium.launch();
async function walletPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: SITE });
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
  const p = await ctx.newPage();
  await p.goto(`${SITE}/#/`);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.getByRole("button", { name: "Test Wallet" }).click();
  await p.locator(".cp-menu .addr").waitFor();
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => /[1-9][0-9.]* CSD/.test(document.querySelector(".cp-wallet > button")?.textContent ?? ""), null, { timeout: 60_000 });
  return p;
}

let page: any, maker: any;
try {
  // a visitor with nothing: a browser, and a passkey on the device
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });

  // 1. finding a topic
  await page.goto(`${SITE}/#/topics`);
  await page.locator(".cp-topiclink").first().waitFor({ timeout: 60_000 });
  const some = (await page.locator(".cp-topiclink").first().innerText()).split("\n")[0].trim();
  await page.getByPlaceholder("Find a topic").fill(some.slice(0, 4));
  check((await page.locator("nav[aria-label='Topics found'] .cp-topiclink", { hasText: some }).count()) >= 1, `searching "${some.slice(0, 4)}" finds ${some}`);
  await page.getByPlaceholder("Find a topic").fill("Brand New Thing");
  check(await page.getByText("Start “brand new thing” by writing the first entry in it").isVisible(), "a name nobody has used offers to start it");
  await page.screenshot({ path: `${out}/f1-search.png` });

  // 2. writing before signing in
  await page.goto(`${SITE}/#/`);
  await page.locator("#draft").fill(WORDS);
  await page.locator(".cp-topic input").fill("first steps");
  await page.getByRole("button", { name: "Keep it", exact: true }).click();
  await page.getByRole("button", { name: "Save it to keep later" }).click();
  await page.locator(".cp-waiting").waitFor();
  check((await page.locator("#draft").inputValue()) === "", "saving it for later clears the draft");
  await page.reload();
  await page.locator(".cp-waiting").waitFor();
  check((await page.locator(".cp-waiting").innerText()).includes(WORDS), "it waits on the page, and is still there after a reload");
  await page.screenshot({ path: `${out}/f2-waiting.png`, fullPage: true });

  // 3. a passkey instead of a wallet
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New here? Make a passkey" }).click();
  await page.locator(".cp-wallet > button .bal").waitFor({ timeout: 30_000 });
  const visitor = (await page.locator(".cp-menu .addr").innerText()).trim().toLowerCase();
  check(/^0x[0-9a-f]{40}$/.test(visitor), "a passkey makes a writing key");
  await page.keyboard.press("Escape");
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Use your passkey" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  check((await page.locator(".cp-menu .addr").innerText()).trim().toLowerCase() === visitor, "the same passkey makes the same key again");
  await page.keyboard.press("Escape");

  // 4. someone with CSD makes invite links
  maker = await walletPage();
  await maker.locator(".cp-wallet > button").click();
  await maker.getByRole("button", { name: "Make invite links" }).click();
  const dlg = maker.getByRole("dialog");
  await dlg.getByRole("button", { name: "0.5 CSD" }).click();
  await dlg.getByRole("button", { name: "3", exact: true }).click();
  await dlg.getByRole("button", { name: "Make 3 links" }).waitFor();
  await maker.waitForFunction(() => !document.querySelector("[role=dialog] .cp-btn")?.hasAttribute("disabled"), null, { timeout: 60_000 });
  await maker.screenshot({ path: `${out}/f3-make.png` });
  await dlg.getByRole("button", { name: "Make 3 links" }).click();
  await dlg.locator(".cp-links").waitFor({ timeout: 30_000 });
  const links: string[] = (await dlg.locator(".cp-links span").allInnerTexts()).map((s: string) => s.trim());
  check(links.length === 3 && links.every(l => l.includes("#/invite/")) && new Set(links).size === 3, "three different links are made");
  await maker.screenshot({ path: `${out}/f4-links.png` });
  await dlg.getByRole("button", { name: "Back" }).click();

  // 5. the visitor opens one before it's in a block, then after
  await page.goto(links[0]);
  await page.locator("h1").waitFor();
  check(/has been used|given/.test(await page.locator("h1").innerText()), "the invite page opens");
  await until("the invite is in a block and the page shows it", async () => {
    await page.goto(`${SITE}/#/`); await page.goto(links[0]);
    await page.locator("h1").waitFor();
    return (await page.locator("h1").innerText()).includes("given 0.5 CSD");
  });
  await page.screenshot({ path: `${out}/f5-invite.png`, fullPage: true });
  await page.getByRole("button", { name: "Take it" }).click();
  await page.getByText("It's yours").waitFor({ timeout: 30_000 });
  check(true, "the visitor takes it");
  await page.screenshot({ path: `${out}/f6-taken.png` });

  // 6. the maker takes one of the others back
  await maker.locator(".cp-wallet > button").click();
  await maker.getByRole("button", { name: "Make invite links" }).click();
  await dlg.locator(".cp-invite").first().waitFor({ timeout: 60_000 });
  await dlg.locator(".cp-invite").last().getByRole("button", { name: "Take it back" }).click();
  await maker.waitForFunction(() => !document.body.innerText.includes("Taking back…"), null, { timeout: 30_000 });
  check(!(await dlg.locator(".err").count()), "an unused link can be taken back");
  await maker.screenshot({ path: `${out}/f7-made-before.png` });

  // 7. the visitor's CSD arrives, and what they wrote first gets kept with it
  await page.goto(`${SITE}/#/`);
  await until("the gift arrives on the visitor's key", async () => { await page.reload(); await page.locator(".cp-wallet > button").waitFor(); await page.waitForTimeout(3000); return (await balanceOf(page)) >= 0.5; });
  await page.locator(".cp-waiting").getByRole("button", { name: "Keep it" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Keep it forever" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60_000 });
  check((await page.locator(".cp-waiting").count()) === 0, "keeping it empties the waiting list");
  await until("what they wrote first is on the network", async () =>
    ((await fetch(`${SITE}/node/proposals/first%20steps/20`).then(r => r.json())).proposals ?? []).some((p: any) => p.uri.includes(WORDS)));
  // a taken-back link reads as used
  await page.goto(links[2]); await page.locator("h1").waitFor();
  await until("a used or taken-back link says so", async () => { await page.goto(`${SITE}/#/`); await page.goto(links[2]); await page.locator("h1").waitFor(); await page.waitForTimeout(1500); return (await page.locator("h1").innerText()).includes("used"); });
  console.log("done");
} catch (e) { console.error(e); await page?.screenshot({ path: `${out}/f-failed.png` }); await maker?.screenshot({ path: `${out}/f-failed-maker.png` }); process.exitCode = 1; }
await browser.close();
