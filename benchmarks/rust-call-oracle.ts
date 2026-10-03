// Independent call-site oracle for Rust. RAW tree-sitter only: imports NOTHING from src/.
// Enumerates call sites, classifies them syntactically, and draws the deterministic
// stratified sample + dev/held-out split. See benchmarks/rust-semantic-calls/README.md.
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Node = Parser.SyntaxNode;

export const CATEGORIES = [
  "self-method",
  "field-method",
  "param-method",
  "local-method",
  "chained-method",
  "assoc-Self",
  "assoc-Type",
  "path-module",
  "path-generic",
  "bare-fn",
  "bare-closure-or-ctor",
  "qualified-trait",
  "macro-invocation",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type CallSite = {
  repo: string;
  file: string;
  line: number; // 1-based, of the callee-name token
  col: number; // 0-based, of the callee-name token
  callerQualifiedName: string;
  callText: string;
  calleeName: string;
  category: Category;
};
export type SampleEntry = CallSite & { split: "dev" | "held-out" };

let parser: Parser | undefined;
function parse(source: string) {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Rust as any);
  }
  // The node binding rejects string inputs of ~32KB or more, so feed it in small chunks.
  return parser.parse((index: number) => source.slice(index, index + 4_096));
}

const isUpper = (s: string) => /^[A-Z]/.test(s);

function patternIdentifiers(node: Node, out: Set<string>) {
  if (node.type === "identifier") out.add(node.text);
  for (const c of node.namedChildren) patternIdentifiers(c, out);
}

function collectLets(node: Node, out: Set<string>) {
  for (const c of node.namedChildren) {
    if (c.type === "function_item") continue; // nested fn has its own scope
    if (c.type === "let_declaration") {
      const pat = c.childForFieldName("pattern");
      if (pat) patternIdentifiers(pat, out);
    }
    collectLets(c, out);
  }
}

function collectParams(fn: Node): Set<string> {
  const out = new Set<string>();
  const params = fn.childForFieldName("parameters");
  for (const p of params?.namedChildren ?? []) {
    if (p.type !== "parameter") continue; // self_parameter is not a named param
    const pat = p.childForFieldName("pattern");
    if (pat) patternIdentifiers(pat, out);
  }
  return out;
}

type Ctx = {
  mods: string[];
  container?: string;
  fnPath: string[];
  params?: Set<string>;
  lets?: Set<string>;
};

function typeName(t: Node | null): string {
  if (!t) return "";
  if (t.type === "generic_type")
    return t.childForFieldName("type")?.text ?? t.text;
  return t.text;
}

/** Position + name of the callee token (unique per call even for `a().b()` and `f()()`). */
function calleeInfo(
  fnNode: Node,
  argsNode: Node | null,
): { name: string; at: Node } {
  switch (fnNode.type) {
    case "field_expression": {
      const f = fnNode.childForFieldName("field")!;
      return { name: f.text, at: f };
    }
    case "scoped_identifier": {
      const n = fnNode.childForFieldName("name")!;
      return { name: n.text, at: n };
    }
    case "identifier":
      return { name: fnNode.text, at: fnNode };
    case "generic_function":
      return calleeInfo(fnNode.childForFieldName("function")!, argsNode);
    default:
      return { name: "", at: argsNode ?? fnNode };
  }
}

function receiverKind(value: Node, ctx: Ctx): Category {
  if (value.type === "self") return "self-method";
  if (value.type === "field_expression") {
    let base: Node = value;
    while (base.type === "field_expression")
      base = base.childForFieldName("value")!;
    if (base.type === "self") return "field-method";
    return "chained-method";
  }
  if (value.type === "identifier") {
    if (ctx.params?.has(value.text)) return "param-method"; // param wins over shadowing let
    if (ctx.lets?.has(value.text)) return "local-method";
  }
  return "chained-method";
}

