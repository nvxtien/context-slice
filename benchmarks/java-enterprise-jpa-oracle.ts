// Independent ground-truth oracle for JPA entity relationships and Spring Data repository
// linkage. Raw text scan only: imports NOTHING from src/ (mirrors every other oracle's
// independence discipline: java-enterprise-di-oracle.ts, java-enterprise-route-oracle.ts,
// java-enterprise-transactions-oracle.ts). Used to measure the real extractors'
// (src/languages/java/enterprise/jpa-entity.ts, spring-data.ts) recall/precision without
// trusting their own logic to grade itself.
//
// Two independent scans, mirroring the two extractor files:
//
// (a) ENTITY_RELATION: @Entity-annotated classes and their @OneToOne/@OneToMany/@ManyToOne/
//     @ManyToMany fields, with explicit mappedBy/fetch/cascade/@JoinColumn only (never a
//     framework default).
//
// (b) Repository linkage (PERSISTS_ENTITY + REPOSITORY_QUERY): interfaces extending a known
//     Spring Data base with <Entity, Id> type arguments, plus their derived-query and @Query
//     methods. Unlike a naive scan, this oracle ALSO walks each such interface's own supertype
//     interfaces (plain ones, with no generic of their own) declared in the same repo, because
//     petclinic-rest has a real, confirmed pattern: a plain interface (e.g. OwnerRepository, no
//     `extends` at all) declares the derived-query methods the SERVICE layer actually calls,
//     while a separate sibling (SpringDataOwnerRepository) `extends OwnerRepository,
//     Repository<Owner, Integer>` and re-declares only SOME of them. The oracle's ground truth
//     is "this entity's repository has this queryable method", regardless of which single
//     interface file happens to declare it — matching how §22-23 frame repository linkage as an
//     entity-level fact, not a single-symbol fact.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type RelationKind =
  "OneToOne" | "OneToMany" | "ManyToOne" | "ManyToMany";

export type EntityRelationEntry = {
  repo: string;
  file: string;
  entityClass: string;
  fieldName: string;
  relationKind: RelationKind;
  targetSimpleName: string;
  mappedBy?: string;
  fetch?: string;
  cascade?: string;
  joinColumn?: string;
  startLine: number;
};

export type RepositoryQueryEntry = {
  repo: string;
  entitySimpleName: string;
  /** The generic-carrying interface this fact is ultimately attributed to (e.g. SpringDataOwnerRepository, or OwnerRepository in spring-petclinic where there is no split). */
  ownerInterface: string;
  /** Every file that textually declares this exact (name, paramCount) method for this repository family — 1 entry normally, 2 when both a plain interface and its @Override sibling declare it. */
  declaredIn: string[];
  methodName: string;
  paramCount: number;
  isDerived: boolean;
  hasQuery: boolean;
  startLine: number; // of the first (plain-interface-preferred) declaration
};

export type PersistsEntityEntry = {
  repo: string;
  file: string;
  interfaceName: string;
  entitySimpleName: string;
  idType: string;
  startLine: number;
};

export type OracleResult = {
  entityRelations: EntityRelationEntry[];
  persistsEntity: PersistsEntityEntry[];
  repositoryQueries: RepositoryQueryEntry[];
};

const RELATION_RE =
  /@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b(?:\s*\(([^)]*)\))?/g;
const COLLECTION_RE = /\b(?:List|Set|Collection)<\s*([\w.]+)\s*>/;
const BASE_RE =
  /\b(?:JpaRepository|CrudRepository|PagingAndSortingRepository|Repository)\s*</g;
const DERIVED_RE = /^(?:find|exists|delete|count)By(?=[A-Z])/;
const CLASS_DECL_RE = /\b(class|interface|enum|record)\s+([\w$]+)/;

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

type TypeBlock = {
  kind: string;
  name: string;
  preamble: string;
  bodyOpen: number;
  bodyClose: number;
};

/** Every top-level (non-nested) class/interface/enum/record body in a file, with its preamble
 * (annotations, javadoc, header up to and including any `extends`/`implements` clause). Nested
 * types are intentionally out of scope, matching every other oracle's top-level-only convention. */
