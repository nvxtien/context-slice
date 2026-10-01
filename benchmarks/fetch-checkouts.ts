import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Recreates the pinned benchmark checkouts so regressions do not depend on a developer's local clones.
type Repository = {
  id: string;
  url: string;
  commit: string;
  source: string;
  sparse?: string[];
};
const root = process.cwd();
const manifests = [
  "benchmarks/repositories.json",
  "benchmarks/typescript-repositories.json",
  "benchmarks/python-repositories.json",
  "benchmarks/rust-repositories.json",
  "benchmarks/go-repositories.json",
];
const repositories = manifests.flatMap(
  (manifest) =>
    JSON.parse(readFileSync(join(root, manifest), "utf8")) as Repository[],
);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

for (const repository of repositories) {
  const directory = resolve(root, repository.source);
  if (existsSync(directory)) {
    const head = git(directory, "rev-parse", "HEAD");
    if (head !== repository.commit)
      throw new Error(
        `${repository.source} is at ${head}, expected ${repository.commit}. Remove it and rerun.`,
      );
    continue;
  }
  console.log(`Fetching ${repository.id}@${repository.commit.slice(0, 12)}`);
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  git(directory, "remote", "add", "origin", repository.url);
  if (repository.sparse)
    git(directory, "sparse-checkout", "set", "--cone", ...repository.sparse);
  git(
    directory,
    "fetch",
    "-q",
    "--depth",
    "1",
    ...(repository.sparse ? ["--filter=blob:none"] : []),
    "origin",
    repository.commit,
  );
  git(directory, "checkout", "-q", "FETCH_HEAD");
}
