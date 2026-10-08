import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectIndex } from "../src/indexer/index.js";

type Repository = {
  id: string;
  scale: string;
  url: string;
  commit: string;
  source: string;
  scope: string;
  kind: string;
};
type OracleSymbol = { name: string; kind: string };
type OracleImport = { module: string; kind: string; localName?: string };
type OracleCall = {
  calleeName: string;
  receiverText?: string;
  // When present, this entry documents a known indexer gap: the call record
  // exists, but is expected to stay unresolved (resolvedTargetId undefined).
  resolved?: boolean;
};

const repositories: Repository[] = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "benchmarks/typescript-repositories.json"),
    "utf8",
  ),
);

// Hand-read from the real checked-out source (packages/zod/src/v3 at commit
// 0b216ef674e297ebe41d8bf902262e56f8755822) during this benchmark's own writing.
// types.ts declares `export abstract class ZodType<...>` (line 158) with
// ~36 concrete subclasses following it (ZodString, ZodNumber, ZodBigInt,
// ZodBoolean, ZodDate, ZodSymbol, ZodUndefined, ZodNull, ZodAny, ZodUnknown,
// ZodNever, ZodVoid, ZodArray, ZodObject, ZodUnion, ZodDiscriminatedUnion,
// ZodIntersection, ZodTuple, ZodRecord, ZodMap, ZodSet, ZodFunction, ZodLazy,
// ZodLiteral, ZodEnum, ZodNativeEnum, ZodPromise, ZodEffects, ZodOptional,
// ZodNullable, ZodDefault, ZodCatch, ZodNaN, ZodBranded, ZodPipeline,
// ZodReadonly). A subset is sampled below alongside interfaces, type
// aliases and free functions from ZodError.ts, errors.ts,
// helpers/parseUtil.ts and helpers/util.ts.
const oracles: Record<string, OracleSymbol[]> = {
  "zod-v3": [
    // types.ts — ZodType abstract base and a sample of concrete subclasses.
    { name: "ZodType", kind: "class" },
    { name: "ZodString", kind: "class" },
    { name: "ZodNumber", kind: "class" },
    { name: "ZodBigInt", kind: "class" },
    { name: "ZodBoolean", kind: "class" },
    { name: "ZodDate", kind: "class" },
    { name: "ZodArray", kind: "class" },
    { name: "ZodObject", kind: "class" },
    { name: "ZodUnion", kind: "class" },
    { name: "ZodEffects", kind: "class" },
    // ZodError.ts / helpers/parseUtil.ts — classes.
    { name: "ZodError", kind: "class" },
    { name: "ParseStatus", kind: "class" },
    // Interfaces.
    { name: "RefinementCtx", kind: "interface" }, // types.ts
    { name: "ZodTypeDef", kind: "interface" }, // types.ts
    { name: "ParseContext", kind: "interface" }, // helpers/parseUtil.ts
    { name: "ZodInvalidTypeIssue", kind: "interface" }, // ZodError.ts
    // Type aliases.
    { name: "ZodTypeAny", kind: "type" }, // types.ts
    { name: "ZodRawShape", kind: "type" }, // types.ts
    { name: "ZodIssueBase", kind: "type" }, // ZodError.ts
    { name: "ParseReturnType", kind: "type" }, // helpers/parseUtil.ts
    // Free functions.
    { name: "quotelessJson", kind: "function" }, // ZodError.ts
    { name: "makeIssue", kind: "function" }, // helpers/parseUtil.ts
    { name: "addIssueToContext", kind: "function" }, // helpers/parseUtil.ts
    { name: "setErrorMap", kind: "function" }, // errors.ts
    { name: "getErrorMap", kind: "function" }, // errors.ts
    { name: "getParsedType", kind: "function" }, // helpers/util.ts
  ],
};

const imports: Record<string, OracleImport[]> = {
  "zod-v3": [
    // types.ts: import { ..., ZodError, ... } from "./ZodError.js"
    { module: "./ZodError.js", kind: "named", localName: "ZodError" },
    // types.ts: import { defaultErrorMap, getErrorMap } from "./errors.js"
    { module: "./errors.js", kind: "named", localName: "getErrorMap" },
    // types.ts: import { util, ZodParsedType, getParsedType, ... } from "./helpers/util.js"
    { module: "./helpers/util.js", kind: "named", localName: "getParsedType" },
    // types.ts: import { ..., DIRTY, ... } from "./helpers/parseUtil.js"
    { module: "./helpers/parseUtil.js", kind: "named", localName: "DIRTY" },
  ],
};

