import { registerLanguage, type LanguageAdapter } from "../adapter.js";
import { LANGUAGE_ID, parseGo } from "./parse.js";

export const goAdapter: LanguageAdapter = {
  id: LANGUAGE_ID,
  label: "Go",
  extensions: [".go"],
  ignoredDirectories: ["vendor"],
  parse: parseGo,
  resolveCalls: () => {}, // Phase 3 concern; no calls are produced yet.
};

registerLanguage(goAdapter);

export { LANGUAGE_ID as GO_LANGUAGE_ID };
