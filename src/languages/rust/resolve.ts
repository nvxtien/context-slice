import type { ResolveContext } from "../adapter.js";

/**
 * Call/import/use resolution is deferred to a later phase (§11-30 of the
 * v1.5 spec). This phase indexes symbols only — every Rust CallEdge array
 * is always empty, so there is nothing to resolve yet.
 */
export function resolveRustCalls(_context: ResolveContext) {
  // Intentionally empty.
}
