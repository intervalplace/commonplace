"use client";

// Adding CSD to the writing key with USDC, from the open market (see market.ts)

import { useEffect, useState } from "react";
import { COIN, MIN_FEE_PROPOSE, type CsdKey, type Hex, type Node } from "./csd";
import { aonLink, findReceipt, quotes, refund, refundable, topUp, topUpStatus, usdcBalance, USDC_UNIT, type TopUp } from "./market";
import { account, discoverWallets, type WalletInfo } from "./wallet";

export type EthWallet = { wallet: WalletInfo; account: Hex };
const K_TOPUPS = "commonplace.topups1";
export const K_PAYER = "commonplace.payer1"; // which wallet (its id) paid or connected, for this tab
const loadTopUps = (): TopUp[] => { try { return JSON.parse(localStorage.getItem(K_TOPUPS) ?? "[]"); } catch { return []; } };
const saveTopUps = (t: TopUp[]) => { try { localStorage.setItem(K_TOPUPS, JSON.stringify(t.slice(0, 20))); } catch {} };
const fmt = (units: bigint, unit: bigint, digits = 2) => (Number(units) / Number(unit)).toLocaleString("en-US", { maximumFractionDigits: digits });

function explain(e: any): string {
  const m = String(e?.message ?? e);
  if (/rejected|denied/i.test(m)) return "The wallet didn't sign, so nothing happened.";
  if (m.includes("NOT_ENOUGH_USDC")) return "This wallet doesn't hold that much USDC on Ethereum.";
  if (m.includes("NO_OFFER")) return "No market maker is selling CSD right now. Try again later.";
  if (m.includes("NO_MAKER_ANSWERED")) return "No market maker took the order. Nothing was taken from you; try again in a few minutes.";
  if (m.includes("MARKET_FULL")) return "The market is at its limit for open trades right now. Try again in a few minutes.";
  if (/AON|fetch|network/i.test(m)) return "Couldn't reach the market. Try again in a moment.";
  return m;
}

export function TopUpBox({ me, eth, setEth, csdNode, onLocked, compact }: {
  me: CsdKey; eth: EthWallet | null; setEth: (e: EthWallet) => void; csdNode: Node; onLocked: () => void; compact?: boolean;
}) {
  const [spend, setSpend] = useState("2");
  const [preview, setPreview] = useState<null | { csd: bigint; total: bigint; fee: bigint }>(null);
  const [none, setNone] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [doneLink, setDoneLink] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const units = (() => { const n = Number(spend); return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n; })();

  useEffect(() => {
    setPreview(null); setNone(false);
    if (!units) return;
    const t = setTimeout(() => quotes(units).then(q => q[0] ? setPreview({ csd: q[0].csd, total: q[0].total, fee: q[0].fee }) : setNone(true)).catch(() => setNone(true)), 300);
    return () => clearTimeout(t);
  }, [units]);
  useEffect(() => { if (eth) usdcBalance(eth.wallet.provider, eth.account as any).then(setUsdc).catch(() => setUsdc(null)); }, [eth]);

  const go = async () => {
    if (!eth) return;
    setErr(null); setDone(null);
    try {
      const t = await topUp({ provider: eth.wallet.provider, buyer: eth.account as any, key: me, spend: units, csdNode, onStep: setBusy });
      saveTopUps([t, ...loadTopUps()]);
      setDoneLink(aonLink(t.aonHash));
      setDone(t.status === "locked"
        ? `Done. About ${fmt(BigInt(t.csd), COIN)} CSD is on its way to your writing key and shows up within a few minutes.`
        : "The market maker took the order. Your CSD should arrive within a few minutes; if it doesn't, your USDC comes back.");
      onLocked();
    } catch (e) { setErr(explain(e)); } finally { setBusy(null); }
  };

  return (
    <div className="cp-topup" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <strong style={{ fontWeight: 600 }}>Top up with USDC</strong>
      {!eth ? <PickWallet onPick={setEth} /> : (
        <>
          <div role="group" aria-label="Amount" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {["2", "5"].map(v => <button key={v} type="button" aria-pressed={spend === v} className="choice" style={{ padding: "8px 12px", fontWeight: spend === v ? 600 : 400, borderColor: spend === v ? "var(--accent)" : undefined }} onClick={() => setSpend(v)}>{v} USDC</button>)}
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input aria-label="Other amount in USDC" inputMode="decimal" value={spend} onChange={e => setSpend(e.target.value.replace(/[^0-9.]/g, ""))} style={{ width: 70, font: "inherit", padding: "8px 10px", border: "1px solid var(--edge)", borderRadius: 8 }} /> USDC
            </label>
          </div>
          <span className="cp-hint">
            {preview ? `About ${fmt(preview.csd, COIN, 0)} CSD, enough for about ${fmt(preview.csd / MIN_FEE_PROPOSE, 1n, 0)} entries. Includes the market maker's ${fmt(preview.fee, USDC_UNIT)} USDC fee.`
              : none ? "No offer covers that amount right now. Most makers take 1 to 30 USDC." : units ? "Checking the market…" : ""}
          </span>
          {!compact && <span className="cp-hint">No gas: you sign twice in your wallet and the market maker sends the transaction. Your USDC is only paid out once the CSD has arrived.</span>}
          {usdc !== null && <span className="cp-hint">This wallet holds {fmt(usdc, USDC_UNIT)} USDC.</span>}
          <button type="button" className="cp-btn" disabled={!preview || !!busy} onClick={go}>{busy ?? `Top up ${spend} USDC`}</button>
          {err && <span className="cp-hint over">{err}</span>}
          {done && <span className="cp-hint" style={{ color: "var(--ink)" }}>{done} {doneLink && <a href={doneLink} target="_blank" rel="noreferrer noopener">Receipt</a>}</span>}
          <PastTopUps eth={eth} />
        </>
      )}
    </div>
  );
}

