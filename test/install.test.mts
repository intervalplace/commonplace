// Releases from the network (src/install.ts): a CAR file is turned into files only if every block
// matches its address and the tree hangs off the address asked for.
//   npx tsx test/install.test.mts release/commonplace-<build>.car <its CID> out
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { filesFromCar } from "../src/install";
let failures = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failures++; };
const refuses = async (p: Promise<unknown>, what: string) => { try { await p; ok(false, `${what} (accepted)`); } catch (e: any) { ok(true, `${what}: ${e.message}`); } };
const [carPath, cid, outDir] = process.argv.slice(2);
const car = new Uint8Array(readFileSync(carPath));
const files = await filesFromCar(car, cid);
const disk: string[] = [];
const list = (d: string, p = "") => { for (const n of readdirSync(d)) { const f = join(d, n), q = p ? `${p}/${n}` : n; statSync(f).isDirectory() ? list(f, q) : disk.push(q); } };
list(outDir);
ok(files.size === disk.length, `every file of the release comes out (${files.size})`);
ok(disk.every(p => files.has(p) && Buffer.from(files.get(p)!).equals(readFileSync(join(outDir, p)))), "byte for byte the same as the build");
// a changed byte deep inside a block
const bad = car.slice(); bad[bad.length - 100] ^= 1;
await refuses(filesFromCar(bad, cid), "a CAR with one changed byte");
await refuses(filesFromCar(car, "bafybeigqtu3nfqikwhmevdp7unfajbhdx7eikz4nc7k4puvqluaebo3jc4"), "a CAR that isn't the release asked for");
await refuses(filesFromCar(car.slice(0, Math.floor(car.length / 2)), cid), "half a CAR");
console.log(failures ? `\n${failures} failed` : "\nall passed"); process.exit(failures ? 1 : 0);
