import type { CallEdge } from "../types/model.js";

export function resetCallResolution(call: CallEdge) {
  call.declaredTargetId = undefined;
  call.resolvedTargetId = undefined;
  call.confidence = "unresolved";
}
