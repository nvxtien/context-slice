import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CallEdge,
  ExportRecord,
  ImportRecord,
  LanguageId,
  SymbolRecord,
} from "../types/model.js";
import { WorkflowError } from "../workflow/errors.js";

// Bump whenever any language adapter's parse OR resolve output changes: unchanged files and their cached (resolved)
// call edges are otherwise reused from cache. Rust parse and resolve output is guarded by tests/rust-parse-snapshot.test.ts,
// which refuses to regenerate its snapshot for changed output without a bump here.
export const INDEX_VERSION = "1.12.0";

export interface IndexedFileRecord {
  hash: string;
  language: LanguageId;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, parse_error INTEGER NOT NULL, indexing_version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, caller_id TEXT NOT NULL, callee_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exports (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_calls_file_path ON calls(file_path);
CREATE INDEX IF NOT EXISTS idx_calls_caller_id ON calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_imports_file_path ON imports(file_path);
CREATE INDEX IF NOT EXISTS idx_exports_file_path ON exports(file_path);
`;

export class IndexStorage {
  private readonly db: Database.Database;
  constructor(root: string) {
    const directory = join(root, ".context-slice");
    try {
      mkdirSync(directory, { recursive: true });
      // Self-ignoring cache: keeps `git status` clean without editing the repository's own .gitignore.
      if (!existsSync(join(directory, ".gitignore")))
        writeFileSync(join(directory, ".gitignore"), "*\n");
    } catch (error) {
      throw new WorkflowError(
        "INDEX_CORRUPT",
        `Cannot create index cache directory: ${directory} (${error instanceof Error ? error.message : String(error)})`,
        "Check write permissions on the repository root, or run from a writable checkout.",
      );
    }
    this.db = new Database(join(directory, "index.sqlite"));
    try {
      this.db.pragma("schema_version");
    } catch (error) {
      this.db.close();
      throw new WorkflowError(
        "INDEX_CORRUPT",
        `Unreadable index cache: ${join(directory, "index.sqlite")} (${error instanceof Error ? error.message : String(error)})`,
        "Delete the cache and rebuild it: rm -rf .context-slice && context-slice init",
      );
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
    const version = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    // A cache written by any other schema is dropped and rebuilt, never reused.
    if (version?.value !== INDEX_VERSION)
      this.db.exec(
        "DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS calls; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS exports;",
      );
    this.db.exec(SCHEMA);
    if (version?.value !== INDEX_VERSION)
      this.db
        .prepare(
          "INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)",
        )
        .run(INDEX_VERSION);
  }
  load() {
    const files = new Map<string, IndexedFileRecord>();
    for (const row of this.db
      .prepare("SELECT path, content_hash, language FROM files")
      .all() as Array<{
      path: string;
      content_hash: string;
      language: string;
    }>)
      files.set(row.path, { hash: row.content_hash, language: row.language });
    const rows = <T>(table: string) =>
      (
        this.db.prepare(`SELECT payload FROM ${table}`).all() as Array<{
          payload: string;
        }>
      ).map((row) => {
        try {
          return JSON.parse(row.payload) as T;
        } catch (error) {
          this.db.close();
          throw new WorkflowError(
            "INDEX_CORRUPT",
            `Unreadable index cache payload in ${table}: ${error instanceof Error ? error.message : String(error)}`,
            "Delete the cache and rebuild it: rm -rf .context-slice && context-slice init",
          );
        }
      });
    return {
      files,
      symbols: rows<SymbolRecord>("symbols"),
      calls: rows<CallEdge>("calls"),
      imports: rows<ImportRecord>("imports"),
      exports: rows<ExportRecord>("exports"),
    };
  }
  metadata() {
    const rows = this.db
      .prepare("SELECT key, value FROM metadata")
      .all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
  save(
    files: Map<string, IndexedFileRecord>,
    symbols: SymbolRecord[],
    calls: CallEdge[],
    imports: ImportRecord[] = [],
    exports: ExportRecord[] = [],
    changedPaths?: ReadonlySet<string>,
    removedPaths?: ReadonlySet<string>,
  ) {
    const incremental =
      changedPaths !== undefined && removedPaths !== undefined;
    const changed = changedPaths ?? new Set(files.keys());
    const removed = removedPaths ?? new Set<string>();
    if (incremental && changed.size === 0 && removed.size === 0) return;
    const transaction = this.db.transaction(() => {
      if (incremental) {
        const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
        const deleteSymbols = this.db.prepare(
          "DELETE FROM symbols WHERE file_path = ?",
        );
        // Imports/exports are pure per-file parse output (nothing downstream mutates them the
        // way call resolution mutates calls below), so they can be kept genuinely incremental:
        // only the changed/removed files' own rows are ever touched.
        const deleteImports = this.db.prepare(
          "DELETE FROM imports WHERE file_path = ?",
        );
        const deleteExports = this.db.prepare(
          "DELETE FROM exports WHERE file_path = ?",
        );
        for (const path of new Set([...changed, ...removed])) {
          deleteFile.run(path);
          deleteSymbols.run(path);
          deleteImports.run(path);
          deleteExports.run(path);
        }
      } else {
        this.db.prepare("DELETE FROM files").run();
        this.db.prepare("DELETE FROM symbols").run();
        this.db.prepare("DELETE FROM imports").run();
        this.db.prepare("DELETE FROM exports").run();
      }
      const fileStatement = this.db.prepare(
        "INSERT OR REPLACE INTO files(path, content_hash, language, parse_error, indexing_version) VALUES (?, ?, ?, 0, ?)",
      );
      for (const [path, record] of files)
        if (!incremental || changed.has(path))
          fileStatement.run(path, record.hash, record.language, INDEX_VERSION);
      const symbolStatement = this.db.prepare(
        "INSERT INTO symbols(id, file_path, language, payload) VALUES (?, ?, ?, ?)",
      );
      for (const symbol of symbols)
        if (!incremental || changed.has(symbol.filePath))
          symbolStatement.run(
            symbol.id,
            symbol.filePath,
            symbol.language,
            JSON.stringify(symbol),
          );
      const importStatement = this.db.prepare(
        "INSERT INTO imports(file_path, language, payload) VALUES (?, ?, ?)",
      );
      for (const record of imports)
        if (!incremental || changed.has(record.filePath))
          importStatement.run(
            record.filePath,
            record.language,
            JSON.stringify(record),
          );
      const exportStatement = this.db.prepare(
        "INSERT INTO exports(file_path, language, payload) VALUES (?, ?, ?)",
      );
      for (const record of exports)
        if (!incremental || changed.has(record.filePath))
          exportStatement.run(
            record.filePath,
            record.language,
            JSON.stringify(record),
          );
      // Calls are different: resolution is graph-wide (see ProjectIndex.rebuild), so a call's
      // resolved fields can change even when its own file didn't. Rewriting only the
      // changed-file set would silently leave stale resolution data for every other file's
      // calls. Instead, diff against what's already stored, by payload, as a MULTISET (two
      // distinct call sites can legitimately produce an identical payload) — so only rows that
      // actually changed cost a write, and everything identical is left untouched.
      const existingCalls = this.db
        .prepare("SELECT id, payload FROM calls")
        .all() as Array<{ id: number; payload: string }>;
      const existingIdsByPayload = new Map<string, number[]>();
      for (const row of existingCalls) {
        const ids = existingIdsByPayload.get(row.payload);
        if (ids) ids.push(row.id);
        else existingIdsByPayload.set(row.payload, [row.id]);
      }
      const insertCall = this.db.prepare(
        "INSERT INTO calls(caller_id, callee_name, file_path, language, payload) VALUES (?, ?, ?, ?, ?)",
      );
      for (const call of calls) {
        const payload = JSON.stringify(call);
        const reusable = existingIdsByPayload.get(payload);
        if (reusable?.length) {
          // An identical row already exists in the table; keep it rather than
          // deleting and reinserting the same bytes.
          reusable.pop();
          continue;
        }
        insertCall.run(
          call.callerId,
          call.calleeName,
          call.filePath,
          call.language ?? "java",
          payload,
        );
      }
      const deleteCallById = this.db.prepare("DELETE FROM calls WHERE id = ?");
      for (const ids of existingIdsByPayload.values())
        for (const id of ids) deleteCallById.run(id);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO metadata(key, value) VALUES ('last_refreshed_at', ?)",
        )
        .run(new Date().toISOString());
    });
    transaction();
  }
  close() {
    this.db.close();
  }
}
