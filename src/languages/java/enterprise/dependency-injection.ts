import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";
import { registerEnterpriseExtractor, registerEnterpriseResolver } from "./registry.js";

// Two-phase design: the per-file extractor only records injection points (type name,
// optional @Qualifier) as provisional "unresolved" relations; bean identity (§13) needs
// every project class/interface, so resolveDependencyRelations runs as a post-pass once
// all files are parsed (see registry.ts resolveEnterpriseRelations).

const INJECT_RE = /@(Autowired|Inject|Resource)\b(?:\s*\([^)]*\))?/g;
const QUALIFIER_RE = /@Qualifier\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/;
const QUALIFIER_EVIDENCE_RE = /^@Qualifier\("(.*)"\)$/;

/** Text between the first top-level "(" and its matching ")", string-aware. */
function firstParenGroup(text: string): string | undefined {
  let inString = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(" && depth++ === 0) start = i + 1;
    else if (ch === ")" && --depth === 0) return text.slice(start, i);
  }
  return undefined;
}

/** Splits on commas outside (), <>, and strings. */
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
function parseDeclaration(text: string) {
  const qualifier = text.match(QUALIFIER_RE)?.[1];
  const bare = text
    .replace(/@[\w.]+(?:\s*\([^)]*\))?/g, " ")
    .replace(/\b(?:final|private|protected|public|static|transient|volatile)\b/g, " ")
    .trim();
  // ponytail: generic wrappers (List<Repo>, Optional<Repo>) resolve by the outer type, which
  // is never a project class, so they produce no relation; unwrap if collection DI matters.
  const match = bare.match(/^((?:[\w$]+\.)*([\w$]+))\s*(?:<.*>)?\s*(?:\[\s*\])*\s+([\w$]+)$/s);
  if (!match) return undefined;
  return { type: match[2], name: match[3], qualifier };
}

/**
 * The class body at member depth only: nested bodies (methods, initializers, inner classes),
 * and comments are blanked to spaces, so positions still line up with the
 * class source while annotations on locals or inside comments can never match.
 */
function memberLevelBody(classSource: string): string {
  const out = classSource.split("");
  let depth = 0;
  let inString = false;
  for (let i = 0; i < out.length; i++) {
    const ch = classSource[i];
    if (!inString && ch === "/" && classSource[i + 1] === "/") {
      while (i < out.length && classSource[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (!inString && ch === "/" && classSource[i + 1] === "*") {
      const end = classSource.indexOf("*/", i + 2);
      const stop = end === -1 ? out.length : end + 2;
      for (; i < stop; i++) if (out[i] !== "\n") out[i] = " ";
      i--;
      continue;
    }
    if (ch === '"' && classSource[i - 1] !== "\\") inString = !inString;
    const keep = depth === 1; // member-level string literals kept: @Qualifier values live there
    if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (!keep && out[i] !== "\n") out[i] = " ";
  }
  return out.join("");
}

function relation(
  source: SymbolRecord,
  filePath: string,
  decl: { type: string; qualifier?: string },
  evidence: string,
): EnterpriseRelation {
  return {
    kind: "INJECTS_DEPENDENCY",
    family: "dependency-injection",
    sourceSymbolId: source.id,
    targetLabel: decl.type,
    confidence: "unresolved", // provisional until resolveDependencyRelations runs
    evidence: decl.qualifier !== undefined ? [evidence, `@Qualifier("${decl.qualifier}")`] : [evidence],
    range: source.range,
    filePath,
  };
}

function extractDependencyInjection(
  symbols: SymbolRecord[],
  filePath: string,
  _source: string,
): EnterpriseRelation[] {
  const own = symbols.filter((s) => s.filePath === filePath);
  const relations: EnterpriseRelation[] = [];

  // Constructor injection first (§12 preference ordering).
  for (const ctor of own.filter((s) => s.kind === "constructor")) {
    const params = firstParenGroup(ctor.source);
    if (!params) continue;
    for (const param of splitTopLevel(params)) {
      const decl = parseDeclaration(param);
      if (decl) relations.push(relation(ctor, filePath, decl, `constructor parameter ${decl.type} ${decl.name}`));
    }
  }

  // Field and explicit-setter injection, scanned at class-member depth only.
  for (const cls of own.filter((s) => s.kind === "class")) {
    const body = memberLevelBody(cls.source);
    for (const match of body.matchAll(INJECT_RE)) {
      const annotation = match[1];
      const rest = body.slice((match.index ?? 0) + match[0].length);
      // Other annotations stacked after this one (e.g. @Qualifier) belong to the same member.
      const lead = rest.match(/^(?:\s*@[\w.]+(?:\s*\([^)]*\))?)*/)![0];
      const leadQualifier = lead.match(QUALIFIER_RE)?.[1];
      const decl = rest.slice(lead.length);
      const end = decl.search(/[;(=]/);
      if (end === -1) continue;
      if (decl[end] === "(") {
        const methodName = decl.slice(0, end).match(/([\w$]+)\s*$/)?.[1];
        const setter = own.find((s) => s.kind === "method" && s.parentId === cls.id && s.name === methodName);
        const params = firstParenGroup(decl.slice(end));
        if (!setter || params === undefined) continue; // e.g. an annotated constructor, handled above
        for (const param of splitTopLevel(params)) {
          const p = parseDeclaration(param);
          if (!p) continue;
          p.qualifier ??= leadQualifier;
          relations.push(relation(setter, filePath, p, `@${annotation} setter ${setter.name}(${p.type})`));
        }
      } else {
        const field = parseDeclaration(lead + decl.slice(0, end));
        if (field) relations.push(relation(cls, filePath, field, `@${annotation} field ${field.type} ${field.name}`));
      }
    }
  }
  return relations;
}

/**
 * Bean identity (§13): exactly one project class/interface with the simple name -> exact;
 * several, with a @Qualifier equal to exactly one candidate's simple name -> exact; any
 * other multi-candidate case -> unresolved (never a guessed winner); zero -> not a bean.
 */
export function resolveBeanType(
  typeName: string,
  qualifier: string | undefined,
  projectTypes: SymbolRecord[],
): { confidence: "exact" | "unresolved"; targetSymbolId?: string } | undefined {
  const candidates = projectTypes.filter((s) => s.name === typeName);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return { confidence: "exact", targetSymbolId: candidates[0].id };
  const qualified = candidates.filter((s) => s.name === qualifier);
  if (qualified.length === 1) return { confidence: "exact", targetSymbolId: qualified[0].id };
  return { confidence: "unresolved" };
}

/** Post-pass: fills in bean identity for DI relations; drops ones naming no project type. */
export function resolveDependencyRelations(
  relations: EnterpriseRelation[],
  allSymbols: SymbolRecord[],
): EnterpriseRelation[] {
  const projectTypes = allSymbols.filter((s) => s.kind === "class" || s.kind === "interface");
  return relations.flatMap((r) => {
    if (r.kind !== "INJECTS_DEPENDENCY" || r.family !== "dependency-injection") return [r];
    const qualifier = r.evidence.map((e) => e.match(QUALIFIER_EVIDENCE_RE)?.[1]).find((q) => q !== undefined);
    const resolved = resolveBeanType(r.targetLabel ?? "", qualifier, projectTypes);
    if (!resolved) return [];
    const { targetSymbolId: _stale, ...rest } = r;
    return [{ ...rest, ...resolved }];
  });
}

registerEnterpriseExtractor(extractDependencyInjection);
registerEnterpriseResolver(resolveDependencyRelations);
