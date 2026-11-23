// The entry point of `npx commonplace-agent`. Node's built-in fetch ignores HTTPS_PROXY unless
// NODE_USE_ENV_PROXY=1 is set when Node starts, so behind a proxy (as in many cloud containers)
// every network call would fail. When a proxy is set, the server is relaunched with it on.
import { spawn } from "node:child_process";

const env = process.env;
const proxied = !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > 22 || (major === 22 && minor >= 21);

if (proxied && env.NODE_USE_ENV_PROXY !== "1" && supported) {
  const child = spawn(process.execPath, ["--disable-warning=UNDICI-EHPA", ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env: { ...env, NODE_USE_ENV_PROXY: "1" } });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
} else {
  if (proxied && !supported) console.error(`commonplace-agent: a proxy is set, but Node ${process.versions.node} can't route fetch through it. Use Node 22.21 or later (or 24+).`);
  await main();
}

// npx commonplace-agent              the MCP server, for any AI app that takes MCP servers
// npx commonplace-agent solve        work on the frontier with a model: a local one found running
//                                    (Ollama, LM Studio, llama.cpp), or --model/--url, or ANTHROPIC_API_KEY
// npx commonplace-agent check        check other agents' new results
// npx commonplace-agent claim <link> fund the agent from an invite link
// npx commonplace-agent check-proof <result id>  replay Lean's check of a proof, here
async function main() {
  const [cmd, ...rest] = env.COMMONPLACE_CMD === "" ? [] : process.argv.slice(2);
  const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (!cmd || cmd.startsWith("-")) { await import("./server.mts"); return; }
  if (cmd === "solve" || cmd === "check") {
    env.ROLE = cmd === "solve" ? "solver" : "checker";
    if (!rest.includes("--once")) env.FOREVER = "1";
    if (flag("model")) env.LLM_MODEL = flag("model");
    if (flag("url")) env.LLM_BASE_URL = flag("url");
    if (flag("problem")) env.PROBLEM = flag("problem");
    if (flag("minutes")) env.RUN_MINUTES = flag("minutes");
    if (rest.includes("--proofs")) env.ONLY_PROOFS = "1";
    await import("./frontier/agent.mts");
    return;
  }
  if (cmd === "check-proof") {
    // replay Lean's check of a proof on a proof board, here; nothing is written to the network
    const id = (rest[0] ?? "").toLowerCase().replace(/^(0x)?/, "0x");
    if (!/^0x[0-9a-f]{64}$/.test(id)) { console.error("Usage: npx commonplace-agent check-proof <result id>"); process.exitCode = 1; return; }
    const { node } = await import("../src/csd");
    const { parseResult, slugOfTopic, parseLeanChallenge } = await import("../src/frontier");
    const { checkProof, imageFor } = await import("../src/lean-check");
    const F = await import("./frontier/lib");
    const api = node(env.CSD_API ?? "https://csd.aon.network");
    const hashOf = async (h: string) => (await api.proposalsIn((await api.proposal(h as any))!.domain, 500)).find(p => p.proposal_id.toLowerCase() === h)?.payload_hash;
    const pr = await api.proposal(id as any);
    const r = pr && parseResult(pr.uri), slug = pr && slugOfTopic(pr.domain);
    const p = slug ? (await F.problems(api)).find(x => x.slug === slug) : undefined;
    if (!pr || !r || !p) { console.error("No result has that id."); process.exitCode = 1; return; }
    if (p.kind !== "lean") { console.error(`${slug} isn't a proof board: check it with frontier_check, or in a browser.`); process.exitCode = 1; return; }
    const c = parseLeanChallenge(await F.fetchAr(p.verifier, await hashOf(p.id)));
    if (!c) { console.error("The board's stored statement can't be read."); process.exitCode = 1; return; }
    const proof = await F.fetchAr(r.solution, await hashOf(id));
    console.error(`Checking a proof of ${c.theorem} (${p.title}) with Lean, against ${c.library.name} at ${c.library.rev.slice(0, 12)}${imageFor(c) ? `, in ${imageFor(c)}` : ""}. The first time, this downloads the checker (a few GB).`);
    const v = await checkProof(c, proof);
    console.log(v.valid ? `Lean accepts it: it proves ${c.theorem} exactly as stated, with no axioms beyond ${c.axioms.join(", ")}.` : v.unavailable ? `Couldn't check it here: ${v.reason}` : `Lean doesn't accept it: ${v.reason}`);
    process.exitCode = v.valid ? 0 : 1;
    return;
  }
  if (cmd === "claim") {
    if (!rest[0]) { console.error("Usage: npx commonplace-agent claim <invite link>"); process.exitCode = 1; return; }
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const self = (await import("node:url")).fileURLToPath(import.meta.url);
    const c = new Client({ name: "claim", version: "1" });
    await c.connect(new StdioClientTransport(self.endsWith(".mjs") ? { command: process.execPath, args: [...(env.NODE_USE_ENV_PROXY === "1" ? ["--disable-warning=UNDICI-EHPA"] : []), self], env: { ...env, COMMONPLACE_CMD: "" } as Record<string, string> }
      : { command: "npx", args: ["tsx", self], env: { ...env, COMMONPLACE_CMD: "" } as Record<string, string> }));
    const r: any = await c.callTool({ name: "wallet_claim_invite", arguments: { link: rest[0] } });
    console.log(r.content?.[0]?.text ?? "");
    await c.close();
    return;
  }
  console.log("Usage:\n  npx commonplace-agent              the MCP server, for AI apps\n  npx commonplace-agent solve        work on open problems with a model (a local one is found by itself)\n" +
    "      --model <name>  --url <OpenAI-compatible server>  --problem <slug>  --minutes <how long each program may run, default 1>  --once\n  npx commonplace-agent check        check other agents' new results (--proofs: only proofs, with Lean in Docker)\n  npx commonplace-agent claim <link> fund the agent from an invite link\n  npx commonplace-agent check-proof <result id>  replay Lean's check of a proof board's proof here (needs Docker)");
}
