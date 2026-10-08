import { readdirSync, statSync, watch } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { markDirty } from "./dirty-marker.js";
const ignored = new Set([
    ".git",
    ".context-slice",
    "node_modules",
    "build",
    "dist",
    "out",
]);
export class ProjectFileWatcher {
    active = false;
    root;
    watchers = [];
    watchedDirectories = new Set();
    pending = new Set();
    timer;
    constructor(root) {
        this.root = resolve(root);
        try {
            this.watchTopLevel();
        }
        catch {
            // Watching can be unavailable in restricted runtimes; metadata remains the fallback.
        }
        try {
            const recursive = watch(this.root, { recursive: true }, (_event, filename) => this.enqueue(filename));
            recursive.once("error", () => {
                recursive.close();
                this.watchers.splice(this.watchers.indexOf(recursive), 1);
                this.watchDirectoryTree();
            });
            this.watchers.push(recursive);
        }
        catch {
            // Recursive watching is unavailable on some Linux filesystems.
            this.watchDirectoryTree();
        }
    }
    watchTopLevel() {
        const watcher = this.watchDirectory(this.root);
        this.watchers.push(watcher);
        this.active = true;
    }
    watchDirectory(directory) {
        const watcher = watch(directory, (_event, filename) => this.enqueue(filename, directory));
        this.watchedDirectories.add(directory);
        watcher.on("error", () => {
            this.active = false;
            watcher.close();
            this.watchedDirectories.delete(directory);
        });
        return watcher;
    }
    watchDirectoryTree(directory = this.root) {
        if (!this.watchedDirectories.has(directory))
            this.watchers.push(this.watchDirectory(directory));
        try {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (entry.isDirectory() && !ignored.has(entry.name))
                    this.watchDirectoryTree(resolve(directory, entry.name));
            }
        }
        catch {
            // The directory may have been removed between the event and the scan.
        }
    }
    enqueue(filename, directory = this.root) {
        if (!filename)
            return;
        const relativePath = relative(this.root, resolve(directory, filename.toString()));
        if (!relativePath ||
            relativePath === ".." ||
            relativePath.startsWith(`..${sep}`) ||
            relativePath.split(sep).some((part) => ignored.has(part)))
            return;
        try {
            if (statSync(resolve(directory, filename.toString())).isDirectory())
                this.watchDirectoryTree(resolve(directory, filename.toString()));
        }
        catch {
            // The path may already have been removed.
        }
        this.pending.add(relativePath);
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            const paths = [...this.pending];
            this.pending.clear();
            this.timer = undefined;
            markDirty(this.root, paths);
        }, 100);
    }
    close() {
        if (this.timer)
            clearTimeout(this.timer);
        for (const watcher of this.watchers)
            watcher.close();
    }
}
