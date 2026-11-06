// Run the test files and save names + pass/fail to results/tests.json (the site lists them).
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const files = { checkout: "test/checkout.test.js", "mcp-webhooks": "test/mcp-webhooks.test.js" };
const out = [];
for (const [file, path] of Object.entries(files)) {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", path], { encoding: "utf8" });
  for (const line of r.stdout.split("\n")) { const m = /^(not ok|ok) \d+ - (.+)$/.exec(line); if (m) out.push({ file, name: m[2].replace(/\\#/g, "#"), ok: m[1] === "ok" }); }
}
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/tests.json", JSON.stringify(out, null, 1));
console.log(`${out.filter((t) => t.ok).length}/${out.length} passed`);
process.exit(out.every((t) => t.ok) ? 0 : 1);
