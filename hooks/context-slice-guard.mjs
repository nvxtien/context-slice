import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const dataRoot = process.env.CLAUDE_PLUGIN_DATA;

if (!dataRoot) process.exit(0);

const sessionId = String(input.session_id ?? "default").replace(
  /[^a-zA-Z0-9._-]/g,
  "_",
);
const stateDir = join(dataRoot, "guard-state");
const statePath = join(stateDir, `${sessionId}.json`);
const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const stateTtlMs = 30 * 60 * 1000;
const canonicalPath = (value) => {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
};
const canonicalProjectRoot = projectRoot ? canonicalPath(projectRoot) : null;

function save(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: Date.now() }));
}

function load() {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (!state.updatedAt || Date.now() - state.updatedAt > stateTtlMs) {
      return { ...state, previewed: false, fallback: false };
    }
    return state;
  } catch {
    return { previewed: false };
  }
}

function cleanupExpiredStates() {
  let entries;
  try {
    entries = readdirSync(stateDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(stateDir, entry.name);
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (!state.updatedAt || Date.now() - state.updatedAt > stateTtlMs)
        unlinkSync(path);
    } catch {
      unlinkSync(path);
    }
  }
}

function findPreviewRoot(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.repositoryRoot === "string") return value.repositoryRoot;
  if (typeof value.repository_root === "string") return value.repository_root;
  if (typeof value.root === "string") return value.root;
  for (const child of Object.values(value)) {
    const found = findPreviewRoot(child);
    if (found) return found;
  }
  return null;
}

function previewRoot(result) {
  const candidates = [result];
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (typeof item?.text !== "string") continue;
      try {
        candidates.push(JSON.parse(item.text));
      } catch {
        // Non-JSON MCP text has no machine-checkable root.
      }
    }
  }
  for (const candidate of candidates) {
    const found = findPreviewRoot(candidate);
    if (found) return found;
  }
  return null;
}

const event = input.hook_event_name;
const toolName = String(input.tool_name ?? "");

if (event === "UserPromptSubmit") {
  cleanupExpiredStates();
  const prompt = String(input.user_prompt ?? "");
  const codeTask =
    /\b(?:explain|trace|debug|fix|implement|review|refactor|flow|caller|callee|source|code|class|method|function|repository|repo)\b|\.(?:java|ts|tsx|js|mjs|cjs|py|rs|go)\b|giải thích|luồng|mã nguồn|sửa lỗi/i.test(
      prompt,
    );
  save({
    promptId: input.prompt_id ?? sessionId,
    enabled: codeTask,
    previewed: false,
  });
  process.exit(0);
}

if (event === "PostToolUse" || event === "PostToolUseFailure") {
  if (/context.?preview/i.test(toolName)) {
    const result = JSON.stringify(input.tool_result ?? "");
    const failed =
      /"(?:isError|is_error)"\s*:\s*true|transport closed|tool call error|failed to (?:call|connect)/i.test(
        result,
      );
    const reportedRoot = previewRoot(input.tool_result);
    const rootMismatch =
      !reportedRoot ||
      (Boolean(canonicalProjectRoot) &&
        canonicalPath(reportedRoot) !== canonicalProjectRoot);
    save({
      previewed: !failed && !rootMismatch,
      fallback: failed || rootMismatch,
    });
  }
  process.exit(0);
}

if (event !== "PreToolUse") process.exit(0);

const toolInput = input.tool_input ?? {};
const raw = JSON.stringify(toolInput);
const supportedSource = /\.(?:java|ts|tsx|js|mjs|cjs|py|rs|go)$/i;
const readCommand = /\b(?:cat|head|tail|sed|awk|grep|rg)\b/i;
const sourcePath = (value) => {
  if (typeof value !== "string") return null;
  return value.trim().replace(/:\d+(?::\d+)?$/, "");
};
const isProjectSource = (value) => {
  const path = sourcePath(value);
  if (!path || !supportedSource.test(path) || !canonicalProjectRoot)
    return false;
  const absolute = isAbsolute(path) ? path : resolve(projectRoot, path);
  const outside = relative(canonicalProjectRoot, canonicalPath(absolute));
  return outside === "" || (!outside.startsWith("..") && !isAbsolute(outside));
};
const inputPath = toolInput.file_path ?? toolInput.path ?? toolInput.glob;
const readsSupportedSource =
  ((toolName === "Read" || toolName === "Grep") &&
    isProjectSource(inputPath)) ||
  (toolName === "Bash" &&
    readCommand.test(raw) &&
    !/\b(?:rg\s+--files|grep\s+-[lL])\b/i.test(raw) &&
    /\.(?:java|ts|tsx|js|mjs|cjs|py|rs|go)(?:["'\s]|$)/i.test(raw));

const state = load();
if (
  !readsSupportedSource ||
  state.promptId !== (input.prompt_id ?? sessionId) ||
  !state.enabled ||
  state.previewed ||
  state.fallback
) {
  process.exit(0);
}

process.stderr.write(
  "Blocked source read: call the context-slice context.preview tool first, then retry.\n",
);
process.exit(2);
