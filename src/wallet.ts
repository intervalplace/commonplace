// Finding the browser's Ethereum wallets (EIP-6963, then window.ethereum) and asking one to sign
// the writing-key message. Nothing is sent anywhere; the signature only makes the key.

import { WALLET_MESSAGE, keyFromSignature, bytesToHex, utf8, type CsdKey, type Hex } from "./csd";

export type Provider = { request(args: { method: string; params?: unknown[] }): Promise<any> };
export type WalletInfo = { id: string; name: string; icon?: string; provider: Provider };

export function discoverWallets(onChange: (ws: WalletInfo[]) => void): () => void {
  const found = new Map<string, WalletInfo>();
  const emit = () => {
    const list = [...found.values()];
    const eth = (window as any).ethereum as Provider | undefined;
    if (!list.length && eth) list.push({ id: "injected", name: "Browser wallet", provider: eth });
    onChange(list);
  };
  const onAnnounce = (e: any) => {
    const d = e?.detail;
    if (!d?.info?.rdns || !d.provider) return;
    found.set(d.info.rdns, { id: d.info.rdns, name: String(d.info.name ?? d.info.rdns), icon: d.info.icon, provider: d.provider });
    emit();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const t = setTimeout(emit, 400);
  return () => { window.removeEventListener("eip6963:announceProvider", onAnnounce); clearTimeout(t); };
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
