// A writing key from a passkey (Face ID, Touch ID, Windows Hello, a phone or a security key),
// for people without an Ethereum wallet. WebAuthn's PRF extension has the passkey return the same
// 32 secret bytes every time it is asked with the same salt; those become the writing key. Nothing
// is stored or sent anywhere: the passkey (synced by the platform's password manager) is the key.
//
// A passkey belongs to the site's domain, so this key can only be made again on the same domain.
// Its writing key can still be shown and used anywhere else, like any other.

import { sha256 } from "@noble/hashes/sha2";
import { concat, keyFromPrivate, utf8, type CsdKey } from "./csd";

const SALT = sha256(utf8("commonplace writing key v1"));
const buf = (b: Uint8Array) => new Uint8Array(b) as Uint8Array<ArrayBuffer>;
const fromSecret = (s: ArrayBuffer) => keyFromPrivate(sha256(concat(utf8("commonplace passkey v1"), new Uint8Array(s))));

export const passkeysHere = () => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

export class NoPrf extends Error { constructor() { super("NO_PRF"); } }

// asks any passkey this site has made for its secret
export async function signInWithPasskey(): Promise<CsdKey> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      rpId: location.hostname,
      userVerification: "required",
      extensions: { prf: { eval: { first: buf(SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen.");
  const first = (cred.getClientExtensionResults() as any).prf?.results?.first as ArrayBuffer | undefined;
  if (!first) throw new NoPrf();
  return fromSecret(first);
}

// makes a new passkey for this site, then reads its secret (some passkeys give it on creation)
export async function makePasskey(): Promise<CsdKey> {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: "Commonplace", id: location.hostname },
      user: { id: buf(crypto.getRandomValues(new Uint8Array(16))), name: "Commonplace writing key", displayName: "Commonplace writing key" },
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: buf(SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was made.");
  const prf = (cred.getClientExtensionResults() as any).prf;
  if (prf?.results?.first) return fromSecret(prf.results.first);
  if (prf?.enabled === false) throw new NoPrf();
  // made, but the secret only comes when it is used: use it once
  const got = await navigator.credentials.get({
    publicKey: {
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: cred.rawId }],
      userVerification: "required",
      extensions: { prf: { eval: { first: buf(SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  const first = (got?.getClientExtensionResults() as any)?.prf?.results?.first as ArrayBuffer | undefined;
  if (!first) throw new NoPrf();
  return fromSecret(first);
}
