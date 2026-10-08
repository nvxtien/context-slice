import type { SymbolRecord } from "../../../types/model.js";
import type {
  EnterpriseRelation,
  EnterpriseRelationConfidence,
} from "../../../types/enterprise.js";
import { registerEnterpriseExtractor } from "./registry.js";
import { bareName, header } from "./shared.js";

/**
 * Spring MVC mapping annotation -> HTTP method label. A bare @RequestMapping's
 * `method = RequestMethod.X` attribute is out of scope for this phase (known
 * limitation): every @RequestMapping, regardless of any method= attribute,
 * maps to "REQUEST" rather than being parsed into a real verb.
 */
const MAPPING_ANNOTATIONS: Record<string, string> = {
  RequestMapping: "REQUEST",
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};
const CONST_RE_TEMPLATE = (name: string) =>
  new RegExp(
    `(?:static\\s+final|final\\s+static)\\s+String\\s+${name}\\s*=\\s*"([^"]*)"`,
  );

/**
 * Matches ONE specific, already-AST-confirmed mapping annotation's own argument text.
 * Detection of WHICH annotation (if any) is present happens via SymbolRecord.annotations,
 * never via this regex — this only ever runs to extract an argument list for an annotation
 * name already known to be real, eliminating the false-positive risk a generic multi-name
 * scan over raw text would have (e.g. matching annotation-shaped text inside a comment).
 * The optional `(?:[\w.]+\.)?` prefix tolerates a fully-qualified annotation name (e.g.
 * "@org.springframework.web.bind.annotation.GetMapping(...)") the same way bareName()
 * already tolerates one for detection — without it, a qualified annotation would be
 * correctly DETECTED (via .annotations) but its argument text would never be found,
 * silently downgrading every qualified-annotation route to a path-less "probable" result
 * instead of the fully-resolved "exact" one it should get.
 */
function mappingArgsRegex(name: string): RegExp {
  return new RegExp(`@(?:[\\w.]+\\.)?${name}(?:\\(([^)]*)\\))?`);
}

type PathResolution =
  | { kind: "absent" }
  | { kind: "literal"; value: string }
  | { kind: "const"; value: string }
  | { kind: "array"; value: string }
  | { kind: "unresolved"; raw: string };

/**
 * Resolves a mapping annotation's argument text to a path.
 * - A quoted string literal is exact.
 * - A same-class `static final String NAME = "literal"` constant resolves through
 *   one hop, downgrading confidence to at most "probable".
 * - An array literal (`{"/a", "/b"}`, including a single-element `{"/a"}`) is never
 *   treated as an unambiguous single route; its first element resolves through the
 *   same "probable" downgrade as a const hop, with the raw `{...}` text kept in
 *   evidence so a developer can see it was an array.
 * - Anything else (a call, a qualified constant, a placeholder) is unresolved;
 *   the raw expression is kept for evidence/targetLabel, never guessed into a path.
 */
function resolvePath(
  rawInside: string | undefined,
  classSource: string,
): PathResolution {
  if (rawInside === undefined) return { kind: "absent" };
  let text = rawInside.trim();
  if (text === "") return { kind: "absent" };

  // produces=/consumes=/a bare method= attribute (no value=/path= alongside it) isn't a
  // path argument at all — treat it the same as no path, never as a fabricated route.
  if (
    /^(?:produces|consumes|method)\s*=/.test(text) &&
    !/\b(?:value|path)\s*=/.test(text)
  ) {
    return { kind: "absent" };
  }

  text = text.replace(/^(?:value|path)\s*=\s*/, "").trim();

  // An array literal (`{"/a", "/b"}`) is never a single exact route — take the first
  // element but downgrade to "probable" (like a const hop), never "exact".
  if (text.startsWith("{")) {
    const firstElement = text.match(/"([^"]*)"/);
    if (firstElement) return { kind: "array", value: firstElement[1] };
    return { kind: "unresolved", raw: text };
  }

  // Only a literal that IS the whole argument value counts — not string concatenation
  // (`Paths.P + "/x"`) or a quoted substring buried inside other tokens.
  const quoted = text.match(/^"([^"]*)"$/);
  if (quoted) return { kind: "literal", value: quoted[1] };

  const identMatch = text.match(/^([A-Za-z_$][\w$]*)$/);
  if (identMatch) {
    const match = classSource.match(CONST_RE_TEMPLATE(identMatch[1]));
    if (match) return { kind: "const", value: match[1] };
  }
  return { kind: "unresolved", raw: text };
}

