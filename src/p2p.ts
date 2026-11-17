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

// At most this many requests to one node at a time; the rest wait their turn. The node serves 16
// streams per connection, and a page opening an entry asks for a burst of things at once.
const MAX_IN_FLIGHT = 12;
const queues = new Map<string, { busy: number; waiting: (() => void)[] }>();
async function turn(base: string): Promise<() => void> {
  let q = queues.get(base);
  if (!q) queues.set(base, (q = { busy: 0, waiting: [] }));
  if (q.busy >= MAX_IN_FLIGHT) await new Promise<void>(go => q!.waiting.push(go));
  q.busy++;
  return () => { q!.busy--; q!.waiting.shift()?.(); };
}

// `fetch` for a peer address: `base` is the address, the URL's path is the request
export function peerFetch(base: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const done = await turn(base);
    try { return await ask(base, input, init); } finally { done(); }
  }) as typeof fetch;
}

async function ask(base: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(base)) throw new Error("PEER_FETCH: not this peer");
    const path = url.slice(base.length) || "/";
    const { node, multiaddr } = await load();
    const signal = init?.signal ?? AbortSignal.timeout(30_000);
    const stream = await node.dialProtocol(multiaddr(base), PROTOCOL, { signal, maxOutboundStreams: 256 });
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
      // the whole answer is in: let go of the stream now rather than when the close times out, so
      // finished requests don't pile up against the browser's per-protocol stream limit
      stream.abort?.(new Error("done"));
      const all = new Uint8Array(size);
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      const res = JSON.parse(dec.decode(all)) as { status: number; body: string };
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
    } catch (e) {
      stream.abort?.(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }
}

// `fetch` for any node address: a URL goes over HTTP, a peer address over WebRTC
export const fetchFor = (base: string): typeof fetch => (isPeerAddr(base) ? peerFetch(base) : fetch.bind(globalThis));
