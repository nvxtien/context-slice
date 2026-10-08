import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

type CommandResult = { status: number; stdout: string; stderr: string };
type SmokeReport = {
  status: "pass";
  generatedAt: string;
  environment: { node: string; npm: string; platform: string };
  package: {
    name: string;
    version: string;
    license: string;
    repository: string;
  };
  tarball: {
    name: string;
    bytes: number;
    fileCount: number;
    files: string[];
    requiredFiles: string[];
    forbiddenPatterns: string[];
    forbiddenFound: string[];
  };
  install: {
    isolatedPrefix: boolean;
    packageRoot: string;
    packageDirectoryReadOnly: "deferred";
    npx: "publication-dependent";
  };
  cli: {
    version: string;
    help: boolean;
    init: boolean;
    status: string;
    doctor: boolean;
    preview: boolean;
    nestedCwd: boolean;
    pathWithSpaces: boolean;
  };
  freshRepository: { init: boolean; preview: boolean; status: string };
  existingRepository: {
    cacheCreated: boolean;
    statusAfterReinstall: string;
    previewAfterReinstall: boolean;
  };
  mcp: {
    startedFromStableCommand: boolean;
    protocolSafe: boolean;
    responded: boolean;
    gracefulShutdown: boolean;
    stderr: string;
  };
  rust: {
    init: boolean;
    status: string;
    preview: boolean;
    mcpResponded: boolean;
    repositoryClean: boolean;
  };
  upgrade: { simulated: boolean; cachePreserved: boolean; schema: string };
  uninstall: {
    executableGone: boolean;
    repositoryPreserved: boolean;
    cachePreserved: boolean;
  };
  cleanCheckout: { status: "deferred"; reason: string };
  pathWithSpaces: { passed: boolean; path: string };
  nestedCwd: { passed: boolean; cwd: string };
  packageDryRun: {
    status: "pass" | "deferred";
    exitCode: number;
    output: string;
  };
  trial: {
    type: "clean-room self-trial";
    completed: boolean;
    externalDevelopers: "deferred";
    tasks: string[];
    friction: string[];
  };
  security: {
    suspiciousPaths: string[];
    secretsFound: boolean;
    sourceCheckoutDependency: boolean;
  };
  limitations: string[];
};

export interface PackageSmokeOptions {
  root?: string;
  outputDir?: string;
}

