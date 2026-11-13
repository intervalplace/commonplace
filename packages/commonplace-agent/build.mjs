// Bundles research/server.mts and everything it uses into one file, so `npx commonplace-agent`
// needs nothing else installed.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "../../research/agent-entry.mts")],
  outfile: join(here, "dist/server.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node20", minify: false,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
console.log("built dist/server.mjs");
