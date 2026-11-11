// Signs in with a stand-in Cairn Wallet and keeps an entry and a resonance through it, on a local
// test network. The stand-in answers like Cairn's provider (window.cairn, csd:announceProvider,
// {ok, result} envelopes) and builds each transaction here with a funded key, as Cairn would with
// its own. It also checks a refusal shows plainly and that the features needing the page's own key
// step aside.
//
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-cairn.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";
import { buildAppTx, hexToBytes, keyFromSignature, node, WALLET_MESSAGE, type Hex } from "../src/csd";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3000";
const out = process.argv[2] ?? "e2e-shots";
const api = node(process.env.CSD_API ?? "http://127.0.0.1:8789");
// the account the stand-in Cairn holds: the stand-in Ethereum wallet's writing key, which e2e-local funds
const acct = keyFromSignature(await privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d").signMessage({ message: WALLET_MESSAGE }));
const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); console.log("ok  " + what); };
const WORDS = `Kept through Cairn, ${Date.now()}.`;
let refuseNext = false;
const asked: string[] = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.exposeBinding("__cairn", async (_s: unknown, method: string, p: any) => {
  asked.push(method);
  if (method === "connect") return { ok: true, result: { addr: acct.addr20 } };
  if (refuseNext) { refuseNext = false; return { ok: true, result: { ok: false, error: "user rejected", code: "USER_REJECTED" } }; }
  const app = method === "propose"
    ? { kind: "propose" as const, domain: p.domain, payloadHash: hexToBytes(p.payloadHash), uri: p.uri, expiresEpoch: BigInt(p.expiresEpoch) }
    : { kind: "attest" as const, proposalId: p.proposalId as Hex, score: p.score, confidence: p.confidence };
  try {
    const tx = buildAppTx(await api.utxos(acct.addr20), acct, app, BigInt(p.fee));
    const txid = await api.submit(tx);
    return { ok: true, result: { ok: true, txid, sighashMatch: true } };
  } catch (e: any) { return { ok: true, result: { ok: false, error: String(e?.message ?? e), code: "INTERNAL" } }; }
});
await ctx.addInitScript(`(() => {
  const call = (m) => (p) => window.__cairn(m, p ?? null);
  const provider = Object.freeze({ isCairn: true, version: "test", connect: call("connect"), getAddress: call("connect"), propose: call("propose"), attest: call("attest"), on() {}, removeListener() {} });
  Object.defineProperty(window, "cairn", { value: provider, writable: false });
  const detail = Object.freeze({ info: { uuid: "t", name: "Cairn Wallet", icon: "", rdns: "com.cairn-substrate.wallet" }, provider });
  window.addEventListener("csd:requestProvider", () => window.dispatchEvent(new CustomEvent("csd:announceProvider", { detail })));
})();`);
const page = await ctx.newPage();
try {
  await page.goto(`${SITE}/#/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Cairn Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor({ timeout: 30_000 });
  check((await page.locator(".cp-menu .addr").innerText()).trim().toLowerCase() === acct.addr20, "signing in with Cairn writes as the Cairn account");
  check((await page.getByRole("button", { name: "Show writing key" }).count()) === 0 && (await page.getByRole("button", { name: "Make invite links" }).count()) === 0, "what needs this page's own key isn't offered");
  await page.screenshot({ path: `${out}/c1-menu.png` });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /[1-9][0-9.]* CSD/.test(document.querySelector(".cp-wallet > button")?.textContent ?? ""), null, { timeout: 60_000 });
  check((await page.getByRole("button", { name: "Publish a document" }).count()) === 0, "documents aren't offered with Cairn");

  // declined in Cairn
  await page.locator("#draft").fill(WORDS);
  await page.locator(".cp-topic input").fill("cairn");
  await page.getByRole("button", { name: "Keep it", exact: true }).click();
  refuseNext = true;
  await page.getByRole("dialog").getByRole("button", { name: "Keep it forever" }).click();
  await page.getByText("You declined it in Cairn.").waitFor({ timeout: 30_000 });
  check(true, "declining in Cairn says so and keeps the draft");
  // approved
  await page.getByRole("dialog").getByRole("button", { name: "Keep it forever" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 30_000 });
  check(asked.filter(m => m === "propose").length === 2, "the entry went to Cairn for approval");
  const deadline = Date.now() + 25 * 60_000;
  let id: string | undefined;
  while (!id) {
    id = ((await fetch(`${SITE}/node/proposals/cairn/20`).then(r => r.json())).proposals ?? []).find((p: any) => p.uri.includes(WORDS))?.proposal_id;
    if (!id) { if (Date.now() > deadline) throw new Error("entry never landed"); await page.waitForTimeout(10_000); }
  }
  console.log("ok  the entry is on the network, from the Cairn account");
  const author = (await fetch(`${SITE}/node/proposal/${id.replace(/^0x/, "")}`).then(r => r.json())).proposal?.proposer;
  check(String(author).toLowerCase() === acct.addr20, "and its author is the Cairn account");
  await page.goto(`${SITE}/#/e/${id}`);
  await page.getByRole("button", { name: /Resonate/ }).first().click();
  const dlg = page.getByRole("dialog");
  if (await dlg.count()) await dlg.getByRole("button", { name: /Resonate/ }).last().click();
  await page.waitForTimeout(3000);
  check(asked.includes("attest"), "resonating goes to Cairn too");
  await page.screenshot({ path: `${out}/c2-entry.png` });
  console.log("done");
} catch (e) { console.error(e); await page.screenshot({ path: `${out}/c-failed.png` }); process.exitCode = 1; }
await browser.close();
