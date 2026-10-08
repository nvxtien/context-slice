import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type DirtyState = { dirty: boolean; markedAt: string; paths?: string[] };

function markerPath(root: string) {
  return join(resolve(root), ".context-slice", "dirty.json");
}

export function markDirty(root: string, paths: string[] = []) {
  const path = markerPath(root);
  mkdirSync(join(resolve(root), ".context-slice"), { recursive: true });
  const normalized = paths.map((file) =>
    relative(resolve(root), resolve(root, file)),
  );
  writeFileSync(
    path,
    JSON.stringify({
      dirty: true,
      markedAt: new Date().toISOString(),
      paths: normalized,
    }) + "\n",
  );
}

export function dirtyMarkerExists(root: string) {
  return existsSync(markerPath(root));
}

export function clearDirty(root: string) {
  writeFileSync(
    markerPath(root),
    JSON.stringify({
      dirty: false,
      markedAt: new Date().toISOString(),
    } satisfies DirtyState) + "\n",
  );
}

export function isDirty(root: string) {
  try {
    return (JSON.parse(readFileSync(markerPath(root), "utf8")) as DirtyState)
      .dirty;
  } catch {
    return false;
  }
}

export function dirtyPaths(root: string): string[] {
  try {
    const state = JSON.parse(
      readFileSync(markerPath(root), "utf8"),
    ) as DirtyState;
    return state.dirty ? (state.paths ?? []) : [];
  } catch {
    return [];
  }
}
