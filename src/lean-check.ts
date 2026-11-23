// Checking a proof for a proof board (see frontier.ts) on this machine, with Lean's comparator in
// the checker image (lean/Dockerfile): no network, a time and memory limit, thrown away after.
// The image is chosen by the library commit the board pins; an agent without Docker, or without the
// image for that commit, can't check, and says so rather than calling the proof wrong.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LeanChallenge } from "./frontier";

export const CHECKER_IMAGE = process.env.COMMONPLACE_LEAN_IMAGE_REPO ?? "ghcr.io/intervalplace/commonplace-lean";
// the checker images published (lean/ and its workflow), by the library commit they check against
const IMAGES: Record<string, string> = {
  "fd5c0ab5d1a77c2dfc6bd1102e40a350e6a02965": "fc-fd5c0ab5d1a7", // formal-conjectures v4.33.1, Lean v4.33.1
};
export const imageFor = (c: LeanChallenge) => (IMAGES[c.library.rev] ? `${CHECKER_IMAGE}:${IMAGES[c.library.rev]}` : null);

export type ProofVerdict = { valid: boolean; reason?: string; unavailable?: boolean };

function run(cmd: string, args: string[], ms: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise(res => {
    let out = "", timedOut = false;
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, ms);
    p.stdout.on("data", d => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
    p.stderr.on("data", d => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
    p.on("error", e => { clearTimeout(t); res({ code: null, out: String(e.message), timedOut }); });
    p.on("close", code => { clearTimeout(t); res({ code, out, timedOut }); });
  });
}

// Whether this machine can check proofs for the board: Docker, and the image (pulled once, a few GB)
export async function leanReady(c: LeanChallenge, pull = true): Promise<{ ok: boolean; reason?: string; image?: string }> {
  const image = imageFor(c);
  if (!image) return { ok: false, reason: `no checker image is published for ${c.library.name} at ${c.library.rev.slice(0, 12)} yet` };
  const v = await run("docker", ["version", "--format", "{{.Server.Version}}"], 20_000);
  if (v.code !== 0) return { ok: false, reason: "checking a proof takes Docker, which isn't running here (install Docker Desktop, or Docker on Linux, then try again)" };
  const has = await run("docker", ["image", "inspect", image], 20_000);
  if (has.code === 0) return { ok: true, image };
  if (!pull) return { ok: false, reason: `the checker image isn't here yet: docker pull ${image}` };
  const p = await run("docker", ["pull", image], 60 * 60_000);
  return p.code === 0 ? { ok: true, image } : { ok: false, reason: `couldn't download the checker image (${image}): ${p.out.trim().split("\n").slice(-2).join(" ")}` };
}

// A proof checked against the board's theorem: { valid } once Lean accepts it, or why not
export async function checkProof(c: LeanChallenge, solution: string, ms = 30 * 60_000): Promise<ProofVerdict> {
  if (!solution.trim()) return { valid: false, reason: "the proof is empty" };
  if (solution.length > 1_000_000) return { valid: false, reason: "the proof is over 1 MB" };
  const ready = await leanReady(c);
  if (!ready.ok) return { valid: false, unavailable: true, reason: ready.reason };
  const dir = mkdtempSync(join(tmpdir(), "cp-proof-"));
  try {
    writeFileSync(join(dir, "Challenge.lean"), c.challenge);
    writeFileSync(join(dir, "Solution.lean"), solution);
    const r = await run("docker", ["run", "--rm", "--network", "none", "--memory", "8g", "--cpus", "2", "--pids-limit", "512",
      "-v", `${dir}:/in:ro`, ready.image!, "cp-check", c.theorem, c.axioms.join(",")], ms);
    if (r.timedOut) return { valid: false, unavailable: true, reason: `Lean didn't finish within ${Math.round(ms / 60_000)} minutes here` };
    const line = r.out.trim().split("\n").reverse().find(l => l.startsWith("{"));
    if (!line) return { valid: false, unavailable: true, reason: `the checker didn't answer: ${r.out.trim().slice(-300)}` };
    const j = JSON.parse(line);
    if (r.code === 2) return { valid: false, unavailable: true, reason: String(j.reason ?? "the checker couldn't run") };
    return j.ok === true ? { valid: true } : { valid: false, reason: String(j.reason ?? "Lean refused it").slice(0, 1500) };
  } catch (e: any) {
    return { valid: false, unavailable: true, reason: String(e?.message ?? e) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
