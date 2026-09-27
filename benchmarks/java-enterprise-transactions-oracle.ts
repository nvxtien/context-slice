// Independent ground-truth oracle for Spring `@Transactional` boundaries. Raw text scan only:
// imports NOTHING from src/ (mirrors benchmarks/java-enterprise-di-oracle.ts's and
// java-enterprise-route-oracle.ts's independence discipline). Used to measure the real
// extractor's (src/languages/java/enterprise/transactions.ts) recall/precision without trusting
// its own logic to grade itself.
//
// Only records occurrences with a NON-EMPTY argument list (e.g. `@Transactional(readOnly =
// true)`) — a bare `@Transactional` or empty-parens `@Transactional()` is deliberately excluded,
// matching the extractor's own "attribute-only extraction" rule (plan Global Constraints):
// nothing beyond the bare annotation name is worth reporting when there is no explicit attribute.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Attribute = { name: string; value: string };

export type OracleEntry = {
  repo: string;
  file: string;
  className: string;
  methodName: string;
  attributes: Attribute[];
  startLine: number; // 1-based line of the method name in its declaration
};

const TRANSACTIONAL_RE = /@Transactional\s*\(([^)]*)\)/g;
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

/** Within a class body (opening `{` at bodyOpen .. matching close), blank everything at brace
 * depth > 1 (nested method bodies, initializers, inner classes) so only member-level
 * declarations (fields, method signatures up to their own opening `{` or `;`) remain, keeping
 * newlines so line numbers stay accurate. Re-derived from java-enterprise-di-oracle.ts's
 * memberLevelMask (each oracle is self-contained per convention, not shared). */
function memberLevelMask(text: string, bodyOpen: number, bodyClose: number): string {
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
  for (let i = bodyClose + 1; i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  return out.join("");
}

/** Every top-level (non-nested) class/interface/enum/record body in a file. Nested types are
 * intentionally out of scope (documented limitation, matches the DI/route oracles' own
 * top-level-only convention) — no `@Transactional` on a nested/inner type was found in either
 * pinned repo. */
function topLevelTypeBlocks(source: string): Array<{ name: string; bodyOpen: number; bodyClose: number }> {
  const blocks: Array<{ name: string; bodyOpen: number; bodyClose: number }> = [];
  let depth = 0;
  let lastBoundary = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) {
        const preamble = source.slice(lastBoundary, i);
        const classMatch = [...preamble.matchAll(new RegExp(CLASS_DECL_RE, "g"))].pop();
        if (classMatch) {
          const close = matchingBrace(source, i);
          const bodyClose = close === -1 ? source.length - 1 : close;
          blocks.push({ name: classMatch[1], bodyOpen: i, bodyClose });
          lastBoundary = bodyClose + 1;
        }
      }
      depth++;
    } else if (ch === "}") {
      depth--;
    }
  }
  return blocks;
}

/** Splits an annotation argument list on commas outside (), strings — same technique as
 * transactions.ts's own splitTopLevel, re-derived here (oracle stays independent). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let inString = false;
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function scanFile(absPath: string, relPath: string, repo: string): OracleEntry[] {
  const raw = readFileSync(absPath, "utf8");
  const source = stripComments(raw);
  const entries: OracleEntry[] = [];

  for (const block of topLevelTypeBlocks(source)) {
    const masked = memberLevelMask(source, block.bodyOpen, block.bodyClose);

    for (const m of masked.matchAll(TRANSACTIONAL_RE)) {
      const rawArgs = (m[1] ?? "").trim();
      if (!rawArgs) continue; // bare or empty-parens: no fact to record

      const attributes: Attribute[] = [];
      for (const pair of splitTopLevel(rawArgs)) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        attributes.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() });
      }
      if (attributes.length === 0) continue;

      // The method declaration immediately follows this annotation (possibly after further
      // annotations, e.g. @Override or @Cacheable in either order around it). Strip any
      // leading annotations, then take everything up to the method's own "{" (concrete method)
      // or ";" (abstract/interface method) — memberLevelMask already blanked the method BODY
      // (depth > 1), so this is exactly the method's own signature text, never a stray brace
      // from inside its body.
      const afterIdx = (m.index ?? 0) + m[0].length;
      const rest = masked.slice(afterIdx);
      const lead = rest.match(/^(?:\s*@[\w.]+(?:\s*\([^)]*\))?)*/)![0];
      const sig = rest.slice(lead.length);
      const end = sig.search(/[{;]/);
      if (end === -1) continue;
      const decl = sig.slice(0, end);
      const nameMatch = decl.match(/([A-Za-z_$][\w$]*)\s*\(/);
      if (!nameMatch) continue;

      const nameOffsetInRest = lead.length + (nameMatch.index ?? 0);
      const absIndex = afterIdx + nameOffsetInRest;

      entries.push({
        repo,
        file: relPath,
        className: block.name,
        methodName: nameMatch[1],
        attributes,
        startLine: lineAt(masked, absIndex),
      });
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

export function extractOracleTransactions(repoRoot: string, repoId: string, scopeDir = "src/main/java"): OracleEntry[] {
  const dir = join(repoRoot, scopeDir);
  const files = listJavaFiles(dir);
  return files.flatMap((absPath) => scanFile(absPath, absPath.slice(repoRoot.length + 1), repoId));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const repositories = JSON.parse(readFileSync(join(root, "benchmarks/repositories.json"), "utf8")) as Array<{
    id: string;
    source: string;
  }>;
  const targets = repositories.filter((r) => r.id === "spring-petclinic" || r.id === "petclinic-rest");
  const outDir = join(root, "benchmarks/results");
  mkdirSync(outDir, { recursive: true });
  for (const repo of targets) {
    const entries = extractOracleTransactions(join(root, repo.source), repo.id);
    const outFile = join(outDir, `java-enterprise-transactions-oracle.${repo.id}.json`);
    writeFileSync(outFile, JSON.stringify(entries, null, 2) + "\n");
    console.log(`${repo.id}: ${entries.length} oracle transaction-boundary entries -> ${outFile}`);
  }
}
