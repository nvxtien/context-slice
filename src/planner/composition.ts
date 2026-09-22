import type { ProjectIndex } from "../indexer/index.js";
import type { SymbolRecord } from "../types/model.js";
import { estimateTokens } from "./budget.js";

/** Why a sibling of the target was composed into the slice. */
export type CompositionReason =
  | "enclosing type"
  | "enterprise relation";

export interface CompositionCandidate {
  symbol?: SymbolRecord;
  label: string;
  reason: CompositionReason;
  evidence: string[];
  rendered: string;
  estimatedTokens: number;
  filePath: string;
}

const TYPE_KINDS = new Set([
  "class",
  "interface",
  "enum",
  "record",
  "namespace",
]);
/** A skeleton stays compact even for a large class. */
const MAX_SKELETON_MEMBERS = 12;

/** The first line of a declaration, exactly as written, without its opening brace. */
export function declarationLine(symbol: SymbolRecord) {
  return symbol.source
    .split("\n")[0]
    .trim()
    .replace(/\s*\{\s*$/, "")
    .replace(/\s*=>\s*$/, "")
    .trim();
}

/**
 * Java fields are not indexed as symbols, so read their declarations from the
 * enclosing type's source. Analysis only: nothing is added to the index, so
 * retrieval and ranking are untouched.
 */
function javaFieldDeclarations(parent: SymbolRecord) {
  if (parent.language !== "java") return [];
  return [
    ...(parent.body ?? parent.source).matchAll(
      /^\s*(?:(?:public|protected|private|static|final|transient|volatile)\s+)*[A-Za-z_$][\w$<>,.[\]\s]*?\s+[A-Za-z_$][\w$]*\s*(?:=[^;]*)?;/gm,
    ),
  ]
    .map((match) => match[0].trim())
    .filter((declaration) => !/[()]/.test(declaration));
}

/**
 * Compose a compact skeleton of the target's enclosing type: its own
 * declaration line, its field declarations and up to 12 member declaration
 * lines. Never a body, so this can never become a whole-class dump.
 */
export function composeSiblings(
  index: ProjectIndex,
  target: SymbolRecord,
  /** Symbols already in the slice: the skeleton must not repeat them. */
  alreadyIncluded: ReadonlySet<string> = new Set(),
): CompositionCandidate[] {
  const parent = target.parentId
    ? index.symbols.find((symbol) => symbol.id === target.parentId)
    : undefined;
  if (!parent || !TYPE_KINDS.has(parent.kind)) return [];
  const members = index.symbols.filter(
    (symbol) => symbol.parentId === parent.id && symbol.id !== target.id,
  );
  if (!members.length) return [];

  const remaining = members.filter((member) => !alreadyIncluded.has(member.id));
  const shown = remaining
    .sort((a, b) => a.range.startLine - b.range.startLine)
    .slice(0, MAX_SKELETON_MEMBERS);
  const lines = [
    `// Enclosing type of ${target.name}`,
    declarationLine(parent),
    ...javaFieldDeclarations(parent).map((declaration) => `  ${declaration}`),
    ...shown.map((member) => `  ${declarationLine(member)}`),
  ];
  if (remaining.length > shown.length)
    lines.push(`  // … ${remaining.length - shown.length} more members`);
  const rendered = lines.join("\n");
  return [
    {
      symbol: parent,
      label: parent.qualifiedName ?? parent.name,
      reason: "enclosing type",
      evidence: [
        `${target.name} is declared in ${parent.name}; declaration lines only, ${shown.length} of ${members.length} members${
          members.length - remaining.length > 0
            ? `, ${members.length - remaining.length} already in the slice`
            : ""
        }`,
      ],
      rendered,
      estimatedTokens: estimateTokens(rendered),
      filePath: parent.filePath,
    },
  ];
}
