// Independent ground-truth oracle for Spring MVC routes. Raw text scan only: imports NOTHING
// from src/ (mirrors benchmarks/rust-call-oracle.ts's independence discipline). Used to measure
// the real extractor's (src/languages/java/enterprise/spring-mvc.ts) recall/precision without
// trusting its own logic to grade itself.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type OracleEntry = {
  repo: string;
  file: string;
  classPath: string;
  methodPath: string;
  httpMethod: string;
  composedRoute: string;
  handlerName: string;
  startLine: number; // 1-based, of the handler method's declaration line
};

const MAPPING_TO_VERB: Record<string, string> = {
  RequestMapping: "REQUEST",
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};
const MAPPING_RE =
  /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b(?:\(([^)]*)\))?/;
const STEREOTYPE_RE = /@(RestController|Controller)\b/;
const CLASS_RE = /^(?:public\s+|private\s+)?(?:final\s+)?class\s+(\w+)/;
const INLINE_ANNOTATION_RE = /@\w+(?:\([^)]*\))?/g;

/**
 * Method name from a declaration line, tolerant of an inline return-type annotation
 * (e.g. `public @ResponseBody Vets showResourcesVetList()`, seen in VetController) by
 * stripping all `@Annotation(...)` tokens first, then taking the first `name(` left.
 */
function methodNameFrom(declLine: string): string | undefined {
  const stripped = declLine.replace(INLINE_ANNOTATION_RE, " ");
  const m = stripped.match(/(\w+)\s*\(/);
  return m?.[1];
}

/** First quoted-string argument, or "" when the annotation has no path (e.g. bare @GetMapping). */
function literalPath(rawInside: string | undefined): string {
  if (!rawInside) return "";
  const m = rawInside.match(/"([^"]*)"/);
  return m ? m[1] : "";
}

function joinPaths(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

function listJavaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJavaFiles(path);
    return entry.isFile() && entry.name.endsWith(".java") ? [path] : [];
  });
}

/**
 * Single-pass line scanner. Tracks brace depth to know when we're directly inside a top-level
 * controller class body (depth === 1) vs. nested deeper (anonymous class, lambda, inner class) —
 * handler annotations are only honored at that top level, per plan Review Focus #5 (no false
 * positives from non-handler contexts).
 */
function scanFile(
  absPath: string,
  relPath: string,
  repo: string,
): OracleEntry[] {
  const source = readFileSync(absPath, "utf8");
  const lines = source.split("\n");
  const entries: OracleEntry[] = [];

  let pending: string[] = [];
  let depth = 0;
  let controllerActive = false;
  let controllerClassPath = "";
  let awaitingClassBrace = false;
  let pendingClassPath = "";
  let pendingIsController = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const isComment =
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*");

    if (!isComment && trimmed.startsWith("@")) {
      pending.push(trimmed);
    } else if (!isComment) {
      const classMatch = trimmed.match(CLASS_RE);
      if (classMatch) {
        pendingIsController = pending.some((l) => STEREOTYPE_RE.test(l));
        const classMapping = pending
          .map((l) => l.match(MAPPING_RE))
          .find((m): m is RegExpMatchArray => !!m);
        pendingClassPath = classMapping ? literalPath(classMapping[2]) : "";
        awaitingClassBrace = true;
        pending = [];
      } else if (controllerActive && depth === 1) {
        const mappingLine = pending.find((l) => MAPPING_RE.test(l));
        if (mappingLine && trimmed.includes("(")) {
          const name = methodNameFrom(trimmed);
          const mapMatch = mappingLine.match(MAPPING_RE)!;
          if (name) {
            const httpMethod = MAPPING_TO_VERB[mapMatch[1]];
            const methodPath = literalPath(mapMatch[2]);
            entries.push({
              repo,
              file: relPath,
              classPath: controllerClassPath,
              methodPath,
              httpMethod,
              composedRoute: `${httpMethod} ${joinPaths(controllerClassPath, methodPath)}`,
              handlerName: name,
              startLine: i + 1,
            });
          }
        }
        pending = [];
      } else if (trimmed !== "") {
        pending = [];
      }
    }

    if (!isComment) {
      for (const ch of raw) {
        if (ch === "{") {
          depth++;
          if (awaitingClassBrace) {
            awaitingClassBrace = false;
            if (depth === 1) {
              controllerActive = pendingIsController;
              controllerClassPath = pendingClassPath;
            }
          }
        } else if (ch === "}") {
          depth--;
          if (depth === 0) controllerActive = false;
        }
      }
    }
  }

  return entries;
}

export function extractOracleRoutes(
  repoRoot: string,
  repoId: string,
  scopeDir = "src/main/java",
): OracleEntry[] {
  const dir = join(repoRoot, scopeDir);
  const files = listJavaFiles(dir);
  return files.flatMap((absPath) =>
    scanFile(absPath, absPath.slice(repoRoot.length + 1), repoId),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const repositories = JSON.parse(
    readFileSync(join(root, "benchmarks/repositories.json"), "utf8"),
  ) as Array<{
    id: string;
    source: string;
  }>;
  const targets = repositories.filter(
    (r) => r.id === "spring-petclinic" || r.id === "petclinic-rest",
  );
  const outDir = join(root, "benchmarks/results");
  mkdirSync(outDir, { recursive: true });
  for (const repo of targets) {
    const entries = extractOracleRoutes(join(root, repo.source), repo.id);
    const outFile = join(
      outDir,
      `java-enterprise-route-oracle.${repo.id}.json`,
    );
    writeFileSync(outFile, JSON.stringify(entries, null, 2) + "\n");
    console.log(
      `${repo.id}: ${entries.length} oracle route entries -> ${outFile}`,
    );
  }
}
