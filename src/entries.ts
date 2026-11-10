// What an entry is on chain. An entry is a CSD proposal:
//   domain         its topic
//   uri            "cp:" + the text, or "cp:re:<proposal id>:" + the text for a reply
//   payload_hash   sha256d(utf8(text))
//   expires_epoch  far away, so anyone can resonate with it for years
// A proposal made by anything else (a link, an anchored file) shows as it is.
// Resonating is an attestation: its fee is the weight, and every one is public.

import { EPOCH_LEN, MAX_DOMAIN_BYTES, MAX_URI_BYTES, sha256d, utf8, type Hex, type ProposalItem } from "./csd";

export const PREFIX = "cp:";
export const DEFAULT_TOPIC = "thoughts";
const KEEP_EPOCHS = 10_000_000n; // far beyond any reader's lifetime

export type Entry = {
  id: Hex;
  topic: string;
  text: string;          // the words, or the link for an outside proposal
  kind: "note" | "reply" | "link" | "profile" | "doc" | "style";
  docId?: string;
  hash?: string;         // payload_hash: the fingerprint of the text or file        // a document entry: its Arweave id (the title is `text`)
  pic?: number;          // a profile entry: its picture (0: the one made from the key) and name
  name?: string;
  style?: PageStyle;     // a style entry: how its key's page looks
  replyTo?: Hex;
  height: number;
  time: number;          // unix seconds, from the block
  pending?: boolean;     // sent, not in a block yet
  hidden?: string;       // not displayed on this site, and why (moderation/README.md)
  author?: Hex;
};

export function normTopic(t: string): string {
  const s = t.trim().toLowerCase().replace(/\s+/g, " ");
  return s || DEFAULT_TOPIC;
}

export function entryUri(text: string, replyTo?: Hex): string {
  return replyTo ? `${PREFIX}re:${replyTo.toLowerCase().replace(/^0x/, "")}:${text}` : `${PREFIX}${text}`;
}

// How many more bytes of text fit (negative: that many too many)
export function room(text: string, replyTo?: Hex): number {
  return MAX_URI_BYTES - utf8(entryUri(text, replyTo)).length;
}
export const topicOk = (t: string) => utf8(normTopic(t)).length <= MAX_DOMAIN_BYTES;

export function proposeArgs(text: string, topic: string, height: number, replyTo?: Hex) {
  return {
    kind: "propose" as const,
    domain: normTopic(topic),
    payloadHash: sha256d(utf8(text)),
    uri: entryUri(text, replyTo),
    expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS,
  };
}

export function parseEntry(p: ProposalItem): Entry {
  const base = { id: p.proposal_id.toLowerCase() as Hex, topic: p.domain, height: Number(p.height), time: Number(p.time), hash: p.payload_hash };
  const u = p.uri ?? "";
  const re = /^cp:re:([0-9a-f]{64}):/.exec(u);
  if (re) return { ...base, kind: "reply", replyTo: `0x${re[1]}` as Hex, text: u.slice(re[0].length) };
  const doc = /^cp:doc:ar:\/\/([A-Za-z0-9_-]{43}):/.exec(u);
  if (doc) return { ...base, kind: "doc", docId: doc[1], text: u.slice(doc[0].length) };
  const pr = /^cp:profile:(\d{1,3}):([^\n]{0,40})$/.exec(u);
  if (pr && p.domain === PROFILE_TOPIC) return { ...base, kind: "profile", pic: Number(pr[1]), name: pr[2].trim(), text: pr[2].trim() };
  const st = /^cp:style:([a-z]{1,16}):([a-z]{1,16}):([0-9a-f]{64})?:/.exec(u);
  if (st && p.domain === STYLE_TOPIC) {
    const bio = u.slice(st[0].length);
    return { ...base, kind: "style", text: bio, style: { bg: st[1], type: st[2], pin: st[3] ? (`0x${st[3]}` as Hex) : undefined, bio } };
  }
  if (u.startsWith(PREFIX)) return { ...base, kind: "note", text: u.slice(PREFIX.length) };
  return { ...base, kind: "link", text: u };
}

// A profile is an entry too, under its own topic: `cp:profile:<picture>:<name>`. The newest one
// from a key is that key's profile. Names are chosen, not owned, so the address always shows too.
export const PROFILE_TOPIC = "cp.profile";
export const NAME_MAX = 40;
export const cleanName = (n: string) => n.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
export function profileArgs(pic: number, name: string, height: number) {
  const uri = `${PREFIX}profile:${pic}:${cleanName(name)}`;
  return { kind: "propose" as const, domain: PROFILE_TOPIC, payloadHash: sha256d(utf8(uri)), uri, expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS };
}

// A page style is an entry too: `cp:style:<background>:<typeface>:<pinned entry id or nothing>:<a
// few lines about you>`, under its own topic. The newest one from a key is how that key's page
// looks. The names are a fixed vocabulary, not CSS, so a page can't imitate the site around it;
// a client that doesn't know a name shows its own default.
export const STYLE_TOPIC = "cp.style";
export const BACKGROUNDS = ["paper", "night", "grid", "notebook", "kraft", "print", "moss", "tiles"] as const;
export const TYPEFACES = ["serif", "mono", "sans"] as const;
export type PageStyle = { bg: string; type: string; pin?: Hex; bio: string };
export const styleUri = (s: PageStyle) => `${PREFIX}style:${s.bg}:${s.type}:${s.pin ? s.pin.toLowerCase().replace(/^0x/, "") : ""}:${s.bio}`;
export const styleRoom = (s: PageStyle) => MAX_URI_BYTES - utf8(styleUri({ ...s, pin: ("0x" + "0".repeat(64)) as Hex })).length;
export function styleArgs(s: PageStyle, height: number) {
  const uri = styleUri(s);
  return { kind: "propose" as const, domain: STYLE_TOPIC, payloadHash: sha256d(utf8(uri)), uri, expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS };
}

// Topics starting "cp." belong to the app (profiles, guestbooks) and aren't listed as topics
export const isReserved = (topic: string) => topic.startsWith("cp.");
// A guestbook is the entries under a topic named after the page's key, so every key has one
export const guestbookTopic = (addr: string) => `cp.guestbook.${addr.toLowerCase().replace(/^0x/, "")}`;
export const guestbookOwner = (topic: string): Hex | null => { const m = /^cp\.guestbook\.([0-9a-f]{40})$/.exec(topic); return m ? (`0x${m[1]}` as Hex) : null; };

// A document is a file kept on Arweave (stored for good, paid once) with an entry pointing at it:
// `cp:doc:ar://<id>:<title>`, payload_hash = sha256d(the file's bytes), so anyone can check that
// the file they read is the one that was published, and the block shows when
export const docUri = (arId: string, title: string) => `${PREFIX}doc:ar://${arId}:${title}`;
export const docRoom = (title: string) => MAX_URI_BYTES - utf8(docUri("x".repeat(43), title)).length;
export function docArgs(arId: string, title: string, topic: string, fileHash: Uint8Array, height: number) {
  return { kind: "propose" as const, domain: normTopic(topic), payloadHash: fileHash, uri: docUri(arId, title), expiresEpoch: BigInt(Math.floor(height / EPOCH_LEN)) + KEEP_EPOCHS };
}

export const linkHref = (u: string) => (/^https?:\/\//i.test(u) ? u : /^ipfs:\/\//i.test(u) ? `https://ipfs.io/ipfs/${u.slice(7)}` : null);
