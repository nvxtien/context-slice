export type SymbolKind = "class" | "interface" | "enum" | "record" | "method" | "constructor" | "field";
export type CallConfidence = "exact" | "probable" | "unresolved";
export type ResolutionKind = "same-type" | "explicit-receiver" | "static" | "constructor" | "inherited" | "interface" | "method-reference" | "lambda" | "framework-declared" | "unresolved";
export interface SourceRange { startLine: number; startColumn: number; endLine: number; endColumn: number; }
export interface SymbolRecord { id: string; language: "java"; kind: SymbolKind; name: string; packageName?: string; qualifiedName?: string; canonicalIdentity?: string; signature?: string; filePath: string; range: SourceRange; bodyRange?: SourceRange; parentId?: string; supertypes?: string[]; annotations: string[]; modifiers: string[]; source: string; body?: string; }
export interface CallEdge { callerId: string; receiverText?: string; calleeName: string; argumentCount?: number; declaredTargetId?: string; resolvedTargetId?: string; runtimeTargetIds?: string[]; filePath: string; range: SourceRange; confidence: CallConfidence; resolutionKind: ResolutionKind; evidence: string[]; }
export interface IndexedFile { filePath: string; hash: string; parseError: boolean; }