function topLevelTypeBlocks(source: string): TypeBlock[] {
  const blocks: TypeBlock[] = [];
  let depth = 0;
  let lastBoundary = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) {
        const preamble = source.slice(lastBoundary, i);
        const classMatch = [
          ...preamble.matchAll(new RegExp(CLASS_DECL_RE, "g")),
        ].pop();
        if (classMatch) {
          const close = matchingBrace(source, i);
          const bodyClose = close === -1 ? source.length - 1 : close;
          blocks.push({
            kind: classMatch[1],
            name: classMatch[2],
            preamble,
            bodyOpen: i,
            bodyClose,
          });
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

/** Member-level body: everything at brace depth 1 kept, depth>1 (method bodies, nested types,
 * initializers) blanked to spaces (newlines preserved so line numbers stay accurate). */
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

// ---------- (a) ENTITY_RELATION scan ----------

function explicitAttributes(args: string): {
  mappedBy?: string;
  fetch?: string;
  cascade?: string;
} {
  const mappedBy = args.match(/\bmappedBy\s*=\s*"([^"]*)"/)?.[1];
  const fetch = args.match(/\bfetch\s*=\s*([\w.]+)/)?.[1];
  const cascade = args.match(/\bcascade\s*=\s*(\{[^}]*\}|[\w.]+)/)?.[1];
  return { mappedBy, fetch, cascade };
}

type LeadAnnotation = { name: string; args?: string };

/** Consumes zero or more leading stacked annotations from the start of `text` (the annotations
 * between a relation annotation and the field declaration it decorates), paren-depth counting
 * an annotation's own `(...)` argument list so a nested-annotation argument (e.g.
 * `@JoinTable(joinColumns = @JoinColumn(...), inverseJoinColumns = @JoinColumn(...))`) doesn't
 * truncate consumption early at the first `)` -- mirrors memberLevelMask's brace-depth counting,
 * one level down at paren depth instead of brace depth. Also returns each consumed annotation's
 * own bare name and (unparsed) argument text, so a caller can tell a genuine top-level stacked
 * annotation (e.g. a field's own `@JoinColumn`) apart from one merely nested inside another
 * top-level annotation's argument list (e.g. `@JoinTable`'s `joinColumns = @JoinColumn(...)`). */
function consumeLeadingAnnotations(text: string): {
  consumed: string;
  annotations: LeadAnnotation[];
} {
  let i = 0;
  const annotations: LeadAnnotation[] = [];
  for (;;) {
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== "@") break;
    j++;
    const nameStart = j;
    while (j < text.length && /[\w.]/.test(text[j])) j++;
    const name = text.slice(nameStart, j);
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    let args: string | undefined;
    if (text[k] === "(") {
      let depth = 0;
      let m = k;
      const argsStart = k + 1;
      while (m < text.length) {
        if (text[m] === "(") depth++;
        else if (text[m] === ")") {
          depth--;
          if (depth === 0) {
            args = text.slice(argsStart, m);
            m++;
            break;
          }
        }
        m++;
      }
      j = m;
    }
    annotations.push({ name: name.slice(name.lastIndexOf(".") + 1), args });
    i = j;
  }
  return { consumed: text.slice(0, i), annotations };
}

