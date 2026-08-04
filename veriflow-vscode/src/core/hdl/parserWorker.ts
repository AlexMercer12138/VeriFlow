import { createHash } from 'crypto';
import { parentPort, workerData } from 'worker_threads';
// The ESM export relies on import.meta.url, which is unavailable in this CJS worker bundle.
import TreeSitter = require('web-tree-sitter');

import type { HdlDiagnostic, HdlDocument, SourceFileSpan, SourceSpan } from './model';
import { ParserRequestQueue } from './parserQueue';
import {
    canonicalizeSourceUri,
    getPreprocessMetadataForWorker,
    preprocessForParsing,
} from './preprocessor';
import type { PreprocessMacroCandidate } from './preprocessor';
import {
    HdlParseOptions,
    ParseRequest,
    ParserWorkerRequest,
    ParserWorkerResponse,
} from './protocol';
import { adaptTree, classifyTreeMacroUsages } from './treeSitterAdapter';
import type { TreeMacroUsageContext } from './treeSitterAdapter';

if (!parentPort) {
    throw new Error('HDL parser worker requires a parent port');
}
const port = parentPort;

let parserPromise: Promise<TreeSitter.Parser> | undefined;
const queue = new ParserRequestQueue<ParseRequest>();
const cancelled = new Set<string>();
let running = false;
let runningRequestId: string | undefined;
let disposed = false;

function getParser(): Promise<TreeSitter.Parser> {
    if (!parserPromise) {
        parserPromise = (async () => {
            await TreeSitter.Parser.init({
                locateFile: () => workerData.runtimeWasmPath,
            });
            const language = await TreeSitter.Language.load(workerData.languageWasmPath);
            if (language.abiVersion !== 15) {
                throw new Error(`Unexpected SystemVerilog ABI ${language.abiVersion}`);
            }
            return new TreeSitter.Parser().setLanguage(language);
        })();
    }
    return parserPromise;
}

function post(response: ParserWorkerResponse): void {
    port.postMessage(response);
}

function canRespond(requestId: string): boolean {
    return !disposed && !cancelled.has(requestId);
}

function preprocessingFingerprint(options: HdlParseOptions): string {
    const defines = Object.entries(options.defines)
        .sort(([left], [right]) => left.localeCompare(right));
    const includes = (options.resolvedIncludes ?? []).map(include => ({
        fromUri: canonicalizeSourceUri(include.fromUri),
        rawPath: include.rawPath,
        resolvedUri: canonicalizeSourceUri(include.resolvedUri),
        contentHash: createHash('sha256').update(include.text).digest('hex'),
    })).sort((left, right) =>
        left.fromUri.localeCompare(right.fromUri)
        || left.rawPath.localeCompare(right.rawPath)
        || left.resolvedUri.localeCompare(right.resolvedUri)
        || left.contentHash.localeCompare(right.contentHash)
    );
    return createHash('sha256').update(JSON.stringify({
        defines,
        includes,
        maxIncludeDepth: options.maxIncludeDepth ?? 32,
    })).digest('hex');
}

function compareDiagnostics(
    left: ReturnType<typeof preprocessForParsing>['diagnostics'][number],
    right: ReturnType<typeof preprocessForParsing>['diagnostics'][number]
): number {
    return (left.span?.uri ?? '').localeCompare(right.span?.uri ?? '')
        || (left.span?.start ?? Number.MAX_SAFE_INTEGER)
            - (right.span?.start ?? Number.MAX_SAFE_INTEGER)
        || (left.span?.end ?? Number.MAX_SAFE_INTEGER)
            - (right.span?.end ?? Number.MAX_SAFE_INTEGER)
        || left.code.localeCompare(right.code)
        || left.message.localeCompare(right.message);
}

function sourceParts(span: SourceSpan): SourceFileSpan[] {
    if (span.compositeParts) {
        return span.compositeParts;
    }
    return span.uri === undefined
        ? []
        : [{ uri: span.uri, start: span.start, end: span.end }];
}

function spanContainsCandidate(span: SourceSpan, candidate: PreprocessMacroCandidate): boolean {
    return sourceParts(span).some(part =>
        part.uri === candidate.span.uri
        && candidate.span.start >= part.start
        && candidate.span.end <= part.end
    );
}

function spanTouchesCandidate(span: SourceSpan, candidate: PreprocessMacroCandidate): boolean {
    return sourceParts(span).some(part =>
        part.uri === candidate.span.uri
        && candidate.span.start <= part.end + 1
        && candidate.span.end + 1 >= part.start
    );
}

function structuralSpans(document: HdlDocument): SourceSpan[] {
    const spans: SourceSpan[] = [];
    for (const module of document.modules) {
        spans.push(module.headerSpan);
        for (const parameter of [...module.parameters, ...module.localParameters]) {
            spans.push(parameter.declarationSpan, parameter.nameSpan);
            if (parameter.valueSpan) {
                spans.push(parameter.valueSpan);
            }
        }
        for (const port of module.ports) {
            spans.push(
                port.declarationSpan,
                port.nameSpan,
                port.headerItemSpan,
                port.headerNameSpan
            );
            if (port.bodyDeclarationSpan) {
                spans.push(port.bodyDeclarationSpan);
            }
            if (port.bodyNameSpan) {
                spans.push(port.bodyNameSpan);
            }
            if (port.packedRangeSpan) {
                spans.push(port.packedRangeSpan);
            }
        }
        for (const group of module.portDeclarationGroups) {
            spans.push(group.declarationSpan, group.sharedPrefixSpan);
            for (const item of group.items) {
                spans.push(item.itemSpan);
                if (item.separatorSpan) {
                    spans.push(item.separatorSpan);
                }
            }
        }
        for (const net of module.nets) {
            spans.push(net.declarationSpan, ...net.names.map(name => name.nameSpan));
        }
        for (const instance of module.instances) {
            spans.push(
                instance.declarationSpan,
                instance.itemSpan,
                instance.moduleNameSpan,
                instance.nameSpan
            );
            for (const connection of [
                ...instance.parameterConnections,
                ...instance.portConnections,
            ]) {
                spans.push(connection.connectionSpan, connection.expressionSpan);
                if (connection.nameSpan) {
                    spans.push(connection.nameSpan);
                }
            }
        }
        for (const group of module.instanceDeclarationGroups) {
            spans.push(group.statementSpan, group.moduleNameSpan);
            if (group.parameterBlockSpan) {
                spans.push(group.parameterBlockSpan);
            }
            for (const item of group.items) {
                spans.push(item.itemSpan);
                if (item.separatorSpan) {
                    spans.push(item.separatorSpan);
                }
            }
        }
    }
    spans.push(
        ...document.interfaces.flatMap(unit => [unit.nameSpan, unit.declarationSpan]),
        ...document.packages.flatMap(unit => [unit.nameSpan, unit.declarationSpan])
    );
    return spans;
}

