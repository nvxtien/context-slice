import Parser from "tree-sitter";
import Python from "tree-sitter-python";
export const LANGUAGE_ID = "python";
let parser;
function pythonParser() {
    if (!parser) {
        parser = new Parser();
        parser.setLanguage(Python);
    }
    return parser;
}
const range = (node) => ({
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column,
});
const field = (node, name) => node.childForFieldName(name);
const text = (node) => node?.text ?? "";
/** `src/orders/service.py::OrderService::method::create(self, order)` */
function canonicalId(filePath, chain, kind, name, parameters) {
    return [
        filePath,
        ...chain,
        kind,
        parameters === undefined ? name : `${name}(${parameters})`,
    ].join("::");
}
/** Parameter names only: an added annotation must not change a symbol's identity. */
function parameterNames(parameters) {
    if (!parameters)
        return "";
    return parameters.namedChildren
        .map((parameter) => {
        if (parameter.type === "identifier")
            return parameter.text;
        const name = field(parameter, "name") ?? parameter.namedChild(0);
        return text(name);
    })
        .filter(Boolean)
        .join(", ");
}
function parameterSignature(parameters) {
    return parameters ? parameters.text.replace(/^\(|\)$/g, "") : "";
}
const decoratorNames = (node) => node.parent?.type === "decorated_definition"
    ? node.parent.namedChildren
        .filter((child) => child.type === "decorator")
        .map((child) => child.text.replace(/^@/, "").trim())
    : [];
