import type { SourceRange } from "./model.js";

/**
 * Generic relation kinds an enterprise extractor can emit. Exact naming may
 * evolve per family; this is the full v1.4 vocabulary (§6 of the spec).
 */
export type EnterpriseRelationKind =
  | "ROUTE_TO_HANDLER"
  | "INJECTS_DEPENDENCY"
  | "TRANSACTION_BOUNDARY"
  | "ASYNC_BOUNDARY"
  | "EVENT_HANDLER"
  | "SCHEDULED_ENTRYPOINT"
  | "PERSISTS_ENTITY"
  | "ENTITY_RELATION"
  | "REPOSITORY_QUERY"
  | "PRODUCES_MESSAGE"
  | "CONSUMES_MESSAGE"
  | "CONFIGURES_BEAN"
  | "READS_PROPERTY"
  | "TESTS_SYMBOL";

/** Which extractor family produced a relation; drives per-family benchmarking (§50, §80). */
export type EnterpriseSemanticFamily =
  | "spring-mvc"
  | "dependency-injection"
  | "transactions"
  | "async-events-scheduled"
  | "spring-data-jpa"
  | "kafka"
  | "config"
  | "test-linkage";

/** Conservative confidence levels only (§46) — never invent a fourth level. */
export type EnterpriseRelationConfidence = "exact" | "probable" | "unresolved";

/**
 * A static, framework-relevant relation extracted from Java enterprise code.
 * Kept fully separate from SymbolRecord/CallEdge so core indexing behavior
 * (§3, §4 regression gates) cannot be affected by adding relation kinds.
 */
export interface EnterpriseRelation {
  kind: EnterpriseRelationKind;
  family: EnterpriseSemanticFamily;
  /** The symbol this relation originates from (e.g. the handler method, the injected field). */
  sourceSymbolId: string;
  /** The target symbol id, when statically resolvable to a project symbol. */
  targetSymbolId?: string;
  /** A human-readable target when there is no project symbol (e.g. an HTTP route, a Kafka topic, a property key). */
  targetLabel?: string;
  confidence: EnterpriseRelationConfidence;
  /** Why this relation was extracted — surfaced verbatim in context (§45 explainability). */
  evidence: string[];
  range: SourceRange;
  filePath: string;
  /** Rough token cost if this relation's evidence were included in context; set by the planner, not the extractor. */
  estimatedContextTokens?: number;
}
