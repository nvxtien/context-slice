import { readFileSync } from "node:fs";

export interface PackageInfo {
  name: string;
  version: string;
}

function loadPackageInfo(): PackageInfo {
  for (const location of [
    new URL("../package.json", import.meta.url),
    new URL("../../package.json", import.meta.url),
  ]) {
    try {
      return JSON.parse(readFileSync(location, "utf8")) as PackageInfo;
    } catch {
      /* try the package root candidate */
    }
  }
  throw new Error(
    "Cannot locate package metadata relative to the installed ContextSlice runtime.",
  );
}

export const packageInfo = loadPackageInfo();
