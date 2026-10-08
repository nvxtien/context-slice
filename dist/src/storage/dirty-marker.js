import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
function markerPath(root) {
    return join(resolve(root), ".context-slice", "dirty.json");
}
export function markDirty(root, paths = []) {
    const path = markerPath(root);
    mkdirSync(join(resolve(root), ".context-slice"), { recursive: true });
    const normalized = paths.map((file) => relative(resolve(root), resolve(root, file)));
    writeFileSync(path, JSON.stringify({
        dirty: true,
        markedAt: new Date().toISOString(),
        paths: normalized,
    }) + "\n");
}
export function dirtyMarkerExists(root) {
    return existsSync(markerPath(root));
}
export function clearDirty(root) {
    writeFileSync(markerPath(root), JSON.stringify({
        dirty: false,
        markedAt: new Date().toISOString(),
    }) + "\n");
}
export function isDirty(root) {
    try {
        return JSON.parse(readFileSync(markerPath(root), "utf8"))
            .dirty;
    }
    catch {
        return false;
    }
}
export function dirtyPaths(root) {
    try {
        const state = JSON.parse(readFileSync(markerPath(root), "utf8"));
        return state.dirty ? (state.paths ?? []) : [];
    }
    catch {
        return [];
    }
}
