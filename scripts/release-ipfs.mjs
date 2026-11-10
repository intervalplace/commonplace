#!/usr/bin/env node
/**
 * Build Commonplace as a static site, pack it for IPFS, and (optionally) pin it.
 *
 *   npm run release:ipfs                 build + pack, print the CID
 *   IPFS_API=http://127.0.0.1:5001 npm run release:ipfs
 *                                        ...and import + pin it on that IPFS node
 *
 * Env:
 *   IPFS_API        Kubo RPC endpoint (your own node, or a pinning service
 *                   that speaks the Kubo RPC API). Optional.
 *   IPFS_API_AUTH   Value for the Authorization header, if the API needs one.
 *   BUILD_ID        Override the build id (defaults to the git commit), which
 *                   keeps builds reproducible.
 *   --skip-build    Pack the existing ./out without rebuilding.
 *
 * The same commit always produces the same CID, so anyone can verify a
 * release by rebuilding it. To make that hold on any machine, the build runs
 * from the committed files only, in one fixed location
 * (/tmp/commonplace-release/commonplace) with a clean install: Next.js
 * derives internal module ids from absolute paths, so building in another
 * folder would give a different CID.
 */
import { spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, cpSync } from "node:fs";

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts });
  if (r.status !== 0) { console.error(`\n✗ ${cmd} ${args.join(" ")} failed`); process.exit(r.status ?? 1); }
  return (r.stdout ?? "").trim();
};

// Releases build only from committed settings (.env.production), so anyone
// can rebuild the same CID from the commit. A local override would break that.
for (const f of [".env.local", ".env.production.local"]) {
  if (existsSync(f)) { console.error(`✗ ${f} exists. Move it aside: releases build only from the committed .env.production.`); process.exit(1); }
}
if (!existsSync(".env.production")) { console.error("✗ No .env.production. Create it from .env.production.example and commit it."); process.exit(1); }
{
  const env = readFileSync(".env.production", "utf8");
  const node = (env.match(/^NEXT_PUBLIC_CSD_API=(.*)$/m)?.[1] ?? "").trim();
  if (!/^https:\/\//.test(node)) { console.error(`✗ .env.production: NEXT_PUBLIC_CSD_API is "${node}". Set it to a public CSD node (https) and commit.`); process.exit(1); }
}

let commit = "unknown";
try { commit = execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const buildId = process.env.BUILD_ID || commit;

const STAGE_ROOT = "/tmp/commonplace-release";
const STAGE = `${STAGE_ROOT}/commonplace`;
if (!process.argv.includes("--skip-build")) {
  let prefix;
  try { prefix = execSync("git rev-parse --show-prefix", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { console.error("✗ Releases are built from a git checkout (the commit is what makes them reproducible)."); process.exit(1); }
  const dirty = execSync("git status --porcelain --untracked-files=no -- .").toString().trim();
  if (dirty) { console.error(`✗ Uncommitted changes:\n${dirty}\nCommit them first: a release is built from the commit.`); process.exit(1); }

  console.log(`Building static site (build id ${buildId}) from the commit, in ${STAGE}…`);
  rmSync(STAGE_ROOT, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  const top = execSync("git rev-parse --show-toplevel").toString().trim();
  const tree = prefix ? `HEAD:${prefix.replace(/\/+$/, "")}` : "HEAD";
  execSync(`set -o pipefail; git -C '${top}' archive --format=tar '${tree}' | tar -x -C '${STAGE}'`, { stdio: "inherit", shell: "/bin/bash" });
  if (!existsSync(`${STAGE}/package-lock.json`)) { console.error(`✗ Couldn't stage the committed files in ${STAGE}`); process.exit(1); }
  run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: STAGE, stdio: "inherit" });
  run("npx", ["next", "build"], { cwd: STAGE, stdio: "inherit", env: { ...process.env, BUILD_ID: buildId, NEXT_TELEMETRY_DISABLED: "1" } });
  rmSync("out", { recursive: true, force: true });
  cpSync(`${STAGE}/out`, "out", { recursive: true });
}
if (!existsSync("out/index.html")) { console.error("✗ out/index.html missing — is output: 'export' set?"); process.exit(1); }

mkdirSync("release", { recursive: true });
const car = `release/commonplace-${buildId}.car`;
console.log("Packing for IPFS…");
const packed = run("npx", ["ipfs-car", "pack", "out", "--output", car]);
const cid = packed.split(/\s+/).pop();
const roots = run("npx", ["ipfs-car", "roots", car]);
if (!roots.includes(cid)) { console.error(`✗ CAR root ${roots} doesn't match ${cid}`); process.exit(1); }

let pinned = null;
if (process.env.IPFS_API) {
  const api = process.env.IPFS_API.replace(/\/+$/, "");
  console.log(`Importing and pinning on ${api}…`);
  const form = new FormData();
  form.append("file", new Blob([readFileSync(car)]), "commonplace.car");
  const headers = process.env.IPFS_API_AUTH ? { Authorization: process.env.IPFS_API_AUTH } : {};
  const res = await fetch(`${api}/api/v0/dag/import?pin-roots=true`, { method: "POST", body: form, headers });
  const text = await res.text();
  if (!res.ok || !text.includes(cid)) { console.error(`✗ Import failed (${res.status}): ${text.slice(0, 300)}`); process.exit(1); }
  pinned = api;
  console.log(`✓ Pinned ${cid}`);
}

const record = { cid, buildId, commit, createdAt: new Date().toISOString(), car, carBytes: statSync(car).size, pinnedOn: pinned };
writeFileSync(`release/commonplace-${buildId}.json`, JSON.stringify(record, null, 2) + "\n");

console.log(`
Commonplace ${buildId}
  CID      ${cid}
  Preview  https://${cid}.ipfs.dweb.link/
  Archive  ${car}

Next:
  1. Pin it in more than one place (upload the .car to any pinning service,
     or run: ipfs dag import ${car}).
  2. Announce the CID everywhere at once (release notes, posts), with the
     commit, so anyone can rebuild and check it.
  3. Add it to the list of release CIDs in the repo.

This CID will serve exactly this build forever. A fix is a new release.
`);
