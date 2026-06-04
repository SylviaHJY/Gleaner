#!/usr/bin/env node
// Rebuild the offline ECDICT data the app ships with.
//
//   1. Download ecdict.csv (skywind3000/ECDICT, MIT) into .ecdict-src/ if missing.
//   2. Build the trimmed runtime database at app/main/data/ecdict.sqlite.
//   3. Bake clean reference meanings + phonetics into importedVocabulary.json.
//
// Usage: node scripts/refresh_ecdict.mjs

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, ".ecdict-src");
const csvPath = path.join(srcDir, "ecdict.csv");
const dbPath = path.join(root, "app", "main", "data", "ecdict.sqlite");
const CSV_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv";

function python() {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("Python 3 is required to build the ECDICT database.");
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
  }
}

async function downloadCsv() {
  fs.mkdirSync(srcDir, { recursive: true });
  if (fs.existsSync(csvPath) && fs.statSync(csvPath).size > 1_000_000) {
    console.log(`Using cached ${path.relative(root, csvPath)}`);
    return;
  }
  console.log(`Downloading ECDICT csv from ${CSV_URL} ...`);
  const response = await fetch(CSV_URL);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(csvPath, buffer);
  console.log(`Saved ${(buffer.length / 1e6).toFixed(1)} MB to ${path.relative(root, csvPath)}`);
}

async function main() {
  const py = python();
  await downloadCsv();
  console.log("Building trimmed ecdict.sqlite ...");
  run(py, [path.join("scripts", "build_ecdict.py"), csvPath, dbPath]);
  console.log("Baking reference meanings into importedVocabulary.json ...");
  run(py, [path.join("scripts", "apply_ecdict_reference.py")]);
  console.log("Done.");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
