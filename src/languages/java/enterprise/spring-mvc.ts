import type { SymbolRecord } from "../../../types/model.js";
import type {
  EnterpriseRelation,
  EnterpriseRelationConfidence,
} from "../../../types/enterprise.js";
import { registerEnterpriseExtractor } from "./registry.js";

/**
 * Spring MVC mapping annotation -> HTTP method label. A bare @RequestMapping's
 * `method = RequestMethod.X` attribute is out of scope for this phase (known
 * limitation): every @RequestMapping, regardless of any method= attribute,
 * maps to "REQUEST" rather than being parsed into a real verb.
 */
const MAPPING_ANNOTATIONS: Record<string, string> = {
  RequestMapping: "REQUEST",
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};
const MAPPING_NAMES = Object.keys(MAPPING_ANNOTATIONS).join("|");
// Follows java-parser.ts's own annotationRe/typeRe/methodRe convention: raw regex over
// already-known symbol source slices, not a tokenizer.
const MAPPING_RE = new RegExp(`@(${MAPPING_NAMES})(?:\\(([^)]*)\\))?`);
const CONST_RE_TEMPLATE = (name: string) =>
  new RegExp(`(?:static\\s+final|final\\s+static)\\s+String\\s+${name}\\s*=\\s*"([^"]*)"`);

/**
 * The symbol's own header text (annotations + declaration), stopping before its body's
 * opening "{". A naive indexOf("{") breaks when a mapping annotation's path literal itself
 * contains "{" (e.g. "/{id}"), so this tracks string-literal and paren depth to find the
 * real body brace instead.
 */
function header(symbol: SymbolRecord): string {
  const text = symbol.source;
  let inString = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "{" && depth === 0) return text.slice(0, i);
  }
  return text;
}

/**
 * Guards against parseJava's own regex picking up an annotation-shaped comment (e.g.
 * "// example: @RequestMapping(...)") as if it preceded a real declaration: the symbol's
 * range starts at that bogus annotation text, so if "//" appears earlier on that same
 * source line, this isn't a real annotated declaration.
 */
function startsInsideLineComment(symbol: SymbolRecord, fullSource: string): boolean {
  const line = fullSource.split("\n")[symbol.range.startLine - 1] ?? "";
  return line.slice(0, symbol.range.startColumn).includes("//");
}

type PathResolution =
  | { kind: "absent" }
  | { kind: "literal"; value: string }
  | { kind: "const"; value: string }
  | { kind: "unresolved"; raw: string };

/**
 * Resolves a mapping annotation's argument text to a path.
 * - A quoted string literal is exact.
 * - A same-class `static final String NAME = "literal"` constant resolves through
 *   one hop, downgrading confidence to at most "probable".
 * - Anything else (a call, a qualified constant, a placeholder) is unresolved;
 *   the raw expression is kept for evidence/targetLabel, never guessed into a path.
 */
function resolvePath(rawInside: string | undefined, classSource: string): PathResolution {
  if (rawInside === undefined) return { kind: "absent" };
  let text = rawInside.trim();
  if (text === "") return { kind: "absent" };
  text = text.replace(/^(?:value|path)\s*=\s*/, "").trim();

  const quoted = text.match(/"([^"]*)"/);
  if (quoted) return { kind: "literal", value: quoted[1] };

  const identMatch = text.match(/^([A-Za-z_$][\w$]*)$/);
  if (identMatch) {
    const match = classSource.match(CONST_RE_TEMPLATE(identMatch[1]));
    if (match) return { kind: "const", value: match[1] };
  }
  return { kind: "unresolved", raw: text };
}

function joinPaths(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

function describeAnnotation(name: string, rawInside: string | undefined, kind: string, symbolName: string): string {
  const args = rawInside !== undefined ? `(${rawInside.trim()})` : "";
  return `@${name}${args} on ${kind} ${symbolName}`;
}

function extractSpringMvcRelations(
  symbols: SymbolRecord[],
  filePath: string,
  source: string,
): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];
  const classes = symbols.filter((s) => s.kind === "class");

  for (const method of symbols.filter((s) => s.kind === "method")) {
    if (startsInsideLineComment(method, source)) continue;
    const parent = classes.find((c) => c.id === method.parentId);
    const methodMatch = header(method).match(MAPPING_RE);
    if (!methodMatch) continue; // not a handler: no annotation spam for non-mapped methods

    const httpMethod = MAPPING_ANNOTATIONS[methodMatch[1]];
    const classSourceForConstants = parent?.source ?? "";
    const methodResolution = resolvePath(methodMatch[2], classSourceForConstants);

    const evidence: string[] = [];
    let classMatch: RegExpMatchArray | null = null;
    if (parent && !startsInsideLineComment(parent, source)) {
      classMatch = header(parent).match(MAPPING_RE);
      if (classMatch) evidence.push(describeAnnotation(classMatch[1], classMatch[2], "class", parent.name));
    }
    evidence.push(describeAnnotation(methodMatch[1], methodMatch[2], "method", method.name));

    let confidence: EnterpriseRelationConfidence;
    let targetLabel: string | undefined;

    const classResolution: PathResolution = classMatch
      ? resolvePath(classMatch[2], classSourceForConstants)
      : { kind: "absent" };

    if (methodResolution.kind === "unresolved") {
      confidence = "unresolved";
      targetLabel = methodResolution.raw;
    } else if (classResolution.kind === "unresolved") {
      confidence = "unresolved";
      targetLabel = classResolution.raw;
    } else {
      const classPath = classResolution.kind === "absent" ? "" : classResolution.value;
      const methodPath = methodResolution.kind === "absent" ? "" : methodResolution.value;
      const usedConstHop = classResolution.kind === "const" || methodResolution.kind === "const";
      confidence = usedConstHop ? "probable" : "exact";
      targetLabel = `${httpMethod} ${joinPaths(classPath, methodPath)}`;
    }

    relations.push({
      kind: "ROUTE_TO_HANDLER",
      family: "spring-mvc",
      sourceSymbolId: method.id,
      targetLabel,
      confidence,
      evidence,
      range: method.range,
      filePath,
    });
  }

  return relations;
}

registerEnterpriseExtractor(extractSpringMvcRelations);
