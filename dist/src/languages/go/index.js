import { registerLanguage } from "../adapter.js";
import { LANGUAGE_ID, parseGo } from "./parse.js";
import { resolveGoCalls } from "./resolve.js";
export const goAdapter = {
    id: LANGUAGE_ID,
    label: "Go",
    extensions: [".go"],
    ignoredDirectories: ["vendor"],
    parse: parseGo,
    resolveCalls: (context) => {
        resolveGoCalls(context);
    },
};
registerLanguage(goAdapter);
export { LANGUAGE_ID as GO_LANGUAGE_ID };
