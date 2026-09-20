import type { ProjectIndex } from "../indexer/index.js";
import type { SymbolRecord } from "../types/model.js";
import { estimateTokens } from "./budget.js";

/** Why a sibling of the target was composed into the slice. */
export type CompositionReason =
  | "same-type shared state"
  | "state accessor"
  | "constructor dependency"
  | "lexical shared state"
  | "enclosing type";

export interface CompositionRules {
  sharedState: boolean;
  accessors: boolean;
  constructorDependency: boolean;
  lexicalSharedState: boolean;
  enclosingType: boolean;
}

export const ALL_COMPOSITION_RULES: CompositionRules = {
  sharedState: true,
  accessors: true,
  constructorDependency: true,
  lexicalSharedState: true,
  enclosingType: true,
};

export interface CompositionCandidate {
  symbol?: SymbolRecord;
  /** Stable id for de-duplication against already included symbols. */
  key: string;
  label: string;
  reason: CompositionReason;
  score: number;
  confidence: "exact" | "probable";
  evidence: string[];
  rendered: string;
  estimatedTokens: number;
  filePath: string;
}

const MEMBER_KINDS = new Set([
  "method",
  "constructor",
  "getter",
  "setter",
  "property",
  "field",
]);
const TYPE_KINDS = new Set([
  "class",
  "interface",
  "enum",
  "record",
  "namespace",
  "type",
]);
const CALLABLE_MEMBER_KINDS = new Set([
  "method",
  "constructor",
  "getter",
  "setter",
]);
/** A skeleton stays compact even for a large class. */
const MAX_SKELETON_MEMBERS = 12;
const MAX_SIBLING_BODY_TOKENS = 400;

const bodyText = (symbol: SymbolRecord) => symbol.body ?? symbol.source;

/**
 * Java fields are not indexed as symbols, so read their declarations from the
 * enclosing type's source for shared-state analysis only. Nothing is added to
 * the index, so retrieval and ranking are untouched.
 */
function javaFieldDeclarations(parent: SymbolRecord) {
  const body = parent.body ?? parent.source;
  const fields = new Map<string, string>();
  for (const match of body.matchAll(
    /^\s*((?:(?:public|protected|private|static|final|transient|volatile)\s+)*)([A-Za-z_$][\w$<>,.\[\]\s]*?)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/gm,
  )) {
    const declaration = match[0].trim();
    const name = match[3];
    // Skip method declarations and local statements that look similar.
    if (/[()]/.test(declaration)) continue;
    fields.set(name, declaration);
  }
  return fields;
}

/** The first line of a declaration, exactly as written, without its opening brace. */
export function declarationLine(symbol: SymbolRecord) {
  const line = symbol.source.split("\n")[0].trim();
  return line
    .replace(/\s*\{\s*$/, "")
    .replace(/\s*=>\s*$/, "")
    .trim();
}

/**
 * Members of the enclosing type that a symbol reads or writes.
 * Deliberately syntactic: `this.x` in both languages, plus bare names in Java
 * that match a known member. No alias or data-flow analysis.
 */
export function memberAccesses(symbol: SymbolRecord, memberNames: Set<string>) {
  const text = bodyText(symbol);
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const match of text.matchAll(
    /this\.([A-Za-z_$][\w$]*)\s*(\+\+|--|[-+*/|&^]?=(?!=))?/g,
  )) {
    const name = match[1];
    if (!memberNames.has(name)) continue;
    if (match[2]) writes.add(name);
    else reads.add(name);
  }
  if (symbol.language === "java")
    for (const name of memberNames) {
      const assignment = new RegExp(
        `(?<![\\w$.])${name}\\s*(\\+\\+|--|[-+*/|&^]?=(?!=))`,
      );
      const reference = new RegExp(`(?<![\\w$.])${name}(?![\\w$(])`);
      if (assignment.test(text)) writes.add(name);
      else if (reference.test(text)) reads.add(name);
    }
  return { reads, writes };
}

const accessorFor = (symbol: SymbolRecord) => {
  const match = symbol.name.match(/^(?:get|set|is)([A-Z][\w$]*)$/);
  return match ? match[1][0].toLowerCase() + match[1].slice(1) : undefined;
};