// Real call sites read directly from types.ts, ZodError.ts and
// helpers/parseUtil.ts, then confirmed against the real indexer output
// during this benchmark's writing (not guessed).
const calls: Record<string, OracleCall[]> = {
  "zod-v3": [
    // ZodError.ts format(): processError(issue) / error.issues recursion.
    { calleeName: "processError" },
    // helpers/parseUtil.ts ParseStatus.mergeArray/mergeObjectSync: status.dirty()
    { calleeName: "dirty", receiverText: "status" },
    // helpers/parseUtil.ts ParseStatus.mergeObjectAsync: ParseStatus.mergeObjectSync(...)
    { calleeName: "mergeObjectSync", receiverText: "ParseStatus" },
    // helpers/parseUtil.ts ParseStatus.mergeArray: used from ZodArray._parse etc.
    { calleeName: "mergeArray", receiverText: "ParseStatus" },
    // types.ts: const ostring = () => stringType().optional() -> ZodString.create's export is
    // not this; real static-create call site: coerce.string -> ZodString.create({...})
    { calleeName: "create", receiverText: "ZodString" },
    // types.ts ZodArray.optional()/ZodNullable etc -> ZodOptional.create(...)
    { calleeName: "create", receiverText: "ZodOptional" },
    // helpers/parseUtil.ts / types.ts: isValid(result) imported from parseUtil
    { calleeName: "isValid" },
    // types.ts _parse() bodies: addIssueToContext(ctx, {...}) imported from parseUtil
    { calleeName: "addIssueToContext" },
    // helpers/util.ts / types.ts: getParsedType(input.data) imported from util
    { calleeName: "getParsedType" },
    // FIXED (was known gap (a)): ZodType declares `abstract _parse(input):
    // ParseReturnType<Output>;` with no body (types.ts line 170). The parser used to
    // only extract method symbols for concrete bodies, so `this._parse(input)` called
    // from ZodType._parseSync / ZodType._parseAsync / ZodType.safeParseAsync stayed
    // unresolved even though the method is declared right there. classMembers() now
    // also handles `abstract_method_signature` nodes (the TS grammar's node type for
    // a class's abstract method declaration, distinct from interface method_signature
    // only by node type, not shape), so these three call sites resolve exact/this-member.
    { calleeName: "_parse", receiverText: "this", resolved: true },
    // FIXED (was known gap (b)): `const stringType = ZodString.create;` (types.ts
    // line 5046) is indexed as kind "variable" since its initializer is a
    // property-access, not a function/arrow literal. parse.ts now records that as
    // `metadata.aliasOf: "ZodString.create"` on the variable symbol, and resolve.ts's
    // bare-call path follows it through the same static-member lookup a direct
    // `ZodString.create()` call would use, so `stringType()` resolves exact/static.
    { calleeName: "stringType", resolved: true },
  ],
};

const results: Record<
  string,
  {
    symbolsTotal: number;
    symbolsFound: number;
    importsTotal: number;
    importsFound: number;
    callsTotal: number;
    callsFound: number;
    missing: string[];
  }
> = {};

for (const repo of repositories) {
  if (repo.id !== "zod-v3") continue;
  const root = resolve(process.cwd(), repo.source);
  const index = new ProjectIndex(root);
  index.rebuild();
  const oracle = oracles[repo.id] ?? [];
  const oracleImports = imports[repo.id] ?? [];
  const oracleCalls = calls[repo.id] ?? [];
  const missing: string[] = [];

  let symbolsFound = 0;
  for (const expected of oracle) {
    const match = index.symbols.some(
      (s) => s.name === expected.name && s.kind === expected.kind,
    );
    if (match) symbolsFound++;
    else missing.push(`${expected.kind} ${expected.name}`);
  }

  let importsFound = 0;
  for (const expected of oracleImports) {
    const match = index.imports.some(
      (i) =>
        i.module === expected.module &&
        i.kind === expected.kind &&
        (expected.localName === undefined ||
          i.localName === expected.localName),
    );
    if (match) importsFound++;
    else missing.push(`import ${expected.module} (${expected.kind})`);
  }

  let callsFound = 0;
  for (const expected of oracleCalls) {
    const candidate = index.calls.find(
      (c) =>
        c.calleeName === expected.calleeName &&
        (expected.receiverText === undefined ||
          c.receiverText === expected.receiverText),
    );
    const match =
      candidate !== undefined &&
      (expected.resolved === undefined ||
        Boolean(candidate.resolvedTargetId) === expected.resolved);
    if (match) callsFound++;
    else
      missing.push(
        `call ${expected.receiverText ? `${expected.receiverText}.` : ""}${expected.calleeName}${expected.resolved === false ? " (expected unresolved)" : ""}`,
      );
  }

  results[repo.id] = {
    symbolsTotal: oracle.length,
    symbolsFound,
    importsTotal: oracleImports.length,
    importsFound,
    callsTotal: oracleCalls.length,
    callsFound,
    missing,
  };
  console.log(
    `${repo.id}: ${symbolsFound}/${oracle.length} symbols, ${importsFound}/${oracleImports.length} imports, ${callsFound}/${oracleCalls.length} calls found`,
  );
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
}

const outDir = resolve(process.cwd(), "benchmarks/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), results };
writeFileSync(
  join(outDir, "v1.8-typescript-zod-v3.json"),
  JSON.stringify(report, null, 2) + "\n",
);
