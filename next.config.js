/** @type {import('next').NextConfig} */
const { execSync } = require("child_process");

// The build id is the git commit, so the same source always builds the same files
function buildId() {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try { return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); }
  catch { return "commonplace"; }
}

module.exports = {
  // A fully static site in ./out: no server, host it anywhere, including IPFS
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  generateBuildId: async () => buildId(),
};
