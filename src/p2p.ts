// Reaching a node directly, with no web server in between: over WebRTC to a node's csd-gateway, by
// an address like /ip4/1.2.3.4/udp/18001/webrtc-direct/certhash/…/p2p/12D3Koo…, which names the
// machine and the hash of its certificate, so there's no domain name or certificate authority to
// go through. Each request is one stream on /csd/rpc/1: {method, path, body} out, {status, body}
// back, the same JSON the node's HTTP RPC gives.
//
// `peerFetch` stands in for `fetch` wherever the page talks to a node, so everything else (the
// light client included) works unchanged. The networking library loads only when a peer address
// is used.

const PROTOCOL = "/csd/rpc/1";
// a node address that is a peer address rather than a URL
export const isPeerAddr = (base: string) => /^\/(ip4|ip6|dns4|dns6|dns)\/.+\/webrtc-direct\//.test(base);

type Lib = { node: any; multiaddr: (s: string) => any };
let lib: Promise<Lib> | null = null;
const load = () => (lib ??= (async () => {
  const [{ createLibp2p }, { webRTCDirect }, { noise }, { multiaddr }] = await Promise.all([
    import("libp2p"), import("@libp2p/webrtc"), import("@chainsafe/libp2p-noise"), import("@multiformats/multiaddr"),
  ]);
  const node = await createLibp2p({
    transports: [webRTCDirect()],
    connectionEncrypters: [noise()],
    // a node on this computer, or on the local network, is as welcome as a public one
    connectionGater: { denyDialMultiaddr: async () => false },
  });
  return { node, multiaddr };
})().catch(e => { lib = null; throw e; }));

const enc = new TextEncoder(), dec = new TextDecoder();

// `fetch` for a peer address: `base` is the address, the URL's path is the request
export function peerFetch(base: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(base)) throw new Error("PEER_FETCH: not this peer");
    const path = url.slice(base.length) || "/";
    const { node, multiaddr } = await load();
    const signal = init?.signal ?? AbortSignal.timeout(30_000);
    const stream = await node.dialProtocol(multiaddr(base), PROTOCOL, { signal });
    try {
      // reading starts before the request goes out: an answer that arrives while the request is
      // still closing is otherwise missed, and the stream's end with it
      const parts: Uint8Array[] = [];
      let size = 0;
      const reading = (async () => {
        for await (const chunk of stream) {
          const b = chunk instanceof Uint8Array ? chunk : chunk.subarray();
          size += b.length;
          if (size > 10 * 1024 * 1024) throw new Error("PEER_FETCH: answer too large");
          parts.push(b);
        }
      })();
      const body = init?.body == null ? undefined : String(init.body);
      stream.send(enc.encode(JSON.stringify({ method: (init?.method ?? "GET").toUpperCase(), path, ...(body !== undefined ? { body } : {}) })));
      // closing our side tells the node the request is complete. Not awaited: the browser's
      // close waits for an acknowledgement the node's WebRTC stack doesn't send, while the answer
      // itself arrives in full either way
      stream.close({ signal }).catch(() => {});
      await Promise.race([reading, new Promise((_, no) => signal.addEventListener("abort", () => no(signal.reason ?? new Error("PEER_FETCH: timeout")), { once: true }))]);
      const all = new Uint8Array(size);
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      const res = JSON.parse(dec.decode(all)) as { status: number; body: string };
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
    } catch (e) {
      stream.abort?.(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }) as typeof fetch;
}

// `fetch` for any node address: a URL goes over HTTP, a peer address over WebRTC
export const fetchFor = (base: string): typeof fetch => (isPeerAddr(base) ? peerFetch(base) : fetch.bind(globalThis));
