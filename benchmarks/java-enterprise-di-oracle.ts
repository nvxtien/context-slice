// Independent ground-truth oracle for Spring dependency injection. Raw text scan only: imports
// NOTHING from src/ (mirrors benchmarks/java-enterprise-route-oracle.ts's independence
// discipline). Used to measure the real extractor's
// (src/languages/java/enterprise/dependency-injection.ts) recall/precision without trusting its
// own logic to grade itself. Deliberately does NOT resolve bean identity (unique/zero/ambiguous
// project-type match) — that judgment belongs to the evaluation script, working from this
// oracle's raw {file, className, injectionKind, typeName} facts plus its own independent scan of
// which simple names are declared as project classes/interfaces.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type InjectionKind = "constructor" | "field" | "setter";

export type OracleEntry = {
  repo: string;
  file: string;
  className: string;
  injectionKind: InjectionKind;
  typeName: string;
  memberName: string; // parameter name (constructor), field name, or setter method name
  qualifier?: string;
  startLine: number; // 1-based line of the injection point's declaration
};

// Spring's actual stereotype set (a domain fact, independently hardcoded — not shared with the
// product's copy). A constructor only counts as DI if its class is stereotyped, or the
// constructor itself carries @Autowired/@Inject: a plain value-object constructor taking a
// project type (e.g. `Order(Customer c)`) is not dependency injection.
const STEREOTYPES = new Set([
  "Component",
  "Service",
  "Repository",
  "Controller",
  "RestController",
  "Configuration",
]);
const INJECT_ANNOTATION_RE = /@(Autowired|Inject|Resource)\b(?:\s*\([^)]*\))?/g;
const QUALIFIER_RE = /@Qualifier\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/;
const CLASS_DECL_RE = /\b(?:class|interface|enum|record)\s+([\w$]+)/;

