import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ProjectIndex } from "../src/indexer/index.js";
import { parseTypeScript } from "../src/languages/typescript/parse.js";
import { typeScriptDiagnostics } from "../src/languages/typescript/index.js";
import type { CallEdge, SymbolRecord } from "../src/types/model.js";

/** A private copy: fixtures must never accumulate a cache from a test run. */
function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `context-slice-${name}-`));
  cpSync(join(process.cwd(), "tests/fixtures", name), root, {
    recursive: true,
    filter: (source) => !source.includes(".context-slice"),
  });
  return root;
}
function indexed(name: string) {
  const root = fixture(name);
  const index = new ProjectIndex(root);
  index.rebuild();
  return { root, index };
}
const byId = (symbols: SymbolRecord[], id: string) =>
  symbols.find((symbol) => symbol.id === id);
const callTo = (calls: CallEdge[], callee: string, receiver?: string) =>
  calls.find(
    (call) =>
      call.calleeName === callee &&
      (receiver === undefined || call.receiverText === receiver),
  );

async function stopMcp(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

test("typescript symbol identities are canonical and stable", () => {
  const { index } = indexed("typescript");
  for (const id of [
    "order-service.ts::class::OrderService",
    "order-service.ts::OrderService::method::create(CreateOrderInput)",
    "order-service.ts::OrderService::constructor::constructor()",
    "repository.ts::interface::OrderRepository",
    "repository.ts::SqlOrderRepository::method::nextId(string)",
    "types.ts::type::OrderId",
    "types.ts::enum::OrderStatus",
    "utils/math.ts::function::calculateTotal(OrderItem[])",
    "utils/math.ts::function::applyDiscount(number, number)",
    "utils/math.ts::outer::function::inner()",
  ])
    assert.ok(byId(index.symbols, id), `missing symbol ${id}`);
  assert.equal(
    new Set(index.symbols.map((symbol) => symbol.id)).size,
    index.symbols.length,
  );
});

test("function-valued variables are callable symbols", () => {
  const { index } = indexed("typescript");
  const arrow = byId(
    index.symbols,
    "utils/math.ts::function::calculateTotal(OrderItem[])",
  );
  const expression = byId(
    index.symbols,
    "utils/math.ts::function::applyDiscount(number, number)",
  );
  assert.equal(arrow?.kind, "function");
  assert.equal(expression?.kind, "function");
  assert.equal(arrow?.metadata?.exported, "named");
  // Nested callables keep their enclosing chain and do not collide.
  assert.equal(
    byId(index.symbols, "utils/math.ts::outer::function::inner()")?.kind,
    "function",
  );
});

test("overload signatures are distinct from the implementation", () => {
  const { index } = indexed("typescript");
  const overloads = index.symbols.filter((symbol) => symbol.name === "parse");
  assert.equal(overloads.length, 3);
  assert.equal(
    overloads.filter((symbol) => symbol.metadata?.overloadSignature).length,
    2,
  );
  const call = callTo(index.calls, "parse");
  assert.equal(
    call?.resolvedTargetId,
    "validation.ts::function::parse(string | number)",
  );
  assert.equal(call?.confidence, "exact");
});

test("imports record name, alias, kind and type-only status", () => {
  const { index } = indexed("typescript");
  const consumer = index.imports.filter(
    (record) => record.filePath === "consumer.ts",
  );
  const alias = consumer.find((record) => record.localName === "checkOrder");
  assert.equal(alias?.importedName, "validateOrder");
  assert.equal(alias?.kind, "named");
  assert.equal(alias?.resolvedFile, "validation.ts");
  const typeOnly = consumer.find((record) => record.module === "./types");
  assert.equal(typeOnly?.typeOnly, true);
  const defaultImport = consumer.find((record) => record.kind === "default");
  assert.equal(defaultImport?.localName, "handler");
  assert.equal(defaultImport?.importedName, "default");
  const namespace = index.imports.find(
    (record) =>
      record.kind === "namespace" && record.filePath === "order-api.ts",
  );
  assert.equal(namespace?.localName, "math");
  assert.equal(namespace?.resolvedFile, "utils/math.ts");
  const external = index.imports.find((record) => record.module === "express");
  assert.equal(external?.externalPackage, "express");
  assert.equal(external?.resolvedFile, undefined);
});

test("relative imports resolve through index files and barrels", () => {
  const { index } = indexed("typescript");
  const barrel = index.imports.find(
    (record) =>
      record.filePath === "consumer.ts" && record.module === "./index",
  );
  assert.equal(barrel?.resolvedFile, "index.ts");
  // `createOrder` and the aliased `makeOrder` both reach the same implementation.
  const target = "order-api.ts::function::createOrder(CreateOrderInput)";
  assert.equal(callTo(index.calls, "createOrder")?.resolvedTargetId, target);
  assert.equal(callTo(index.calls, "makeOrder")?.resolvedTargetId, target);
  // `calculateTotal` reaches the wildcard re-export target.
  assert.equal(
    index.calls.find(
      (call) =>
        call.calleeName === "calculateTotal" && call.filePath === "consumer.ts",
    )?.resolvedTargetId,
    "utils/math.ts::function::calculateTotal(OrderItem[])",
  );
});

test("call edges carry resolution kind, confidence and evidence", () => {
  const { index } = indexed("typescript");
  const expectations: Array<[string, string | undefined, string, string]> = [
    ["assertValid", "this", "this-member", "exact"],
    ["save", "this.repository", "declared-type", "exact"],
    ["create", "service", "declared-type", "exact"],
    ["calculateTotal", "math", "namespace-import", "exact"],
    ["checkOrder", undefined, "aliased-import", "exact"],
    ["handler", undefined, "default-import", "exact"],
    ["validateOrder", undefined, "imported", "exact"],
    ["inner", undefined, "same-file", "exact"],
  ];
  for (const [callee, receiver, kind, confidence] of expectations) {
    const call = callTo(index.calls, callee, receiver);
    assert.equal(call?.resolutionKind, kind, `${callee}: resolution kind`);
    assert.equal(call?.confidence, confidence, `${callee}: confidence`);
    assert.ok(call?.evidence.length, `${callee}: evidence`);
  }
  const constructed = index.calls.find(
    (call) =>
      call.resolutionKind === "constructor" &&
      call.calleeName === "SqlOrderRepository",
  );
  assert.equal(
    constructed?.resolvedTargetId,
    "repository.ts::SqlOrderRepository::constructor::constructor(string)",
  );
});

test("calls into external packages are marked, never resolved to source", () => {
  const { index } = indexed("typescript");
  const external = index.calls.find((call) => call.calleeName === "express");
  assert.equal(external?.externalPackage, "express");
  assert.equal(external?.resolutionKind, "external-package");
  assert.equal(external?.resolvedTargetId, undefined);
});

test("receivers with unknown types stay unresolved rather than guessed", () => {
  const { index } = indexed("typescript");
  for (const [callee, receiver] of [
    ["build", "factory"],
    ["run", "made"],
  ] as const) {
    const call = callTo(index.calls, callee, receiver);
    assert.equal(call?.confidence, "unresolved");
    assert.equal(call?.resolvedTargetId, undefined);
  }
  // Optional chaining is preserved as a call, not invented as a receiver type.
  assert.ok(
    index.calls.some(
      (call) => call.calleeName === "run" && call.optionalChaining,
    ),
  );
});

test("declaration files contribute API symbols but no call edges", () => {
  const { index } = indexed("typescript");
  const declared = index.symbols.filter(
    (symbol) => symbol.filePath === "ambient.d.ts",
  );
  assert.ok(declared.length >= 3);
  assert.ok(declared.every((symbol) => symbol.metadata?.declarationOnly));
  assert.equal(
    index.calls.filter((call) => call.filePath === "ambient.d.ts").length,
    0,
  );
});

test("CommonJS require is parsed safely without false resolution", () => {
  const { index } = indexed("typescript");
  const call = callTo(index.calls, "calculateTotal", "helpers");
  assert.equal(call?.confidence, "unresolved");
  assert.equal(call?.resolvedTargetId, undefined);
  assert.ok(
    byId(index.symbols, "legacy-commonjs.ts::function::legacyTotal(unknown[])"),
  );
});

test("cyclic barrel files terminate and are reported", () => {
  const { root, index } = indexed("typescript");
  assert.ok(byId(index.symbols, "cyclic/a.ts::function::fromA()"));
  const diagnostics = typeScriptDiagnostics({
    root,
    symbols: index.symbols,
    calls: index.calls,
    imports: index.imports,
    exports: index.exports,
    sourceOf: (symbol) => index.sourceFor(symbol),
  });
  assert.equal(diagnostics.reexportResolutionRate, 1);
  assert.equal(diagnostics.relativeImportResolutionRate, 1);
  assert.ok(diagnostics.externalImports >= 1);
});

test("tsconfig path aliases resolve, and unknown aliases are not external", () => {
  const { root, index } = indexed("typescript-alias");
  assert.equal(
    callTo(index.calls, "formatName")?.resolvedTargetId,
    "src/utils/format.ts::function::formatName(string, string)",
  );
  const missing = index.imports.find(
    (record) => record.module === "@/utils/not-there",
  );
  assert.equal(missing?.resolvedFile, undefined);
  assert.equal(missing?.externalPackage, undefined);
  index.close();
  rmSync(root, { recursive: true, force: true });
});

test("tsx components, handlers and JSX references are indexed", () => {
  const { index } = indexed("tsx");
  const component = byId(
    index.symbols,
    "CheckoutButton.tsx::function::CheckoutButton({ cartId: string })",
  );
  assert.equal(component?.metadata?.reactComponent, true);
  assert.equal(
    byId(
      index.symbols,
      "OrderSummary.tsx::function::OrderSummary(OrderSummaryProps)",
    )?.metadata?.reactComponent,
    true,
  );
  // CheckoutButton contains handleClick, and handleClick calls checkout.
  const handler = byId(
    index.symbols,
    "CheckoutButton.tsx::CheckoutButton::function::handleClick()",
  );
  assert.ok(handler);
  assert.equal(
    index.calls.find(
      (call) => call.callerId === handler!.id && call.calleeName === "checkout",
    )?.resolvedTargetId,
    "checkout.ts::function::checkout(string)",
  );
  // JSX element references use their own edge kind.
  const jsx = index.calls.find(
    (call) =>
      call.resolutionKind === "jsx-reference" &&
      call.calleeName === "OrderSummary",
  );
  assert.equal(
    jsx?.resolvedTargetId,
    "OrderSummary.tsx::function::OrderSummary(OrderSummaryProps)",
  );
  // Hooks are ordinary calls into an external package, with no React-specific rule.
  const hook = callTo(index.calls, "useEffect");
  assert.equal(hook?.externalPackage, "react");
});

test("mixed Java and TypeScript repositories coexist", () => {
  const { index } = indexed("mixed");
  const java = index.symbols.filter((symbol) => symbol.language === "java");
  const typescript = index.symbols.filter(
    (symbol) => symbol.language === "typescript",
  );
  assert.ok(java.length >= 3);
  assert.ok(typescript.length >= 2);
  assert.equal(
    new Set(index.symbols.map((symbol) => symbol.id)).size,
    index.symbols.length,
  );
  // Each language resolved its own same-name call without crossing over.
  const javaCall = index.calls.find((call) => call.filePath.endsWith(".java"));
  const tsCall = index.calls.find(
    (call) => call.filePath.endsWith(".ts") && call.calleeName === "audit",
  );
  assert.equal(javaCall?.resolutionKind, "same-type");
  assert.ok(javaCall?.resolvedTargetId?.endsWith("method::audit(String id)"));
  assert.equal(tsCall?.resolutionKind, "same-file");
  assert.equal(
    tsCall?.resolvedTargetId,
    "web/payment.ts::function::audit(string)",
  );
  assert.deepEqual(index.inspect().filesByExtension, { ".java": 1, ".ts": 1 });
  assert.ok(index.search("retryPayment").length >= 2);
});

test("incremental refresh reparses only the changed TypeScript file", () => {
  const { root, index: seedIndex } = indexed("typescript");
  seedIndex.close();
  const warmIndex = new ProjectIndex(root);
  const warm = warmIndex.rebuild();
  assert.equal(warm.filesParsed, 0);
  warmIndex.close();
  const file = join(root, "utils/math.ts");
  writeFileSync(file, `// touched\n${readFileSync(file, "utf8")}`);
  const updateIndex = new ProjectIndex(root);
  const update = updateIndex.rebuild();
  assert.equal(update.filesParsed, 1);
  assert.equal(update.cacheHits, warm.cacheHits - 1);
  updateIndex.close();
  // Cross-file resolution survives a partial reparse.
  const index = new ProjectIndex(root);
  index.rebuild();
  assert.equal(
    index.calls.find(
      (call) =>
        call.calleeName === "calculateTotal" && call.filePath === "consumer.ts",
    )?.confidence,
    "exact",
  );
  warmIndex.close();
  updateIndex.close();
  index.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("parse errors are reported without throwing", () => {
  const broken = parseTypeScript("broken.ts", "export function ( { : ; )");
  assert.equal(broken.parseError, true);
  assert.equal(Array.isArray(broken.symbols), true);
});

test("CLI preview works in a TypeScript repository", () => {
  const root = fixture("typescript");
  const cli = (args: string[]) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(
          join(process.cwd(), "node_modules/tsx/dist/loader.mjs"),
        ).href,
        join(process.cwd(), "src/cli.ts"),
        ...args,
        "--repo",
        root,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
  const init = cli(["init"]);
  assert.equal(init.status, 0);
  // The CLI must not call TypeScript files "Java files".
  assert.match(init.stdout, /Indexed 12 source files .* TypeScript: 12/);
  const status = JSON.parse(cli(["status", "--json"]).stdout);
  assert.equal(status.result.freshness.state, "CURRENT");
  assert.equal(status.result.freshness.filesByLanguage.TypeScript, 12);
  const preview = cli(["preview", "explain the order create flow", "--json"]);
  assert.equal(preview.status, 0, preview.stderr);
  const body = JSON.parse(preview.stdout).result;
  assert.equal(body.target.language, "typescript");
  assert.equal(body.target.qualifiedName, "OrderService.create");
  assert.ok(body.estimatedTokens <= body.budget);
  assert.ok(
    body.included.some((item: { symbol: string }) =>
      item.symbol.includes("calculateTotal"),
    ),
  );
  rmSync(root, { recursive: true, force: true });
});

test(
  "MCP serves TypeScript symbols through the same tools",
  { timeout: 20_000 },
  async () => {
    const root = fixture("tsx");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "src/cli.ts"),
        "mcp",
        "--repo",
        root,
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
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
    const request = (method: string, params: Record<string, unknown>) =>
      new Promise<Record<string, any>>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for MCP ${method}`)),
          10_000,
        );
        const poll = () => {
          const at = messages.findIndex((message) => message.id === id);
          if (at >= 0) {
            clearTimeout(timer);
            const message = messages.splice(at, 1)[0];
            if (message.error) reject(new Error(message.error.message));
            else resolve(message);
            return;
          }
          setTimeout(poll, 10);
        };
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
        poll();
      });
    try {
      await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "typescript-test", version: "1" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );
      const search = await request("tools/call", {
        name: "context.search",
        arguments: { query: "CheckoutButton" },
      });
      const found = JSON.parse(search.result.content[0].text);
      assert.equal(found.results[0].language, "typescript");
      assert.equal(found.results[0].name, "CheckoutButton");
      const callers = await request("tools/call", {
        name: "context.callers",
        arguments: {
          symbol: "checkout.ts::function::checkout(string)",
          depth: 1,
        },
      });
      const body = JSON.parse(callers.result.content[0].text);
      assert.ok(
        body.callers.some((caller: { id: string }) =>
          caller.id.includes("handleClick"),
        ),
      );
      assert.deepEqual(invalid, []);
    } finally {
      await stopMcp(child);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
