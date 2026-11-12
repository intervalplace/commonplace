// Poses a problem through the page with a passkey: the verifier is tried in the browser (a lax one
// is caught by the wrong example), then posed, and it appears on the frontier. Local network with
// the stand-in Arweave; CSD_FUND_KEY funds the passkey's key.
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-pose.mts [out dir]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { COIN, buildSplitTx, hexToBytes, keyFromPrivate, node } from "../src/csd";
const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000", out = process.argv[2] ?? "e2e-shots";
const api = node(process.env.CSD_API ?? "http://127.0.0.1:8789");
const funder = keyFromPrivate(hexToBytes(process.env.CSD_FUND_KEY!));
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
const SLUG = `no-three-test-${Date.now() % 100000}`;
const verifier = readFileSync(new URL("../research/frontier/problems/no-three-in-line-47.js", import.meta.url), "utf8");
const good = Array.from({ length: 47 }, (_, x) => `${x} ${(x * x) % 47}`).join("\n");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const page = await ctx.newPage();
try {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  await page.goto(`${SITE}/#/frontier`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "New here? Make a passkey" }).click();
  await page.locator(".cp-menu .addr").waitFor({ timeout: 30_000 });
  const addr = (await page.locator(".cp-menu .addr").innerText()).trim().toLowerCase() as `0x${string}`;
  await page.keyboard.press("Escape");
  await api.submit(buildSplitTx(await api.utxos(funder.addr20), funder, [{ to: addr, value: COIN }]));

  await page.getByRole("link", { name: "Pose a problem" }).click();
  await page.getByLabel("Title").fill("No three in line (test)");
  await page.getByLabel("Short name, for its link").fill(SLUG);
  await page.getByLabel("Statement").fill("Place as many points as possible on a 47 x 47 grid with no three on a line. One point per line as \"x y\".");
  await page.getByLabel("Proven limit (only if it's proven)").fill("94");
  await page.getByRole("textbox", { name: "Verifier", exact: true }).fill("function verify(s) { return { valid: true, score: s.split('\\n').length }; }");
  await page.getByLabel("A correct example solution").fill(good);
  await page.getByLabel(/A wrong example/).fill("0 0\n1 1\n2 2");
  await page.getByRole("button", { name: "Try the verifier" }).click();
  await page.locator(".cp-trials li.no").first().waitFor();
  check(await page.getByText(/Your wrong example.*lets it through|lets it through/).count() > 0, "a lax verifier is caught: it accepts an empty and a wrong solution");
  check(await page.getByRole("button", { name: "Pose it for good" }).isDisabled(), "and it can't be posed");
  await page.getByRole("textbox", { name: "Verifier", exact: true }).fill(verifier);
  await page.getByRole("button", { name: "Try the verifier" }).click();
  await page.getByText("is accepted, scoring 47").waitFor();
  check((await page.locator(".cp-trials li.no").count()) === 0, "the real verifier passes every trial");
  await page.screenshot({ path: `${out}/p1-pose.png`, fullPage: true });
  await page.waitForFunction(() => /^[1-9]/.test(document.querySelector(".cp-wallet > button .bal")?.textContent?.trim() ?? ""), null, { timeout: 25 * 60_000, polling: 5000 });
  await page.waitForFunction(() => !document.querySelector(".actions .cp-btn")?.hasAttribute("disabled"), null, { timeout: 60_000 });
  await page.getByRole("button", { name: "Pose it for good" }).click();
  await page.getByRole("heading", { name: "Posed" }).waitFor({ timeout: 60_000 });
  check(true, "it's posed");
  const end = Date.now() + 25 * 60_000;
  while (!((await api.proposalsIn("frontier", 50)).some((p: any) => p.uri.includes(`cp:problem:${SLUG}:max:`) && p.uri.includes(":94\n")))) { if (Date.now() > end) throw new Error("never landed"); await page.waitForTimeout(10_000); }
  check(true, "it's on the network with its proven limit");
  await page.goto(`${SITE}/#/frontier/${SLUG}`);
  await page.getByText("No three in line (test)").first().waitFor({ timeout: 60_000 });
  await page.getByText("The verifier, which decides what counts").click();
  await page.getByText("function verify(solution)").waitFor({ timeout: 30_000 });
  check(true, "its page shows the verifier, read back from Arweave");
  console.log("done");
} catch (e) { console.error(e); await page.screenshot({ path: `${out}/p-failed.png`, fullPage: true }); process.exitCode = 1; }
await browser.close();
