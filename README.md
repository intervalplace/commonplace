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

- **Your key.** Either your Ethereum wallet signs one fixed message and that signature becomes
  your CSD writing key (`src/csd.ts`, `keyFromSignature`), or a passkey (Face ID, Touch ID,
  Windows Hello, a phone) gives the same secret every time through WebAuthn's PRF extension and
  that becomes it (`src/passkey.ts`). Either way the same wallet or passkey makes the same key on
  any device, nothing is stored or sent anywhere, and there is nothing to back up. A passkey
  belongs to the site's domain, so its key can only be made again there; the wallet menu shows
  the writing key itself, for keeping elsewhere.
- **Or Cairn Wallet** ([cairn-substrate.com](https://cairn-substrate.com)), a browser extension
  that holds Compute Substrate keys itself (`src/cairn.ts`). Then the Cairn account is the writing
  key: the page never sees a private key, and Cairn asks before each entry and resonance. What
  needs the private key in the page isn't offered with Cairn: documents, remembering, invite links
  and buying CSD with USDC.
- **Before you sign in** you can write and save entries to keep later. They wait in your browser,
  seen by nobody, until you keep them.
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
- **Remembering someone** is a private note to yourself, kept as an entry under the topic
  `cp.remember` with `uri` `cp:remember:<base64url(nonce + sealed)>` (`src/remember.ts`). The
  sealed part is AES-256-GCM over one byte (1 remember, 0 forget) and the person's address, with
  a key derived from your writing key, so only your wallet can read it. Every one has the same
  length: anyone can see that a key kept something encrypted, and when, but not who or how many,
  or whether it was remembering or forgetting. Nobody is told. Replaying your own entries oldest
  first gives your list, on any device and in any client that knows the format.
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

Or someone can give it: an **invite link** carries CSD on a key of its own, with that key in the
link after the `#`, so it never reaches a server (`src/invite.ts`). Whoever opens it first moves
the CSD to their own writing key. Invite keys are made from the maker's writing key and numbered,
so the maker can find their links again on any device and take back any nobody used.

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
the page at another node with `?node=https://…` (their own, for example); it is remembered in their browser,
and `?node=default` forgets it.

To list more than one public node, build with `NEXT_PUBLIC_CSD_APIS=https://a,https://b`. When the node in use
stops answering, the page moves to the next one that does, so one node going down doesn't take the page with it.
A visitor's own node, when they have chosen one, is tried first.

## Checked, not trusted

The page doesn't take the node's word for what it shows. For an entry, it asks the node for a proof
(`/proof/tx`) and checks it in the browser (`src/light.ts`): the transaction's bytes and txid, its
author's signature, its merkle branch to a block header, and that header's place on the chain. Blocks
below the newest *anchor* (a block hash every 1000 blocks, in `src/anchors.json`) are fixed by hash
links to the anchors; every header above it is checked in full, proof-of-work and difficulty rule
included. A node can still leave things out, but not invent, alter or misattribute anything.

The node needs `/headers/:from/:count` (compute-substrate after v1.2.0). Before each release, refresh
the anchors from a node, which checks every header from genesis on the way:

```
npx tsx scripts/anchors.mts https://csd.aon.network
```

Anyone can run the same command against their own node to check a release's anchors.

## Reaching a node directly

A node's address can also be a peer address, for a node running `csd-gateway` (compute-substrate,
`gateway/`):

```
/ip4/203.0.113.7/udp/18001/webrtc-direct/certhash/uEiB…/p2p/12D3KooW…
```

The page then connects to the node over WebRTC, with no web server, domain name or certificate
authority in between, and asks it what it would ask an HTTP node (`src/p2p.ts`). Peer addresses work
anywhere a URL does: in `?node=`, in the node chooser, and in `NEXT_PUBLIC_CSD_APIS`. Everything
the page shows is still checked against the proof-of-work, so a peer needn't be trusted. The
networking library loads only when a peer address is used.

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
- The people you remember are read from the newest 500 things your key has done on the network.
- Pending entries from other people (in the mempool, not yet in a block) are not shown yet.
