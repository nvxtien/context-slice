import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../workflow/errors.js";
// Bump whenever any language adapter's parse OR resolve output changes: unchanged files and their cached (resolved)
// call edges are otherwise reused from cache. Rust parse and resolve output is guarded by tests/rust-parse-snapshot.test.ts,
// which refuses to regenerate its snapshot for changed output without a bump here.
export const INDEX_VERSION = "1.18.0";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, parse_error INTEGER NOT NULL, indexing_version TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sources (file_path TEXT PRIMARY KEY, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS symbols (id TEXT PRIMARY KEY, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, caller_id TEXT NOT NULL, target_ids TEXT NOT NULL, callee_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS call_targets (call_id INTEGER NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY (call_id, target_id));
CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exports (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, language TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_calls_file_path ON calls(file_path);
CREATE INDEX IF NOT EXISTS idx_calls_caller_id ON calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_calls_target_ids ON calls(target_ids);
CREATE INDEX IF NOT EXISTS idx_call_targets_target_id ON call_targets(target_id);
CREATE INDEX IF NOT EXISTS idx_imports_file_path ON imports(file_path);
CREATE INDEX IF NOT EXISTS idx_exports_file_path ON exports(file_path);
`;
export class IndexStorage {
    db;
    constructor(root) {
        const directory = join(root, ".context-slice");
        try {
            mkdirSync(directory, { recursive: true });
            // Self-ignoring cache: keeps `git status` clean without editing the repository's own .gitignore.
            if (!existsSync(join(directory, ".gitignore")))
                writeFileSync(join(directory, ".gitignore"), "*\n");
        }
        catch (error) {
            throw new WorkflowError("INDEX_CORRUPT", `Cannot create index cache directory: ${directory} (${error instanceof Error ? error.message : String(error)})`, "Check write permissions on the repository root, or run from a writable checkout.");
        }
        this.db = new Database(join(directory, "index.sqlite"));
        try {
            this.db.pragma("schema_version");
        }
        catch (error) {
            this.db.close();
            throw new WorkflowError("INDEX_CORRUPT", `Unreadable index cache: ${join(directory, "index.sqlite")} (${error instanceof Error ? error.message : String(error)})`, "Delete the cache and rebuild it: rm -rf .context-slice && context-slice init");
        }
        this.db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
        const version = this.db
            .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
            .get();
        // A cache written by any other schema is dropped and rebuilt, never reused.
        if (version?.value !== INDEX_VERSION)
            this.db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sources; DROP TABLE IF EXISTS symbols; DROP TABLE IF EXISTS calls; DROP TABLE IF EXISTS call_targets; DROP TABLE IF EXISTS imports; DROP TABLE IF EXISTS exports;");
        if (version?.value !== INDEX_VERSION)
            this.db.prepare("DELETE FROM metadata WHERE key = 'calls_digest'").run();
        if (version?.value !== INDEX_VERSION)
            this.db.exec("VACUUM");
        this.db.exec(SCHEMA);
        if (version?.value !== INDEX_VERSION)
            this.db
                .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)")
                .run(INDEX_VERSION);
    }
    load(options = {}) {
        const files = new Map();
        for (const row of this.db
            .prepare("SELECT path, content_hash, language, parse_error, size, mtime_ms, ctime_ms FROM files")
            .all())
            files.set(row.path, {
                hash: row.content_hash,
                language: row.language,
                parseError: row.parse_error !== 0,
                size: row.size,
                mtimeMs: row.mtime_ms,
                ctimeMs: row.ctime_ms,
            });
        const sources = new Map(this.db
            .prepare("SELECT file_path, source FROM sources")
            .all().map((row) => [row.file_path, row.source]));
        const rows = (table) => this.db.prepare(`SELECT payload FROM ${table}`).all().map((row) => {
            try {
                return JSON.parse(row.payload);
            }
            catch (error) {
                this.db.close();
                throw new WorkflowError("INDEX_CORRUPT", `Unreadable index cache payload in ${table}: ${error instanceof Error ? error.message : String(error)}`, "Delete the cache and rebuild it: rm -rf .context-slice && context-slice init");
            }
        });
        return {
            files,
            symbols: rows("symbols").map((symbol) => {
                if (options.symbols !== "full") {
                    delete symbol.source;
                    delete symbol.body;
                }
                else if (!symbol.source) {
                    symbol.source = sources.get(symbol.filePath) ?? "";
                }
                return symbol;
            }),
            calls: options.calls === false ? [] : rows("calls"),
            imports: rows("imports"),
            exports: rows("exports"),
        };
    }
    loadCalls() {
        return this.parseCalls(this.db.prepare("SELECT payload FROM calls").all());
    }
    loadCallsForCaller(callerId) {
        return this.parseCalls(this.db
            .prepare("SELECT payload FROM calls WHERE caller_id = ?")
            .all(callerId));
    }
    loadCallsForTarget(targetId) {
        return this.parseCalls(this.db
            .prepare("SELECT calls.payload FROM calls JOIN call_targets ON call_targets.call_id = calls.id WHERE call_targets.target_id = ?")
            .all(targetId));
    }
    callStats() {
        const stats = {
            total: 0,
            exact: 0,
            probable: 0,
            unresolved: 0,
            external: 0,
            byLanguage: {},
            byResolutionKind: {},
        };
        for (const row of this.db
            .prepare("SELECT payload FROM calls")
            .iterate()) {
            const call = this.parseCall(row.payload);
            stats.total++;
            if (call.confidence === "exact")
                stats.exact++;
            else if (call.confidence === "probable")
                stats.probable++;
            else if (call.confidence === "unresolved")
                stats.unresolved++;
            if (call.externalPackage)
                stats.external++;
            const language = call.language ?? "java";
            stats.byLanguage[language] = (stats.byLanguage[language] ?? 0) + 1;
            stats.byResolutionKind[call.resolutionKind] =
                (stats.byResolutionKind[call.resolutionKind] ?? 0) + 1;
        }
        return stats;
    }
    parseCalls(rows) {
        return rows.map((row) => this.parseCall(row.payload));
    }
    parseCall(payload) {
        try {
            return JSON.parse(payload);
        }
        catch (error) {
            this.db.close();
            throw new WorkflowError("INDEX_CORRUPT", `Unreadable index cache payload in calls: ${error instanceof Error ? error.message : String(error)}`, "Delete the cache and rebuild it: rm -rf .context-slice && context-slice init");
        }
    }
    metadata() {
        const rows = this.db
            .prepare("SELECT key, value FROM metadata")
            .all();
        return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    }
    save(snapshot, changedPaths, removedPaths, callPaths) {
        const { files, symbols, calls, imports, exports } = snapshot;
        const incremental = changedPaths !== undefined && removedPaths !== undefined;
        const changed = changedPaths ?? new Set(files.keys());
        const removed = removedPaths ?? new Set();
        if (incremental && changed.size === 0 && removed.size === 0)
            return;
        const transaction = this.db.transaction(() => {
            if (incremental) {
                const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
                const deleteSymbols = this.db.prepare("DELETE FROM symbols WHERE file_path = ?");
                const deleteSources = this.db.prepare("DELETE FROM sources WHERE file_path = ?");
                // Imports/exports are pure per-file parse output (nothing downstream mutates them the
                // way call resolution mutates calls below), so they can be kept genuinely incremental:
                // only the changed/removed files' own rows are ever touched.
                const deleteImports = this.db.prepare("DELETE FROM imports WHERE file_path = ?");
                const deleteExports = this.db.prepare("DELETE FROM exports WHERE file_path = ?");
                for (const path of new Set([...changed, ...removed])) {
                    deleteFile.run(path);
                    deleteSources.run(path);
                    deleteSymbols.run(path);
                    deleteImports.run(path);
                    deleteExports.run(path);
                }
            }
            else {
                this.db.prepare("DELETE FROM files").run();
                this.db.prepare("DELETE FROM sources").run();
                this.db.prepare("DELETE FROM symbols").run();
                this.db.prepare("DELETE FROM imports").run();
                this.db.prepare("DELETE FROM exports").run();
            }
            const fileStatement = this.db.prepare("INSERT OR REPLACE INTO files(path, content_hash, language, parse_error, indexing_version, size, mtime_ms, ctime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            for (const [path, record] of files)
                if (!incremental || changed.has(path))
                    fileStatement.run(path, record.hash, record.language, record.parseError ? 1 : 0, INDEX_VERSION, record.size, record.mtimeMs, record.ctimeMs);
            const symbolStatement = this.db.prepare("INSERT INTO symbols(id, file_path, language, payload) VALUES (?, ?, ?, ?)");
            for (const symbol of symbols)
                if (!incremental || changed.has(symbol.filePath))
                    symbolStatement.run(symbol.id, symbol.filePath, symbol.language, this.symbolPayload(symbol));
            const sourceByFile = new Map();
            for (const symbol of symbols)
                if ((!incremental || changed.has(symbol.filePath)) &&
                    !sourceByFile.has(symbol.filePath) &&
                    typeof symbol.source === "string")
                    sourceByFile.set(symbol.filePath, symbol.source);
            const sourceStatement = this.db.prepare("INSERT INTO sources(file_path, source) VALUES (?, ?)");
            for (const [filePath, source] of sourceByFile) {
                sourceStatement.run(filePath, source);
            }
            const importStatement = this.db.prepare("INSERT INTO imports(file_path, language, payload) VALUES (?, ?, ?)");
            for (const record of imports)
                if (!incremental || changed.has(record.filePath))
                    importStatement.run(record.filePath, record.language, JSON.stringify(record));
            const exportStatement = this.db.prepare("INSERT INTO exports(file_path, language, payload) VALUES (?, ?, ?)");
            for (const record of exports)
                if (!incremental || changed.has(record.filePath))
                    exportStatement.run(record.filePath, record.language, JSON.stringify(record));
            if (callPaths) {
                const deleteCallTargets = this.db.prepare("DELETE FROM call_targets WHERE call_id IN (SELECT id FROM calls WHERE file_path = ?)");
                const deleteCalls = this.db.prepare("DELETE FROM calls WHERE file_path = ?");
                for (const path of callPaths) {
                    deleteCallTargets.run(path);
                    deleteCalls.run(path);
                }
                const insertCall = this.db.prepare("INSERT INTO calls(caller_id, target_ids, callee_name, file_path, language, payload) VALUES (?, ?, ?, ?, ?, ?)");
                const insertCallTarget = this.db.prepare("INSERT INTO call_targets(call_id, target_id) VALUES (?, ?)");
                for (const call of calls)
                    if (callPaths.has(call.filePath))
                        this.insertCall(insertCall, insertCallTarget, call);
            }
            else {
                // Full resolution can change calls in any file, so use the existing multiset diff.
                const digest = createHash("sha256");
                for (const call of calls)
                    digest.update(JSON.stringify(call));
                const callsDigest = digest.digest("hex");
                const previousCallsDigest = this.db
                    .prepare("SELECT value FROM metadata WHERE key = 'calls_digest'")
                    .get()?.value;
                if (previousCallsDigest !== callsDigest) {
                    const existingCalls = this.db
                        .prepare("SELECT id, payload FROM calls")
                        .all();
                    const existingIdsByPayload = new Map();
                    for (const row of existingCalls) {
                        const ids = existingIdsByPayload.get(row.payload);
                        if (ids)
                            ids.push(row.id);
                        else
                            existingIdsByPayload.set(row.payload, [row.id]);
                    }
                    const insertCall = this.db.prepare("INSERT INTO calls(caller_id, target_ids, callee_name, file_path, language, payload) VALUES (?, ?, ?, ?, ?, ?)");
                    const insertCallTarget = this.db.prepare("INSERT INTO call_targets(call_id, target_id) VALUES (?, ?)");
                    for (const call of calls) {
                        const payload = JSON.stringify(call);
                        const reusable = existingIdsByPayload.get(payload);
                        if (reusable?.length) {
                            reusable.pop();
                            continue;
                        }
                        this.insertCall(insertCall, insertCallTarget, call, payload);
                    }
                    const deleteCallById = this.db.prepare("DELETE FROM calls WHERE id = ?");
                    const deleteCallTargetsById = this.db.prepare("DELETE FROM call_targets WHERE call_id = ?");
                    for (const ids of existingIdsByPayload.values())
                        for (const id of ids) {
                            deleteCallTargetsById.run(id);
                            deleteCallById.run(id);
                        }
                }
                this.db
                    .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('calls_digest', ?)")
                    .run(callsDigest);
            }
            this.db
                .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('last_refreshed_at', ?)")
                .run(new Date().toISOString());
        });
        transaction();
    }
    close() {
        this.db.close();
    }
    insertCall(insertCall, insertCallTarget, call, payload = JSON.stringify(call)) {
        const result = insertCall.run(call.callerId, JSON.stringify(call.runtimeTargetIds ??
            (call.resolvedTargetId ? [call.resolvedTargetId] : [])), call.calleeName, call.filePath, call.language ?? "java", payload);
        for (const targetId of new Set(call.runtimeTargetIds ??
            (call.resolvedTargetId ? [call.resolvedTargetId] : [])))
            insertCallTarget.run(result.lastInsertRowid, targetId);
    }
    symbolPayload(symbol) {
        const payload = {};
        for (const key of Object.keys(symbol))
            if (key !== "source" && key !== "body")
                payload[key] = symbol[key];
        return JSON.stringify(payload);
    }
}