function nonStructuralSpans(document: HdlDocument): SourceSpan[] {
    return document.modules.flatMap(module => [
        ...module.continuousAssignments.flatMap(assignment => [
            assignment.declarationSpan,
            assignment.target.span,
            assignment.value.span,
        ]),
        ...module.opaqueRegions.map(region => region.span),
    ]);
}

function macroDiagnostics(
    document: HdlDocument,
    candidates: readonly PreprocessMacroCandidate[],
    treeUsages: readonly TreeMacroUsageContext[]
): HdlDiagnostic[] {
    const structural = structuralSpans(document);
    const nonStructural = nonStructuralSpans(document);
    const syntaxDiagnostics = document.diagnostics.filter(diagnostic =>
        diagnostic.span
        && (diagnostic.code === 'systemverilog.syntax-error'
            || diagnostic.code === 'systemverilog.missing-syntax')
    );
    const usageByRange = new Map(treeUsages.map(usage => [
        `${usage.generatedStart}:${usage.generatedEnd}`,
        usage,
    ]));
    const byOwner = new Map<string, {
        candidate: PreprocessMacroCandidate;
        structural: boolean;
    }>();
    for (const candidate of candidates) {
        const treeUsage = usageByRange.get(
            `${candidate.generatedStart}:${candidate.generatedEnd}`
        );
        const affectsStructure = treeUsage?.structural
            ?? (!nonStructural.some(span => spanContainsCandidate(span, candidate))
                && (structural.some(span => spanContainsCandidate(span, candidate))
                    || syntaxDiagnostics.some(diagnostic =>
                        diagnostic.span && spanTouchesCandidate(diagnostic.span, candidate)
                    )));
        const ownerKey = `${candidate.span.uri}:${candidate.span.start}:${candidate.span.end}`;
        const existing = byOwner.get(ownerKey);
        if (existing) {
            existing.structural ||= affectsStructure;
        } else {
            byOwner.set(ownerKey, { candidate, structural: affectsStructure });
        }
    }
    return [...byOwner.values()].flatMap(({ candidate, structural: affectsStructure }) =>
        affectsStructure ? [{
            severity: 'warning' as const,
            code: 'HDL_MACRO_UNEXPANDED',
            message: 'Macro usage may affect normalized HDL structure and was not expanded',
            span: candidate.span,
        }] : []
    );
}

async function pump(): Promise<void> {
    if (disposed || running) {
        return;
    }

    const request = queue.takeNext();
    if (!request) {
        return;
    }

    running = true;
    runningRequestId = request.requestId;
    try {
        const parser = await getParser();
        if (disposed) {
            return;
        }
        const options = request.options ?? { defines: {} };
        const preprocessed = preprocessForParsing(request.uri, request.text, options);
        const tree = parser.parse(preprocessed.text);
        if (!tree) {
            throw new Error('SystemVerilog parser returned no tree');
        }

        let document: ReturnType<typeof adaptTree>;
        let treeMacroUsages: TreeMacroUsageContext[];
        try {
            document = adaptTree(tree, request, {
                text: preprocessed.text,
                sourceMap: preprocessed.sourceMap,
                sourceTexts: preprocessed.sourceTexts,
            });
            treeMacroUsages = classifyTreeMacroUsages(tree);
        } finally {
            tree.delete();
        }
        document.preprocessingFingerprint = preprocessingFingerprint(options);
        const metadata = getPreprocessMetadataForWorker(preprocessed);
        document.directives = [...metadata.directives, ...document.directives];
        document.includes = [...metadata.includes, ...document.includes];
        document.diagnostics = [
            ...document.diagnostics,
            ...preprocessed.diagnostics,
            ...macroDiagnostics(document, metadata.macroCandidates, treeMacroUsages),
        ].sort(compareDiagnostics);
        if (canRespond(request.requestId)) {
            post({
                type: 'parsed',
                requestId: request.requestId,
                document,
            });
        }
    } catch (error) {
        if (canRespond(request.requestId)) {
            post({
                type: 'failed',
                requestId: request.requestId,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    } finally {
        cancelled.delete(request.requestId);
        running = false;
        runningRequestId = undefined;
        void pump();
    }
}

port.on('message', (request: ParserWorkerRequest) => {
    switch (request.type) {
        case 'cancel':
            if (queue.cancel(request.requestId)) {
                return;
            }
            if (runningRequestId === request.requestId) {
                cancelled.add(request.requestId);
            }
            return;
        case 'dispose':
            disposed = true;
            queue.clear();
            return;
        case 'parse':
            if (!disposed) {
                queue.enqueue(request);
                void pump();
            }
            return;
    }
});
