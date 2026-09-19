import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CallEdge, SymbolRecord } from "../types/model.js";

const INDEX_VERSION = "0.5.2";

export class IndexStorage {
  private readonly db: Database.Database;
  constructor(root: string) {
    const directory = join(root, ".context-slice");
    mkdirSync(directory, { recursive: true });
    this.db = new Database(join(directory, "index.sqlite"));
    this.db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, parse_error INTEGER NOT NULL, indexing_version TEXT NOT NULL); CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, caller_id TEXT NOT NULL, callee_name TEXT NOT NULL, payload TEXT NOT NULL);");
    const version = this.db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    if (version?.value !== INDEX_VERSION) { this.db.exec(`DELETE FROM files; DELETE FROM symbols; DELETE FROM calls; INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '${INDEX_VERSION}');`); }
  }
  load() {
    const files = new Map<string, string>();
    for (const row of this.db.prepare("SELECT path, content_hash FROM files").all() as Array<{ path: string; content_hash: string }>) files.set(row.path, row.content_hash);
    const symbols = (this.db.prepare("SELECT payload FROM symbols").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as SymbolRecord);
    const calls = (this.db.prepare("SELECT payload FROM calls").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as CallEdge);
    return { files, symbols, calls };
  }
  save(files: Map<string, string>, symbols: SymbolRecord[], calls: CallEdge[]) {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM symbols").run();
      this.db.prepare("DELETE FROM calls").run();
      const fileStatement = this.db.prepare(`INSERT OR REPLACE INTO files(path, content_hash, parse_error, indexing_version) VALUES (?, ?, 0, '${INDEX_VERSION}')`);
      for (const [path, hash] of files) fileStatement.run(path, hash);
      const symbolStatement = this.db.prepare("INSERT INTO symbols(id, file_path, payload) VALUES (?, ?, ?)");
      for (const symbol of symbols) symbolStatement.run(symbol.id, symbol.filePath, JSON.stringify(symbol));
      const callStatement = this.db.prepare("INSERT INTO calls(caller_id, callee_name, payload) VALUES (?, ?, ?)");
      for (const call of calls) callStatement.run(call.callerId, call.calleeName, JSON.stringify(call));
    });
    transaction();
  }
  close() { this.db.close(); }
}