function scanEntityRelations(
  source: string,
  relPath: string,
  repo: string,
): EntityRelationEntry[] {
  const entries: EntityRelationEntry[] = [];
  for (const block of topLevelTypeBlocks(source)) {
    if (block.kind !== "class") continue;
    if (!/@Entity\b/.test(block.preamble)) continue;
    const body = memberLevelMask(source, block.bodyOpen, block.bodyClose);
    for (const match of body.matchAll(RELATION_RE)) {
      const rest = body.slice((match.index ?? 0) + match[0].length);
      const { consumed: lead, annotations: leadAnnotations } =
        consumeLeadingAnnotations(rest);
      const decl = rest.slice(lead.length);
      const end = decl.search(/[;=(]/);
      if (end === -1 || decl[end] === "(") continue; // annotated getter/method: not a field
      const bare = decl
        .slice(0, end)
        .replace(
          /\b(?:final|private|protected|public|static|transient|volatile)\b/g,
          " ",
        )
        .trim();
      const field = bare.match(/^([\w$.]+(?:\s*<.*>)?)\s+([\w$]+)$/s);
      if (!field) continue;
      const [, typeText, fieldName] = field;
      const rawTarget =
        typeText.match(COLLECTION_RE)?.[1] ??
        typeText.replace(/<.*>/s, "").trim();
      const joinColumn = leadAnnotations
        .find((a) => a.name === "JoinColumn")
        ?.args?.trim();
      const { mappedBy, fetch, cascade } = explicitAttributes(match[2] ?? "");
      entries.push({
        repo,
        file: relPath,
        entityClass: block.name,
        fieldName,
        relationKind: match[1] as RelationKind,
        targetSimpleName: rawTarget.slice(rawTarget.lastIndexOf(".") + 1),
        mappedBy,
        fetch,
        cascade,
        joinColumn,
        startLine: lineAt(body, match.index ?? 0),
      });
    }
  }
  return entries;
}

// ---------- (b) repository linkage scan ----------

/** Top-level type arguments of the `<...>` opening at `open`. */
function typeArguments(
  text: string,
  open: number,
): { args: string[]; end: number } | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") depth++;
    else if (ch === ">" && --depth === 0) {
      args.push(text.slice(start, i).trim());
      return { args, end: i + 1 };
    } else if (ch === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/** Splits `extends A, B<X, Y>, C` into ["A", "B<X, Y>", "C"] — comma-split only at angle depth 0. */
function splitExtendsList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

type MethodInfo = {
  name: string;
  paramCount: number;
  isDerived: boolean;
  hasQuery: boolean;
  startLine: number;
};

type IfaceInfo = {
  name: string;
  file: string;
  bodyOpen: number;
  bodyClose: number;
  source: string; // full file source, for line numbers
  extendsRaw: string[]; // raw extends-list entries
  resolvedEntity?: { entity: string; id: string };
  methods: MethodInfo[];
};

/** Strips one leading annotation (with balanced, string-aware parens) if present. */
function stripOneAnnotation(
  text: string,
): { rest: string; hadQuery: boolean } | undefined {
  const m = /^\s*@([\w.]+)/.exec(text);
  if (!m) return undefined;
  let i = (m.index ?? 0) + m[0].length;
  const isQuery = m[1] === "Query";
  if (text[i] === "(") {
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
      if (inString) continue;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
  }
  return { rest: text.slice(i), hadQuery: isQuery };
}

/** Interface member declarations: split masked body on top-level `;` (paren/angle/brace depth 0). */
function splitMembers(body: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' && body[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(" || ch === "<" || ch === "{") depth++;
    else if (ch === ")" || ch === ">" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) {
      members.push(body.slice(start, i + 1));
      start = i + 1;
    }
  }
  return members;
}

function parseMethod(
  memberText: string,
):
  | { name: string; paramCount: number; hasQuery: boolean; declStart: number }
  | undefined {
  let rest = memberText;
  let consumed = 0;
  let hasQuery = false;
  while (true) {
    const stripped = stripOneAnnotation(rest);
    if (!stripped) break;
    if (stripped.hadQuery) hasQuery = true;
    consumed += rest.length - stripped.rest.length;
    rest = stripped.rest;
  }
  // rest now starts with modifiers + return type + name(...) — find the method name + its params.
  const nameMatch = /([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
  if (!nameMatch) return undefined;
  const parenOpen = (nameMatch.index ?? 0) + nameMatch[0].length - 1;
  let depth = 0;
  let inString = false;
  let parenClose = -1;
  for (let i = parenOpen; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '"' && rest[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        parenClose = i;
        break;
      }
    }
  }
  if (parenClose === -1) return undefined;
  const paramsText = rest.slice(parenOpen + 1, parenClose).trim();
  const paramCount =
    paramsText === "" ? 0 : splitExtendsList(paramsText).length;
  return {
    name: nameMatch[1],
    paramCount,
    hasQuery,
    declStart: consumed + (nameMatch.index ?? 0),
  };
}

function scanRepositoryInterfaces(
  source: string,
  relPath: string,
): IfaceInfo[] {
  const ifaces: IfaceInfo[] = [];
  for (const block of topLevelTypeBlocks(source)) {
    if (block.kind !== "interface") continue;
    const extendsText = /\bextends\s+([^{]+)$/.exec(block.preamble)?.[1] ?? "";
    const extendsRaw = splitExtendsList(extendsText);
    let resolvedEntity: { entity: string; id: string } | undefined;
    for (const item of extendsRaw) {
      const openIdx = item.search(/</);
      if (openIdx === -1) continue;
      if (!BASE_RE.test(item.slice(0, openIdx + 1))) continue;
      BASE_RE.lastIndex = 0;
      const parsed = typeArguments(item, openIdx);
      if (!parsed || parsed.args.length !== 2) continue;
      const [entity, id] = parsed.args;
      if (!/^[\w.]+$/.test(entity)) continue;
      resolvedEntity = {
        entity: entity.slice(entity.lastIndexOf(".") + 1),
        id,
      };
      break;
    }

    const body = memberLevelMask(source, block.bodyOpen, block.bodyClose);
    const methods: MethodInfo[] = [];
    for (const member of splitMembers(body)) {
      if (!member.trim()) continue;
      const parsed = parseMethod(member);
      if (!parsed) continue;
      const isDerived = DERIVED_RE.test(parsed.name);
      if (!isDerived && !parsed.hasQuery) continue;
      // Find absolute offset of this member within `body` to compute a real line number.
      const absOffset = body.indexOf(member);
      methods.push({
        name: parsed.name,
        paramCount: parsed.paramCount,
        isDerived,
        hasQuery: parsed.hasQuery,
        startLine: lineAt(body, absOffset === -1 ? 0 : absOffset),
      });
    }

    ifaces.push({
      name: block.name,
      file: relPath,
      bodyOpen: block.bodyOpen,
      bodyClose: block.bodyClose,
      source,
      extendsRaw,
      resolvedEntity,
      methods,
    });
  }
  return ifaces;
}

/** Bare, non-generic supertype names from an extends list (e.g. "OwnerRepository" out of
 * "OwnerRepository, Repository<Owner, Integer>") — candidates for the plain-interface walk. */
function plainSupertypeNames(extendsRaw: string[]): string[] {
  return extendsRaw
    .filter((item) => !item.includes("<"))
    .map((item) => item.trim());
}

function buildRepositoryFacts(
  repo: string,
  allIfaces: IfaceInfo[],
): {
  persistsEntity: PersistsEntityEntry[];
  repositoryQueries: RepositoryQueryEntry[];
} {
  const byName = new Map<string, IfaceInfo>();
  for (const iface of allIfaces) byName.set(iface.name, iface);

  const persistsEntity: PersistsEntityEntry[] = [];
  const repositoryQueries: RepositoryQueryEntry[] = [];

  for (const iface of allIfaces) {
    if (!iface.resolvedEntity) continue;
    persistsEntity.push({
      repo,
      file: iface.file,
      interfaceName: iface.name,
      entitySimpleName: iface.resolvedEntity.entity,
      idType: iface.resolvedEntity.id,
      startLine: lineAt(iface.source, iface.bodyOpen),
    });

    // Walk self + every reachable same-project supertype interface (plain or not), collecting
    // methods, deduped by (name, paramCount). Prefer the plain interface's own declaration site
    // and line (that is the one the brief identifies as what service code actually calls); if a
    // method is ALSO independently declared on a different reachable interface (e.g. re-declared
    // with @Override), record every declaring file for transparency but grade against the fact
    // once.
    const visited = new Set<string>();
    const bySignature = new Map<
      string,
      { info: MethodInfo; files: string[] }
    >();
    const queue: string[] = [
      iface.name,
      ...plainSupertypeNames(iface.extendsRaw),
    ];
    while (queue.length) {
      const name = queue.shift()!;
      if (visited.has(name)) continue;
      visited.add(name);
      const supIface = byName.get(name);
      if (!supIface) continue; // not a project interface (e.g. Repository<Owner,Integer> base or unresolved import)
      for (const m of supIface.methods) {
        const sig = `${m.name}/${m.paramCount}`;
        const existing = bySignature.get(sig);
        if (existing) {
          existing.files.push(supIface.file);
          continue;
        }
        bySignature.set(sig, { info: m, files: [supIface.file] });
      }
      for (const next of plainSupertypeNames(supIface.extendsRaw))
        queue.push(next);
    }

    for (const { info, files } of bySignature.values()) {
      repositoryQueries.push({
        repo,
        entitySimpleName: iface.resolvedEntity.entity,
        ownerInterface: iface.name,
        declaredIn: files,
        methodName: info.name,
        paramCount: info.paramCount,
        isDerived: info.isDerived,
        hasQuery: info.hasQuery,
        startLine: info.startLine,
      });
    }
  }

  return { persistsEntity, repositoryQueries };
}

function listJavaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listJavaFiles(path);
    return entry.isFile() && entry.name.endsWith(".java") ? [path] : [];
  });
}

