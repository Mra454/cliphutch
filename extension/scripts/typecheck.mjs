import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = [
  "tsconfig.ui.json",
  "tsconfig.background.json",
  "tsconfig.offscreen.json",
  "tsconfig.worker.json",
  "tsconfig.test.json",
  "tsconfig.tooling.json",
];

for (const project of projects) {
  console.log(`\n[typecheck] ${project}`);
  const result = spawnSync(
    process.execPath,
    [resolve(extensionDirectory, "node_modules/typescript/bin/tsc"), "-p", project, "--pretty", "false"],
    { cwd: extensionDirectory, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\n[typecheck] ${projects.length} environment projects passed`);
