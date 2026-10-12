import type { SymbolRecord } from "../../types/model.js";
import type { ResolveContext } from "../adapter.js";

/** C has no classes/namespaces, so there is no same-type/inherited/explicit-receiver cascade
 * to mirror from java.ts's resolver family — every function is at global scope, and the question
 * is whether its name is unique project-wide; when it is not, the caller's own file is tried
 * before giving up (real-world C commonly reuses a `static` helper's name across translation
 * units). A call through a struct's function-pointer field (`obj->dispatch()`) is runtime
 * dispatch, never a static reference to a real function definition, so it is deliberately left
 * unresolved rather than guessed at. */
export function resolveCCalls({
  symbols,
  calls,
  callsToResolve,
}: ResolveContext): void {
  const byName = new Map<string, SymbolRecord[]>();
  for (const symbol of symbols) {
    if (symbol.kind !== "function") continue;
    const list = byName.get(symbol.name);
    if (list) list.push(symbol);
    else byName.set(symbol.name, [symbol]);
  }

  for (const call of callsToResolve ?? calls) {
    if (call.receiverText) continue;
    const options = byName.get(call.calleeName) ?? [];
    if (options.length === 1) {
      const target = options[0];
      call.resolvedTargetId = target.id;
      call.confidence = "exact";
      call.resolutionKind = "same-file";
      call.evidence = [`unique same-file target ${target.qualifiedName}`];
    } else if (options.length > 1) {
      // `static` gives a name file-scope in real C, so two same-named candidates in different
      // files are not actually ambiguous at a call site: only the one in the caller's own file
      // is reachable there. Prefer it before giving up.
      const sameFile = options.filter(
        (option) => option.filePath === call.filePath,
      );
      if (sameFile.length === 1) {
        const target = sameFile[0];
        call.resolvedTargetId = target.id;
        call.confidence = "exact";
        call.resolutionKind = "same-file";
        call.evidence = [
          `unique same-file target ${target.qualifiedName} among ${options.length} same-named candidates`,
        ];
      } else {
        call.confidence = "unresolved";
        call.evidence = [`${options.length} plausible targets remain`];
      }
    }
  }
}
