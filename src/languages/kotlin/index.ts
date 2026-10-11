import { registerLanguage, type LanguageAdapter } from "../adapter.js";
import { LANGUAGE_ID, parseKotlin } from "./parse.js";
import { resolveKotlinCalls } from "./resolve.js";

export const kotlinAdapter: LanguageAdapter = {
  id: LANGUAGE_ID,
  label: "Kotlin",
  extensions: [".kt", ".kts"],
  ignoredDirectories: ["build", ".gradle"],
  parse: parseKotlin,
  resolveCalls: resolveKotlinCalls,
};

registerLanguage(kotlinAdapter);

export { LANGUAGE_ID as KOTLIN_LANGUAGE_ID };
