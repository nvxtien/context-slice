import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  return {
    hook_event_name: event,
    session_id: "test-session",
    prompt_id: "prompt-1",
    cwd: "/repo",
    user_prompt: "Explain the source flow",
    ...extra,
  };
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

  run(
    root,
    base("PostToolUse", { tool_name: "mcp__context_slice__context_preview" }),
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

test("does not enable the guard for non-code prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit", { user_prompt: "Commit the changes" }));

  const allowed = run(
    root,
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/LoginService.java" },
    }),
  );
  assert.equal(allowed.status, 0);
});

test("enables the guard when the prompt names a source file", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(
    root,
    base("UserPromptSubmit", { user_prompt: "Inspect LoginService.java" }),
  );

  const blocked = run(
    root,
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/LoginService.java" },
    }),
  );
  assert.equal(blocked.status, 2);
});

test("does not treat find as a source read", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));

  const allowed = run(
    root,
    base("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "find src -name '*.java'" },
    }),
  );
  assert.equal(allowed.status, 0);
});

test("does not block source file listing commands", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));

  for (const command of [
    "rg --files -g '*.java'",
    "grep -l 'Login' src/*.java",
  ]) {
    const allowed = run(
      root,
      base("PreToolUse", { tool_name: "Bash", tool_input: { command } }),
    );
    assert.equal(allowed.status, 0);
  }
});

test("does not guard source files outside the project root", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));

  const allowed = run(
    root,
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/other-repo/src/LoginService.java" },
    }),
  );
  assert.equal(allowed.status, 0);
});

test("does not carry preview state into the next prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));
  run(
    root,
    base("PostToolUse", { tool_name: "mcp__context_slice__context_preview" }),
  );
  run(root, base("UserPromptSubmit", { prompt_id: "prompt-2" }));

  const blocked = run(
    root,
    base("PreToolUse", {
      prompt_id: "prompt-2",
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/LoginService.java" },
    }),
  );
  assert.equal(blocked.status, 2);
});

test("does not trust stale preview state", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));
  writeFileSync(
    join(root, "guard-state", "test-session.json"),
    JSON.stringify({
      promptId: "prompt-1",
      enabled: true,
      previewed: true,
      updatedAt: Date.now() - 31 * 60 * 1000,
    }),
  );

  const allowed = run(
    root,
    base("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/src/LoginService.java" },
    }),
  );
  assert.equal(allowed.status, 2);
});

test("marks a preview from a different repository as fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));
  run(
    root,
    base("PostToolUse", {
      tool_name: "mcp__context_slice__context_preview",
      tool_result: {
        content: [{ text: JSON.stringify({ repositoryRoot: "/other-repo" }) }],
      },
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
  const state = JSON.parse(
    readFileSync(join(root, "guard-state", "test-session.json"), "utf8"),
  );
  assert.equal(state.fallback, true);
});

test("does not trust a successful preview without repository root metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));
  run(
    root,
    base("PostToolUse", {
      tool_name: "mcp__context_slice__context_preview",
      tool_result: {
        content: [{ text: JSON.stringify({ rendered: "code" }) }],
      },
    }),
  );

  const state = JSON.parse(
    readFileSync(join(root, "guard-state", "test-session.json"), "utf8"),
  );
  assert.equal(state.fallback, true);
});

test("removes expired guard state files on the next prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  run(root, base("UserPromptSubmit"));
  const stalePath = join(root, "guard-state", "stale-session.json");
  writeFileSync(
    stalePath,
    JSON.stringify({ updatedAt: Date.now() - 31 * 60 * 1000 }),
  );

  run(root, base("UserPromptSubmit", { prompt_id: "prompt-2" }));
  assert.equal(existsSync(stalePath), false);
});

test("treats a symlinked project root and preview root as the same root", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  const actualRoot = mkdtempSync(join(tmpdir(), "context-slice-project-"));
  const linkedRoot = `${actualRoot}-link`;
  mkdirSync(join(actualRoot, "src"));
  writeFileSync(
    join(actualRoot, "src/LoginService.java"),
    "class LoginService {}",
  );
  symlinkSync(actualRoot, linkedRoot, "dir");
  run(dataRoot, base("UserPromptSubmit", { cwd: linkedRoot }));
  run(
    dataRoot,
    base("PostToolUse", {
      cwd: linkedRoot,
      tool_name: "mcp__context_slice__context_preview",
      tool_result: { repositoryRoot: actualRoot },
    }),
  );

  const allowed = run(
    dataRoot,
    base("PreToolUse", {
      cwd: linkedRoot,
      tool_name: "Read",
      tool_input: { file_path: join(linkedRoot, "src/LoginService.java") },
    }),
  );
  assert.equal(allowed.status, 0);
});

test("does not treat a source symlink escaping the project as project source", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "context-slice-guard-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "context-slice-project-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "context-slice-outside-"));
  mkdirSync(join(outsideRoot, "src"));
  writeFileSync(
    join(outsideRoot, "src/LoginService.java"),
    "class LoginService {}",
  );
  symlinkSync(outsideRoot, join(projectRoot, "vendor"), "dir");
  run(dataRoot, base("UserPromptSubmit", { cwd: projectRoot }));

  const allowed = run(
    dataRoot,
    base("PreToolUse", {
      cwd: projectRoot,
      tool_name: "Read",
      tool_input: {
        file_path: join(projectRoot, "vendor/src/LoginService.java"),
      },
    }),
  );
  assert.equal(allowed.status, 0);
});
