// The data items src/ans104.ts makes, checked against arbundles (the ANS-104 reference library):
// they parse, their signatures verify, and their ids and tags come out the same.
//   npx tsx test/ans104.test.mts

import { createRequire } from "node:module";
import { dataItem } from "../src/ans104";
import { hexToBytes, utf8 } from "../src/csd";

const require = createRequire(import.meta.url);
const { DataItem } = require("@dha-team/arbundles");
let fails = 0;
const ok = (c: unknown, what: string) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) fails++; };

const priv = hexToBytes("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318");
const cases = [
  { name: "a short text with tags", data: utf8("# A thesis\n\nKept for good."), tags: [{ name: "Content-Type", value: "text/markdown; charset=utf-8" }, { name: "App-Name", value: "Commonplace" }, { name: "Title", value: "Ünïcødé, æøå ✓" }] },
  { name: "no tags", data: utf8("plain"), tags: [] },
  { name: "100 KB of data and many tags", data: new Uint8Array(100 * 1024).map((_, i) => i % 251), tags: Array.from({ length: 70 }, (_, i) => ({ name: `k${i}`, value: "v".repeat(i) })) },
];
for (const c of cases) {
  const { bytes, id } = await dataItem(priv, c.data, c.tags);
  const item = new DataItem(Buffer.from(bytes));
  ok(await DataItem.verify(Buffer.from(bytes)), `${c.name}: parses and verifies as a whole (DataItem.verify)`);
  ok(await item.isValid(), `${c.name}: the signature verifies`);
  ok(item.id === id, `${c.name}: same id (${id})`);
  ok(item.signatureType === 3, `${c.name}: an Ethereum signature`);
  ok(Buffer.from(item.rawData).equals(Buffer.from(c.data)), `${c.name}: same data`);
  const tags = item.tags as { name: string; value: string }[];
  ok(tags.length === c.tags.length && tags.every((t, i) => t.name === c.tags[i].name && t.value === c.tags[i].value), `${c.name}: same tags`);
}
console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
