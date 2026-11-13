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
  await import("./server.mts");
}
