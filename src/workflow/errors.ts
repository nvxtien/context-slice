export type WorkflowErrorCode = "REPOSITORY_NOT_FOUND" | "NO_SUPPORTED_SOURCE" | "INDEX_STALE" | "INDEX_CORRUPT" | "SYMBOL_NOT_FOUND" | "SYMBOL_AMBIGUOUS" | "BUDGET_TOO_SMALL" | "INVALID_ARGUMENT" | "MCP_START_FAILED";

export class WorkflowError extends Error {
  constructor(public readonly code: WorkflowErrorCode, message: string, public readonly remediation: string) {
    super(message);
    this.name = "WorkflowError";
  }
}