function joinPaths(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
}

function describeAnnotation(
  name: string,
  rawInside: string | undefined,
  kind: string,
  symbolName: string,
): string {
  const args = rawInside !== undefined ? `(${rawInside.trim()})` : "";
  return `@${name}${args} on ${kind} ${symbolName}`;
}

function extractSpringMvcRelations(
  symbols: SymbolRecord[],
  filePath: string,
  source: string,
): EnterpriseRelation[] {
  const relations: EnterpriseRelation[] = [];
  const classes = symbols.filter((s) => s.kind === "class");

  for (const method of symbols.filter((s) => s.kind === "method")) {
    const parent = classes.find((c) => c.id === method.parentId);
    const methodAnnotationName = method.annotations
      .map(bareName)
      .find((name) => name in MAPPING_ANNOTATIONS);
    if (!methodAnnotationName) continue; // not a handler: no annotation spam for non-mapped methods

    const httpMethod = MAPPING_ANNOTATIONS[methodAnnotationName];
    const methodMatch = header(method).match(
      mappingArgsRegex(methodAnnotationName),
    );
    const classSourceForConstants = parent?.source ?? "";
    const methodResolution = resolvePath(
      methodMatch?.[1],
      classSourceForConstants,
    );

    const evidence: string[] = [];
    let classAnnotationName: string | undefined;
    let classRawInside: string | undefined;
    if (parent) {
      classAnnotationName = parent.annotations
        .map(bareName)
        .find((name) => name in MAPPING_ANNOTATIONS);
      if (classAnnotationName) {
        const classMatch = header(parent).match(
          mappingArgsRegex(classAnnotationName),
        );
        classRawInside = classMatch?.[1];
        evidence.push(
          describeAnnotation(
            classAnnotationName,
            classRawInside,
            "class",
            parent.name,
          ),
        );
      }
    }
    evidence.push(
      describeAnnotation(
        methodAnnotationName,
        methodMatch?.[1],
        "method",
        method.name,
      ),
    );

    let confidence: EnterpriseRelationConfidence;
    let targetLabel: string | undefined;

    const classResolution: PathResolution = classAnnotationName
      ? resolvePath(classRawInside, classSourceForConstants)
      : { kind: "absent" };

    if (methodResolution.kind === "unresolved") {
      confidence = "unresolved";
      targetLabel = methodResolution.raw;
    } else if (classResolution.kind === "unresolved") {
      confidence = "unresolved";
      targetLabel = classResolution.raw;
    } else {
      const classPath =
        classResolution.kind === "absent" ? "" : classResolution.value;
      const methodPath =
        methodResolution.kind === "absent" ? "" : methodResolution.value;
      const usedConstOrArrayHop =
        classResolution.kind === "const" ||
        methodResolution.kind === "const" ||
        classResolution.kind === "array" ||
        methodResolution.kind === "array";
      // No path text resolved anywhere (e.g. a produces=-only mapping with no class prefix):
      // never claim "exact" for a route that has no actual path evidence behind it.
      const noPathAtAll = classPath === "" && methodPath === "";
      confidence = usedConstOrArrayHop || noPathAtAll ? "probable" : "exact";
      targetLabel =
        `${httpMethod} ${joinPaths(classPath, methodPath)}`.trimEnd();
    }

    relations.push({
      kind: "ROUTE_TO_HANDLER",
      family: "spring-mvc",
      sourceSymbolId: method.id,
      targetLabel,
      confidence,
      evidence,
      range: method.range,
      filePath,
    });
  }

  return relations;
}

registerEnterpriseExtractor(extractSpringMvcRelations);
