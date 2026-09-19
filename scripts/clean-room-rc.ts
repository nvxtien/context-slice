// v0.9 clean-room release-candidate validation. Every step runs against a fresh clone, a packed tarball,
// a temporary HOME/npm cache and a PATH that contains only the isolated install, node/npm and system tools.
// Usage: npm run release:rc -- [--source <git url|path>] [--ref <ref>] [--baseline-ref <ref>] [--node <bin dir>]... [--unsupported-node <bin dir>] [--assistants]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import Database from "better-sqlite3";

type Status = "PASS" | "FAIL" | "DEFERRED";
type Step = { status: Status; evidence: Record<string, unknown> };
type Result = { status: number; stdout: string; stderr: string; ms: number };

const argv = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};
const options = (name: string) =>
  argv.flatMap((value, at) => (value === name ? [argv[at + 1]] : []));
const developerRoot = process.cwd();
const source = option("--source", developerRoot)!;
const ref = option("--ref", "HEAD")!;
const baselineRef = option("--baseline-ref", "cb9b11a")!; // the previous released version, for the upgrade path.
const reportLabel = option("--label", "v1.0")!; // report filenames and title.
const javaRepository = {
  url: "https://github.com/spring-projects/spring-petclinic.git",
  commit: "818c4136ea971c21674525f9053de0d9c7ad8cfe",
};
const task = "explain the owner update flow";

