import assert from "node:assert/strict";
import test from "node:test";
import { resetCallResolution } from "../src/indexer/resolution-state.js";
import type { CallEdge } from "../src/types/model.js";

test("resetCallResolution clears derived targets but preserves parse facts", () => {
  const call: CallEdge = {
    callerId: "caller",
    calleeName: "save",
    filePath: "service.java",
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
    confidence: "exact",
    resolutionKind: "same-type",
    evidence: ["receiver type"],
    declaredTargetId: "declared",
    resolvedTargetId: "resolved",
  };

  resetCallResolution(call);

  assert.equal(call.declaredTargetId, undefined);
  assert.equal(call.resolvedTargetId, undefined);
  assert.equal(call.confidence, "unresolved");
  assert.equal(call.resolutionKind, "same-type");
  assert.deepEqual(call.evidence, ["receiver type"]);
});
