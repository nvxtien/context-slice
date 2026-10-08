import { registerLanguage } from "../adapter.js";
import { JAVASCRIPT_LANGUAGE_ID, parseTypeScript, } from "../typescript/parse.js";
import { resolveTypeScriptCalls } from "../typescript/resolve.js";
// Reuses the TypeScript grammar/parser: JS syntax is a subset of TS, and parseTypeScript
// already derives the right language id and JSX-vs-plain grammar per file extension.
export const javaScriptAdapter = {
    id: JAVASCRIPT_LANGUAGE_ID,
    label: "JavaScript",
    extensions: [".jsx", ".mjs", ".cjs", ".js"],
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
registerLanguage(javaScriptAdapter);
export { JAVASCRIPT_LANGUAGE_ID };
