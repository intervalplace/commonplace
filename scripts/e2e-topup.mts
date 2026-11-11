// Tops up a writing key with USDC through the page, against a local market: anvil, the real
// settlement contract, a stand-in AON node and CSD node, and real market makers
// (aon-namespace-csd-usdc's test/dev-stack.mjs). Then waits for the CSD to arrive.
//
//   npx tsx test/dev-stack.mjs                                 (in aon-namespace-csd-usdc)
//   NEXT_PUBLIC_CSD_API=/node NEXT_PUBLIC_AON_NODES=/aon NEXT_PUBLIC_CHAIN_ID=31337 \
//     NEXT_PUBLIC_CSD_SETTLEMENT=… NEXT_PUBLIC_USDC=… NEXT_PUBLIC_CSD_GENESIS=… npm run build
//   node scripts/serve-local.mjs 3001 http://127.0.0.1:18991 http://127.0.0.1:18993
//   NODE_PATH=$(npm root -g) npx tsx scripts/e2e-topup.mts [out dir]

import { createRequire } from "node:module";
import { privateKeyToAccount } from "viem/accounts";

const { chromium } = createRequire(import.meta.url)("playwright");
const SITE = process.env.SITE ?? "http://localhost:3001";
const RPC = process.env.ETH_RPC ?? "http://127.0.0.1:8545";
const out = process.argv[2] ?? "e2e-shots";
const user = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1, holds test USDC

// The stand-in wallet: signs with the test key, passes everything else to anvil
async function rpc(method: string, params: unknown[]) {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [user.address];
  if (method === "personal_sign") return user.signMessage({ message: { raw: params[0] as `0x${string}` } });
  if (method === "eth_signTypedData_v4") {
    const td = JSON.parse(params[1] as string); const { EIP712Domain, ...types } = td.types;
    return user.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
  }
  if (method === "wallet_switchEthereumChain") return null;
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(x => x.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.exposeBinding("__eth", async (_s: unknown, method: string, params: unknown[]) => {
  try { return { ok: await rpc(method, params ?? []) }; } catch (e: any) { return { err: String(e.message ?? e) }; }
});
await ctx.addInitScript(`(() => {
  const provider = { request: async ({ method, params }) => { const r = await window.__eth(method, params || []); if (r.err) throw new Error(r.err); return r.ok; } };
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
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Test Wallet" }).click();
  await page.locator(".cp-menu .addr").waitFor();
  await page.getByText(/^About .* CSD, enough for about/).waitFor({ timeout: 30_000 });
  await shot("t1-menu-topup");
  await page.getByRole("button", { name: "Top up 2 USDC" }).click();
  await page.getByText(/^Done\. About|took the order/).waitFor({ timeout: 120_000 });
  await shot("t2-topup-done");
  const end = Date.now() + 5 * 60_000;
  while (!/[1-9][0-9.,]* CSD/.test((await page.locator(".cp-wallet > button").textContent()) ?? "")) {
    if (Date.now() > end) throw new Error("the CSD never arrived");
    await page.waitForTimeout(5000);
    await page.keyboard.press("Escape"); await page.reload(); await page.waitForTimeout(3000);
  }
  console.log("balance:", await page.locator(".cp-wallet > button").textContent());
  await page.locator(".cp-wallet > button").click(); await page.waitForTimeout(4000);
  await shot("t3-arrived");
  console.log("done");
} catch (e) { console.error(e); await shot("t-failed"); process.exitCode = 1; }
await browser.close();
