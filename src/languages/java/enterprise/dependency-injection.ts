import type { SymbolRecord } from "../../../types/model.js";
import type { EnterpriseRelation } from "../../../types/enterprise.js";
import {
  registerEnterpriseExtractor,
  registerEnterpriseResolver,
} from "./registry.js";
import { bareName, splitTopLevel } from "./shared.js";

// Two-phase design: the per-file extractor only records injection points (type name,
// optional @Qualifier) as provisional "unresolved" relations; bean identity (§13) needs
// every project class/interface, so resolveDependencyRelations runs as a post-pass once
// all files are parsed (see registry.ts resolveEnterpriseRelations).

const QUALIFIER_RE = /@Qualifier\s*\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)/;
const STEREOTYPES = new Set([
  "Component",
  "Service",
  "Repository",
  "Controller",
  "RestController",
  "Configuration",
]);
const INJECT_ANNOTATIONS = new Set(["Autowired", "Inject", "Resource"]);

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


/** "@Qualifier("x") final a.b.Repo repo" -> { type: "Repo", name: "repo", qualifier: "x" }. */
function parseDeclaration(text: string) {
  const qualifier = text.match(QUALIFIER_RE)?.[1];
  const bare = text
    .replace(/@[\w.]+(?:\s*\([^)]*\))?/g, " ")
    .replace(
      /\b(?:final|private|protected|public|static|transient|volatile)\b/g,
      " ",
    )
    .trim();
  // ponytail: generic wrappers (List<Repo>, Optional<Repo>) resolve by the outer type, which
  // is never a project class, so they produce no relation; unwrap if collection DI matters.
  const match = bare.match(
    /^((?:[\w$]+\.)*([\w$]+))\s*(?:<.*>)?\s*(?:\[\s*\])*\s+([\w$]+)$/s,
  );
  if (!match) return undefined;
  return { type: match[2], name: match[3], qualifier };
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
    evidence:
      decl.qualifier !== undefined
        ? [evidence, `@Qualifier("${decl.qualifier}")`]
        : [evidence],
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

  // Constructor injection first (§12 preference ordering). Gated: only a Spring-managed class
  // (stereotype) or an explicitly @Autowired/@Inject constructor counts, so value objects like
  // Order(Customer c) never become false "exact" edges (§57).
  const seen = new Set<string>();
  for (const ctor of own.filter((s) => s.kind === "constructor")) {
    // parseJava can emit an annotated constructor twice (same range/source, "#2" id); keep one.
    const key = `${ctor.range.startLine}:${ctor.range.startColumn}:${ctor.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cls = own.find((s) => s.id === ctor.parentId);
    const stereotyped = cls?.annotations.some((a) =>
      STEREOTYPES.has(bareName(a)),
    );
    const annotated = ctor.annotations.some(
      (a) => bareName(a) === "Autowired" || bareName(a) === "Inject",
    );
    if (!stereotyped && !annotated) continue;
    const params = firstParenGroup(ctor.source);
    if (!params) continue;
    for (const param of splitTopLevel(params)) {
      const decl = parseDeclaration(param);
      if (decl)
        relations.push(
          relation(
            ctor,
            filePath,
            decl,
            `constructor parameter ${decl.type} ${decl.name}`,
          ),
        );
    }
  }

  // Field injection, using field symbols directly (Phase 0 AST rewrite) instead of a
  // regex scan over class-member text.
  for (const field of own.filter((s) => s.kind === "field")) {
    const annotation = field.annotations.find((a) =>
      INJECT_ANNOTATIONS.has(bareName(a)),
    );
    if (!annotation) continue;
    const cls = own.find((s) => s.id === field.parentId);
    if (!cls) continue;
    const decl = parseDeclaration(
      `${field.metadata?.declaredType ?? ""} ${field.name}`,
    );
    if (!decl) continue;
    const hasQualifier = field.annotations.some(
      (a) => bareName(a) === "Qualifier",
    );
    decl.qualifier ??= hasQualifier
      ? field.source.match(QUALIFIER_RE)?.[1]
      : undefined;
    relations.push(
      relation(
        cls,
        filePath,
        decl,
        `@${bareName(annotation)} field ${decl.type} ${field.name}`,
      ),
    );
  }

  // Explicit setter injection, using method symbols directly.
  for (const method of own.filter((s) => s.kind === "method")) {
    const annotation = method.annotations.find((a) =>
      INJECT_ANNOTATIONS.has(bareName(a)),
    );
    if (!annotation) continue;
    // method.source includes any leading annotations (tree-sitter's method_declaration node
    // starts at the modifiers); strip them first so a parenthesized annotation argument (e.g.
    // @Autowired(required = false)) isn't mistaken by firstParenGroup for the method's own params.
    const bodyText = method.source.replace(
      /^(?:\s*@[\w.]+(?:\s*\([^)]*\))?\s*)*/,
      "",
    );
    const params = firstParenGroup(bodyText);
    if (params === undefined) continue;
    const hasQualifier = method.annotations.some(
      (a) => bareName(a) === "Qualifier",
    );
    const qualifier = hasQualifier
      ? method.source.match(QUALIFIER_RE)?.[1]
      : undefined;
    for (const param of splitTopLevel(params)) {
      const p = parseDeclaration(param);
      if (!p) continue;
      p.qualifier ??= qualifier;
      relations.push(
        relation(
          method,
          filePath,
          p,
          `${annotation} setter ${method.name}(${p.type})`,
        ),
      );
    }
  }
  return relations;
}

/**
 * Bean identity (§13): exactly one project class/interface with the simple name -> exact;
 * several -> unresolved (never a guessed winner); zero -> not a bean. A @Qualifier value is
 * kept as evidence only: candidates all share the simple name, so it can't break a tie.
 */
export function resolveBeanType(
  typeName: string,
  projectTypes: SymbolRecord[],
): { confidence: "exact" | "unresolved"; targetSymbolId?: string } | undefined {
  const candidates = projectTypes.filter((s) => s.name === typeName);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1)
    return { confidence: "exact", targetSymbolId: candidates[0].id };
  return { confidence: "unresolved" };
}

/** Post-pass: fills in bean identity for DI relations; drops ones naming no project type. */
export function resolveDependencyRelations(
  relations: EnterpriseRelation[],
  allSymbols: SymbolRecord[],
): EnterpriseRelation[] {
  const projectTypes = allSymbols.filter(
    (s) => s.kind === "class" || s.kind === "interface",
  );
  return relations.flatMap((r) => {
    if (r.kind !== "INJECTS_DEPENDENCY" || r.family !== "dependency-injection")
      return [r];
    const resolved = resolveBeanType(r.targetLabel ?? "", projectTypes);
    if (!resolved) return [];
    const { targetSymbolId: _stale, ...rest } = r;
    return [{ ...rest, ...resolved }];
  });
}

registerEnterpriseExtractor(extractDependencyInjection);
registerEnterpriseResolver(resolveDependencyRelations);
