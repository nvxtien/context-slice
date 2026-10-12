import { registerLanguage, type LanguageAdapter } from "../adapter.js";
import { LANGUAGE_ID, parseC } from "./parse.js";
import { resolveCCalls } from "./resolve.js";

export const cAdapter: LanguageAdapter = {
  id: LANGUAGE_ID,
  label: "C",
  // Deliberately not ".h": that extension already belongs to the cpp adapter (C++ headers
  // also use ".h"), and the registry has no way to tell a C header from a C++ one by
  // extension alone. A plain-C header is still parsed — as C++, which is a superset — just
  // under language "cpp" instead of "c".
  extensions: [".c"],
  parse: parseC,
  resolveCalls: resolveCCalls,
};

registerLanguage(cAdapter);

export { LANGUAGE_ID as C_LANGUAGE_ID };
