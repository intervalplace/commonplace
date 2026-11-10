# Commonplace

https://commonplace.place

A notebook that is also a shared memory.

You write something you mean and keep it. It goes onto Compute Substrate (CSD), a proof-of-work
chain, where every node holds it with the time it was written. Nobody can edit it, remove it or
backdate it, including you. Your page is everything you have kept. Zoom out and the same entries
sit among everyone else's: by topic, and then all of them at once, as a sky.

There is no server, no account and no owner. The site is a static page. It reads from any CSD
node and writes with a key made in your browser.

## How it works

- **Your key.** Your Ethereum wallet signs one fixed message, and that signature becomes your
  CSD writing key (`src/csd.ts`, `keyFromSignature`). The same wallet makes the same key on any
  device, so there is nothing to back up. The signature never leaves the page.
- **An entry** is a CSD proposal (`src/entries.ts`):

  | field           | value                                                    |
  |-----------------|----------------------------------------------------------|
  | `domain`        | the topic, lower case                                    |
  | `uri`           | `cp:` + the text, or `cp:re:<proposal id>:` + the text for a reply |
  | `payload_hash`  | `sha256d(utf8(text))`                                    |
  | `expires_epoch` | ten million epochs out, so it can be resonated with for good |

  A `uri` holds 512 bytes, so a short entry lives entirely on chain. Proposals made by anything
  else show as they are, as links.
- **A profile** is an entry under the topic `cp.profile` with `uri` `cp:profile:<picture>:<name>`.
  The newest one from a key is that key's profile. Picture 0 is the one made from the key itself;
  1 to 16 are the pictures that ship with the app (`src/avatars.tsx`), so a profile is fully on
  chain and needs nothing hosted. Names are chosen, not owned, so the address always shows too.
- **A document** is a file kept on Arweave, which stores it for good, with an entry pointing at
  it: `cp:doc:ar://<arweave id>:<title>`, `payload_hash` = `sha256d(the file)`. The page signs the
  file as an Arweave data item with the writing key (`src/ans104.ts`) and hands it to Turbo
  (ArDrive's upload service), which stores files up to 105 KiB free. Readers check every file
  against the entry's fingerprint before showing it. For now: Markdown and plain text.
- **A guestbook** is the entries under the topic `cp.guestbook.<address, 40 hex>`, so every key
  has one without doing anything. Topics starting `cp.` belong to the app and aren't listed.
- **Resonating** is a CSD attestation on the entry. Its fee is its weight, and it is public.
  Consensus ranks each topic's entries by that weight every epoch (30 blocks, about an hour).
- **Costs**, set by the chain: 0.25 CSD to keep an entry, 0.05 CSD to resonate. The fees go to
  the miners who keep the chain running. Nobody earns from writing.

Any other client that follows the table above reads and writes the same memory.

## Topping up with USDC

A new writer needs a little CSD. The page buys it on the open CSD/USDC market (`src/market.ts`):
market makers publish signed offers on AON, and a contract on Ethereum settles each trade. The
visitor's wallet signs an order and a USDC permit, with no transaction and no gas. A maker locks
the USDC, sends the CSD straight to the writing key, and is paid by the contract only once it
proves that payment with 20 CSD blocks on top. If it never does, the lock runs out and the USDC
goes back to the visitor; the wallet menu offers the refund. Any page can use the same market.

## Running it

```
npm install
NEXT_PUBLIC_CSD_API=https://your-csd-node npm run build    # static site in ./out
```

The node's API must allow the site's origin (CORS) and serve `/tip`, `/block/height/*`, `/utxos/*`, `/tx/submit`,
`/proposals/*`, `/proposal/*`, `/address/*/activity`, `/top/all-time`, `/topk/*` and `/domains`. A visitor can point
the page at another node with `?node=https://…`; it is remembered in their browser.

## Testing against a local chain

A CSD node built for tests (`cargo build --features test-bypass`) with its genesis check relaxed
runs a private chain. Then:

```
NEXT_PUBLIC_CSD_API=/node npm run build
node scripts/serve-local.mjs 3000 http://127.0.0.1:8789
CSD_API=http://127.0.0.1:8789 CSD_TEST_KEY=<key holding test CSD> npm test
CSD_FUND_KEY=<same key> npx tsx scripts/e2e-local.mts shots
```

`npm test` submits an entry, a reply and a resonance built by this code and requires the node to
accept each one with the same txid, which means the encoding matches the chain's byte for byte.
`e2e-local.mts` does the same through the page in a browser, with a stand-in wallet. Never point
either at mainnet: what they write is permanent.

## Not yet

- Entries are read from the node's `/proposals` list, which walks the chain and returns the
  newest 500. A larger memory needs a lighter index.
- Resonance counts come from `/top/all-time`, which lists the 50 most resonated entries.
- Pending entries from other people (in the mempool, not yet in a block) are not shown yet.