export function extractOracleJpaSpringData(
  repoRoot: string,
  repoId: string,
  scopeDir = "src/main/java",
): OracleResult {
  const dir = join(repoRoot, scopeDir);
  const files = listJavaFiles(dir);

  const entityRelations: EntityRelationEntry[] = [];
  const allIfaces: IfaceInfo[] = [];

  for (const absPath of files) {
    const relPath = absPath.slice(repoRoot.length + 1);
    const raw = readFileSync(absPath, "utf8");
    const source = stripComments(raw);
    entityRelations.push(...scanEntityRelations(source, relPath, repoId));
    allIfaces.push(...scanRepositoryInterfaces(source, relPath));
  }

  const { persistsEntity, repositoryQueries } = buildRepositoryFacts(
    repoId,
    allIfaces,
  );

  return { entityRelations, persistsEntity, repositoryQueries };
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
    const result = extractOracleJpaSpringData(join(root, repo.source), repo.id);
    const outFile = join(outDir, `java-enterprise-jpa-oracle.${repo.id}.json`);
    writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
    console.log(
      `${repo.id}: ${result.entityRelations.length} entity relations, ${result.persistsEntity.length} repository interfaces, ${result.repositoryQueries.length} repository-query facts -> ${outFile}`,
    );
  }
}