/** Blanks // and /* *\/ comments to spaces, preserving newlines and all other offsets. */
function stripComments(source: string): string {
  const out = source.split("");
  let inString = false;
  let inChar = false;
  for (let i = 0; i < out.length; i++) {
    const ch = source[i];
    if (!inString && !inChar && ch === "/" && source[i + 1] === "/") {
      while (i < out.length && source[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (!inString && !inChar && ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? out.length : end + 2;
      for (; i < stop; i++) if (source[i] !== "\n") out[i] = " ";
      i--;
      continue;
    }
    if (!inChar && ch === '"' && source[i - 1] !== "\\") inString = !inString;
    if (!inString && ch === "'" && source[i - 1] !== "\\") inChar = !inChar;
  }
  return out.join("");
}

/** Within a class body (opening `{` at index bodyStart+1 .. matching close), blank everything at
 * brace depth > 1 (nested method bodies, initializers, inner classes) so only member-level
 * declarations remain, while keeping newlines (line numbers stay accurate) and member-level
 * string literals (qualifier values). */
function memberLevelMask(
  text: string,
  bodyOpen: number,
  bodyClose: number,
): string {
  const out = text.split("");
  let depth = 0;
  let inString = false;
  for (let i = bodyOpen; i <= bodyClose; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    const keep = depth === 1;
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (!keep && out[i] !== "\n") out[i] = " ";
  }
  for (let i = 0; i < bodyOpen; i++) if (out[i] !== "\n") out[i] = " ";
  for (let i = bodyClose + 1; i < out.length; i++)
    if (out[i] !== "\n") out[i] = " ";
  return out.join("");
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/** Matching `}` for the `{` at openIndex, brace-depth aware, string-aware. */
function matchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a parameter list on top-level commas (outside (), <>, strings). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let inString = false;
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(" || ch === "<") depth++;
    else if (ch === ")" || ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** "@Qualifier("x") final a.b.Repo repo" -> { type: "Repo", name: "repo", qualifier: "x" }. */
function parseParamOrField(
  text: string,
): { type: string; name: string; qualifier?: string } | undefined {
  const qualifier = text.match(QUALIFIER_RE)?.[1];
  const bare = text
    .replace(/@[\w.]+(?:\s*\([^)]*\))?/g, " ")
    .replace(
      /\b(?:final|private|protected|public|static|transient|volatile)\b/g,
      " ",
    )
    .trim();
  const match = bare.match(
    /^((?:[\w$]+\.)*([\w$]+))\s*(?:<.*>)?\s*(?:\[\s*\])*\s+([\w$]+)$/s,
  );
  if (!match) return undefined;
  return { type: match[2], name: match[3], qualifier };
}

/** Every top-level (non-nested) class/interface/enum/record body in a file, with its own
 * preceding-annotation text (used to detect stereotypes). Nested types are intentionally out of
 * scope (documented limitation, matches route oracle's top-level-only convention). */
function topLevelTypeBlocks(source: string): Array<{
  name: string;
  stereotyped: boolean;
  bodyOpen: number;
  bodyClose: number;
}> {
  const blocks: Array<{
    name: string;
    stereotyped: boolean;
    bodyOpen: number;
    bodyClose: number;
  }> = [];
  let depth = 0;
  let lastBoundary = 0; // index just after the previous top-level block's close (or file start)
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) {
        const preamble = source.slice(lastBoundary, i);
        const classMatch = [
          ...preamble.matchAll(new RegExp(CLASS_DECL_RE, "g")),
        ].pop();
        if (classMatch) {
          const stereotyped = [...preamble.matchAll(/@([\w.]+)/g)].some((m) =>
            STEREOTYPES.has(m[1].slice(m[1].lastIndexOf(".") + 1)),
          );
          const close = matchingBrace(source, i);
          blocks.push({
            name: classMatch[1],
            stereotyped,
            bodyOpen: i,
            bodyClose: close === -1 ? source.length - 1 : close,
          });
          lastBoundary = (close === -1 ? source.length - 1 : close) + 1;
        }
      }
      depth++;
    } else if (ch === "}") {
      depth--;
    }
  }
  return blocks;
}

function scanFile(
  absPath: string,
  relPath: string,
  repo: string,
): OracleEntry[] {
  const raw = readFileSync(absPath, "utf8");
  const source = stripComments(raw);
  const entries: OracleEntry[] = [];

  for (const block of topLevelTypeBlocks(source)) {
    const masked = memberLevelMask(source, block.bodyOpen, block.bodyClose);

    // Constructors: `ClassName(...)` at member level, one or more overloads.
    const ctorRe = new RegExp(`\\b${block.name}\\s*\\(([^)]*)\\)`, "g");
    for (const m of masked.matchAll(ctorRe)) {
      const idx = m.index ?? 0;
      const precedingStart = Math.max(
        block.bodyOpen,
        masked.lastIndexOf(";", idx),
        masked.lastIndexOf("}", idx),
      );
      const preceding = masked.slice(precedingStart + 1, idx);
      const annotated = /@(Autowired|Inject)\b/.test(preceding);
      if (!block.stereotyped && !annotated) continue;
      const qualifier = preceding.match(QUALIFIER_RE)?.[1];
      for (const param of splitTopLevel(m[1])) {
        const decl = parseParamOrField(param);
        if (!decl) continue;
        entries.push({
          repo,
          file: relPath,
          className: block.name,
          injectionKind: "constructor",
          typeName: decl.type,
          memberName: decl.name,
          qualifier: decl.qualifier ?? qualifier,
          startLine: lineAt(masked, idx),
        });
      }
    }

    // Field / setter injection: every @Autowired/@Inject/@Resource at member level.
    for (const m of masked.matchAll(INJECT_ANNOTATION_RE)) {
      const idx = m.index ?? 0;
      const rest = masked.slice(idx + m[0].length);
      const lead = rest.match(/^(?:\s*@[\w.]+(?:\s*\([^)]*\))?)*/)![0];
      const leadQualifier = lead.match(QUALIFIER_RE)?.[1];
      const decl = rest.slice(lead.length);
      const end = decl.search(/[;(]/);
      if (end === -1) continue;
      if (decl[end] === "(") {
        const methodName = decl.slice(0, end).match(/([\w$]+)\s*$/)?.[1];
        const paramsEnd = decl.indexOf(")", end);
        if (!methodName || paramsEnd === -1) continue;
        const params = decl.slice(end + 1, paramsEnd);
        for (const param of splitTopLevel(params)) {
          const p = parseParamOrField(param);
          if (!p) continue;
          entries.push({
            repo,
            file: relPath,
            className: block.name,
            injectionKind: "setter",
            typeName: p.type,
            memberName: methodName,
            qualifier: p.qualifier ?? leadQualifier,
            startLine: lineAt(masked, idx),
          });
        }
      } else {
        const field = parseParamOrField(lead + decl.slice(0, end));
        if (!field) continue;
        entries.push({
          repo,
          file: relPath,
          className: block.name,
          injectionKind: "field",
          typeName: field.type,
          memberName: field.name,
          qualifier: field.qualifier ?? leadQualifier,
          startLine: lineAt(masked, idx),
        });
      }
    }
  }

  return entries;
}

function listJavaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJavaFiles(path);
    return entry.isFile() && entry.name.endsWith(".java") ? [path] : [];
  });
}

export function extractOracleDependencyInjection(
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

/** Every simple type name declared as a class/interface/enum/record anywhere under scopeDir —
 * the oracle's OWN independent notion of "is this a project bean type", used by the evaluation
 * script to judge (without trusting the product) whether an oracle entry's type is genuinely a
 * uniquely-resolvable project bean, ambiguous, or external. */
export function projectTypeNameCounts(
  repoRoot: string,
  scopeDir = "src/main/java",
): Map<string, number> {
  const dir = join(repoRoot, scopeDir);
  const files = listJavaFiles(dir);
  const counts = new Map<string, number>();
  for (const absPath of files) {
    const source = stripComments(readFileSync(absPath, "utf8"));
    for (const m of source.matchAll(
      /\b(?:class|interface|enum|record)\s+([\w$]+)/g,
    )) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return counts;
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
    const entries = extractOracleDependencyInjection(
      join(root, repo.source),
      repo.id,
    );
    const outFile = join(outDir, `java-enterprise-di-oracle.${repo.id}.json`);
    writeFileSync(outFile, JSON.stringify(entries, null, 2) + "\n");
    console.log(
      `${repo.id}: ${entries.length} oracle DI entries -> ${outFile}`,
    );
  }
}
