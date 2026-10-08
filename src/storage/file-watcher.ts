import { watch, type FSWatcher } from "node:fs";
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
  private readonly root: string;
  private readonly watchers: FSWatcher[] = [];
  private readonly pending = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(root: string) {
    this.root = resolve(root);
    try {
      this.watchTopLevel();
    } catch {
      // Watching can be unavailable in restricted runtimes; metadata remains the fallback.
    }
    try {
      const recursive = watch(
        this.root,
        { recursive: true },
        (_event, filename) => this.enqueue(filename),
      );
      recursive.once("error", () => {
        recursive.close();
        this.watchers.splice(this.watchers.indexOf(recursive), 1);
        this.watchTopLevel();
      });
      this.watchers.push(recursive);
    } catch {
      // Recursive watching is unavailable on some Linux filesystems; top-level coverage remains active.
    }
  }

  private watchTopLevel() {
    const watcher = watch(this.root, (_event, filename) =>
      this.enqueue(filename),
    );
    watcher.on("error", () => {
      this.active = false;
      watcher.close();
    });
    this.watchers.push(watcher);
    this.active = true;
  }

  private enqueue(filename: string | Buffer | null) {
    if (!filename) return;
    const relativePath = relative(
      this.root,
      resolve(this.root, filename.toString()),
    );
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath.split(sep).some((part) => ignored.has(part))
    )
      return;
    this.pending.add(relativePath);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending.clear();
      this.timer = undefined;
      markDirty(this.root, paths);
    }, 100);
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
  }
}
