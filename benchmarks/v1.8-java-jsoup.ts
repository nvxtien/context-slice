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
};

// Hand-curated from reading the real jsoup source at pinned commit 088614f4 under
// benchmarks/checkouts/jsoup (verified `git rev-parse HEAD` matches before writing this).
// Files read in full for this task: Jsoup.java, Connection.java, nodes/Node.java,
// nodes/LeafNode.java, nodes/TextNode.java, internal/StringUtil.java, parser/Parser.java,
// select/Selector.java, select/Elements.java.
//
// Node.java (38462 bytes) and Connection.java (43713 bytes) are both >= 32KB — exactly the
// files that commit 2a127ce's chunked-parse fix matters for. Before that fix,
// parser.parse(source) on a >=32KB input silently dropped every symbol in the file (the
// tree-sitter node binding rejects such inputs outright). Entries 14-17 below (Node, Node's
// nodeName/attr methods, its parentNode field) and the Connection.java entries are picked
// specifically to prove those symbols are now indexed.
type OracleSymbol = { name: string; kind: string; filePath: string };

const oracleSymbols: OracleSymbol[] = [
  // Jsoup.java
  { name: "Jsoup", kind: "class", filePath: "src/main/java/org/jsoup/Jsoup.java" },
  { name: "Jsoup", kind: "constructor", filePath: "src/main/java/org/jsoup/Jsoup.java" },
  { name: "parse", kind: "method", filePath: "src/main/java/org/jsoup/Jsoup.java" },
  { name: "connect", kind: "method", filePath: "src/main/java/org/jsoup/Jsoup.java" },
  { name: "newSession", kind: "method", filePath: "src/main/java/org/jsoup/Jsoup.java" },
  { name: "isValid", kind: "method", filePath: "src/main/java/org/jsoup/Jsoup.java" },
  // Connection.java (>=32KB file; only indexed correctly after the chunked-parse fix)
  { name: "Connection", kind: "interface", filePath: "src/main/java/org/jsoup/Connection.java" },
  { name: "Method", kind: "enum", filePath: "src/main/java/org/jsoup/Connection.java" },
  { name: "hasBody", kind: "field", filePath: "src/main/java/org/jsoup/Connection.java" },
  { name: "Request", kind: "interface", filePath: "src/main/java/org/jsoup/Connection.java" },
  { name: "Response", kind: "interface", filePath: "src/main/java/org/jsoup/Connection.java" },
  { name: "KeyVal", kind: "interface", filePath: "src/main/java/org/jsoup/Connection.java" },
  { name: "data", kind: "method", filePath: "src/main/java/org/jsoup/Connection.java" },
  // nodes/Node.java (>=32KB file; only indexed correctly after the chunked-parse fix)
  { name: "Node", kind: "class", filePath: "src/main/java/org/jsoup/nodes/Node.java" },
  { name: "nodeName", kind: "method", filePath: "src/main/java/org/jsoup/nodes/Node.java" },
  { name: "attr", kind: "method", filePath: "src/main/java/org/jsoup/nodes/Node.java" },
  { name: "parentNode", kind: "field", filePath: "src/main/java/org/jsoup/nodes/Node.java" },
  // nodes/LeafNode.java
  { name: "LeafNode", kind: "class", filePath: "src/main/java/org/jsoup/nodes/LeafNode.java" },
  { name: "coreValue", kind: "method", filePath: "src/main/java/org/jsoup/nodes/LeafNode.java" },
  // nodes/TextNode.java
  { name: "TextNode", kind: "class", filePath: "src/main/java/org/jsoup/nodes/TextNode.java" },
  { name: "TextNode", kind: "constructor", filePath: "src/main/java/org/jsoup/nodes/TextNode.java" },
  { name: "text", kind: "method", filePath: "src/main/java/org/jsoup/nodes/TextNode.java" },
  { name: "splitText", kind: "method", filePath: "src/main/java/org/jsoup/nodes/TextNode.java" },
  // select/Selector.java
  { name: "Selector", kind: "class", filePath: "src/main/java/org/jsoup/select/Selector.java" },
  { name: "select", kind: "method", filePath: "src/main/java/org/jsoup/select/Selector.java" },
];