function classifyCall(call: Node, ctx: Ctx): Category {
  let fnNode = call.childForFieldName("function")!;
  let generic = false;
  if (fnNode.type === "generic_function") {
    generic = true;
    fnNode = fnNode.childForFieldName("function")!;
  }
  if (fnNode.type === "field_expression")
    return receiverKind(fnNode.childForFieldName("value")!, ctx);
  if (fnNode.type === "scoped_identifier") {
    const path = fnNode.childForFieldName("path");
    const name = fnNode.childForFieldName("name")!.text;
    if (path?.type === "bracketed_type") return "qualified-trait"; // beats path-generic
    if (generic || path?.type === "generic_type") return "path-generic";
    if (isUpper(name)) return "bare-closure-or-ctor"; // Enum::Variant(..) / Tuple::Struct(..)
    const last =
      path?.type === "scoped_identifier"
        ? path.childForFieldName("name")!.text
        : (path?.text ?? "");
    if (last === "Self") return "assoc-Self";
    if (isUpper(last)) return "assoc-Type";
    return "path-module";
  }
  if (fnNode.type === "identifier") {
    if (generic) return "path-generic";
    const t = fnNode.text;
    if (isUpper(t)) return "bare-closure-or-ctor";
    if (ctx.params?.has(t) || ctx.lets?.has(t)) return "bare-closure-or-ctor"; // calling a local binding
    return "bare-fn";
  }
  return "bare-closure-or-ctor"; // (self.f)(x), f()(x), xs[0](x), closure literal
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").slice(0, 200);

/** Count call-like token runs inside a macro token_tree (they are never enumerated). */
function countHidden(tt: Node): number {
  let n = 0;
  const kids = tt.children;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.type === "call_expression") n++;
    if (k.type === "token_tree") n += countHidden(k);
    else if (k.type === "identifier") {
      const next = kids[i + 1];
      if (next?.type === "token_tree" && next.firstChild?.type === "(") n++;
      else if (next?.type === "!" && kids[i + 2]?.type === "token_tree") n++;
    }
  }
  return n;
}

export function enumerateCallSites(
  source: string,
  file: string,
  repo = "",
): { sites: CallSite[]; hiddenInMacro: number } {
  const sites: CallSite[] = [];
  let hidden = 0;
  const visit = (node: Node, ctx: Ctx) => {
    for (const c of node.namedChildren) {
      let next = ctx;
      if (c.type === "mod_item") {
        const name = c.childForFieldName("name")?.text ?? "";
        next = { mods: [...ctx.mods, name], fnPath: [] };
      } else if (c.type === "impl_item") {
        next = {
          mods: ctx.mods,
          container: typeName(c.childForFieldName("type")),
          fnPath: [],
        };
      } else if (c.type === "trait_item") {
        next = {
          mods: ctx.mods,
          container: c.childForFieldName("name")?.text,
          fnPath: [],
        };
      } else if (c.type === "function_item") {
        const lets = new Set<string>();
        const body = c.childForFieldName("body");
        if (body) collectLets(body, lets);
        next = {
          mods: ctx.mods,
          container: ctx.container,
          fnPath: [...ctx.fnPath, c.childForFieldName("name")?.text ?? ""],
          params: collectParams(c),
          lets,
        };
      } else if (ctx.params && c.type === "call_expression") {
        const fnNode = c.childForFieldName("function")!;
        const { name, at } = calleeInfo(
          fnNode,
          c.childForFieldName("arguments"),
        );
        sites.push(record(c, at, name, classifyCall(c, ctx), ctx));
      } else if (ctx.params && c.type === "macro_invocation") {
        const m = c.childForFieldName("macro") ?? c.firstNamedChild!;
        const name =
          m.type === "scoped_identifier"
            ? m.childForFieldName("name")!.text
            : m.text;
        sites.push(record(c, m, name, "macro-invocation", ctx));
        for (const tt of c.namedChildren)
          if (tt.type === "token_tree") hidden += countHidden(tt);
        continue; // never descend into the token_tree
      } else if (c.type === "token_tree") {
        if (ctx.params) hidden += countHidden(c);
        continue;
      }
      visit(c, next);
    }
  };
  const record = (
    c: Node,
    at: Node,
    name: string,
    category: Category,
    ctx: Ctx,
  ): CallSite => ({
    repo,
    file,
    line: at.startPosition.row + 1,
    col: at.startPosition.column,
    callerQualifiedName: [
      ...ctx.mods,
      ...(ctx.container ? [ctx.container] : []),
      ...ctx.fnPath,
    ].join("::"),
    callText: oneLine(c.text),
    calleeName: name,
    category,
  });
  visit(parse(source).rootNode, { mods: [], fnPath: [] });
  return { sites, hiddenInMacro: hidden };
}

