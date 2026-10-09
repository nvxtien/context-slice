import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const dataRoot = process.env.CLAUDE_PLUGIN_DATA;

if (!dataRoot) process.exit(0);

const sessionId = String(input.session_id ?? "default").replace(
  /[^a-zA-Z0-9._-]/g,
  "_",
);
const stateDir = join(dataRoot, "guard-state");
const statePath = join(stateDir, `${sessionId}.json`);

function save(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
}

function load() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { previewed: false };
  }
}

const event = input.hook_event_name;
const toolName = String(input.tool_name ?? "");

if (event === "UserPromptSubmit") {
  save({ previewed: false });
  process.exit(0);
}

if (event === "PostToolUse" || event === "PostToolUseFailure") {
  if (/context.?preview/i.test(toolName)) {
    const result = JSON.stringify(input.tool_result ?? "");
    const failed =
      /"(?:isError|is_error)"\s*:\s*true|transport closed|tool call error|failed to (?:call|connect)/i.test(
        result,
      );
    save({
      previewed: !failed,
      fallback: failed,
    });
  }
  process.exit(0);
}

if (event !== "PreToolUse") process.exit(0);

const toolInput = input.tool_input ?? {};
const raw = JSON.stringify(toolInput);
const supportedSource = /\.(?:java|ts|tsx|js|mjs|cjs|py|rs|go)(?:["'\s]|$)/i;
const readCommand = /\b(?:cat|head|tail|sed|awk|grep|rg|find)\b/i;
const readsSupportedSource =
  (toolName === "Read" && supportedSource.test(raw)) ||
  (toolName === "Grep" && supportedSource.test(raw)) ||
  (toolName === "Bash" && readCommand.test(raw) && supportedSource.test(raw));

const state = load();
if (!readsSupportedSource || state.previewed || state.fallback) process.exit(0);

process.stderr.write(
  "Blocked source read: call the context-slice context.preview tool first, then retry.\n",
);
process.exit(2);
