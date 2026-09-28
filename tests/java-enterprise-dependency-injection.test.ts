import assert from "node:assert/strict";
import test from "node:test";
import { parseJava } from "../src/parser/java-parser.js";
import { extractEnterpriseRelations, resolveEnterpriseRelations } from "../src/languages/java/enterprise/registry.js";
import { resolveBeanType } from "../src/languages/java/enterprise/dependency-injection.js"; // also registers the extractor

function relationsFor(source: string, filePath = "src/main/java/OrderService.java") {
  const { symbols } = parseJava(filePath, source);
  return { symbols, relations: resolved(symbols, filePath, source) };
}

// Two-phase: per-file extraction is provisional; bean identity resolves in the project-wide post-pass.
function resolved(allSymbols: ReturnType<typeof parseJava>["symbols"], filePath: string, source: string) {
  return resolveEnterpriseRelations(extractEnterpriseRelations(allSymbols, filePath, source), allSymbols);
}

test("constructor injection resolves a unique project type as exact", () => {
  const source = `
class OrderRepository {}
@Service
class OrderService {
    private final OrderRepository repo;
    OrderService(OrderRepository repo) { this.repo = repo; }
}
`;
  const { symbols, relations } = relationsFor(source);
  const ctor = symbols.find((s) => s.kind === "constructor")!;
  const repoType = symbols.find((s) => s.kind === "class" && s.name === "OrderRepository")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === ctor.id)!;
  assert.ok(rel, "expected a constructor-injection relation");
  assert.equal(rel.targetLabel, "OrderRepository");
  assert.equal(rel.targetSymbolId, repoType.id);
  assert.equal(rel.confidence, "exact");
  assert.match(rel.evidence.join(" "), /constructor parameter/);
});

test("field injection resolves via the enclosing class (even though fields are now symbols)", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Autowired
    private PaymentGateway gateway;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id)!;
  assert.equal(rel.targetLabel, "PaymentGateway");
  assert.equal(rel.confidence, "exact");
  assert.match(rel.evidence.join(" "), /@Autowired field/);
});

