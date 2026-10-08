import { registerLanguage } from "../adapter.js";
import { LANGUAGE_ID, parseTypeScript } from "./parse.js";
import { resolveTypeScriptCalls, typeScriptDiagnostics } from "./resolve.js";
export const typeScriptAdapter = {
    id: LANGUAGE_ID,
    label: "TypeScript",
    // Longest-suffix matching means ".d.ts" is recognized before ".ts".
    extensions: [".ts", ".tsx", ".mts", ".cts", ".d.ts"],
    ignoredDirectories: [
        "node_modules",
        ".next",
        ".nuxt",
        ".turbo",
        ".cache",
        "coverage",
        "storybook-static",
    ],
    parse: parseTypeScript,
    resolveCalls: (context) => {
        resolveTypeScriptCalls(context);
    },
};
registerLanguage(typeScriptAdapter);
export { typeScriptDiagnostics };
export { LANGUAGE_ID as TYPESCRIPT_LANGUAGE_ID };
