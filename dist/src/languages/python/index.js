import { registerLanguage } from "../adapter.js";
import { LANGUAGE_ID, parsePython } from "./parse.js";
import { pythonDiagnostics, resolvePythonCalls } from "./resolve.js";
export const pythonAdapter = {
    id: LANGUAGE_ID,
    label: "Python",
    extensions: [".py", ".pyi"],
    ignoredDirectories: [
        "__pycache__",
        ".venv",
        "venv",
        "env",
        "site-packages",
        ".pytest_cache",
        ".mypy_cache",
        ".pyright",
        ".ruff_cache",
        ".tox",
        ".nox",
        ".eggs",
    ],
    parse: parsePython,
    resolveCalls: (context) => {
        resolvePythonCalls(context);
    },
};
registerLanguage(pythonAdapter);
export { pythonDiagnostics };
export { LANGUAGE_ID as PYTHON_LANGUAGE_ID };
