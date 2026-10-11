import { registerLanguage, type LanguageAdapter } from "../adapter.js";
import { LANGUAGE_ID, parseCsharp } from "./parse.js";
import { resolveCsharpCalls } from "./resolve.js";

export const csharpAdapter: LanguageAdapter = {
  id: LANGUAGE_ID,
  label: "C#",
  extensions: [".cs"],
  // "bin" is deliberately not ignored here: ignoredDirectories() is a single global,
  // path-unaware name blocklist (src/indexer/index.ts checks `ignored.has(entry.name)`
  // against every directory in the tree, not just this language's own files), and "bin"
  // collides with Rust's own `src/bin/` convention for extra binary targets — ignoring it
  // would silently drop real Rust source directories from indexing.
  ignoredDirectories: ["obj"],
  parse: parseCsharp,
  resolveCalls: resolveCsharpCalls,
};

registerLanguage(csharpAdapter);

export { LANGUAGE_ID as CSHARP_LANGUAGE_ID };
