import { registerLanguage } from "../adapter.js";
import { LANGUAGE_ID, parseRust } from "./parse.js";
import { resolveRustCalls } from "./resolve.js";
export const rustAdapter = {
    id: LANGUAGE_ID,
    label: "Rust",
    extensions: [".rs"],
    ignoredDirectories: ["target"],
    parse: parseRust,
    resolveCalls: resolveRustCalls,
};
registerLanguage(rustAdapter);
