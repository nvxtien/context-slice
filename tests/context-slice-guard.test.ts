import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = join(process.cwd(), "hooks/context-slice-guard.mjs");

function run(root: string, event: Record<string, unknown>) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: root },
    input: JSON.stringify(event),
    encoding: "utf8",
  });
}

function base(event: string, extra: Record<string, unknown> = {}) {
  return { hook_event_name: event, session_id: "test-session", ...extra };
}

test("blocks source reads until context.preview completes", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));

  const blocked = run(
    root,
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/LoginService.java" },
    }),
  );
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /context-slice.*context\.preview/i);

  run(root, base("PostToolUse", { tool_name: "mcp__context_slice__context_preview" }));
  const allowed = run(
    root,
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/LoginService.java" },
    }),
  );
  assert.equal(allowed.status, 0);
});

test("does not block documentation reads or unrelated Bash", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));

  for (const event of [
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/README.md" },
    }),
    base("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git status --short" },
    }),
  ]) {
    assert.equal(run(root, event).status, 0);
  }
});

test("falls back to direct reads when preview is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));
  run(
    root,
    base("PostToolUse", {
      tool_name: "mcp__context_slice__context_preview",
      tool_result: { isError: true, content: [{ text: "Transport closed" }] },
    }),
  );

  const allowed = run(
    root,
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/LoginService.java" },
    }),
  );
  assert.equal(allowed.status, 0);
});
