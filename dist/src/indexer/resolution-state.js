export function resetCallResolution(call) {
    call.declaredTargetId = undefined;
    call.resolvedTargetId = undefined;
    call.confidence = "unresolved";
}