function renderMember(symbol: SymbolRecord, relation: string) {
  const tokens = estimateTokens(symbol.source);
  const body =
    tokens <= MAX_SIBLING_BODY_TOKENS ? symbol.source : declarationLine(symbol);
  return `// ${relation}\n${body}`;
}

/**
 * Compose relevant siblings of the target: members of the same enclosing type
 * that share state with it, and a compact skeleton of the type itself.
 * Never the whole class: bodies come only from members with shared-state
 * evidence, and the skeleton is declaration lines only.
 */
export function composeSiblings(
  index: ProjectIndex,
  target: SymbolRecord,
  rules: CompositionRules = ALL_COMPOSITION_RULES,
  /** Symbols already in the slice: the skeleton must not repeat them. */
  alreadyIncluded: ReadonlySet<string> = new Set(),
): CompositionCandidate[] {
  const parent = target.parentId
    ? index.symbols.find((symbol) => symbol.id === target.parentId)
    : undefined;
  if (!parent) return [];
  const members = index.symbols.filter(
    (symbol) => symbol.parentId === parent.id && symbol.id !== target.id,
  );
  if (!members.length) return [];
  // A class-like parent has members; a callable parent has lexical siblings.
  const isType = TYPE_KINDS.has(parent.kind);
  const javaFields =
    parent.language === "java" && isType
      ? javaFieldDeclarations(parent)
      : new Map<string, string>();
  const memberNames = new Set([
    ...index.symbols
      .filter((symbol) => symbol.parentId === parent.id)
      .map((symbol) => symbol.name),
    ...javaFields.keys(),
  ]);
  const targetAccess = memberAccesses(target, memberNames);
  const touched = new Set([...targetAccess.reads, ...targetAccess.writes]);
  const candidates: CompositionCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: CompositionCandidate) => {
    if (seen.has(candidate.key)) return;
    seen.add(candidate.key);
    candidates.push(candidate);
  };

  if (rules.sharedState)
    for (const [name, declaration] of javaFields)
      if (touched.has(name))
        push({
          key: `${parent.id}#field:${name}`,
          label: `${parent.qualifiedName ?? parent.name}.${name}`,
          reason: "same-type shared state",
          score: 3,
          confidence: "exact",
          evidence: [
            `target ${targetAccess.writes.has(name) ? "writes" : "reads"} ${name}`,
          ],
          rendered: `// Shared state\n${declaration}`,
          estimatedTokens: estimateTokens(declaration),
          filePath: parent.filePath,
          symbol: undefined,
        });

  for (const member of members) {
    if (!MEMBER_KINDS.has(member.kind) && isType) continue;
    const access = memberAccesses(member, memberNames);
    const shared = [...touched].filter(
      (name) => access.reads.has(name) || access.writes.has(name),
    );
    // A field the target touches is itself required context.
    if (
      (member.kind === "property" || member.kind === "field") &&
      touched.has(member.name)
    ) {
      if (!rules.sharedState) continue;
      push({
        symbol: member,
        key: member.id,
        label: member.qualifiedName ?? member.name,
        reason: "same-type shared state",
        score: 3,
        confidence: "exact",
        evidence: [
          `target ${targetAccess.writes.has(member.name) ? "writes" : "reads"} ${member.name}`,
        ],
        rendered: `// Shared state\n${declarationLine(member)}`,
        estimatedTokens: estimateTokens(declarationLine(member)),
        filePath: member.filePath,
      });
      continue;
    }
    if (!shared.length) continue;
    const accessorTarget = accessorFor(member);
    const isAccessor =
      member.kind === "getter" ||
      member.kind === "setter" ||
      (accessorTarget !== undefined && touched.has(accessorTarget));
    if (isAccessor && !rules.accessors) continue;
    if (!isAccessor && !rules.sharedState) continue;
    const writesShared = shared.filter((name) => access.writes.has(name));
    const relation = isAccessor
      ? `Accessor for ${shared.join(", ")}`
      : `Shares ${shared.join(", ")} with ${target.name}`;
    push({
      symbol: member,
      key: member.id,
      label: member.qualifiedName ?? member.name,
      reason: isAccessor ? "state accessor" : "same-type shared state",
      score: 2 + shared.length + writesShared.length,
      confidence: "exact",
      evidence: [
        `${member.name} ${writesShared.length ? "writes" : "reads"} ${shared.join(", ")}, also used by ${target.name}`,
      ],
      rendered: renderMember(member, relation),
      estimatedTokens: estimateTokens(renderMember(member, relation)),
      filePath: member.filePath,
    });
  }

  // Constructor that supplies a dependency the target uses.
  if (rules.constructorDependency && isType) {
    const constructor = members.find(
      (member) => member.kind === "constructor" && member.name !== target.name,
    );
    const supplies =
      constructor &&
      [...touched].filter((name) =>
        new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(constructor.source),
      );
    if (constructor && supplies?.length)
      push({
        symbol: constructor,
        key: `${constructor.id}#dependency`,
        label: constructor.qualifiedName ?? constructor.name,
        reason: "constructor dependency",
        score: 2 + supplies.length,
        confidence: "exact",
        evidence: [`constructor supplies ${supplies.join(", ")}`],
        rendered: `// Constructor dependency\n${declarationLine(constructor)}`,
        estimatedTokens: estimateTokens(declarationLine(constructor)),
        filePath: constructor.filePath,
      });
  }

  // Nested callables sharing a captured local with the target (components, closures).
  if (rules.lexicalSharedState && !isType) {
    for (const member of members) {
      if (!CALLABLE_MEMBER_KINDS.has(member.kind) && member.kind !== "function")
        continue;
      const locals = [
        ...bodyText(parent).matchAll(
          /(?:const|let|var)\s+(?:\[\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]|([A-Za-z_$][\w$]*))/g,
        ),
      ]
        .flatMap((match) => [match[1], match[2], match[3]])
        .filter((name): name is string => Boolean(name));
      const shared = locals.filter(
        (name) =>
          name !== member.name &&
          name !== target.name &&
          new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(bodyText(target)) &&
          new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(bodyText(member)),
      );
      if (!shared.length) continue;
      const relation = `Shares local ${[...new Set(shared)].join(", ")} with ${target.name}`;
      push({
        symbol: member,
        key: member.id,
        label: member.qualifiedName ?? member.name,
        reason: "lexical shared state",
        score: 1 + new Set(shared).size,
        confidence: "probable",
        evidence: [
          `${member.name} and ${target.name} both use ${[...new Set(shared)].join(", ")} from ${parent.name}`,
        ],
        rendered: renderMember(member, relation),
        estimatedTokens: estimateTokens(renderMember(member, relation)),
        filePath: member.filePath,
      });
    }
  }

  // A compact skeleton of the enclosing type: declaration lines only.
  if (rules.enclosingType && isType) {
    const ranked = [...members]
      .filter((member) => !alreadyIncluded.has(member.id))
      .sort((a, b) => {
        const scoreOf = (symbol: SymbolRecord) =>
          (candidates.find((candidate) => candidate.symbol?.id === symbol.id)
            ?.score ?? 0) +
          (symbol.kind === "property" || symbol.kind === "field" ? 2 : 0) +
          (symbol.kind === "constructor" ? 1 : 0);
        return scoreOf(b) - scoreOf(a) || a.range.startLine - b.range.startLine;
      });
    const shown = ranked.slice(0, MAX_SKELETON_MEMBERS);
    const lines = [
      `// Enclosing type of ${target.name}`,
      declarationLine(parent),
      ...[...javaFields.values()].map((declaration) => `  ${declaration}`),
      ...shown.map((member) => `  ${declarationLine(member)}`),
    ];
    if (ranked.length > shown.length)
      lines.push(`  // … ${ranked.length - shown.length} more members`);
    const rendered = lines.join("\n");
    push({
      symbol: parent,
      key: `${parent.id}#skeleton`,
      label: parent.qualifiedName ?? parent.name,
      reason: "enclosing type",
      score: 1,
      confidence: "exact",
      evidence: [
        `${target.name} is declared in ${parent.name}; declaration lines only, ${shown.length} of ${members.length} members${
          members.length - ranked.length > 0
            ? `, ${members.length - ranked.length} already in the slice`
            : ""
        }`,
      ],
      rendered,
      estimatedTokens: estimateTokens(rendered),
      filePath: parent.filePath,
    });
  }

  return candidates.sort(
    (a, b) => b.score - a.score || a.label.localeCompare(b.label),
  );
}
