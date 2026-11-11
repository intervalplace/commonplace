// Runs a verifier (or a solving program) from someone else in a separate Node process with the
// permission model on: no file access, no child processes, no environment (so no keys), and a
// time limit. Network access is not blocked by Node, so nothing secret is ever passed in.

import { spawn } from "node:child_process";
import { RUNNER } from "./frontier";

export function runSandboxed(source: string, fn: string, input: unknown, ms = 20_000): Promise<{ ok: boolean; out?: any; error?: string }> {
  return new Promise(resolve => {
    const code = `${RUNNER}
let s = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", d => s += d).on("end", () => { process.stdout.write(JSON.stringify(run(JSON.parse(s)))); });`;
    // the permission model is "--permission" from Node 23, "--experimental-permission" in 20 to 22
    const flag = Number(process.versions.node.split(".")[0]) >= 23 ? "--permission" : "--experimental-permission";
    const p = spawn(process.execPath, [flag, "--max-old-space-size=512", "--no-warnings", "-e", code], { env: {} as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); resolve({ ok: false, error: `took longer than ${ms / 1000} seconds` }); }, ms);
    p.stdout.on("data", d => out += d);
    p.stderr.on("data", d => err += d);
    p.on("close", () => {
      clearTimeout(t);
      try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, error: (err || "no answer").slice(0, 500) }); }
    });
    p.stdin.end(JSON.stringify({ source, fn, input }));
  });
}

export async function verifyNode(verifier: string, solution: string) {
  const r = await runSandboxed(verifier, "verify", solution);
  if (!r.ok) return { valid: false, score: NaN, reason: r.error ?? "the verifier failed" };
  const o = r.out ?? {};
  return { valid: !!o.valid, score: Number(o.score), reason: o.reason ? String(o.reason) : undefined };
}
