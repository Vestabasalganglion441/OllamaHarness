import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

let totalPass = 0;
let totalFail = 0;
const failures = [];

for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" });
  if (r.status !== 0) {
    totalFail += 1;
    failures.push(f);
  } else {
    totalPass += 1;
  }
}

console.log(`\n=== summary ===`);
console.log(`files passed: ${totalPass}/${files.length}`);
if (failures.length) {
  console.log(`failed files: ${failures.join(", ")}`);
  process.exit(1);
}