/** `dev` when the first 4 hex digits of sha1("<repo>:<file>:<line>:<col>") as an integer % 10 < 6. */
export function splitFor(
  repo: string,
  file: string,
  line: number,
  col: number,
): "dev" | "held-out" {
  const n = parseInt(sha1(`${repo}:${file}:${line}:${col}`).slice(0, 4), 16);
  return n % 10 < 6 ? "dev" : "held-out";
}
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const TARGET = 30;
export function quotaFor(count: number, total: number): number {
  if (count <= 3) return count;
  return Math.min(5, Math.max(1, Math.round((TARGET * count) / total)));
}

/** Sites may span repos; output order: repo (first seen), category (schema order), sha1 ascending. */
export function selectSample(all: CallSite[]): SampleEntry[] {
  const repos = [...new Set(all.map((s) => s.repo))];
  const out: SampleEntry[] = [];
  for (const repo of repos) {
    const mine = all.filter((s) => s.repo === repo);
    for (const category of CATEGORIES) {
      const inCat = mine.filter((s) => s.category === category);
      const keyed = inCat
        .map((s) => ({ s, h: sha1(`${s.repo}:${s.file}:${s.line}:${s.col}`) }))
        .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
      for (const { s } of keyed.slice(0, quotaFor(inCat.length, mine.length)))
        out.push({ ...s, split: splitFor(s.repo, s.file, s.line, s.col) });
    }
  }
  return out;
}

/** Method names declared in `trait_item`s (signatures and default bodies), as `Trait::method`. */
export function collectTraitMethods(source: string): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.type === "trait_item") {
      const t = n.childForFieldName("name")?.text ?? "";
      for (const m of n.childForFieldName("body")?.namedChildren ?? [])
        if (m.type === "function_signature_item" || m.type === "function_item")
          out.push(`${t}::${m.childForFieldName("name")?.text ?? ""}`);
    }
    for (const c of n.namedChildren) walk(c);
  };
  walk(parse(source).rootNode);
  return out;
}

export type TraitEntry = SampleEntry & {
  supplement: "trait-candidate";
  traitMethods: string[];
};
const SUPPLEMENT_CAP = 12;

