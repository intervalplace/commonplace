# Commonplace

https://commonplace.place

A notebook that is also a shared memory.

You write something you mean and keep it. It goes onto Compute Substrate (CSD), a proof-of-work
network, where every node holds it with the time it was written. Nobody can edit it, remove it or
backdate it, including you. Your page is everything you have kept. Zoom out and the same entries
sit among everyone else's: by topic, and then all of them at once, as a sky.

There is no server, no account and no owner. The site is a static page. It reads from any CSD
node and writes with a key made in your browser.

This is a reference app: one way into a memory that doesn't depend on it. It shows what Compute
Substrate makes possible, and anyone can build another client with the format below. Nobody
promises to run this one forever.

The site doesn't display a few clearly illegal entries, only when reported, never by words or
opinions, and each one is listed publicly: [moderation/](moderation/README.md). The entries
themselves stay on the network, and other clients can show them.

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

  A `uri` holds 512 bytes, so a short entry lives entirely on the network. Proposals made by anything
  else show as they are, as links.
- **A profile** is an entry under the topic `cp.profile` with `uri` `cp:profile:<picture>:<name>`.
  The newest one from a key is that key's profile. Picture 0 is the one made from the key itself;
  1 to 16 are the pictures that ship with the app (`src/avatars.tsx`), so a profile is fully on
  the network and needs nothing hosted. Names are chosen, not owned, so the address always shows too.
- **A document** is a file kept on Arweave, which stores it for good, with an entry pointing at
  it: `cp:doc:ar://<arweave id>:<title>`, `payload_hash` = `sha256d(the file)`. The page signs the
  file as an Arweave data item with the writing key (`src/ans104.ts`) and hands it to Turbo
  (ArDrive's upload service), which stores files up to 105 KiB free. Readers check every file
  against the entry's fingerprint before showing it. Text only, by design: Markdown and plain text.
- **A guestbook** is the entries under the topic `cp.guestbook.<address, 40 hex>`, so every key
  has one without doing anything. Topics starting `cp.` belong to the app and aren't listed.
- **A page style** is an entry under the topic `cp.style` with `uri`
  `cp:style:<background>:<typeface>:<pinned entry id, or nothing>:<a few lines about you>`. The
  newest one from a key is how that key's page looks. Backgrounds are `paper`, `night`, `grid`,
  `notebook`, `kraft`, `print`, `moss` and `tiles`; typefaces `serif`, `mono` and `sans`. It is a
  fixed vocabulary rather than CSS, so no page can restyle the site into something it isn't (a
  fake wallet prompt, say). A client that doesn't know a name shows its own default.
- **Resonating** is a CSD attestation on the entry. Its fee is its weight, and it is public.
  The network ranks each topic's entries by that weight every epoch (30 blocks, about an hour).
- **Costs**, set by the network: 0.25 CSD to keep an entry, 0.05 CSD to resonate. The fees go to
  the miners who keep the network running. Nobody earns from writing.

Any other client that follows the table above reads and writes the same memory.

## Topping up with USDC

A new writer needs a little CSD. The page buys it on the open CSD/USDC market (`src/market.ts`):
market makers publish signed offers on AON, and a contract on Ethereum settles each trade. The
visitor's wallet signs an order and a USDC permit, with no transaction and no gas. A maker locks
the USDC, sends the CSD straight to the writing key, and is paid by the contract only once it
proves that payment with 20 CSD blocks on top. If it never does, the lock runs out and the USDC
goes back to the visitor; the wallet menu offers the refund. Any page can use the same market.

CSD can leave the same way it came: the wallet menu sends any amount, or all of it, to another
Compute Substrate address, and shows the writing key itself for importing into a CSD wallet. A
CSD address looks exactly like an Ethereum one, so the page refuses the connected Ethereum
address and warns before every send.

## Running it

```
npm install
NEXT_PUBLIC_CSD_API=https://your-csd-node npm run build    # static site in ./out
```

The node's API must allow the site's origin (CORS) and serve `/tip`, `/block/height/*`, `/utxos/*`, `/tx/submit`,
`/proposals/*`, `/proposal/*`, `/address/*/activity`, `/top/all-time`, `/recent/attestations/*`, `/topk/*` and `/domains`. A visitor can point
the page at another node with `?node=https://…`; it is remembered in their browser.

## Testing against a local network

A CSD node built for tests (`cargo build --features test-bypass`) with its genesis check relaxed
runs a private network. Then:

```
NEXT_PUBLIC_CSD_API=/node npm run build
node scripts/serve-local.mjs 3000 http://127.0.0.1:8789
CSD_API=http://127.0.0.1:8789 CSD_TEST_KEY=<key holding test CSD> npm test
CSD_FUND_KEY=<same key> npx tsx scripts/e2e-local.mts shots
```

`npm test` submits an entry, a reply and a resonance built by this code and requires the node to
accept each one with the same txid, which means the encoding matches the network's byte for byte.
`e2e-local.mts` does the same through the page in a browser, with a stand-in wallet. Never point
either at mainnet: what they write is permanent.

## Not yet

- Entries are read from the node's `/proposals` list (the newest 500 across all topics), and
  each topic's own `/proposals/<topic>` list (its newest 500) when that topic or the whole sky
  is opened. Topic counts come from `/domains`. A larger memory needs a lighter index.
- Resonance counts come from `/top/all-time`, which lists the network's 50 most resonated
  proposals, and from each Commonplace topic's `/recent/attestations/<topic>/200`, which only
  looks back over the last 10,000 blocks. An older entry outside the top 50 shows no count.
- Pending entries from other people (in the mempool, not yet in a block) are not shown yet.
