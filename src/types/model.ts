/** Open language identifier: adding a language must not require core changes. */
export type LanguageId = string;
export type SymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "method"
  | "constructor"
  | "field"
  | "function"
  | "type"
  | "namespace"
  | "variable"
  | "getter"
  | "setter"
  | "property";
export type CallConfidence = "exact" | "probable" | "unresolved";
export type ResolutionKind =
  | "same-type"
  | "explicit-receiver"
  | "static"
  | "constructor"
  | "inherited"
  | "interface"
  | "method-reference"
  | "lambda"
  | "framework-declared"
  | "same-file"
  | "imported"
  | "aliased-import"
  | "namespace-import"
  | "default-import"
  | "declared-type"
  | "this-member"
  | "external-package"
  | "jsx-reference"
  | "unresolved";
export interface SourceRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
/** Optional, language-specific facts that must not change core behavior. */
export interface SymbolMetadata {
  /** "default" or "named" when the symbol is exported. */
  exported?: "default" | "named";
  /** TypeScript overload signature rather than the implementation. */
  overloadSignature?: boolean;
  /** Declared in a .d.ts file: an API surface, not executable source. */
  declarationOnly?: boolean;
  /** Structurally looks like a React component. Never required for correctness. */
  reactComponent?: boolean;
  /** Declared type of a function-valued variable's receiver, when syntactic. */
  declaredType?: string;
  async?: boolean;
  /** Synthetic owner for a file's top-level statements. */
  moduleScope?: boolean;
  /** Python `@classmethod` / `@staticmethod`. */
  classMethod?: boolean;
  staticMethod?: boolean;
  /** Rust impl block: base name of the Self type (generics, `&`, `dyn`, path prefix stripped). */
  implSelfType?: string;
  /** Rust impl block: base name of the implemented trait. */
  implTrait?: string;
  /** Rust struct: field name (tuple index as string) -> type text; fn: parameter name -> type text, plus `self` -> "&self" | "&mut self" | "self". */
  declaredTypes?: Record<string, string>;
  /** Go: this field has no explicit name — it IS the embedded type, not a coincidentally same-named one. */
  embedded?: boolean;
  /** Go: an interface's own declared method names (excludes embedded interfaces' names). */
  interfaceMethods?: string[];
  /** Go: interfaceMethods' name -> normalized "(types)result" signature, for exact-signature interface satisfaction. */
  interfaceMethodSignatures?: Record<string, string>;
  /** Go: a method's own normalized "(types)result" signature, compared against interfaceMethodSignatures. */
  methodSignature?: string;
  /** Go: a function's declared return type (bare, pointer-stripped; first value of a multi-return) — used to resolve "x := NewFoo()" to its real constructed type instead of guessing from the function's name. */
  returnType?: string;
}
export interface SymbolRecord {
  id: string;
  language: LanguageId;
  kind: SymbolKind;
  name: string;
  packageName?: string;
  qualifiedName?: string;
  canonicalIdentity?: string;
  signature?: string;
  filePath: string;
  range: SourceRange;
  bodyRange?: SourceRange;
  parentId?: string;
  supertypes?: string[];
  annotations: string[];
  modifiers: string[];
  metadata?: SymbolMetadata;
  source: string;
  body?: string;
}
export type ImportKind = "named" | "default" | "namespace" | "side-effect";
/** One imported binding: `import { a as b } from "./m"` is one record. */
export interface ImportRecord {
  filePath: string;
  language: LanguageId;
  /** Module specifier exactly as written. */
  module: string;
  /** Exported name in the target module; "default" for default imports. */
  importedName?: string;
  /** Name bound in this file. */
  localName?: string;
  kind: ImportKind;
  typeOnly: boolean;
  /** Repository-relative path of the resolved module, when deterministic. */
  resolvedFile?: string;
  /** External package name when the module is not repository source. */
  externalPackage?: string;
  /** Stylesheet, image or other non-source import: never a call target. */
  asset?: boolean;
  /** `use foo::*` — every name from the target module, not one binding. */
  wildcard?: boolean;
  range: SourceRange;
}
export interface ExportRecord {
  filePath: string;
  language: LanguageId;
  /** Name seen by importers; "default" for default exports. */
  exportedName: string;
  /** Local symbol backing the export, when declared in this file. */
  localName?: string;
  symbolId?: string;
  /** Re-export source module, as written. */
  fromModule?: string;
  /** Name in the source module for a re-export. */
  sourceName?: string;
  /** `export * from "./m"`. */
  wildcard?: boolean;
  typeOnly: boolean;
  resolvedFile?: string;
  range: SourceRange;
}
export interface CallEdge {
  callerId: string;
  receiverText?: string;
  /** Syntactically declared type of the receiver, when the source states it. */
  receiverType?: string;
  calleeName: string;
  argumentCount?: number;
  declaredTargetId?: string;
  resolvedTargetId?: string;
  runtimeTargetIds?: string[];
  /** Package name when the call leaves repository source. */
  externalPackage?: string;
  optionalChaining?: boolean;
  filePath: string;
  language?: LanguageId;
  range: SourceRange;
  confidence: CallConfidence;
  resolutionKind: ResolutionKind;
  evidence: string[];
}
export interface IndexedFile {
  filePath: string;
  hash: string;
  language: LanguageId;
  parseError: boolean;
}
