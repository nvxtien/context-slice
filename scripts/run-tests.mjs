import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const excluded = new Set(
  process.argv
    .filter((arg) => arg.startsWith("--exclude="))
    .map((arg) => arg.slice("--exclude=".length)),
);
const testFiles = readdirSync(resolve("tests"))
  .filter((file) => file.endsWith(".test.ts"))
  .filter((file) => !excluded.has(file))
  .sort()
  .map((file) => resolve("tests", file));

const concurrency =
  process.platform === "win32" ? ["--test-concurrency=1"] : [];
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...concurrency, ...testFiles],
  { stdio: "inherit" },
);

process.exitCode = result.status ?? 1;