function PickWallet({ onPick }: { onPick: (e: EthWallet) => void }) {
  const [ws, setWs] = useState<WalletInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => discoverWallets(setWs), []);
  // the wallet used earlier in this tab: picked again without a prompt, if it still shares the account
  useEffect(() => {
    let id: string | null = null; try { id = sessionStorage.getItem(K_PAYER); } catch {}
    const w = ws?.find(x => x.id === id);
    if (w) w.provider.request({ method: "eth_accounts" }).then((a: string[]) => { if (a?.[0]) onPick({ wallet: w, account: a[0] as Hex }); }).catch(() => {});
  }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <span className="cp-hint">Pay from an Ethereum wallet holding USDC.</span>
      {ws === null ? <span className="cp-hint">Looking for wallets…</span> : ws.length === 0 ? <span className="cp-hint">No browser wallet found.</span> :
        ws.map(w => <button key={w.id} type="button" className="choice" onClick={async () => { try { onPick({ wallet: w, account: await account(w) }); try { sessionStorage.setItem(K_PAYER, w.id); } catch {} } catch (e) { setErr(explain(e)); } }}>{w.name}</button>)}
      {err && <span className="cp-hint over">{err}</span>}
    </>
  );
}

// Earlier top-ups from this browser, and a refund for any that ran out of time unpaid
function PastTopUps({ eth }: { eth: EthWallet }) {
  const [list, setList] = useState<(TopUp & { canRefund?: boolean })[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const ts = loadTopUps().filter(t => t.auth.buyer?.toLowerCase() === eth.account.toLowerCase()).slice(0, 5);
      const out: (TopUp & { canRefund?: boolean })[] = [];
      for (const t of ts) {
        try {
          const status = t.status === "done" ? "done" : await topUpStatus(eth.wallet.provider, t);
          const receipt = t.receipt ?? (status === "done" ? await findReceipt(t).catch(() => null) ?? undefined : undefined);
          out.push({ ...t, status, receipt, canRefund: status === "locked" && await refundable(eth.wallet.provider, t) });
        } catch { out.push(t); }
      }
      if (!live) return;
      saveTopUps(loadTopUps().map(t => out.find(o => o.authHash === t.authHash) ?? t));
      setList(out);
    })();
    return () => { live = false; };
  }, [eth]);
  if (!list.length) return null;
  const word = { waiting: "waiting for a maker", locked: "on its way", done: "arrived", refunded: "refunded", failed: "not taken" } as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--muted)" }}>
      {list.map(t => (
        <span key={t.authHash}>
          {fmt(BigInt(t.total), USDC_UNIT)} USDC for {fmt(BigInt(t.csd), COIN, 0)} CSD, {word[t.status]}
          {t.status !== "failed" && <> <a href={aonLink(t.receipt ?? t.aonHash)} target="_blank" rel="noreferrer noopener">Receipt</a></>}
          {t.canRefund && <button type="button" className="choice" style={{ marginLeft: 8, padding: "4px 8px" }} onClick={async () => {
            try { await refund(eth.wallet.provider, eth.account as any, t); setMsg("Refund sent. Your USDC is back once it's in a block."); } catch (e) { setMsg(explain(e)); }
          }}>Get the USDC back</button>}
        </span>
      ))}
      {msg && <span>{msg}</span>}
    </div>
  );
}