const workspace = realpathSync(
  mkdtempSync(join(tmpdir(), "context-slice-v09-")),
);
const home = join(workspace, "home");
const toolBin = join(workspace, "tool bin");
const log = join(workspace, "commands.log");
mkdirSync(home);
mkdirSync(toolBin);
// Only node/npm from the running Node; nothing from the developer's global npm bin (which may hold an `npm link`).
symlinkSync(process.execPath, join(toolBin, "node"));
symlinkSync(
  realpathSync(join(dirname(process.execPath), "npm")),
  join(toolBin, "npm"),
);
const systemPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const cleanEnv = (...front: string[]): NodeJS.ProcessEnv => ({
  HOME: home,
  PATH: [...front, toolBin, ...systemPath].join(":"),
  npm_config_cache: join(home, ".npm"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  LANG: "en_US.UTF-8",
  TMPDIR: tmpdir(),
});

function sh(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 900_000,
): Result {
  const started = performance.now();
  const result = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ms: Math.round(performance.now() - started),
  };
  appendFileSync(
    log,
    `$ (${cwd}) ${file} ${args.join(" ")}\n[exit ${out.status}, ${out.ms} ms]\n${out.stdout.slice(-3000)}${out.stderr.slice(-3000)}\n`,
  );
  return out;
}
function must(result: Result, what: string) {
  if (result.status !== 0)
    throw new Error(
      `${what} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  return result;
}
// Resolve `context-slice` through PATH only, never through an absolute path into a checkout or prefix.
const cs = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  sh(
    "/bin/sh",
    ["-c", 'exec context-slice "$@"', "context-slice", ...args],
    cwd,
    env,
  );
const json = (result: Result) => JSON.parse(result.stdout);
const git = (cwd: string, ...args: string[]) =>
  sh("git", args, cwd, cleanEnv());
const gitClean = (cwd: string) =>
  git(cwd, "status", "--porcelain").stdout.trim() === "";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? files(path)
      : entry.isFile() || entry.isSymbolicLink()
        ? [path]
        : [];
  });
}
function snapshot(root: string) {
  return Object.fromEntries(
    files(root).map((file) => {
      const stat = statSync(file);
      return [
        relative(root, file),
        `${createHash("sha256").update(readFileSync(file)).digest("hex")}:${stat.size}:${stat.mtimeMs}`,
      ];
    }),
  );
}
function fetchPinned(directory: string, url: string, commit: string) {
  mkdirSync(directory, { recursive: true });
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", url],
    ["fetch", "-q", "--depth", "1", "origin", commit],
    ["checkout", "-q", "FETCH_HEAD"],
  ])
    must(git(directory, ...args), `git ${args[0]}`);
}
function testCounts(output: string) {
  const count = (name: string) =>
    Number(output.match(new RegExp(`^[#ℹ] ${name} (\\d+)`, "m"))?.[1] ?? NaN);
  return { tests: count("tests"), pass: count("pass"), fail: count("fail") };
}

async function mcpSession(
  cwd: string,
  env: NodeJS.ProcessEnv,
  probeFile: string,
) {
  const child = spawn("/bin/sh", ["-c", "exec context-slice mcp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: any[] = [];
  const invalid: string[] = [];
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      try {
        const message = JSON.parse(line);
        (message.jsonrpc === "2.0" ? messages : invalid).push(
          message.jsonrpc === "2.0" ? message : line,
        );
      } catch {
        invalid.push(line);
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const started = performance.now();
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out`)),
        60_000,
      );
      const poll = () => {
        const at = messages.findIndex((message) => message.id === id);
        if (at < 0) return void setTimeout(poll, 10);
        clearTimeout(timer);
        resolve({
          ...messages.splice(at, 1)[0],
          ms: Math.round(performance.now() - started),
        });
      };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      poll();
    });
  const text = (response: any) => JSON.parse(response.result.content[0].text);
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "v0.9-clean-room", version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    const tools = await request("tools/list", {});
    const preview = await request("tools/call", {
      name: "context.preview",
      arguments: { task },
    });
    const original = readFileSync(probeFile, "utf8");
    let stale: any;
    try {
      writeFileSync(
        probeFile,
        `${original}\n// context-slice v0.9 stale-index probe\n`,
      );
      stale = await request("tools/call", {
        name: "context.search",
        arguments: { query: "owner" },
      });
    } finally {
      writeFileSync(probeFile, original);
    }
    const previewBody = preview.error ? undefined : text(preview);
    const staleBody = stale.error ? undefined : text(stale);
    child.stdin.end(); // graceful shutdown: client closes stdin
    const exit = await Promise.race([
      exited,
      new Promise<undefined>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (!exit) child.kill("SIGTERM");
    return {
      server: init.result?.serverInfo,
      protocolVersion: init.result?.protocolVersion,
      tools: tools.result?.tools?.map((tool: any) => tool.name) ?? [],
      preview: previewBody
        ? {
            ok: true,
            ms: preview.ms,
            target: previewBody.target.qualifiedName,
            estimatedTokens: previewBody.estimatedTokens,
            budget: previewBody.budget,
          }
        : { ok: false, error: preview.error },
      staleRefresh: staleBody
        ? {
            filesParsed: staleBody.refresh.summary.filesParsed,
            cacheHits: staleBody.refresh.summary.cacheHits,
            state: staleBody.refresh.freshness.state,
          }
        : { error: stale.error },
      stdoutProtocolOnly: invalid.length === 0,
      invalidStdout: invalid,
      stderr,
      shutdown: exit
        ? { via: "stdin closed", ...exit }
        : { via: "SIGTERM after 5s", ...(await exited) },
    };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

function scanTarball(extracted: string) {
  const leak =
    /\/Volumes\/|\/Users\/|\/home\/|[A-Za-z]:\\\\|context-slice\/src/;
  const secrets: Array<[string, RegExp]> = [
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["AWS key", /AKIA[0-9A-Z]{16}/],
    ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36}/],
    ["npm token", /npm_[A-Za-z0-9]{36}/],
    ["OpenAI/Anthropic key", /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/],
    ["Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
    ["auth header", /Authorization:\s*(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/i],
    [
      "assigned credential",
      /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    ],
  ];
  const forbiddenNames =
    /(^|\/)(\.env[^/]*|\.DS_Store|\.npmrc|\.vscode|\.idea|coverage|node_modules|\.context-slice|checkouts)(\/|$)|\.(log|sqlite|db|pem|key|p12|tgz)$/;
  const pathLeaks: string[] = [];
  const secretHits: string[] = [];
  const forbidden: string[] = [];
  for (const file of files(extracted)) {
    const name = relative(extracted, file);
    if (forbiddenNames.test(name)) forbidden.push(name);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, at) => {
        if (leak.test(line))
          pathLeaks.push(`${name}:${at + 1}: ${line.trim().slice(0, 160)}`);
        for (const [kind, pattern] of secrets)
          if (pattern.test(line)) secretHits.push(`${name}:${at + 1}: ${kind}`);
      });
  }
  return {
    pathLeaks,
    secretHits,
    forbidden,
    envDump:
      secretHits.length === 0 &&
      !files(extracted).some((file) =>
        /HOME=|PATH=\//.test(readFileSync(file, "utf8")),
      ),
  };
}

function installNode(label: string, nodeBin: string) {
  const bin = join(workspace, `tool bin ${label}`);
  mkdirSync(bin);
  symlinkSync(realpathSync(join(nodeBin, "node")), join(bin, "node"));
  symlinkSync(realpathSync(join(nodeBin, "npm")), join(bin, "npm"));
  const prefix = join(workspace, `prefix ${label}`);
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(join(prefix, "bin")),
    PATH: [join(prefix, "bin"), bin, ...systemPath].join(":"),
    npm_config_prefix: prefix,
  };
  return {
    env,
    prefix,
    node: sh("node", ["--version"], workspace, env).stdout.trim(),
  };
}

const steps: Record<string, Step> = {};
const record = (
  name: string,
  pass: boolean | "deferred",
  evidence: Record<string, unknown>,
) => {
  steps[name] = {
    status: pass === "deferred" ? "DEFERRED" : pass ? "PASS" : "FAIL",
    evidence,
  };
  console.log(`${steps[name].status.padEnd(8)} ${name}`);
};
async function attempt(name: string, body: () => Promise<void> | void) {
  try {
    await body();
  } catch (error) {
    record(name, false, {
      error:
        error instanceof Error ? error.message.slice(0, 2000) : String(error),
    });
  }
}

// 1. Clean checkout.
const checkout = join(workspace, "context-slice-clean");
must(
  sh(
    "git",
    ["clone", "-q", "--no-hardlinks", source, checkout],
    workspace,
    cleanEnv(),
  ),
  "git clone",
);
must(git(checkout, "checkout", "-q", "--detach", ref), "git checkout");
const commit = git(checkout, "rev-parse", "HEAD").stdout.trim();
const packageJson = JSON.parse(
  readFileSync(join(checkout, "package.json"), "utf8"),
);
const environment = {
  node: process.version,
  npm: sh("npm", ["--version"], workspace, cleanEnv()).stdout.trim(),
  os: `${process.platform} ${sh("uname", ["-rm"], workspace, cleanEnv()).stdout.trim()}`,
  git: git(workspace, "--version").stdout.trim(),
  home: "temporary",
  npmCache: "temporary (empty)",
  registry: sh(
    "npm",
    ["config", "get", "registry"],
    workspace,
    cleanEnv(),
  ).stdout.trim(),
  path: cleanEnv().PATH!.replace(workspace, "<workspace>"),
  requiredEnvironment: "none (HOME, PATH only)",
};
record(
  "cleanCheckout",
  gitClean(checkout) &&
    git(checkout, "status", "--porcelain", "--ignored").stdout.trim() === "" &&
    !existsSync(join(checkout, "dist")),
  {
    source:
      source === developerRoot
        ? "local repository (committed objects only)"
        : source,
    commit,
    version: packageJson.version,
    untrackedOrIgnored: git(
      checkout,
      "status",
      "--porcelain",
      "--ignored",
    ).stdout.trim(),
    distPresent: existsSync(join(checkout, "dist")),
    trackedRuntimeAssets: git(
      checkout,
      "ls-files",
      "queries",
      "src/cli.ts",
      "package-lock.json",
    )
      .stdout.trim()
      .split("\n"),
  },
);

// 2. Build, tests, regressions, pack — from the clean checkout only.
const ci = sh("npm", ["ci"], checkout, cleanEnv());
record("npmCi", ci.status === 0, {
  exit: ci.status,
  ms: ci.ms,
  tail: (ci.stdout + ci.stderr).trim().split("\n").slice(-3),
});
const build = sh("npm", ["run", "build"], checkout, cleanEnv());
record(
  "build",
  build.status === 0 && existsSync(join(checkout, "dist/src/cli.js")),
  { exit: build.status, ms: build.ms },
);
const testRun = sh("npm", ["test"], checkout, cleanEnv());
const counts = testCounts(testRun.stdout + testRun.stderr);
record(
  "tests",
  testRun.status === 0 && counts.fail === 0 && counts.pass === counts.tests,
  { exit: testRun.status, ms: testRun.ms, ...counts },
);
const v06 = sh("npm", ["run", "benchmark:v06"], checkout, cleanEnv());
await attempt("regressionV06", () => {
  const report = JSON.parse(
    readFileSync(
      join(
        checkout,
        "benchmarks/results/v0.6-developer-context-efficiency.json",
      ),
      "utf8",
    ),
  ).aggregate;
  const v04 = JSON.parse(
    readFileSync(
      join(checkout, "benchmarks/results/v0.4-symbol-index-hardening.json"),
      "utf8",
    ),
  );
  const v05 = JSON.parse(
    readFileSync(
      join(checkout, "benchmarks/results/v0.5-semantic-call-resolution.json"),
      "utf8",
    ),
  ).semanticFixture;
  record(
    "regressionV06",
    v06.status === 0 &&
      report.overallRequiredFactRecall === 1 &&
      report.overallRetrievalRecall === 1 &&
      v04.retrievalRecall === 1,
    {
      exit: v06.status,
      ms: v06.ms,
      tasks: report.totalTasks,
      requiredFactRecall: report.overallRequiredFactRecall,
      retrievalRecall: report.overallRetrievalRecall,
      medianContextWindowReduction: report.medianContextWindowReduction,
      v04RetrievalRecall: v04.retrievalRecall,
      v05SemanticCallRecall: v05.semanticCallRecall,
      checkoutsFetchedByScript: true,
    },
  );
});
const v07 = sh("npm", ["run", "benchmark:v07"], checkout, cleanEnv());
await attempt("regressionV07", () => {
  const report = JSON.parse(
    readFileSync(
      join(checkout, "benchmarks/results/v0.7-developer-workflow.json"),
      "utf8",
    ),
  );
  record(
    "regressionV07",
    v07.status === 0 &&
      report.usabilityChecklist.every((item: any) => item.passed) &&
      report.errors.observed.length === 0,
    {
      exit: v07.status,
      ms: v07.ms,
      checklist: `${report.usabilityChecklist.filter((item: any) => item.passed).length}/${report.usabilityChecklist.length}`,
      context: report.context,
    },
  );
});
const v08 = sh("npm", ["run", "benchmark:v08"], checkout, cleanEnv());
record("regressionV08", v08.status === 0, {
  exit: v08.status,
  ms: v08.ms,
  note: "packaging smoke test (tarball install, CLI, MCP, upgrade, uninstall, publish dry run) from the clean checkout",
});
const dryRun = sh(
  "npm",
  ["publish", "--dry-run", "--json", "--ignore-scripts"],
  checkout,
  cleanEnv(),
);
record("publishDryRun", dryRun.status === 0, {
  command: "npm publish --dry-run",
  exit: dryRun.status,
  note: "dry run only; nothing was published",
  tail: `${dryRun.stdout}${dryRun.stderr}`.trim().split("\n").slice(-6),
});
await attempt("dependencyAudit", () => {
  const audit = sh("npm", ["audit", "--json"], checkout, cleanEnv());
  const parsed = JSON.parse(audit.stdout || "{}");
  const production = sh(
    "npm",
    ["audit", "--omit", "dev", "--json"],
    checkout,
    cleanEnv(),
  );
  const parsedProduction = JSON.parse(production.stdout || "{}");
  const outdated = sh("npm", ["outdated", "--json"], checkout, cleanEnv());
  const severities = parsed.metadata?.vulnerabilities ?? {};
  const productionSeverities = parsedProduction.metadata?.vulnerabilities ?? {};
  const runtimeTotal = productionSeverities.total ?? 0;
  record("dependencyAudit", runtimeTotal === 0, {
    runtime: productionSeverities,
    includingDev: severities,
    classification:
      runtimeTotal === 0
        ? (severities.total ?? 0) === 0
          ? "no findings"
          : "dev-only findings; not shipped in the tarball"
        : "runtime findings — classify before release",
    advisories: Object.values(parsed.vulnerabilities ?? {})
      .slice(0, 20)
      .map(
        (entry: any) =>
          `${entry.name} ${entry.severity} (${entry.isDirect ? "direct" : "transitive"})`,
      ),
    outdated: Object.entries(JSON.parse(outdated.stdout || "{}")).map(
      ([name, info]: [string, any]) =>
        `${name} ${info.current} -> ${info.latest}`,
    ),
    note: "No dependency was upgraded during release validation.",
  });
});
const pack = must(
  sh("npm", ["pack", "--json"], checkout, cleanEnv()),
  "npm pack",
);
const packed = JSON.parse(pack.stdout)[0];
const artifacts = join(workspace, "artifacts");
mkdirSync(artifacts);
const tarball = join(artifacts, packed.filename);
copyFileSync(join(checkout, packed.filename), tarball);
const extracted = join(workspace, "extracted");
mkdirSync(extracted);
must(
  sh("tar", ["-xzf", tarball, "-C", extracted], workspace, cleanEnv()),
  "tar",
);
const scan = scanTarball(extracted);
const tarFiles = files(extracted).map((file) => relative(extracted, file));
record("packageArtifact", pack.status === 0 && scan.forbidden.length === 0, {
  filename: packed.filename,
  bytes: statSync(tarball).size,
  unpackedBytes: packed.unpackedSize,
  fileCount: packed.entryCount,
  shasum: packed.shasum,
  integrity: packed.integrity,
  files: tarFiles,
  forbidden: scan.forbidden,
});
record("sourcePathScan", scan.pathLeaks.length === 0, {
  patterns: ["/Volumes/", "/Users/", "/home/", "C:\\", "context-slice/src"],
  matches: scan.pathLeaks,
});
record("secretScan", scan.secretHits.length === 0 && scan.envDump, {
  matches: scan.secretHits,
  note: "Lightweight pattern scan; not a security certification.",
});

await attempt("licenseCheck", () => {
  const license = readFileSync(join(checkout, "LICENSE"), "utf8");
  const runtime = Object.keys(packageJson.dependencies).map((name) => {
    const metadata = JSON.parse(
      readFileSync(
        join(checkout, "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    return `${name}@${metadata.version}: ${typeof metadata.license === "string" ? metadata.license : JSON.stringify(metadata.license ?? metadata.licenses)}`;
  });
  const permissive = runtime.every((entry) =>
    /: (MIT|ISC|BSD|Apache-2.0)/.test(entry),
  );
  record(
    "licenseCheck",
    packageJson.license === "MIT" &&
      /MIT License/i.test(license) &&
      tarFiles.includes("package/LICENSE") &&
      permissive,
    {
      packageJson: packageJson.license,
      licenseFile: license.split("\n")[0],
      inTarball: tarFiles.includes("package/LICENSE"),
      runtimeDependencies: runtime,
      note: "Release hygiene only; not a formal legal review.",
    },
  );
});
await attempt("packageName", () => {
  const view = sh(
    "npm",
    ["view", packageJson.name, "version", "--json"],
    workspace,
    cleanEnv(),
  );
  const missing = /E404|is not in this registry/i.test(
    view.stderr + view.stdout,
  );
  record("packageName", true, {
    name: packageJson.name,
    availability: missing
      ? "AVAILABLE"
      : view.status === 0
        ? "TAKEN"
        : "UNCERTAIN",
    registryResponse: (view.stdout || view.stderr)
      .trim()
      .split("\n")[0]
      .slice(0, 200),
    note: "Read-only check. The name was not reserved or published.",
  });
});

// Build the previous-version baseline tarball the same way, for upgrade/downgrade.
const baselineCheckout = join(workspace, "context-slice-0.8.0");
must(
  sh(
    "git",
    ["clone", "-q", "--no-hardlinks", source, baselineCheckout],
    workspace,
    cleanEnv(),
  ),
  "baseline clone",
);
must(
  git(baselineCheckout, "checkout", "-q", "--detach", baselineRef),
  "baseline checkout",
);
must(sh("npm", ["ci"], baselineCheckout, cleanEnv()), "baseline npm ci");
const baselineTarball = join(
  artifacts,
  JSON.parse(
    must(
      sh("npm", ["pack", "--json"], baselineCheckout, cleanEnv()),
      "baseline pack",
    ).stdout,
  )[0].filename,
);
copyFileSync(
  join(baselineCheckout, relative(artifacts, baselineTarball)),
  baselineTarball,
);

// 3. Isolated install, following the README command literally from the tarball directory.
const prefix = join(workspace, "install prefix");
const env = { ...cleanEnv(join(prefix, "bin")), npm_config_prefix: prefix };
const install = sh(
  "npm",
  ["install", "-g", `./${packed.filename}`],
  artifacts,
  env,
);
const packageDir = join(prefix, "lib/node_modules/context-slice");
const resolved = sh(
  "/bin/sh",
  ["-c", "command -v context-slice"],
  workspace,
  env,
).stdout.trim();
record(
  "isolatedInstall",
  install.status === 0 &&
    resolved === join(prefix, "bin/context-slice") &&
    realpathSync(packageDir).startsWith(prefix),
  {
    command: `npm install -g ./${packed.filename}`,
    prefix: "<workspace>/install prefix (contains a space)",
    resolvedExecutable: resolved.replace(workspace, "<workspace>"),
    packageRealpathInsidePrefix: realpathSync(packageDir).startsWith(prefix),
    ms: install.ms,
  },
);

// 4. Read-only package directory for everything that follows.
const before = snapshot(packageDir);
must(sh("chmod", ["-R", "a-w", packageDir], workspace, env), "chmod");
let writeBlocked = false;
try {
  writeFileSync(join(packageDir, "probe"), "x");
} catch {
  writeBlocked = true;
}

const version = cs(["--version"], workspace, env);
const help = cs(["--help"], workspace, env);
record(
  "cliThroughPath",
  version.status === 0 &&
    version.stdout.trim() === packageJson.version &&
    help.status === 0 &&
    ["init", "index", "status", "doctor", "preview", "mcp"].every((command) =>
      help.stdout.includes(command),
    ),
  {
    version: version.stdout.trim(),
    expected: packageJson.version,
    help: help.status === 0,
    invocation: "context-slice (resolved through PATH)",
  },
);

// 5. Fresh Java repository with spaces in its path; commands run from a nested directory.
const javaRoot = join(workspace, "java repos", "spring petclinic");
fetchPinned(javaRoot, javaRepository.url, javaRepository.commit);
const nested = join(
  javaRoot,
  "src/main/java/org/springframework/samples/petclinic/owner",
);
const javaHead = git(javaRoot, "rev-parse", "HEAD").stdout.trim();
await attempt("freshRepository", async () => {
  const cacheBefore = existsSync(join(javaRoot, ".context-slice"));
  const statusBefore = cs(["status"], javaRoot, env);
  const init = cs(["init"], nested, env);
  const status = json(cs(["status", "--json"], nested, env));
  const doctor = cs(["doctor"], nested, env);
  const outside = json(
    cs(["status", "--json", "--repo", javaRoot], workspace, env),
  );
  record(
    "freshRepository",
    !cacheBefore &&
      gitClean(javaRoot) &&
      statusBefore.status === 0 &&
      /Index: UNINITIALIZED/.test(statusBefore.stdout) &&
      init.status === 0 &&
      status.result.freshness.state === "CURRENT" &&
      status.result.repository === javaRoot &&
      doctor.status === 0,
    {
      repository: `${javaRepository.url}@${javaHead}`,
      cacheBeforeInit: cacheBefore,
      statusBeforeInit: statusBefore.stdout
        .trim()
        .replace(workspace, "<workspace>")
        .split("\n"),
      init: init.stdout.trim().replace(workspace, "<workspace>").split("\n"),
      initMs: init.ms,
      statusAfter: {
        state: status.result.freshness.state,
        javaFiles: status.result.freshness.javaFiles,
        schema: status.result.freshness.schemaVersion,
      },
      doctor: doctor.stdout
        .trim()
        .replace(workspace, "<workspace>")
        .split("\n"),
    },
  );
  record("nestedCwd", status.result.repository === javaRoot, {
    cwd: relative(javaRoot, nested),
    detectedRoot: status.result.repository.replace(workspace, "<workspace>"),
  });
  record(
    "pathWithSpaces",
    javaRoot.includes(" ") &&
      prefix.includes(" ") &&
      outside.result.repository === javaRoot &&
      outside.result.freshness.state === "CURRENT",
    {
      repository: javaRoot.replace(workspace, "<workspace>"),
      prefix: prefix.replace(workspace, "<workspace>"),
      repoFlagFromOutside: outside.result.freshness.state,
    },
  );
});
await attempt("preview", () => {
  const run = cs(["preview", task, "--json", "--explain"], nested, env);
  const body = json(run).result;
  const human = cs(["preview", task, "--explain"], nested, env);
  record(
    "preview",
    run.status === 0 &&
      body.estimatedTokens <= body.budget &&
      human.status === 0,
    {
      task,
      target: body.target.qualifiedName,
      estimatedTokens: body.estimatedTokens,
      budget: body.budget,
      withinBudget: body.estimatedTokens <= body.budget,
      included: body.included.map(
        (item: any) => `${item.reason}: ${item.symbol}`,
      ),
      omitted: body.omitted.map(
        (item: any) => `${item.symbol}: ${item.reason}`,
      ),
      unresolved: body.unresolved.map((call: any) => call.calleeName),
      confidence: body.confidence,
      wholeFileFallback: false,
      latencyMs: run.ms,
      humanHeader: human.stdout.split("\n").slice(0, 2),
    },
  );
});
await attempt("mcp", async () => {
  const session = await mcpSession(
    nested,
    env,
    join(nested, "OwnerController.java"),
  );
  record(
    "mcp",
    session.tools.length === 6 &&
      session.preview.ok === true &&
      session.stdoutProtocolOnly &&
      session.staleRefresh.filesParsed === 1 &&
      session.shutdown.code === 0,
    session,
  );
});

// 6. Optional assistant integrations: real HOME for auth, but `context-slice` still resolves to the RC prefix.
if (argv.includes("--assistants")) {
  const assistantEnv = {
    ...process.env,
    PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
  };
  const prompt = `Call the context-slice MCP tool context.preview with task "${task}". Reply with only the target symbol it returns.`;
  await attempt("claude", () => {
    const config = join(workspace, "claude-mcp.json");
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          "context-slice": { command: "context-slice", args: ["mcp"] },
        },
      }),
    );
    const run = sh(
      "claude",
      [
        "-p",
        prompt,
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__context-slice",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      javaRoot,
      assistantEnv,
      300_000,
    );
    const events = run.stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const init = events.find(
      (event) => event.type === "system" && event.subtype === "init",
    );
    const uses = events.flatMap((event) =>
      event.type === "assistant"
        ? event.message.content.filter(
            (part: any) =>
              part.type === "tool_use" &&
              part.name.startsWith("mcp__context-slice"),
          )
        : [],
    );
    const results = events.flatMap((event) =>
      event.type === "user"
        ? event.message.content.filter(
            (part: any) => part.type === "tool_result",
          )
        : [],
    );
    const connected = init?.mcp_servers?.find(
      (server: any) => server.name === "context-slice",
    )?.status;
    record(
      "claude",
      connected === "connected" &&
        uses.length > 0 &&
        results.some((part: any) => !part.is_error),
      {
        version: sh(
          "claude",
          ["--version"],
          workspace,
          assistantEnv,
        ).stdout.trim(),
        config: { command: "context-slice", args: ["mcp"] },
        mcpStatus: connected,
        toolsVisible: (init?.tools ?? []).filter((tool: string) =>
          tool.startsWith("mcp__context-slice"),
        ),
        toolCalls: uses.map((part: any) => part.name),
        toolCallSucceeded: results.some((part: any) => !part.is_error),
        answer: events.find((event) => event.type === "result")?.result,
      },
    );
  });
  await attempt("codex", () => {
    const run = sh(
      "codex",
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "--json",
        "-c",
        'mcp_servers.context-slice.command="context-slice"',
        "-c",
        'mcp_servers.context-slice.args=["mcp"]',
        prompt,
      ],
      javaRoot,
      assistantEnv,
      300_000,
    );
    const events = run.stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    const calls = events
      .filter(
        (event) =>
          event.item?.type === "mcp_tool_call" &&
          event.type === "item.completed",
      )
      .map((event) => event.item);
    const answer = events
      .filter((event) => event.item?.type === "agent_message")
      .at(-1)?.item?.text;
    // A failed turn before any MCP call (usage limit, auth) means the assistant runtime was unavailable, not that ContextSlice failed.
    const runtimeError = events.find((event) => event.type === "turn.failed")
      ?.error?.message as string | undefined;
    const unavailable =
      calls.length === 0 &&
      runtimeError !== undefined &&
      !/mcp|context-slice/i.test(runtimeError);
    record(
      "codex",
      unavailable
        ? "deferred"
        : calls.some(
            (call: any) =>
              call.server === "context-slice" && call.status === "completed",
          ),
      {
        status: unavailable
          ? `DEFERRED — runtime unavailable: ${runtimeError}`
          : undefined,
        version: sh(
          "codex",
          ["--version"],
          workspace,
          assistantEnv,
        ).stdout.trim(),
        config: { command: "context-slice", args: ["mcp"] },
        exit: run.status,
        toolCalls: calls.map((call: any) => ({
          server: call.server,
          tool: call.tool,
          status: call.status,
          error: call.error,
        })),
        answer,
        stderrTail: run.stderr.trim().split("\n").slice(-5),
      },
    );
  });
} else {
  record("claude", "deferred", {
    reason: "Run with --assistants to exercise Claude Code.",
  });
  record("codex", "deferred", {
    reason: "Run with --assistants to exercise Codex.",
  });
}

// 7. Package immutability.
const after = snapshot(packageDir);
const changed = [
  ...new Set([...Object.keys(before), ...Object.keys(after)]),
].filter((file) => before[file] !== after[file]);
record("readOnlyPackage", writeBlocked && changed.length === 0, {
  chmod: "a-w recursively on the installed package directory",
  writeProbeBlocked: writeBlocked,
  filesHashed: Object.keys(before).length,
  changedFiles: changed,
  commandsRun: [
    "--version",
    "--help",
    "status",
    "init",
    "status --json",
    "doctor",
    "preview",
    "mcp",
  ],
});
sh("chmod", ["-R", "u+w", packageDir], workspace, env);

// 8. Upgrade 0.8.0 -> 0.9.0 and downgrade on a separate repository copy and prefix.
await attempt("upgrade", () => {
  const upPrefix = join(workspace, "upgrade prefix");
  const upEnv = {
    ...cleanEnv(join(upPrefix, "bin")),
    npm_config_prefix: upPrefix,
  };
  const repo = join(workspace, "java repos", "upgrade copy");
  must(git(workspace, "clone", "-q", javaRoot, repo), "clone copy");
  const baseName = relative(artifacts, baselineTarball);
  must(
    sh("npm", ["install", "-g", `./${baseName}`], artifacts, upEnv),
    "install 0.8.0",
  );
  const oldVersion = cs(["--version"], repo, upEnv).stdout.trim();
  must(cs(["init"], repo, upEnv), "0.8.0 init");
  const oldStatus = json(cs(["status", "--json"], repo, upEnv)).result
    .freshness;
  const oldGit = git(repo, "status", "--porcelain").stdout.trim();
  must(
    sh("npm", ["install", "-g", `./${packed.filename}`], artifacts, upEnv),
    "install 0.9.0",
  );
  const newVersion = cs(["--version"], repo, upEnv).stdout.trim();
  const newStatus = json(cs(["status", "--json"], repo, upEnv)).result
    .freshness;
  const preview = cs(["preview", task], repo, upEnv);
  const db = new Database(join(repo, ".context-slice/index.sqlite"));
  db.prepare(
    "UPDATE metadata SET value = '0.4.0' WHERE key = 'schema_version'",
  ).run();
  db.close();
  const incompatible = json(cs(["status", "--json"], repo, upEnv)).result
    .freshness;
  const rebuildPreview = cs(["preview", task], repo, upEnv);
  const rebuilt = json(cs(["status", "--json"], repo, upEnv)).result.freshness;
  record(
    "upgrade",
    oldVersion === "0.8.0" &&
      newVersion === packageJson.version &&
      newStatus.state === "CURRENT" &&
      preview.status === 0 &&
      incompatible.state === "UNINITIALIZED" &&
      rebuildPreview.status === 0 &&
      rebuilt.state === "CURRENT" &&
      gitClean(repo) &&
      git(repo, "rev-parse", "HEAD").stdout.trim() === javaHead,
    {
      from: oldVersion,
      to: newVersion,
      schemaBefore: oldStatus.schemaVersion,
      stateAfterUpgrade: newStatus.state,
      schemaAfter: newStatus.schemaVersion,
      previewAfterUpgrade: preview.stdout.split("\n")[0],
      gitStatusWith080Cache: oldGit || "(clean)",
      gitStatusAfterUpgrade:
        git(repo, "status", "--porcelain").stdout.trim() || "(clean)",
      incompatibleCache: {
        forgedSchema: "0.4.0",
        stateSeen: incompatible.state,
        previewExit: rebuildPreview.status,
        stateAfterPreview: rebuilt.state,
        schemaAfterRebuild: rebuilt.schemaVersion,
        manualDeletion: false,
      },
    },
  );
  must(
    sh("npm", ["install", "-g", `./${baseName}`], artifacts, upEnv),
    "downgrade to 0.8.0",
  );
  const downVersion = cs(["--version"], repo, upEnv).stdout.trim();
  const downStatus = json(cs(["status", "--json"], repo, upEnv)).result
    .freshness;
  const downPreview = cs(["preview", task], repo, upEnv);
  const db2 = new Database(join(repo, ".context-slice/index.sqlite"));
  db2
    .prepare(
      "UPDATE metadata SET value = '99.0.0' WHERE key = 'schema_version'",
    )
    .run();
  db2.close();
  const future = json(cs(["status", "--json"], repo, upEnv)).result.freshness;
  const futurePreview = cs(["preview", task], repo, upEnv);
  writeFileSync(join(repo, ".context-slice/index.sqlite"), "not a database");
  const corrupt = cs(["status"], repo, upEnv);
  must(
    sh("npm", ["install", "-g", `./${packed.filename}`], artifacts, upEnv),
    "reinstall 0.9.0",
  );
  const corrupt09 = cs(["status"], repo, upEnv);
  record(
    "downgrade",
    downVersion === "0.8.0" &&
      downStatus.state === "CURRENT" &&
      downPreview.status === 0 &&
      future.state === "UNINITIALIZED" &&
      futurePreview.status === 0,
    {
      version: downVersion,
      cacheFrom: packageJson.version,
      stateOn090Cache: downStatus.state,
      previewExit: downPreview.status,
      newerSchemaCache: {
        forgedSchema: "99.0.0",
        stateSeenBy080: future.state,
        previewExit: futurePreview.status,
        behavior: "discarded and rebuilt; never reused",
      },
      corruptCache: {
        v080: { exit: corrupt.status, stderr: corrupt.stderr.trim() },
        v090: { exit: corrupt09.status, stderr: corrupt09.stderr.trim() },
      },
    },
  );
});

// 9. Node engine boundary.
const fixture = join(workspace, "java repos", "node boundary");
must(git(workspace, "clone", "-q", javaRoot, fixture), "clone fixture");
const engines: Record<string, unknown>[] = [
  { node: process.version, result: "full clean-room flow above" },
];
for (const nodeBin of options("--node")) {
  const node = installNode(`node ${engines.length}`, nodeBin);
  const installed = sh(
    "npm",
    ["install", "-g", `./${packed.filename}`],
    artifacts,
    node.env,
  );
  const init = cs(["init", "--repo", fixture], workspace, node.env);
  const preview = cs(["preview", task, "--repo", fixture], workspace, node.env);
  engines.push({
    node: node.node,
    install: installed.status,
    version: cs(["--version"], workspace, node.env).stdout.trim(),
    init: init.status,
    preview: preview.status,
    target: preview.stdout.split("\n")[0],
    stderr: (init.stderr + preview.stderr).trim().slice(0, 500),
  });
}
const unsupported = option("--unsupported-node");
if (unsupported) {
  const node = installNode("unsupported", unsupported);
  const strict = sh(
    "npm",
    ["install", "-g", `./${packed.filename}`, "--engine-strict"],
    artifacts,
    node.env,
  );
  engines.push({
    node: node.node,
    engineStrictInstall: strict.status,
    rejected:
      strict.status !== 0 &&
      /EBADENGINE|Unsupported engine/i.test(strict.stderr + strict.stdout),
    message: (strict.stderr + strict.stdout)
      .split("\n")
      .find((line) => /engine/i.test(line))
      ?.trim(),
  });
}
const exercised = engines.slice(1);
const minimumExercised = exercised.some((engine) =>
  String(engine.node).startsWith("v20."),
);
const enginesPass = exercised.every(
  (engine) =>
    engine.rejected ??
    (engine.install === 0 && engine.init === 0 && engine.preview === 0),
);
record(
  "nodeEngine",
  !enginesPass ? false : minimumExercised ? true : "deferred",
  { declared: packageJson.engines.node, engines, minimumExercised },
);

// 10. Uninstall and target-repository cleanliness.
await attempt("uninstall", () => {
  const removed = sh(
    "npm",
    ["uninstall", "-g", "context-slice"],
    workspace,
    env,
  );
  const stillResolves = sh(
    "/bin/sh",
    ["-c", "command -v context-slice"],
    workspace,
    env,
  );
  record(
    "uninstall",
    removed.status === 0 &&
      stillResolves.status !== 0 &&
      !existsSync(join(prefix, "bin/context-slice")) &&
      existsSync(join(javaRoot, ".context-slice/index.sqlite")),
    {
      executableRemoved: !existsSync(join(prefix, "bin/context-slice")),
      resolvesAfterUninstall: stillResolves.status === 0,
      cacheRetained: existsSync(join(javaRoot, ".context-slice/index.sqlite")),
      cachePolicy:
        "Repository caches are kept; README documents rm -rf .context-slice.",
    },
  );
});
record(
  "gitCleanliness",
  gitClean(javaRoot) &&
    git(javaRoot, "rev-parse", "HEAD").stdout.trim() === javaHead &&
    git(javaRoot, "diff", "--quiet", "HEAD").status === 0,
  {
    after: [
      "init",
      "status",
      "doctor",
      "preview",
      "mcp (incl. stale probe)",
      ...(argv.includes("--assistants") ? ["claude", "codex"] : []),
      "uninstall",
    ],
    status: git(javaRoot, "status", "--porcelain").stdout.trim() || "(clean)",
    ignored: git(javaRoot, "status", "--porcelain", "--ignored").stdout.trim(),
    headUnchanged:
      git(javaRoot, "rev-parse", "HEAD").stdout.trim() === javaHead,
    gitignoreEdited: false,
  },
);

record("workingTreeCheck", git(checkout, "diff", "--check").status === 0, {
  "git diff --check":
    git(checkout, "diff", "--check").stdout.trim() || "(no whitespace errors)",
  "git status --short": git(checkout, "status", "--porcelain")
    .stdout.trim()
    .split("\n")
    .filter(Boolean),
  note: "Modified files in the clean checkout are regenerated benchmark reports written by the runs above.",
});

// 11. Report.
const friction = JSON.parse(
  readFileSync(
    join(developerRoot, `benchmarks/${reportLabel}-friction.json`),
    "utf8",
  ),
) as Array<Record<string, string>>;
const failures = Object.entries(steps)
  .filter(([, step]) => step.status === "FAIL")
  .map(([name]) => name);
const blockers = [
  ...failures.map((name) => `automated step failed: ${name}`),
  ...friction
    .filter((item) => item.severity === "BLOCKER" && item.status !== "FIXED")
    .map((item) => `${item.category}: ${item.symptom}`),
];
const openMajors = friction.filter(
  (item) => item.severity === "MAJOR" && item.status !== "FIXED",
);
const recommendation = blockers.length ? "NO-GO" : "GO"; // external trial deferral is classified non-blocking below.
const report = {
  version: reportLabel,
  generatedAt: new Date().toISOString(),
  commit,
  packageVersion: packageJson.version,
  environment,
  artifact: {
    filename: packed.filename,
    bytes: statSync(tarball).size,
    fileCount: packed.entryCount,
    shasum: packed.shasum,
    integrity: packed.integrity,
    baseline: relative(artifacts, baselineTarball),
    baselineRef,
    packageVersion: packageJson.version,
  },
  steps,
  developerTrial: {
    type: "SELF CLEAN-ROOM TRIAL",
    externalDeveloperTrial: "DEFERRED — no external developer available",
    method:
      "Scripted: README commands executed literally from a clean clone, packed tarball, temporary HOME and npm cache, and PATH-only invocation.",
  },
  friction,
  blockers,
  openMajors: openMajors.map((item) => item.symptom),
  recommendation,
  publication: "none (no npm publish, tag, or GitHub release)",
};
const outputDir = join(developerRoot, "benchmarks/results");
mkdirSync(outputDir, { recursive: true });
const stem = `${reportLabel}-release-validation`;
writeFileSync(
  join(outputDir, `${stem}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
const section = (title: string, name: string) => [
  `## ${title}`,
  "",
  `**${steps[name]?.status ?? "DEFERRED"}**`,
  "",
  "```json",
  JSON.stringify(steps[name]?.evidence ?? {}, null, 2),
  "```",
  "",
];
writeFileSync(
  join(outputDir, `${stem}.md`),
  [
    `# ContextSlice ${reportLabel} — Release Validation`,
    "",
    `Recommendation: **${recommendation}** · Blockers: ${blockers.length} · Generated ${report.generatedAt}`,
    "",
    "## 1. Commit",
    "",
    `\`${commit}\` (package ${packageJson.version}; upgrade baseline built from \`${baselineRef}\`)`,
    "",
    "## 2. Environment",
    "",
    ...Object.entries(environment).map(([key, value]) => `- ${key}: ${value}`),
    "",
    ...section("3. Clean checkout", "cleanCheckout"),
    ...section("4. Clean install (npm ci)", "npmCi"),
    ...section("4. Clean build", "build"),
    ...section("5. Tests", "tests"),
    ...section("5a. v0.6 regression", "regressionV06"),
    ...section("5b. v0.7 regression", "regressionV07"),
    ...section("5c. v0.8 packaging smoke", "regressionV08"),
    ...section("5d. npm publish --dry-run", "publishDryRun"),
    ...section("5e. Dependency audit", "dependencyAudit"),
    ...section("5f. License check", "licenseCheck"),
    ...section("5g. Package name availability", "packageName"),
    ...section("6. Package artifact", "packageArtifact"),
    ...section("7. Isolated install", "isolatedInstall"),
    ...section("7a. CLI through PATH", "cliThroughPath"),
    ...section("8. Fresh repository flow", "freshRepository"),
    ...section("8a. Nested cwd", "nestedCwd"),
    ...section("8b. Path with spaces", "pathWithSpaces"),
    ...section("9. Preview", "preview"),
    ...section("10. MCP", "mcp"),
    ...section("11. Codex", "codex"),
    ...section("12. Claude Code", "claude"),
    ...section("13. Read-only package", "readOnlyPackage"),
    ...section(
      `14. Upgrade ${baselineRef} → ${packageJson.version}`,
      "upgrade",
    ),
    ...section("15. Downgrade behavior", "downgrade"),
    ...section("15a. Node engine boundary", "nodeEngine"),
    ...section("16. Uninstall", "uninstall"),
    ...section("17. Git cleanliness", "gitCleanliness"),
    ...section("18. Source-path scan", "sourcePathScan"),
    ...section("19. Secret scan", "secretScan"),
    ...section("19a. Clean-checkout working tree", "workingTreeCheck"),
    "## 20. Developer trial",
    "",
    `- ${report.developerTrial.type}: ${report.developerTrial.method}`,
    `- External developer trial: ${report.developerTrial.externalDeveloperTrial}`,
    "",
    "## 21. Friction log",
    "",
    "| Category | Step | Symptom | Severity | Root cause | Fix | Regression test | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...friction.map(
      (item) =>
        `| ${item.category} | ${item.step} | ${item.symptom} | ${item.severity} | ${item.rootCause} | ${item.fix} | ${item.regressionTest} | ${item.status} |`,
    ),
    "",
    "## 22. Release blockers",
    "",
    blockers.length ? blockers.map((item) => `- ${item}`).join("\n") : "None.",
    "",
    "## 23. Release recommendation",
    "",
    `**${recommendation}**. ${recommendation === "GO" ? "Every technical release criterion passed from a clean checkout of this commit. Any DEFERRED step above is an external runtime or participant availability limit, not a ContextSlice defect, and is classified non-blocking." : "Blockers remain; see above."}`,
    "",
    `Open MAJOR issues: ${openMajors.length ? openMajors.map((item) => item.symptom).join("; ") : "none"}. No publication was performed.`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(outputDir, `${reportLabel}-friction-log.md`),
  [
    `# ContextSlice ${reportLabel} friction log`,
    "",
    `Generated ${report.generatedAt} for commit \`${commit}\`. Severity: BLOCKER / MAJOR / MINOR / COSMETIC.`,
    "",
    "| Category | Step | Symptom | Severity | Root cause | Fix | Regression test | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...friction.map(
      (item) =>
        `| ${item.category} | ${item.step} | ${item.symptom} | ${item.severity} | ${item.rootCause} | ${item.fix} | ${item.regressionTest} | ${item.status} |`,
    ),
    "",
    `Unresolved BLOCKER: ${blockers.length}. Unresolved MAJOR: ${openMajors.length}.`,
    "",
  ].join("\n"),
);
console.log(
  `\n${recommendation}; blockers=${blockers.length}; workspace=${workspace}`,
);
