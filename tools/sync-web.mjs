// Prepares web/public: copies the evidence files the verifier needs and bundles the verifier.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("web/public/evidence", { recursive: true });
// the sample household cards are already public in docs/; the sandbox page uses them for one-click villagers
mkdirSync("web/public/demo", { recursive: true });
copyFileSync("docs/test-cards.json", "web/public/demo/sandbox-cards.json");
for (const f of ["borehole_pool.wasm", "state-init.json", "publish.json"]) copyFileSync(`evidence/${f}`, `web/public/evidence/${f}`);
await build({
  entryPoints: ["web/src/verify-core.js"],
  bundle: true,
  format: "esm",
  outfile: "web/public/verify-bundle.js",
  minify: true,
  target: "es2022",
  logLevel: "warning",
});
await build({
  entryPoints: ["web/src/wallet.js"],
  bundle: true,
  format: "esm",
  outfile: "web/public/wallet-bundle.js",
  minify: true,
  target: "es2022",
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
});
const pub = JSON.parse(readFileSync("evidence/publish.json", "utf8"));
writeFileSync(
  "web/public/config.json",
  JSON.stringify({ poolId: pub.poolId, codeHash: pub.codeHash, rpcUrl: "https://test.rpc.fastnear.com", explorer: "https://testnet.nearblocks.io" }, null, 1),
);
// keep the Worker's pool id in step with the published pool
const toml = readFileSync("wrangler.toml", "utf8").replace(/POOL_ID = ".*"/, `POOL_ID = "${pub.poolId}"`);
writeFileSync("wrangler.toml", toml);
console.log("web/public ready for", pub.poolId);
