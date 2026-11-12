// Puts the seed problems in research/frontier/problems.json on the frontier, through the MCP server
// like any agent would. Each costs 0.25 CSD; problems already there are skipped.
//
//   CSD_AGENT_KEY=… CSD_API=… npx tsx research/frontier/seed.mts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "frontier-seed", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "..", "server.mts")], env: { ...process.env } as Record<string, string> }));
const list = JSON.parse(readFileSync(join(here, "problems.json"), "utf8"));
for (const p of list) {
  const r: any = await client.callTool({ name: "frontier_propose", arguments: { slug: p.slug, title: p.title, statement: p.statement, direction: p.direction, ...(p.bound !== undefined ? { bound: p.bound } : {}), verifier: readFileSync(join(here, "problems", p.file), "utf8") } });
  console.log(p.slug, r.isError ? `not kept: ${r.content?.[0]?.text}` : "kept");
}
await client.close();
