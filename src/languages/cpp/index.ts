import { registerLanguage, type LanguageAdapter } from "../adapter.js";
import { LANGUAGE_ID, parseCpp } from "./parse.js";
import { resolveCppCalls } from "./resolve.js";

export const cppAdapter: LanguageAdapter = {
  id: LANGUAGE_ID,
  label: "C++",
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".h"],
  parse: parseCpp,
  resolveCalls: resolveCppCalls,
};

registerLanguage(cppAdapter);

export { LANGUAGE_ID as CPP_LANGUAGE_ID };
