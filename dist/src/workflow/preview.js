import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../planner/budget.js";
import { rankSymbol } from "../planner/rank.js";
import { renderSkeleton } from "../render/compact-context.js";
import { composeDependencyContext, composeImportContext, composeJpaContext, composeRouteContext, composeSiblings, composeTransactionContext, } from "../planner/composition.js";
import { WorkflowError } from "./errors.js";
/**
 * Composition may use at most this share of the budget, so sibling context
 * fills spare capacity and never crowds out the target, callers or callees.
 */
export const COMPOSITION_BUDGET_SHARE = 0.35;
/** Reads each distinct included file once, in full, as the "without context-slice" cost.
 * A file that can't be read (renamed/deleted since indexing) is skipped rather than guessed —
 * the resulting reduction then understates savings, never overstates them. */
function wholeFileBaseline(index, included, estimatedTokens) {
    const filePaths = new Set(included.map((item) => item.filePath));
    let wholeFileTokens = 0;
    for (const filePath of filePaths) {
        try {
            wholeFileTokens += estimateTokens(readFileSync(join(index.root, filePath), "utf8"));
        }
        catch {
            // Excluded, not guessed — see doc comment above.
        }
    }
    const reduction = wholeFileTokens > 0
        ? Math.min(1, Math.max(0, 1 - estimatedTokens / wholeFileTokens))
        : 0;
    return { files: filePaths.size, wholeFileTokens, reduction };
}
function parameterCount(symbol) {
    const parameters = symbol.signature?.match(/\(([^)]*)\)/)?.[1].trim() ?? "";
    return parameters ? parameters.split(",").length : 0;
}
/** Test sources answer "how is this tested", not "how does this work". */
const isTestPath = (filePath) => /(^|\/)tests?\//i.test(filePath) ||
    /(^|\/)test_[^/]*$/.test(filePath) ||
    /_test\.[^/]+$/.test(filePath) ||
    /Tests?\.java$/.test(filePath) ||
    /\.(test|spec)\.[jt]sx?$/.test(filePath);