/** One repo: sites whose callee name is a trait method name, minus macros and already-sampled `file:line:col` keys. */
export function selectTraitSupplement(
  repo: string,
  sites: CallSite[],
  traitMethods: string[],
  mainKeys: Set<string>,
): { candidates: number; dropped: number; entries: TraitEntry[] } {
  const byName = new Map<string, string[]>();
  for (const tm of [...new Set(traitMethods)].sort()) {
    const name = tm.slice(tm.lastIndexOf("::") + 2);
    byName.set(name, [...(byName.get(name) ?? []), tm]);
  }
  const cand = sites.filter(
    (s) =>
      s.repo === repo &&
      s.category !== "macro-invocation" &&
      byName.has(s.calleeName),
  );
  const fresh = cand.filter(
    (s) => !mainKeys.has(`${s.file}:${s.line}:${s.col}`),
  );
  const entries = fresh
    .map((s) => ({ s, h: sha1(`${s.repo}:${s.file}:${s.line}:${s.col}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
    .slice(0, SUPPLEMENT_CAP)
    .map(({ s }) => ({
      ...s,
      split: splitFor(s.repo, s.file, s.line, s.col),
      supplement: "trait-candidate" as const,
      traitMethods: byName.get(s.calleeName)!,
    }));
  return {
    candidates: cand.length,
    dropped: cand.length - fresh.length,
    entries,
  };
}

function rustFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  const entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const e of entries) {
    if (e.name === ".git" || e.name === "target") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...rustFiles(dir, r));
    else if (e.name.endsWith(".rs")) out.push(r);
  }
  return out;
}

function main() {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const repos: Array<{ id: string; source: string }> = JSON.parse(
    readFileSync(join(root, "benchmarks/rust-repositories.json"), "utf8"),
  );
  const supplement = process.argv.includes("--supplement");
  if (
    supplement &&
    process.argv[process.argv.indexOf("--supplement") + 1] !==
      "trait-candidates"
  )
    throw new Error("usage: --supplement trait-candidates");
  const all: CallSite[] = [];
  const traitByRepo: Record<string, string[]> = {};
  const counts: Record<
    string,
    Record<string, number> & { total: number; hiddenInMacro: number }
  > = {};
  for (const r of repos) {
    const dir = join(root, r.source);
    let hidden = 0;
    const mine: CallSite[] = [];
    for (const file of rustFiles(dir)) {
      const res = enumerateCallSites(
        readFileSync(join(dir, file), "utf8"),
        file,
        r.id,
      );
      mine.push(...res.sites);
      if (supplement)
        (traitByRepo[r.id] ??= []).push(
          ...collectTraitMethods(readFileSync(join(dir, file), "utf8")),
        );
      hidden += res.hiddenInMacro;
    }
    const keys = new Set(mine.map((s) => `${s.file}:${s.line}:${s.col}`));
    if (keys.size !== mine.length)
      throw new Error(`${r.id}: duplicate call-site positions`);
    const c: any = { total: mine.length, hiddenInMacro: hidden };
    for (const cat of CATEGORIES)
      c[cat] = mine.filter((s) => s.category === cat).length;
    if (CATEGORIES.reduce((n, cat) => n + c[cat], 0) !== c.total)
      throw new Error(`${r.id}: categories do not partition the sites`);
    counts[r.id] = c;
    all.push(...mine);
  }
  const outDir = join(root, "benchmarks/rust-semantic-calls");
  mkdirSync(outDir, { recursive: true });
  if (supplement) {
    const main = JSON.parse(
      readFileSync(join(outDir, "sample.json"), "utf8"),
    ) as CallSite[];
    const mainKeys = new Set(
      main.map((s) => `${s.repo}:${s.file}:${s.line}:${s.col}`),
    );
    const out: TraitEntry[] = [];
    for (const r of repos) {
      const tm = traitByRepo[r.id] ?? [];
      const res = selectTraitSupplement(
        r.id,
        all,
        tm,
        new Set(
          [...mainKeys]
            .filter((k) => k.startsWith(`${r.id}:`))
            .map((k) => k.slice(r.id.length + 1)),
        ),
      );
      const dev = res.entries.filter((e) => e.split === "dev").length;
      console.log(
        `${r.id}: traitMethods=${JSON.stringify([...new Set(tm)].sort())} candidates=${res.candidates} dropped=${res.dropped} taken=${res.entries.length} dev=${dev} held-out=${res.entries.length - dev}`,
      );
      out.push(...res.entries);
    }
    const rows = out.map((s) => ({
      repo: s.repo,
      file: s.file,
      line: s.line,
      col: s.col,
      callerQualifiedName: s.callerQualifiedName,
      callText: s.callText,
      calleeName: s.calleeName,
      category: s.category,
      split: s.split,
      supplement: s.supplement,
      traitMethods: s.traitMethods,
    }));
    writeFileSync(
      join(outDir, "sample-trait.json"),
      JSON.stringify(rows, null, 2) + "\n",
    );
    return;
  }
  const sample = selectSample(all).map((s) => ({
    repo: s.repo,
    file: s.file,
    line: s.line,
    col: s.col,
    callerQualifiedName: s.callerQualifiedName,
    callText: s.callText,
    calleeName: s.calleeName,
    category: s.category,
    split: s.split,
  }));
  writeFileSync(
    join(outDir, "sample.json"),
    JSON.stringify(sample, null, 2) + "\n",
  );
  writeFileSync(
    join(outDir, "counts.json"),
    JSON.stringify(counts, null, 2) + "\n",
  );
  console.log(JSON.stringify(counts, null, 2));
  console.log(`sample: ${sample.length}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