// Hand-verified call-resolution outcomes, by reading the real source and cross-checking
// src/languages/java.ts's resolveCalls (the only resolutionKind values it can emit are:
// "constructor", "inherited", "interface", "static", "explicit-receiver", "same-type", and
// "unresolved"). Disambiguated by file + line since calleeName/receiverText recur.
type OracleResolution = {
  calleeName: string;
  receiverText?: string;
  file: string;
  line: number;
  expectedKind: string;
  note: string;
};

const oracleResolutions: OracleResolution[] = [
  {
    // splitText(): text(head) — TextNode.text(String) is declared directly on TextNode
    // itself, same parentId as the caller splitText (both members of TextNode) => same-type.
    calleeName: "text",
    file: "src/main/java/org/jsoup/nodes/TextNode.java",
    line: 75,
    expectedKind: "same-type",
    note: "splitText() calls text(head); TextNode.text(String) is declared on TextNode itself",
  },
  {
    // splitText(): coreValue() (0-arg) — declared on LeafNode, TextNode's supertype, not on
    // TextNode itself => resolved via the inherited/supertype path. There are two coreValue
    // overloads in LeafNode (0-arg getter, 1-arg setter); argumentCount=0 disambiguates them.
    calleeName: "coreValue",
    file: "src/main/java/org/jsoup/nodes/TextNode.java",
    line: 69,
    expectedKind: "inherited",
    note: "splitText() calls coreValue() with 0 args; LeafNode declares both a 0-arg getter and a 1-arg setter named coreValue, argumentCount narrows to the getter",
  },
  {
    // splitText(): new TextNode(tail) — syntactic `new` prefix marks this a constructor
    // call up front; TextNode has exactly one constructor (String), so it resolves.
    calleeName: "TextNode",
    file: "src/main/java/org/jsoup/nodes/TextNode.java",
    line: 76,
    expectedKind: "constructor",
    note: "splitText() calls new TextNode(tail); TextNode's single String constructor resolves",
  },
  {
    // Jsoup.parse(URL,int): con.timeout(timeoutMillis) — con is a local var declared
    // `Connection con = HttpConnection.connect(url);` two lines above; the declared-type
    // regex picks up "Connection con" correctly, narrowing to Connection.java's own
    // timeout(int) member -- its parent is kind "interface", so the adapter labels this
    // resolutionKind "interface" (receiver-typed call whose target lives on an interface).
    calleeName: "timeout",
    receiverText: "con",
    file: "src/main/java/org/jsoup/Jsoup.java",
    line: 331,
    expectedKind: "interface",
    note: "parse(URL,int) calls con.timeout(timeoutMillis); con's declared type Connection is picked up from 'Connection con = HttpConnection.connect(url);', resolving to the Connection interface's timeout(int)",
  },
  {
    // Same method, next line: con.get() -> Connection.get().
    calleeName: "get",
    receiverText: "con",
    file: "src/main/java/org/jsoup/Jsoup.java",
    line: 332,
    expectedKind: "interface",
    note: "parse(URL,int) calls con.get(); same con:Connection binding, resolves to the Connection interface's get()",
  },
  {
    // helper/HttpConnection.java's validateMimeContentType(): Validate.notEmptyParam(...) —
    // genuine cross-file static call, Validate declares exactly one 2-arg notEmptyParam, so
    // it resolves uniquely (receiverText "Validate" is capitalized -> resolutionKind "static").
    calleeName: "notEmptyParam",
    receiverText: "Validate",
    file: "src/main/java/org/jsoup/helper/HttpConnection.java",
    line: 125,
    expectedKind: "static",
    note: "validateMimeContentType(String) calls Validate.notEmptyParam(contentType, \"contentType\"); resolves cross-file to helper/Validate.java's single notEmptyParam(String,String)",
  },
  {
    // Next line, same method: Validate.isFalse(cond, msg) -- Validate has 2 overloads named
    // isFalse (1-arg and 2-arg); this call site passes 2 args, so argumentCount narrows to
    // the 2-arg overload uniquely.
    calleeName: "isFalse",
    receiverText: "Validate",
    file: "src/main/java/org/jsoup/helper/HttpConnection.java",
    line: 126,
    expectedKind: "static",
    note: "validateMimeContentType(String) calls Validate.isFalse(cond, msg) with 2 args; Validate declares isFalse(boolean) and isFalse(boolean,String), argumentCount=2 disambiguates to the latter",
  },
  {
    // KNOWN GAP (found during this task, not fixed -- out of scope): text() calls
    // StringUtil.normaliseWhitespace(getWholeText()). java.ts's declared-type regex scans
    // the WHOLE FILE's source (sourceOf(caller) returns the entire file, not just the
    // caller's own body) looking for `IDENT\s+ReceiverText` to detect a local variable's
    // declared type. TextNode.java happens to contain the literal text "return
    // StringUtil" (the very call being resolved: "return StringUtil.normaliseWhitespace(...)"),
    // which the regex misreads as a declared-variable pattern ("return" the "type", bound to
    // a variable confusingly named "StringUtil"). That bogus declaredType="return" then fails
    // to match any real symbol's parent name, so the call is left unresolved even though
    // StringUtil.normaliseWhitespace(String) is a real, unique, resolvable static method.
    // This is a real, pre-existing limitation of resolveCalls' declared-type heuristic on any
    // "return Capitalized.method(...)" call site (the same false match breaks
    // StringUtil.isBlank(...) at TextNode.java:59 and Parser.parse(...) at Jsoup.java:37) --
    // recorded here as found, not papered over or fixed by this task.
    calleeName: "normaliseWhitespace",
    receiverText: "StringUtil",
    file: "src/main/java/org/jsoup/nodes/TextNode.java",
    line: 33,
    expectedKind: "unresolved",
    note: "text() calls StringUtil.normaliseWhitespace(getWholeText()); stays unresolved because java.ts's declared-type regex scans the whole file and misreads the literal text \"return StringUtil\" (this same call site) as a declared-variable pattern, overriding the correct capitalized-receiver static-call inference -- a real, pre-existing bug this task did not fix",
  },
];

