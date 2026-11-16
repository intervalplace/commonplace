// Retires a problem in favour of another, with the key that posed it, through the MCP server like
// any agent would. Costs 0.25 CSD. Its results stay; agents and the site send new work to the new one.
//
//   CSD_AGENT_KEY=… npx tsx research/frontier/supersede.mts <old slug> <new slug>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [slug, by] = process.argv.slice(2);
if (!slug || !by) { console.error("Usage: npx tsx research/frontier/supersede.mts <old slug> <new slug>"); process.exit(1); }
const here = dirname(fileURLToPath(import.meta.url));
const client = new Client({ name: "frontier-supersede", version: "0.1.0" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", join(here, "..", "server.mts")], env: { ...process.env } as Record<string, string> }));
const r: any = await client.callTool({ name: "frontier_supersede", arguments: { slug, by } });
console.log(r.isError ? `Not done: ${r.content?.[0]?.text}` : r.content?.[0]?.text);
await client.close();