const isAsync = (node) => node.children.some((child) => child.type === "async");
export function parsePython(filePath, source) {
    const symbols = [];
    const calls = [];
    const imports = [];
    const exports = [];
    let parseError = false;
    let tree;
    try {
        // The node binding rejects inputs of 32KB or more, so feed it in chunks.
        tree = pythonParser().parse((index) => source.slice(index, index + 4_096));
    }
    catch {
        return { symbols, calls, imports, exports, parseError: true };
    }
    if (tree.rootNode.hasError)
        parseError = true;
    let moduleSymbol;
    /** Python runs real code at module level; those calls need an owner. */
    const moduleOwner = () => {
        if (!moduleSymbol) {
            moduleSymbol = {
                id: `${filePath}::module::${filePath}`,
                language: LANGUAGE_ID,
                kind: "namespace",
                name: filePath,
                qualifiedName: filePath,
                canonicalIdentity: `${filePath}::module::${filePath}`,
                signature: `module ${filePath}`,
                filePath,
                range: range(tree.rootNode),
                annotations: [],
                modifiers: [],
                metadata: { moduleScope: true },
                source: "",
            };
            symbols.push(moduleSymbol);
        }
        return moduleSymbol;
    };
    const addSymbol = (node, kind, name, chain, options = {}) => {
        const id = canonicalId(filePath, chain, kind, name, options.parameters);
        const body = options.bodyNode ?? undefined;
        const symbol = {
            id,
            language: LANGUAGE_ID,
            kind,
            name,
            qualifiedName: [...chain, name].join("."),
            canonicalIdentity: id,
            signature: options.signature ?? `${kind} ${name}`,
            filePath,
            range: range(node),
            bodyRange: body ? range(body) : undefined,
            parentId: options.parentId,
            supertypes: options.supertypes,
            annotations: options.annotations ?? [],
            modifiers: [],
            metadata: options.metadata,
            source: node.text,
            body: body?.text,
        };
        symbols.push(symbol);
        return symbol;
    };
    // ---- imports -------------------------------------------------------------
    const importStatement = (node) => {
        const base = {
            filePath,
            language: LANGUAGE_ID,
            typeOnly: false,
            range: range(node),
        };
        if (node.type === "import_statement") {
            for (const child of node.namedChildren) {
                if (child.type === "dotted_name")
                    imports.push({
                        ...base,
                        module: child.text,
                        kind: "namespace",
                        localName: child.text.split(".")[0],
                    });
                else if (child.type === "aliased_import")
                    imports.push({
                        ...base,
                        module: text(field(child, "name")),
                        kind: "namespace",
                        localName: text(field(child, "alias")),
                    });
            }
            return;
        }
        const moduleNode = field(node, "module_name");
        const relativeLevel = moduleNode?.type === "relative_import"
            ? (moduleNode.text.match(/^\.+/)?.[0].length ?? 0)
            : 0;
        const module = text(moduleNode);
        const wildcard = node.namedChildren.some((child) => child.type === "wildcard_import");
        if (wildcard) {
            exports.push({
                ...base,
                exportedName: "*",
                fromModule: module,
                wildcard: true,
            });
            imports.push({ ...base, module, kind: "side-effect" });
            return;
        }
        for (const child of node.namedChildren) {
            if (child === moduleNode)
                continue;
            if (child.type === "dotted_name")
                imports.push({
                    ...base,
                    module,
                    importedName: child.text,
                    localName: child.text,
                    kind: "named",
                });
            else if (child.type === "aliased_import")
                imports.push({
                    ...base,
                    module,
                    importedName: text(field(child, "name")),
                    localName: text(field(child, "alias")),
                    kind: "named",
                });
        }
        void relativeLevel;
    };
    // ---- calls ---------------------------------------------------------------
    const addCall = (node, owner) => {
        const callee = field(node, "function");
        if (!callee)
            return;
        const argumentsNode = field(node, "arguments");
        const argumentCount = argumentsNode
            ? argumentsNode.namedChildren.length
            : 0;
        const shared = {
            callerId: owner.id,
            argumentCount,
            filePath,
            language: LANGUAGE_ID,
            range: range(node),
            confidence: "unresolved",
            evidence: [],
        };
        if (callee.type === "identifier") {
            calls.push({
                ...shared,
                calleeName: callee.text,
                resolutionKind: /^[A-Z]/.test(callee.text)
                    ? "constructor"
                    : "unresolved",
            });
            return;
        }
        if (callee.type === "attribute") {
            const object = field(callee, "object");
            const attribute = field(callee, "attribute");
            if (!attribute)
                return;
            // `self.repo.save()` keeps the whole receiver path for field typing.
            const receiverText = object?.type === "identifier"
                ? object.text
                : object?.type === "attribute" &&
                    field(object, "object")?.type === "identifier"
                    ? `${text(field(object, "object"))}.${text(field(object, "attribute"))}`
                    : undefined;
            calls.push({
                ...shared,
                calleeName: attribute.text,
                receiverText,
                resolutionKind: "unresolved",
            });
        }
    };
    // ---- traversal -----------------------------------------------------------
    const walk = (node, owner, chain) => {
        for (const child of node.namedChildren)
            visit(child, owner, chain);
    };
    function classBody(body, chain, parent) {
        if (!body)
            return;
        for (const statement of body.namedChildren) {
            const definition = statement.type === "decorated_definition"
                ? field(statement, "definition")
                : statement;
            if (definition?.type === "function_definition") {
                const name = text(field(definition, "name"));
                const parameters = field(definition, "parameters");
                const decorators = decoratorNames(definition);
                const accessor = decorators.includes("property")
                    ? "getter"
                    : decorators.some((decorator) => decorator.endsWith(".setter"))
                        ? "setter"
                        : undefined;
                const kind = accessor ?? (name === "__init__" ? "constructor" : "method");
                const returns = text(field(definition, "return_type"));
                const symbol = addSymbol(definition, kind, name, chain, {
                    parameters: parameterNames(parameters),
                    signature: `${name}(${parameterSignature(parameters)})${returns ? ` -> ${returns}` : ""}`,
                    parentId: parent.id,
                    annotations: decorators.map((decorator) => `@${decorator}`),
                    bodyNode: field(definition, "body"),
                    metadata: {
                        async: isAsync(definition),
                        classMethod: decorators.includes("classmethod"),
                        staticMethod: decorators.includes("staticmethod"),
                        overloadSignature: decorators.some((decorator) => /(^|\.)overload$/.test(decorator)),
                    },
                });
                walk(field(definition, "body") ?? definition, symbol, [...chain, name]);
                continue;
            }
            // Class-level attributes, including dataclass fields.
            const assignment = statement.type === "expression_statement"
                ? statement.namedChild(0)
                : undefined;
            if (assignment?.type === "assignment") {
                const left = field(assignment, "left");
                if (left?.type === "identifier")
                    addSymbol(assignment, "property", left.text, chain, {
                        parentId: parent.id,
                        signature: assignment.text.split("\n")[0],
                        metadata: {
                            declaredType: text(field(assignment, "type")).trim() || undefined,
                        },
                    });
            }
        }
    }
    function visit(node, owner, chain) {
        switch (node.type) {
            case "import_statement":
            case "import_from_statement":
                importStatement(node);
                return;
            case "decorated_definition":
                visit(field(node, "definition") ?? node, owner, chain);
                return;
            case "class_definition": {
                const name = text(field(node, "name"));
                const bases = field(node, "superclasses");
                const symbol = addSymbol(node, "class", name, chain, {
                    signature: `class ${name}${bases ? bases.text : ""}`,
                    supertypes: bases ? bases.namedChildren.map((base) => base.text) : [],
                    annotations: decoratorNames(node).map((decorator) => `@${decorator}`),
                    bodyNode: field(node, "body"),
                });
                classBody(field(node, "body"), [...chain, name], symbol);
                return;
            }
            case "function_definition": {
                const name = text(field(node, "name"));
                const parameters = field(node, "parameters");
                const returns = text(field(node, "return_type"));
                const symbol = addSymbol(node, "function", name, chain, {
                    parameters: parameterNames(parameters),
                    signature: `${name}(${parameterSignature(parameters)})${returns ? ` -> ${returns}` : ""}`,
                    parentId: owner?.id,
                    annotations: decoratorNames(node).map((decorator) => `@${decorator}`),
                    bodyNode: field(node, "body"),
                    metadata: { async: isAsync(node) },
                });
                walk(field(node, "body") ?? node, symbol, [...chain, name]);
                return;
            }
            case "assignment": {
                const left = field(node, "left");
                const right = field(node, "right");
                if (left?.type === "identifier" && right?.type === "lambda") {
                    const symbol = addSymbol(node, "function", left.text, chain, {
                        parameters: parameterNames(field(right, "parameters")),
                        signature: `${left.text} = lambda ${parameterSignature(field(right, "parameters"))}`,
                        parentId: owner?.id,
                        bodyNode: field(right, "body"),
                    });
                    walk(right, symbol, chain);
                    return;
                }
                // `__all__` is export metadata when it is a plain list of strings.
                if (left?.type === "identifier" && left.text === "__all__" && right)
                    for (const item of right.namedChildren)
                        if (item.type === "string")
                            exports.push({
                                filePath,
                                language: LANGUAGE_ID,
                                exportedName: item.text.replace(/^['"]|['"]$/g, ""),
                                localName: item.text.replace(/^['"]|['"]$/g, ""),
                                typeOnly: false,
                                range: range(node),
                            });
                if (left?.type === "identifier" &&
                    left.text !== "__all__" &&
                    chain.length === 0 &&
                    !owner)
                    addSymbol(node, "variable", left.text, chain, {
                        signature: node.text.split("\n")[0],
                    });
                walk(node, owner, chain);
                return;
            }
            case "call":
                addCall(node, owner ?? moduleOwner());
                walk(node, owner, chain);
                return;
            default:
                walk(node, owner, chain);
        }
    }
    try {
        walk(tree.rootNode, undefined, []);
    }
    catch {
        return {
            symbols: [],
            calls: [],
            imports: [],
            exports: [],
            parseError: true,
        };
    }
    // Two declarations can share a canonical identity (conditional defs, overloads).
    const identityCounts = new Map();
    for (const symbol of symbols) {
        const identity = symbol.canonicalIdentity ?? symbol.id;
        const count = identityCounts.get(identity) ?? 0;
        if (count > 0) {
            const previousId = symbol.id;
            symbol.id = `${identity}#${count + 1}`;
            for (const call of calls)
                if (call.callerId === previousId)
                    call.callerId = symbol.id;
            for (const other of symbols)
                if (other.parentId === previousId)
                    other.parentId = symbol.id;
        }
        identityCounts.set(identity, count + 1);
    }
    // Module-level definitions are what other modules can import.
    for (const symbol of symbols)
        if (!symbol.parentId && symbol.kind !== "namespace")
            exports.push({
                filePath,
                language: LANGUAGE_ID,
                exportedName: symbol.name,
                localName: symbol.name,
                symbolId: symbol.id,
                typeOnly: false,
                range: symbol.range,
            });
    // `from .x import y` in a package re-exports y.
    for (const record of imports)
        if (record.kind === "named" && record.importedName)
            exports.push({
                filePath,
                language: LANGUAGE_ID,
                exportedName: record.localName ?? record.importedName,
                sourceName: record.importedName,
                fromModule: record.module,
                typeOnly: false,
                range: record.range,
            });
    if (moduleSymbol) {
        const declarations = new Set([
            "function_definition",
            "class_definition",
            "decorated_definition",
        ]);
        moduleSymbol.source = tree.rootNode.namedChildren
            .filter((child) => !declarations.has(child.type))
            .map((child) => child.text)
            .join("\n");
    }
    return { symbols, calls, imports, exports, parseError };
}