test("explicit setter injection attributes to the setter method symbol", () => {
  const source = `
class Notifier {}
class Alerts {
    private Notifier notifier;
    @Autowired
    void setNotifier(Notifier notifier) { this.notifier = notifier; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Alerts.java");
  const setter = symbols.find((s) => s.kind === "method" && s.name === "setNotifier")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === setter.id)!;
  assert.equal(rel.targetLabel, "Notifier");
  assert.equal(rel.confidence, "exact");
  assert.match(rel.evidence.join(" "), /setter/);
});

test("a type matching zero project symbols produces no relation", () => {
  const source = `
class Checkout {
    @Autowired
    private RestTemplate client;
}
`;
  const { relations } = relationsFor(source, "src/main/java/Checkout.java");
  assert.equal(relations.length, 0);
});

test("an ambiguous type with no qualifier is unresolved, never guessed", () => {
  const source = `
class Validator {}
@Service
class Checkout {
    private final Validator v;
    Checkout(Validator v) { this.v = v; }
}
`;
  // A second, differently-scoped Validator to force real ambiguity across the file set —
  // simulate via a second file's symbols merged in, since parseJava is per-file: build the
  // relations call with a combined symbol list from two separate parses.
  const first = parseJava("src/main/java/other/Validator.java", "package other;\nclass Validator {}");
  const { symbols: checkoutSymbols } = parseJava("src/main/java/Checkout.java", source);
  const allSymbols = [...first.symbols, ...checkoutSymbols];
  const relations = resolved(allSymbols, "src/main/java/Checkout.java", source);
  const ctor = checkoutSymbols.find((s) => s.kind === "constructor")!;
  const rel = relations.find((r) => r.sourceSymbolId === ctor.id)!;
  assert.equal(rel.confidence, "unresolved");
  assert.equal(rel.targetSymbolId, undefined);
});

// Deviation from the brief's draft test (which expected the same-file Validator to win):
// candidates are found BY simple name, so every candidate shares the type's simple name and a
// @Qualifier equal to it can never single one out. Picking the same-file class would be an
// invented winner (§13), so this stays unresolved, with the qualifier kept as evidence.
test("a @Qualifier equal to the shared simple name cannot break a tie, so stays unresolved", () => {
  const first = parseJava("src/main/java/other/Validator.java", "package other;\nclass Validator {}");
  const source = `
class Validator {}
@Service
class Checkout {
    Checkout(@Qualifier("Validator") Validator v) {}
}
`;
  const { symbols: checkoutSymbols } = parseJava("src/main/java/Checkout.java", source);
  const allSymbols = [...first.symbols, ...checkoutSymbols];
  const relations = resolved(allSymbols, "src/main/java/Checkout.java", source);
  const ctor = checkoutSymbols.find((s) => s.kind === "constructor")!;
  const rel = relations.find((r) => r.sourceSymbolId === ctor.id)!;
  assert.equal(rel.confidence, "unresolved");
  assert.equal(rel.targetSymbolId, undefined);
  assert.match(rel.evidence.join(" "), /@Qualifier\("Validator"\)/);
});

test("resolveBeanType: unique -> exact, zero -> none, tie -> unresolved", () => {
  const types = parseJava("A.java", "class Fast {}\nclass Slow {}\nclass Fast2 {}").symbols;
  const dup = { ...types[0], id: "other::Fast" };
  assert.equal(resolveBeanType("Fast", [...types, dup])?.confidence, "unresolved");
  assert.deepEqual(resolveBeanType("Fast", [...types, dup]), { confidence: "unresolved" });
  assert.deepEqual(resolveBeanType("Slow", types), { confidence: "exact", targetSymbolId: types[1].id });
  assert.equal(resolveBeanType("Nope", types), undefined);
});

test("both constructor and field injection on the same class produce distinct relations", () => {
  const source = `
class Repo {}
class Gateway {}
@Service
class Service {
    private final Repo repo;
    @Autowired
    private Gateway gateway;
    Service(Repo repo) { this.repo = repo; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Service.java");
  const ctor = symbols.find((s) => s.kind === "constructor")!;
  const cls = symbols.find((s) => s.kind === "class" && s.name === "Service")!;
  assert.ok(relations.find((r) => r.sourceSymbolId === ctor.id && r.targetLabel === "Repo"));
  assert.ok(relations.find((r) => r.sourceSymbolId === cls.id && r.targetLabel === "Gateway"));
});

test("@Autowired inside a comment produces no relation", () => {
  const source = `
class Widget {}
class Screen {
    // example: @Autowired
    private Widget widget;
}
`;
  const { relations } = relationsFor(source, "src/main/java/Screen.java");
  assert.equal(relations.length, 0);
});

test("@Autowired on a local variable inside a method body produces no relation", () => {
  const source = `
class Widget {}
class Screen {
    void run() {
        @Autowired Widget w = null;
    }
}
`;
  const { relations } = relationsFor(source, "src/main/java/Screen.java");
  assert.equal(relations.length, 0);
});

test("a qualifier matching no candidate stays unresolved", () => {
  const first = parseJava("src/main/java/other/Validator.java", "package other;\nclass Validator {}");
  const source = `
class Validator {}
class Checkout {
    @Autowired @Qualifier("strict") private Validator v;
}
`;
  const { symbols } = parseJava("src/main/java/Checkout.java", source);
  const relations = resolved([...first.symbols, ...symbols], "src/main/java/Checkout.java", source);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].confidence, "unresolved");
  assert.equal(relations[0].targetSymbolId, undefined);
  assert.match(relations[0].evidence.join(" "), /@Qualifier\("strict"\)/);
});

test("ProjectIndex resolves bean identity across files in its post-pass", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ProjectIndex } = await import("../src/indexer/index.js");
  const root = mkdtempSync(join(tmpdir(), "di-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/Service.java"), "@Service\nclass Service {\n  Service(Repo r) {}\n}\n");
  writeFileSync(join(root, "src/Repo.java"), "interface Repo {}\n");
  const index = new ProjectIndex(root);
  index.rebuild();
  const rel = index.enterpriseRelations.find((r) => r.kind === "INJECTS_DEPENDENCY")!;
  const repo = index.symbols.find((s) => s.name === "Repo")!;
  assert.equal(rel.confidence, "exact");
  assert.equal(rel.targetSymbolId, repo.id);
});

