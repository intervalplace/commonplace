// Finding the browser's Ethereum wallets (EIP-6963, then window.ethereum) and asking one to sign
// the writing-key message. Nothing is sent anywhere; the signature only makes the key.

import { WALLET_MESSAGE, keyFromSignature, bytesToHex, utf8, type CsdKey, type Hex } from "./csd";

export type Provider = { request(args: { method: string; params?: unknown[] }): Promise<any> };
export type WalletInfo = { id: string; name: string; icon?: string; provider: Provider };

// Wallets announce themselves (EIP-6963) or put themselves on window.ethereum, and some do either
// only a moment after the page loads (Firefox, and Brave with an extension instead of its own
// wallet, can be slow), so this asks a few times over several seconds and also takes a
// window.ethereum that turns up late.
export function discoverWallets(onChange: (ws: WalletInfo[]) => void): () => void {
  const found = new Map<string, WalletInfo>();
  let done = false;
  const emit = () => {
    if (done) return;
    const list = [...found.values()];
    const eth = (window as any).ethereum as (Provider & { providers?: Provider[]; isBraveWallet?: boolean; isMetaMask?: boolean }) | undefined;
    if (!list.length && eth) {
      // several extensions sharing window.ethereum list themselves in .providers
      const all = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
      all.forEach((p: any, i) => list.push({ id: `injected-${i}`, name: p.isBraveWallet ? "Brave Wallet" : p.isRabby ? "Rabby" : p.isMetaMask ? "MetaMask" : "Browser wallet", provider: p }));
    }
    onChange(list);
  };
  const onAnnounce = (e: any) => {
    const d = e?.detail;
    if (!d?.info?.rdns || !d.provider) return;
    found.set(d.info.rdns, { id: d.info.rdns, name: String(d.info.name ?? d.info.rdns), icon: d.info.icon, provider: d.provider });
    emit();
  };
  const ask = () => window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.addEventListener("ethereum#initialized", emit);
  ask();
  const timers = [
    setTimeout(emit, 400),
    ...[1000, 2500, 5000].map(ms => setTimeout(() => { ask(); emit(); }, ms)),
  ];
  return () => {
    done = true;
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    window.removeEventListener("ethereum#initialized", emit);
    timers.forEach(clearTimeout);
  };
}

// Signs twice: a wallet that signs non-deterministically would make a different key each time,
// and writing with a key you can't get back would strand its CSD
export async function deriveKey(w: WalletInfo): Promise<{ key: CsdKey; account: Hex }> {
  const [account] = await w.provider.request({ method: "eth_requestAccounts" });
  if (!account) throw new Error("No account was shared.");
  const msg = bytesToHex(utf8(WALLET_MESSAGE));
  const a: Hex = await w.provider.request({ method: "personal_sign", params: [msg, account] });
  const b: Hex = await w.provider.request({ method: "personal_sign", params: [msg, account] });
  if (a.toLowerCase() !== b.toLowerCase()) throw new Error("This wallet signs differently each time, so it can't make a lasting key. Try another wallet.");
  return { key: keyFromSignature(a), account };
}

// The connected Ethereum account, asking the wallet if it hasn't shared one yet
export async function account(w: WalletInfo): Promise<Hex> {
  const [a] = await w.provider.request({ method: "eth_requestAccounts" });
  if (!a) throw new Error("No account was shared.");
  return a;
}
