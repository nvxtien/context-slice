// End-to-end pilot: the same Claude Code agent answers the same code questions on real repositories
// with and without ContextSlice, and a separate blind Claude call grades each answer against a
// rubric that was written before any run. See benchmarks/e2e/README.md for the method and caveats.
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type Task = {
  id: string;
  repository: string;
  language: string;
  question: string;
  rubric: string[];
};
type Condition = "baseline" | "context-slice";

const ROOT = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const REPS = Number(opt("reps", "1"));
const ONLY = opt("tasks", "").split(",").filter(Boolean);
const CONDITIONS = opt("conditions", "baseline,context-slice").split(
  ",",
) as Condition[];
const MODEL = opt("model", "sonnet");
const OUT = opt("out", "e2e-pilot");
const TASKS_FILE = opt("tasks-file", "tasks.json");
const WORK = opt("work", join(ROOT, "benchmarks/results/e2e-work"));
const MAX_USD = opt("max-usd", "3");

const tasks = (
  JSON.parse(
    readFileSync(join(ROOT, "benchmarks/e2e", TASKS_FILE), "utf8"),
  ) as Task[]
).filter((t) => !ONLY.length || ONLY.includes(t.id));

// Plugin copy (skill + hooks) for the ContextSlice condition. Its MCP server is passed separately
// with --mcp-config, because --strict-mcp-config ignores servers declared by plugins, and runs the
// locally built CLI instead of the published npm package.
const pluginDir = join(WORK, "plugin");
rmSync(pluginDir, { recursive: true, force: true });
mkdirSync(pluginDir, { recursive: true });
for (const entry of [".claude-plugin", "skills", "hooks", "plugin.json"])
  cpSync(join(ROOT, entry), join(pluginDir, entry), { recursive: true });
const SHARED = [
  "-p",
  "--model",
  MODEL,
  "--output-format",
  "stream-json",
  "--verbose",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--permission-mode",
  "dontAsk",
  "--max-budget-usd",
  MAX_USD,
  "--allowedTools",
  "Read",
  "Grep",
  "Glob",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(sed:*)",
  "Bash(wc:*)",
  "--disallowedTools",
  "Edit",
  "Write",
  "NotebookEdit",
  "Agent",
  "WebFetch",
  "WebSearch",
];

function run(
  argv: string[],
  cwd: string,
  stdin?: string,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((done) => {
    const child = spawn("claude", argv, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => done({ stdout, code }));
    child.stdin.end(stdin ?? "");
  });
}

const prompt = (task: Task) =>
  `${task.question}\n\nAnswer from the actual code in this repository (the current directory). Be concise (under 300 words) and name the files and functions involved. Do not modify anything.`;

type Measured = {
  answer: string;
  turns: number;
  costUsd: number;
  durationMs: number;
  tokens: {
    input: number;
    cacheCreation: number;
    cacheRead: number;
    output: number;
  };
  toolCalls: Record<string, number>;
  toolResultTokens: number;
  isError: boolean;
};

function parseStream(stdout: string): Measured {
  const toolCalls: Record<string, number> = {};
  let toolResultChars = 0;
  let result: any;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant")
      for (const block of event.message?.content ?? [])
        if (block.type === "tool_use")
          toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
    if (event.type === "user")
      for (const block of event.message?.content ?? [])
        if (block.type === "tool_result")
          toolResultChars +=
            typeof block.content === "string"
              ? block.content.length
              : JSON.stringify(block.content ?? "").length;
    if (event.type === "result") result = event;
  }
  const usage = result?.usage ?? {};
  return {
    answer: result?.result ?? "",
    turns: result?.num_turns ?? 0,
    costUsd: result?.total_cost_usd ?? 0,
    durationMs: result?.duration_ms ?? 0,
    tokens: {
      input: usage.input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    },
    toolCalls,
    toolResultTokens: Math.ceil(toolResultChars / 4),
    isError: Boolean(result?.is_error) || !result,
  };
}

async function judge(task: Task, answer: string) {
  const list = task.rubric.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const judgePrompt = `You are grading an answer to a code question against a rubric. Grade ONLY what the answer says; do not use outside knowledge to give credit.

Question:
${task.question}

Rubric (each item is worth 1 point; award 1 only if the answer clearly states the item, otherwise 0):
${list}

Answer to grade:
"""
${answer || "(empty answer)"}
"""

Reply with ONLY a JSON object: {"scores":[<0 or 1 per rubric item, in order>],"notes":"<one short sentence>"}`;
  const scratch = join(WORK, "judge");
  mkdirSync(scratch, { recursive: true });
  const { stdout } = await run(
    [
      "-p",
      "--model",
      MODEL,
      "--output-format",
      "json",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--tools",
      "",
    ],
    scratch,
    judgePrompt,
  );
  try {
    const outer = JSON.parse(stdout);
    const match = String(outer.result).match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match![0]) as { scores: number[]; notes: string };
    if (parsed.scores.length !== task.rubric.length) throw new Error("length");
    return { ...parsed, judgeCostUsd: outer.total_cost_usd ?? 0 };
  } catch {
    return {
      scores: task.rubric.map(() => 0),
      notes: "JUDGE_PARSE_FAILED",
      judgeCostUsd: 0,
    };
  }
}

const rows: any[] = [];
for (const task of tasks) {
  const cwd = join(ROOT, "benchmarks/checkouts", task.repository);
  for (let rep = 1; rep <= REPS; rep++) {
    for (const condition of CONDITIONS) {
      // The prompt goes through stdin: --allowedTools/--disallowedTools are variadic and would
      // swallow a positional prompt.
      const mcpConfig = join(WORK, `mcp-${task.repository}.json`);
      writeFileSync(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            "context-slice": {
              type: "stdio",
              command: "node",
              args: [join(ROOT, "dist/src/cli.js"), "mcp"],
              env: { CONTEXT_SLICE_ROOT: realpathSync(cwd) },
            },
          },
        }),
      );
      const argv =
        condition === "baseline"
          ? SHARED
          : [
              ...SHARED,
              "--plugin-dir",
              pluginDir,
              "--mcp-config",
              mcpConfig,
              "--allowedTools",
              "mcp__context-slice",
              "ToolSearch",
            ];
      const started = Date.now();
      const { stdout } = await run(argv, cwd, prompt(task));
      mkdirSync(join(WORK, "raw"), { recursive: true });
      writeFileSync(
        join(WORK, "raw", `${task.id}.${condition}.${rep}.jsonl`),
        stdout,
      );
      const m = parseStream(stdout);
      const graded = await judge(task, m.answer);
      const score = graded.scores.reduce((a, b) => a + b, 0);
      const row = {
        task: task.id,
        language: task.language,
        condition,
        rep,
        ...m,
        answer: undefined,
        score,
        maxScore: task.rubric.length,
        scores: graded.scores,
        notes: graded.notes,
        judgeCostUsd: graded.judgeCostUsd,
        wallMs: Date.now() - started,
      };
      rows.push(row);
      console.log(
        `${task.id} ${condition} #${rep}: score ${score}/${task.rubric.length} turns ${m.turns} toolTokens ${m.toolResultTokens} cost $${m.costUsd.toFixed(3)} calls ${JSON.stringify(m.toolCalls)}`,
      );
      writeFileSync(
        join(ROOT, `benchmarks/results/${OUT}.json`),
        JSON.stringify({ model: MODEL, reps: REPS, rows }, null, 2),
      );
    }
  }
}