test("stereotyped class: unannotated constructor injection resolves", () => {
  const source = `
class OrderRepository {}
@Service
class OrderService {
    OrderService(OrderRepository repo) {}
}
`;
  const { symbols, relations } = relationsFor(source);
  const ctor = symbols.find((s) => s.kind === "constructor")!;
  assert.equal(relations.length, 1);
  assert.equal(relations[0].sourceSymbolId, ctor.id);
  assert.equal(relations[0].confidence, "exact");
});

test("plain class constructor taking a project type is not injection", () => {
  const source = `
class Customer {}
class Order {
    Order(Customer c) {}
}
`;
  const { relations } = relationsFor(source, "src/main/java/Order.java");
  assert.equal(relations.length, 0);
});

test("non-stereotyped class with an @Autowired constructor resolves, once", () => {
  const source = `
class Repo {}
class Helper {
    @Autowired
    Helper(Repo r) {}
}
`;
  const { relations } = relationsFor(source, "src/main/java/Helper.java");
  assert.equal(relations.length, 1);
  assert.equal(relations[0].targetLabel, "Repo");
  assert.equal(relations[0].confidence, "exact");
});

test("a field injected via @Inject resolves the same as @Autowired", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Inject
    private PaymentGateway gateway;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id)!;
  assert.ok(rel, "expected an @Inject field-injection relation");
  assert.equal(rel.targetLabel, "PaymentGateway");
  assert.match(rel.evidence.join(" "), /@Inject field/);
});

test("a field injected via @Resource resolves the same as @Autowired", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Resource
    private PaymentGateway gateway;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id)!;
  assert.ok(rel, "expected an @Resource field-injection relation");
  assert.equal(rel.targetLabel, "PaymentGateway");
  assert.match(rel.evidence.join(" "), /@Resource field/);
});

test("a multi-declarator field sharing an @Qualifier still detects the injection but loses the qualifier value (accepted divergence)", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Autowired @Qualifier("strict")
    private PaymentGateway a, b;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const diRelations = relations.filter((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id);
  assert.equal(diRelations.length, 2, "both declarators must still be detected as injection points");
  for (const rel of diRelations) {
    assert.equal(rel.targetLabel, "PaymentGateway");
    assert.doesNotMatch(rel.evidence.join(" "), /@Qualifier/, "multi-declarator fields cannot recover the shared qualifier's value (accepted divergence, see spec)");
  }
});

test("a multi-line @Autowired-with-arguments field is not lost (AST-native immunity inherited from Phase 0)", () => {
  const source = `
class PaymentGateway {}
class Checkout {
    @Autowired(
        required = false
    )
    private PaymentGateway gateway;
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Checkout.java");
  const checkoutClass = symbols.find((s) => s.kind === "class" && s.name === "Checkout")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === checkoutClass.id)!;
  assert.ok(rel, "a multi-line annotation argument must not hide the field injection");
  assert.equal(rel.targetLabel, "PaymentGateway");
});

test("a multi-line @Autowired-with-arguments setter is not lost", () => {
  const source = `
class Notifier {}
class Alerts {
    private Notifier notifier;
    @Autowired(
        required = false
    )
    void setNotifier(Notifier notifier) { this.notifier = notifier; }
}
`;
  const { symbols, relations } = relationsFor(source, "src/main/java/Alerts.java");
  const setter = symbols.find((s) => s.kind === "method" && s.name === "setNotifier")!;
  const rel = relations.find((r) => r.kind === "INJECTS_DEPENDENCY" && r.sourceSymbolId === setter.id)!;
  assert.ok(rel, "a multi-line annotation argument must not hide the setter injection");
  assert.equal(rel.targetLabel, "Notifier");
});
