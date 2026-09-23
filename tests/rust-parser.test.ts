import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseRust } from "../src/languages/rust/parse.js";

function fixture(name: string) {
  return readFileSync(join(process.cwd(), "tests/fixtures/rust", name), "utf8");
}

test("extracts functions with async and visibility metadata", () => {
  const { symbols, parseError } = parseRust(
    "functions.rs",
    fixture("functions.rs"),
  );
  assert.equal(parseError, false);
  const create = symbols.find((s) => s.name === "create_order");
  assert.ok(create, "create_order not found");
  assert.equal(create!.kind, "function");
  assert.ok(create!.modifiers.includes("pub"));
  assert.equal(create!.metadata?.async, undefined);

  const fetch = symbols.find((s) => s.name === "fetch_order");
  assert.ok(fetch);
  assert.equal(fetch!.metadata?.async, true);
  assert.equal(fetch!.modifiers.includes("pub"), false);

  const helper = symbols.find((s) => s.name === "helper");
  assert.ok(helper);
});

test("extracts structs, tuple structs, and enums", () => {
  const { symbols } = parseRust(
    "structs_enums.rs",
    fixture("structs_enums.rs"),
  );
  const order = symbols.find((s) => s.name === "Order" && s.kind === "class");
  assert.ok(order);
  assert.ok(order!.modifiers.includes("pub"));

  const userId = symbols.find((s) => s.name === "UserId");
  assert.ok(userId, "tuple struct UserId not found");
  assert.equal(userId!.kind, "class");

  const status = symbols.find((s) => s.name === "Status" && s.kind === "enum");
  assert.ok(status);
});

test("extracts traits and links inherent + trait impl methods to their impl block", () => {
  const { symbols } = parseRust(
    "traits_impls.rs",
    fixture("traits_impls.rs"),
  );
  const repository = symbols.find((s) => s.name === "Repository" && s.kind === "interface");
  assert.ok(repository);

  // Trait method with a body still nests under the trait (it's a default method).
  const find = symbols.find((s) => s.name === "find" && s.parentId === repository!.id);
  assert.ok(find, "default trait method 'find' not nested under trait");

  const postgresStruct = symbols.find(
    (s) => s.name === "PostgresRepository" && s.kind === "class",
  );
  assert.ok(postgresStruct);

  // Two impl blocks for the same type: inherent (new, connect) and trait (save).
  const newMethod = symbols.find((s) => s.name === "new" && s.kind === "function");
  const connectMethod = symbols.find((s) => s.name === "connect" && s.kind === "function");
  const saveMethod = symbols.find((s) => s.name === "save" && s.kind === "function");
  assert.ok(newMethod && connectMethod && saveMethod);
  // Methods from different impl blocks must have different parentIds
  // (each impl_item is its own symbol; methods nest under it, not under the struct).
  assert.notEqual(newMethod!.parentId, saveMethod!.parentId);
  assert.equal(newMethod!.parentId, connectMethod!.parentId);
});

test("extracts modules (declaration and inline) with nested items, and const/static/type", () => {
  const { symbols } = parseRust("modules.rs", fixture("modules.rs"));

  const serviceMod = symbols.find((s) => s.name === "service" && s.kind === "namespace");
  assert.ok(serviceMod, "'mod service;' declaration not indexed");

  const repositoryMod = symbols.find((s) => s.name === "repository" && s.kind === "namespace");
  assert.ok(repositoryMod, "inline 'mod repository { ... }' not indexed");

  const inMemory = symbols.find((s) => s.name === "InMemoryRepository" && s.kind === "class");
  assert.ok(inMemory);
  assert.equal(inMemory!.parentId, repositoryMod!.id, "struct not nested under its module");

  const maxRetries = symbols.find((s) => s.name === "MAX_RETRIES");
  assert.ok(maxRetries, "const not indexed");

  const counter = symbols.find((s) => s.name === "COUNTER");
  assert.ok(counter, "static not indexed");

  const orderIdAlias = symbols.find((s) => s.name === "OrderId");
  assert.ok(orderIdAlias, "type alias not indexed");
});

test("large-file parser regression: a big Rust file parses without silent skips", () => {
  const bigSource = Array.from(
    { length: 60 },
    (_, i) => `pub fn generated_fn_${i}() -> u32 { ${i} }`,
  ).join("\n\n");
  const { symbols, parseError } = parseRust("big.rs", bigSource);
  assert.equal(parseError, false);
  const generated = symbols.filter((s) => s.name.startsWith("generated_fn_"));
  assert.equal(generated.length, 60, "not every generated function was indexed");
});