/** Keep production candidates when there are any; otherwise keep everything. */
function preferProduction(symbols) {
    const production = symbols.filter((symbol) => !isTestPath(symbol.filePath));
    return production.length ? production : symbols;
}
function chooseTarget(index, task) {
    const exact = index.resolveSymbol(task);
    if (exact.length === 1)
        return exact[0];
    const normalized = task.toLowerCase();
    const named = new RegExp(`\\b(${task.match(/[A-Za-z_][\w$]*/g)?.join("|") ?? ""})\\b`);
    const exactName = preferProduction(index.symbols.filter((symbol) => (symbol.kind === "method" ||
        symbol.kind === "constructor" ||
        symbol.kind === "function") &&
        normalized.includes(symbol.name.toLowerCase()) &&
        named.test(symbol.name))).sort((a, b) => b.name.length - a.name.length ||
        parameterCount(a) - parameterCount(b) ||
        a.id.localeCompare(b.id));
    if (exactName.length)
        return exactName[0];
    const ranked = index
        .search(task, 10)
        .map((result) => index.symbolById(result.id))
        .filter((symbol) => Boolean(symbol));
    const target = preferProduction(ranked)[0];
    if (target)
        return target;
    throw new WorkflowError("SYMBOL_NOT_FOUND", `No indexed symbol matches task: ${task}`, "Run context-slice index, then use a task that names a method, type, or qualified symbol.");
}
function renderedSkeleton(index, symbol, relation) {
    const calls = index.calls
        .filter((call) => call.callerId === symbol.id)
        .map((call) => `${call.receiverText ? `${call.receiverText}.` : ""}${call.calleeName}(…)${call.externalPackage ? ` [external: ${call.externalPackage}]` : ""}`);
    return `// ${relation}\n${renderSkeleton(symbol, calls)}`;
}
function ranked(symbols, task) {
    return [...symbols].sort((a, b) => rankSymbol(b, task, task) - rankSymbol(a, task, task) ||
        a.id.localeCompare(b.id));
}
export function buildPreview(index, task, options = {}) {
    if (!task.trim()) {
        throw new WorkflowError("SYMBOL_NOT_FOUND", "Preview requires a non-empty developer task.", 'Pass a task such as: context-slice preview "explain retryPayment".');
    }
    if (!index.symbols.length) {
        throw new WorkflowError("INDEX_STALE", "No loaded index is available for preview.", "Run context-slice index before requesting a preview.");
    }
    const target = chooseTarget(index, task);
    const targetTokens = estimateTokens(target.source);
    const budget = options.budget ?? Math.max(1200, targetTokens);
    if (budget < targetTokens) {
        throw new WorkflowError("BUDGET_TOO_SMALL", `Budget ${budget} cannot include target ${target.qualifiedName ?? target.name} (${targetTokens} tokens).`, `Increase --budget to at least ${targetTokens}, or select a smaller target.`);
    }
    const included = [];
    const omitted = [];
    const composition = {
        "task target": 0,
        "direct caller": 0,
        "direct callee": 0,
        "enclosing type": 0,
        "enterprise relation": 0,
        "file imports": 0,
    };
    let estimatedTokens = 0;
    const add = (symbol, reason, rendered, explanation, extra = {}, label, filePath) => {
        const tokens = estimateTokens(rendered);
        if (estimatedTokens + tokens > budget) {
            omitted.push({
                symbolId: symbol?.id,
                symbol: label ?? symbol?.qualifiedName ?? symbol?.name ?? explanation,
                reason: "context budget",
                estimatedTokens: tokens,
            });
            return;
        }
        included.push({
            symbolId: symbol?.id,
            symbol: label ?? symbol?.qualifiedName ?? symbol?.name ?? explanation,
            filePath: filePath ?? symbol?.filePath ?? target.filePath,
            reason,
            explanation,
            estimatedTokens: tokens,
            rendered,
            ...extra,
        });
        estimatedTokens += tokens;
        composition[reason] += tokens;
    };
    add(target, "task target", target.source, `Selected because the task names ${target.name}.`);
    const related = [
        ...ranked(index.callersAtDepth(target, options.depth ?? 1), task).map((symbol) => ({
            symbol,
            reason: "direct caller",
            relation: "Direct caller",
        })),
        ...ranked(index.dependenciesAtDepth(target, options.depth ?? 1), task).map((symbol) => ({
            symbol,
            reason: "direct callee",
            relation: "Direct callee",
        })),
    ].sort((a, b) => rankSymbol(b.symbol, task, options.intent ?? "") -
        rankSymbol(a.symbol, task, options.intent ?? "") ||
        a.symbol.id.localeCompare(b.symbol.id));
    const includedIds = new Set([target.id]);
    for (const item of related) {
        if (includedIds.has(item.symbol.id))
            continue;
        includedIds.add(item.symbol.id);
        add(item.symbol, item.reason, renderedSkeleton(index, item.symbol, item.relation), `${item.relation} of ${target.qualifiedName ?? target.name}.`);
    }
    const relatedFiles = new Set([...includedIds]
        .map((id) => index.symbolById(id)?.filePath)
        .filter((file) => Boolean(file) && file !== target.filePath));
    // Same-enclosing-type and import-context composition run after callers and
    // callees, so they can only use budget they left, and never replace them.
    let compositionTokens = 0;
    const compositionAllowance = Math.floor(budget * COMPOSITION_BUDGET_SHARE);
    const siblings = options.composition === false
        ? []
        : composeSiblings(index, target, includedIds);
    const importCandidates = options.composition === false
        ? []
        : composeImportContext(index, target, relatedFiles, includedIds);
    const relatedIds = new Set([...includedIds].filter((id) => id !== target.id));
    const routeCandidates = options.composition === false
        ? []
        : composeRouteContext(index, target, relatedIds, includedIds);
    const dependencyCandidates = options.composition === false
        ? []
        : composeDependencyContext(index, target, relatedIds, includedIds);
    const transactionCandidates = options.composition === false
        ? []
        : composeTransactionContext(index, target, relatedIds, includedIds);
    const jpaCandidates = options.composition === false
        ? []
        : composeJpaContext(index, target, relatedIds, includedIds);
    for (const candidate of [
        ...siblings,
        ...importCandidates,
        ...routeCandidates,
        ...dependencyCandidates,
        ...transactionCandidates,
        ...jpaCandidates,
    ]) {
        if (candidate.symbol && includedIds.has(candidate.symbol.id))
            continue;
        if (compositionTokens + candidate.estimatedTokens > compositionAllowance) {
            omitted.push({
                symbolId: candidate.symbol?.id,
                symbol: candidate.label,
                reason: "composition budget share",
                estimatedTokens: candidate.estimatedTokens,
                evidence: candidate.evidence,
            });
            continue;
        }
        if (candidate.symbol)
            includedIds.add(candidate.symbol.id);
        compositionTokens += candidate.estimatedTokens;
        add(candidate.symbol, candidate.reason, candidate.rendered, candidate.evidence.join("; "), {
            evidence: candidate.evidence,
        }, candidate.label, candidate.filePath);
    }
    const unresolved = index.calls
        .filter((call) => call.callerId === target.id && !call.resolvedTargetId)
        .map((call) => ({ calleeName: call.calleeName, evidence: call.evidence }))
        .sort((a, b) => a.calleeName.localeCompare(b.calleeName));
    return {
        task,
        target,
        budget,
        estimatedTokens,
        rendered: included.map((item) => item.rendered).join("\n\n"),
        included,
        omitted,
        unresolved,
        confidence: unresolved.length ? "mixed" : "high",
        freshness: index.inspect(),
        composition,
        baseline: wholeFileBaseline(index, included, estimatedTokens),
    };
}
