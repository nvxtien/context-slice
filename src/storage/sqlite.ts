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

// Bump whenever any language adapter's parse/resolve output changes: unchanged files are otherwise reused from cache.
export const INDEX_VERSION = "1.7.0";

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
`;

export class IndexStorage {
  private readonly db: Database.Database;
  constructor(root: string) {
    const directory = join(root, ".context-slice");
    mkdirSync(directory, { recursive: true });
    // Self-ignoring cache: keeps `git status` clean without editing the repository's own .gitignore.
    if (!existsSync(join(directory, ".gitignore")))
      writeFileSync(join(directory, ".gitignore"), "*\n");
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
      ).map((row) => JSON.parse(row.payload) as T);
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
  ) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM files").run();
      this.db.prepare("DELETE FROM symbols").run();
      this.db.prepare("DELETE FROM calls").run();
      this.db.prepare("DELETE FROM imports").run();
      this.db.prepare("DELETE FROM exports").run();
      const fileStatement = this.db.prepare(
        "INSERT OR REPLACE INTO files(path, content_hash, language, parse_error, indexing_version) VALUES (?, ?, ?, 0, ?)",
      );
      for (const [path, record] of files)
        fileStatement.run(path, record.hash, record.language, INDEX_VERSION);
      const symbolStatement = this.db.prepare(
        "INSERT INTO symbols(id, file_path, language, payload) VALUES (?, ?, ?, ?)",
      );
      for (const symbol of symbols)
        symbolStatement.run(
          symbol.id,
          symbol.filePath,
          symbol.language,
          JSON.stringify(symbol),
        );
      const callStatement = this.db.prepare(
        "INSERT INTO calls(caller_id, callee_name, file_path, language, payload) VALUES (?, ?, ?, ?, ?)",
      );
      for (const call of calls)
        callStatement.run(
          call.callerId,
          call.calleeName,
          call.filePath,
          call.language ?? "java",
          JSON.stringify(call),
        );
      const importStatement = this.db.prepare(
        "INSERT INTO imports(file_path, language, payload) VALUES (?, ?, ?)",
      );
      for (const record of imports)
        importStatement.run(
          record.filePath,
          record.language,
          JSON.stringify(record),
        );
      const exportStatement = this.db.prepare(
        "INSERT INTO exports(file_path, language, payload) VALUES (?, ?, ?)",
      );
      for (const record of exports)
        exportStatement.run(
          record.filePath,
          record.language,
          JSON.stringify(record),
        );
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
