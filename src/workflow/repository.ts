import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { adapterFor, ignoredDirectories } from "../languages/adapter.js";
import "../languages/java.js";
import "../languages/typescript/index.js";
import { WorkflowError } from "./errors.js";

const ignored = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "out",
  ".gradle",
  ".idea",
  ".vscode",
  ".context-slice",
  ...ignoredDirectories(),
]);

export interface RepositoryOptions {
  cwd?: string;
  repository?: string;
}

function hasSupportedSource(directory: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isFile() && adapterFor(entry.name)) return true;
    if (entry.isDirectory() && hasSupportedSource(path)) return true;
  }
  return false;
}

function nearestGitRoot(start: string) {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveRepositoryRoot(options: RepositoryOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = options.repository
    ? resolve(options.repository)
    : (nearestGitRoot(cwd) ?? cwd);
  if (!existsSync(root))
    throw new WorkflowError(
      "REPOSITORY_NOT_FOUND",
      `Repository not found: ${root}`,
      "Pass an existing directory with --repo.",
    );
  if (!hasSupportedSource(root))
    throw new WorkflowError(
      "NO_SUPPORTED_SOURCE",
      `No supported source found in: ${root}`,
      "Run ContextSlice in a Java or TypeScript repository, or pass --repo.",
    );
  return root;
}