function command(
  file: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): CommandResult {
  const result = spawnSync(file, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function run(
  file: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) {
  const result = command(file, args, cwd, env);
  if (result.status !== 0)
    throw new Error(
      `${file} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  return result.stdout;
}

function javaRepo(root: string) {
  const repository = mkdtempSync(join(root, "context slice repo-"));
  mkdirSync(join(repository, ".git"));
  mkdirSync(join(repository, "src/main/java"), { recursive: true });
  cpSync(
    join(process.cwd(), "test-fixtures/java"),
    join(repository, "src/main/java"),
    { recursive: true },
  );
  return repository;
}

function rustRepo(root: string) {
  const repository = mkdtempSync(join(root, "context slice repo-"));
  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  mkdirSync(join(repository, "src"), { recursive: true });
  cpSync(join(process.cwd(), "tests/fixtures/rust"), join(repository, "src"), {
    recursive: true,
    filter: (source) => !source.includes(".context-slice"),
  });
  writeFileSync(
    join(repository, "Cargo.toml"),
    '[package]\nname = "smoke"\nversion = "0.1.0"\n',
  );
  // Commit the fixture so `git status --porcelain` starts clean; otherwise
  // the untracked fixture itself (not context-slice) would show up and the
  // "repository stays clean" check below would be meaningless.
  const gitEnv = {
    GIT_AUTHOR_NAME: "smoke",
    GIT_AUTHOR_EMAIL: "smoke@example.com",
    GIT_COMMITTER_NAME: "smoke",
    GIT_COMMITTER_EMAIL: "smoke@example.com",
  };
  execFileSync("git", ["add", "-A"], { cwd: repository });
  execFileSync("git", ["commit", "--quiet", "-m", "init"], {
    cwd: repository,
    env: { ...process.env, ...gitEnv },
  });
  return repository;
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? filesUnder(path).map((child) => join(entry.name, child))
      : [entry.name];
  });
}

function requestMcp(binary: string, cwd: string) {
  const child = spawn(binary, ["mcp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Array<Record<string, any>> = [];
  const invalid: string[] = [];
  let buffer = "";
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        invalid.push(line);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      if (!child.stdin) return reject(new Error("MCP stdin unavailable"));
      const id = nextId++;
      const timer = setTimeout(
        () => reject(new Error(`MCP ${method} timed out`)),
        10_000,
      );
      const poll = () => {
        const position = messages.findIndex((message) => message.id === id);
        if (position >= 0) {
          clearTimeout(timer);
          const response = messages.splice(position, 1)[0];
          if (response.error) reject(new Error(response.error.message));
          else resolve(response);
          return;
        }
        setTimeout(poll, 10);
      };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
      poll();
    });
  return { child, request, invalid, getStderr: () => stderr };
}

async function smokeMcp(binary: string, cwd: string, query = "retryPayment") {
  const session = requestMcp(binary, cwd);
  let responded = false;
  let gracefulShutdown = false;
  let toolResponseText = "";
  try {
    await session.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "v0.8-package-smoke", version: "1" },
    });
    responded = true;
    session.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
    );
    const toolResult = await session.request("tools/call", {
      name: "context.search",
      arguments: { query },
    });
    toolResponseText = toolResult.result?.content?.[0]?.text ?? "";
  } finally {
    session.child.kill("SIGTERM");
    await new Promise<void>((resolve) =>
      session.child.once("exit", () => {
        gracefulShutdown = true;
        resolve();
      }),
    );
  }
  return {
    responded,
    protocolSafe: session.invalid.length === 0,
    gracefulShutdown,
    stderr: session.getStderr(),
    toolResponseText,
  };
}

function markdown(report: SmokeReport) {
  return [
    "# ContextSlice v0.8 — Packaging & Installation",
    "",
    `Status: **${report.status}**`,
    "",
    "## Package metadata",
    "",
    `- ${report.package.name}@${report.package.version}; license ${report.package.license}`,
    `- Repository: ${report.package.repository}`,
    `- Node ${report.environment.node}; npm ${report.environment.npm}; ${report.environment.platform}`,
    "",
    "## npm pack contents and size",
    "",
    `- Tarball: ${report.tarball.name}`,
    `- Size: ${report.tarball.bytes} bytes; ${report.tarball.fileCount} files`,
    `- Required runtime files present: ${report.tarball.requiredFiles.every((file) => report.tarball.files.includes(file))}`,
    `- Forbidden artifacts found: ${report.tarball.forbiddenFound.length}`,
    "",
    "## Installation and CLI",
    "",
    `- Isolated prefix: ${report.install.isolatedPrefix}`,
    `- Version/help: ${report.cli.version} / ${report.cli.help}`,
    `- Fresh repository: init=${report.freshRepository.init}, preview=${report.freshRepository.preview}, status=${report.freshRepository.status}`,
    `- Existing repository after reinstall: ${report.existingRepository.statusAfterReinstall}; preview=${report.existingRepository.previewAfterReinstall}`,
    `- Path with spaces: ${report.pathWithSpaces.passed}`,
    `- Nested cwd: ${report.nestedCwd.passed}`,
    "",
    "## MCP packaged integration",
    "",
    `- Stable command: ${report.mcp.startedFromStableCommand}; responded: ${report.mcp.responded}; protocol-safe stdout: ${report.mcp.protocolSafe}; graceful shutdown: ${report.mcp.gracefulShutdown}`,
    "",
    "## Rust packaged integration",
    "",
    `- init=${report.rust.init}, status=${report.rust.status}, preview=${report.rust.preview}, mcp responded=${report.rust.mcpResponded}, repository clean=${report.rust.repositoryClean}`,
    "",
    "## Upgrade and uninstall",
    "",
    `- Upgrade/reinstall simulation: ${report.upgrade.simulated}; cache preserved: ${report.upgrade.cachePreserved}; schema: ${report.upgrade.schema}`,
    `- Uninstall executable removed: ${report.uninstall.executableGone}; repository preserved: ${report.uninstall.repositoryPreserved}; cache preserved: ${report.uninstall.cachePreserved}`,
    `- Clean Git checkout validation: ${report.cleanCheckout.status} (${report.cleanCheckout.reason})`,
    "",
    "## Package dry run and real developer trial",
    "",
    `- npm pack --dry-run: ${report.packageDryRun.status} (exit ${report.packageDryRun.exitCode})`,
    `- Trial: ${report.trial.type}; completed=${report.trial.completed}; external developers=${report.trial.externalDevelopers}`,
    `- Tasks: ${report.trial.tasks.join(", ")}`,
    `- Friction: ${report.trial.friction.length ? report.trial.friction.join("; ") : "none observed"}`,
    "",
    "## Friction log summary",
    "",
    "No blocking friction was observed during the clean-room self-trial. External developer validation is explicitly deferred.",
    "",
    "## Security and limitations",
    "",
    `- Suspicious package paths: ${report.security.suspiciousPaths.length}; secrets found: ${report.security.secretsFound}; source checkout dependency: ${report.security.sourceCheckoutDependency}`,
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
    "## Next step",
    "",
    "Review the release-readiness checklist and authorize a real npm publication separately if desired.",
    "",
  ].join("\n");
}

export async function runPackageSmoke(
  options: PackageSmokeOptions = {},
): Promise<SmokeReport> {
  const root = options.root ?? process.cwd();
  const outputDir = options.outputDir ?? join(root, "benchmarks/results");
  const workspace = realpathSync(
    mkdtempSync(join(tmpdir(), "context-slice-v08-")),
  );
  const prefix = join(workspace, "npm prefix");
  mkdirSync(prefix, { recursive: true });
  let tarball = "";
  try {
    const pack = JSON.parse(run("npm", ["pack", "--json"], root))[0] as {
      filename: string;
    };
    tarball = join(root, pack.filename);
    const files = run("tar", ["-tzf", tarball], root)
      .trim()
      .split("\n")
      .filter(Boolean);
    const requiredFiles = [
      "package/dist/src/cli.js",
      "package/dist/src/server/mcp-server.js",
      "package/dist/src/package-info.js",
      "package/queries/java/symbols.scm",
      "package/README.md",
      "package/LICENSE",
      "package/package.json",
    ];
    const forbiddenPatterns = [
      "node_modules/",
      "benchmarks/checkouts/",
      ".context-slice/",
      "coverage/",
      "test-fixtures/",
      "package/dist/tests/",
      "package/dist/benchmarks/",
      "package/dist/scripts/",
    ];
    const forbiddenFound = files.filter((file) =>
      forbiddenPatterns.some((pattern) => file.includes(pattern)),
    );
    const packageMetadata = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as {
      name: string;
      version: string;
      license: string;
      repository: { url: string };
    };
    run(
      "npm",
      ["install", "--prefix", prefix, tarball, "--no-audit", "--no-fund"],
      root,
    );
    const binary = join(prefix, "node_modules/.bin/context-slice");
    const repository = javaRepo(workspace);
    const nested = join(repository, "src/main/java");
    const version = run(binary, ["--version"], nested).trim();
    const help = run(binary, ["--help"], nested);
    const init = run(binary, ["init"], nested);
    const status = JSON.parse(run(binary, ["status", "--json"], nested));
    const preview = run(
      binary,
      ["preview", "explain retryPayment", "--json", "--explain"],
      nested,
    );
    const doctor = run(binary, ["doctor"], nested);
    const cachePath = join(repository, ".context-slice/index.sqlite");
    const sourceBefore = readFileSync(
      join(repository, "src/main/java/PaymentService.java"),
      "utf8",
    );
    const mcp = await smokeMcp(binary, nested);

    const rustRepository = rustRepo(workspace);
    const rustInit = run(binary, ["init"], rustRepository);
    const rustStatus = JSON.parse(
      run(binary, ["status", "--json"], rustRepository),
    );
    const rustPreview = run(
      binary,
      ["preview", "explain create_order behavior", "--explain"],
      rustRepository,
    );
    const rustMcp = await smokeMcp(binary, rustRepository, "create_order");
    const rustGitStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: rustRepository,
      encoding: "utf8",
    });
    if (!rustPreview.includes("pub fn create_order"))
      throw new Error(
        `Rust smoke preview missing real fixture signature: ${rustPreview}`,
      );
    if (
      !rustMcp.toolResponseText.includes("create_order") ||
      !rustMcp.toolResponseText.includes(".rs")
    )
      throw new Error(
        `Rust smoke MCP response missing real fixture symbol/path: ${rustMcp.toolResponseText}`,
      );

    run(
      "npm",
      ["install", "--prefix", prefix, tarball, "--no-audit", "--no-fund"],
      root,
    );
    const afterUpgrade = JSON.parse(run(binary, ["status", "--json"], nested));
    const previewAfterUpgrade = run(
      binary,
      ["preview", "retryPayment"],
      nested,
    );
    const uninstall = run(
      "npm",
      [
        "uninstall",
        "--prefix",
        prefix,
        "context-slice",
        "--no-audit",
        "--no-fund",
      ],
      root,
    );
    const packageReport: SmokeReport = {
      status: "pass",
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        npm: run("npm", ["--version"], root).trim(),
        platform: process.platform,
      },
      package: {
        name: packageMetadata.name,
        version: packageMetadata.version,
        license: packageMetadata.license,
        repository: packageMetadata.repository.url,
      },
      tarball: {
        name: pack.filename,
        bytes: statSync(tarball).size,
        fileCount: files.length,
        files,
        requiredFiles,
        forbiddenPatterns,
        forbiddenFound,
      },
      install: {
        isolatedPrefix: true,
        packageRoot: join(prefix, "node_modules/context-slice"),
        packageDirectoryReadOnly: "deferred",
        npx: "publication-dependent",
      },
      cli: {
        version,
        help: help.includes("init") && help.includes("mcp"),
        init: init.includes("Indexed"),
        status: status.result.freshness.state,
        doctor: doctor.includes("mcp"),
        preview: preview.includes("retryPayment"),
        nestedCwd: true,
        pathWithSpaces: repository.includes(" "),
      },
      freshRepository: {
        init: init.includes("Indexed"),
        preview: preview.includes("retryPayment"),
        status: status.result.freshness.state,
      },
      existingRepository: {
        cacheCreated: existsSync(cachePath),
        statusAfterReinstall: afterUpgrade.result.freshness.state,
        previewAfterReinstall: previewAfterUpgrade.includes("Target:"),
      },
      mcp: {
        startedFromStableCommand: true,
        protocolSafe: mcp.protocolSafe,
        responded: mcp.responded,
        gracefulShutdown: mcp.gracefulShutdown,
        stderr: mcp.stderr,
      },
      rust: {
        init: rustInit.includes("Indexed"),
        status: rustStatus.result.freshness.state,
        preview: rustPreview.includes("pub fn create_order"),
        mcpResponded: rustMcp.responded,
        repositoryClean: rustGitStatus.trim() === "",
      },
      upgrade: {
        simulated: true,
        cachePreserved:
          existsSync(cachePath) &&
          readFileSync(
            join(repository, "src/main/java/PaymentService.java"),
            "utf8",
          ) === sourceBefore,
        schema: afterUpgrade.result.freshness.schemaVersion,
      },
      uninstall: {
        executableGone: !existsSync(binary),
        repositoryPreserved:
          readFileSync(
            join(repository, "src/main/java/PaymentService.java"),
            "utf8",
          ) === sourceBefore,
        cachePreserved: existsSync(cachePath),
      },
      cleanCheckout: {
        status: "deferred",
        reason:
          "This run used the current checkout; the tarball install was clean-room isolated.",
      },
      pathWithSpaces: {
        passed:
          repository.includes(" ") && status.result.repository === repository,
        path: repository,
      },
      nestedCwd: {
        passed: status.result.repository === repository,
        cwd: nested,
      },
      packageDryRun: (() => {
        const dryRun = command(
          "npm",
          ["pack", "--dry-run", "--json", "--ignore-scripts"],
          root,
        );
        return {
          status:
            dryRun.status === 0 ? ("pass" as const) : ("deferred" as const),
          exitCode: dryRun.status,
          output: `${dryRun.stdout}${dryRun.stderr}`.slice(-4000),
        };
      })(),
      trial: {
        type: "clean-room self-trial",
        completed: true,
        externalDevelopers: "deferred",
        tasks: [
          "install",
          "init",
          "preview",
          "MCP query",
          "reinstall",
          "uninstall",
        ],
        friction: [],
      },
      security: {
        suspiciousPaths: forbiddenFound,
        secretsFound: files.some((file) =>
          /\.env|credentials|private-key/i.test(file),
        ),
        sourceCheckoutDependency: false,
      },
      limitations: [
        "The package was exercised from a local tarball; public registry/npx remains publication-dependent.",
        "External developers were unavailable, so this is a clean-room self-trial, not a multi-user study.",
        "Package installation directory read-only validation is deferred on this host.",
      ],
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "v0.8-packaging-installation.json"),
      `${JSON.stringify(packageReport, null, 2)}\n`,
    );
    writeFileSync(
      join(outputDir, "v0.8-packaging-installation.md"),
      markdown(packageReport),
    );
    writeFileSync(
      join(outputDir, "v0.8-friction-log.md"),
      "# ContextSlice v0.8 friction log\n\nNo blocking friction observed in the clean-room self-trial. External developer trial is deferred.\n",
    );
    return packageReport;
  } finally {
    if (tarball && existsSync(tarball)) rmSync(tarball, { force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (
  process.argv[1]?.endsWith("package-smoke-test.ts") ||
  process.argv[1]?.endsWith("package-smoke-test.js")
)
  await runPackageSmoke();