const repositories: Repository[] = JSON.parse(
  readFileSync(resolve(process.cwd(), "benchmarks/repositories.json"), "utf8"),
);
const repo = repositories.find((r) => r.id === "jsoup");
if (!repo) throw new Error("jsoup entry missing from benchmarks/repositories.json");

const root = resolve(process.cwd(), repo.source);
const index = new ProjectIndex(root);
index.rebuild();

const missing: string[] = [];

let symbolsFound = 0;
for (const expected of oracleSymbols) {
  const match = index.symbols.some(
    (s) =>
      s.name === expected.name &&
      s.kind === expected.kind &&
      s.filePath === expected.filePath,
  );
  if (match) symbolsFound++;
  else missing.push(`symbol ${expected.kind} ${expected.name} (${expected.filePath})`);
}

let resolutionsMatched = 0;
for (const expected of oracleResolutions) {
  const actual = index.calls.find(
    (c) =>
      c.calleeName === expected.calleeName &&
      c.receiverText === expected.receiverText &&
      c.filePath === expected.file &&
      c.range.startLine === expected.line,
  );
  const label = `resolution ${expected.receiverText ? `${expected.receiverText}.` : ""}${expected.calleeName} (${expected.file}:${expected.line})`;
  if (!actual) {
    missing.push(`${label}: call site not found in index.calls`);
    continue;
  }
  if (actual.resolutionKind === expected.expectedKind) {
    resolutionsMatched++;
  } else {
    missing.push(
      `${label}: expected ${expected.expectedKind}, got ${actual.resolutionKind}`,
    );
  }
}

console.log(
  `jsoup: ${symbolsFound}/${oracleSymbols.length} symbols found, ${resolutionsMatched}/${oracleResolutions.length} resolutions matched`,
);
if (missing.length) console.log(`  missing: ${missing.join(", ")}`);

const outDir = resolve(process.cwd(), "benchmarks/results");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  results: {
    jsoup: {
      symbolsTotal: oracleSymbols.length,
      symbolsFound,
      resolutionsTotal: oracleResolutions.length,
      resolutionsMatched,
      missing,
    },
  },
};
writeFileSync(
  join(outDir, "v1.8-java-jsoup.json"),
  JSON.stringify(report, null, 2) + "\n",
);
