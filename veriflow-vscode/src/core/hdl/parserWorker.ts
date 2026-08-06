import { createHash } from 'crypto';
import { parentPort, workerData } from 'worker_threads';
// The ESM export relies on import.meta.url, which is unavailable in this CJS worker bundle.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import TreeSitter = require('web-tree-sitter');

import type { HdlDiagnostic, HdlDocument, SourceFileSpan, SourceSpan } from './model';
import { ParserRequestQueue } from './parserQueue';
import { PositionMap } from './positionMap';
import {
    getPreprocessMetadataForWorker,
    preprocessForParsing,
    preprocessingFingerprint,
} from './preprocessor';
import type {
    CompositeSourceMap,
    PreprocessMacroCandidate,
} from './preprocessor';
import {
    ParseRequest,
    ParserWorkerRequest,
    ParserWorkerResponse,
} from './protocol';
import { adaptTree, classifyTreeMacroUsages } from './treeSitterAdapter';
import type { TreeMacroUsageContext } from './treeSitterAdapter';
import { computeTreeEdit } from './treeEdit';
import type { ParserTreeEdit } from './treeEdit';

if (!parentPort) {
    throw new Error('HDL parser worker requires a parent port');
}
const port = parentPort;

type ParserResources = {
    parser: TreeSitter.Parser;
    language: TreeSitter.Language;
};

type RetainedTree = {
    uri: string;
    version: number;
    preprocessingFingerprint: string;
    textHash: string;
    preprocessedText: string;
    sourceMap: CompositeSourceMap;
    tree: TreeSitter.Tree;
};

const MAX_RETAINED_TREES = 8;
let parserPromise: Promise<ParserResources> | undefined;
let parserResources: ParserResources | undefined;
const queue = new ParserRequestQueue<ParseRequest>();
const cancelled = new Set<string>();
const retainedTrees = new Map<string, RetainedTree>();
let running = false;
let runningRequestId: string | undefined;
let disposed = false;
let cleanupPromise: Promise<void> | undefined;

function getParser(): Promise<ParserResources> {
    if (!parserPromise) {
        parserPromise = (async () => {
            await TreeSitter.Parser.init({
                locateFile: () => workerData.runtimeWasmPath,
            });
            const language = await TreeSitter.Language.load(workerData.languageWasmPath);
            if (language.abiVersion !== 15) {
                throw new Error(`Unexpected SystemVerilog ABI ${language.abiVersion}`);
            }
            const parser = new TreeSitter.Parser().setLanguage(language);
            parserResources = { parser, language };
            return parserResources;
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

function takeRetainedTree(uri: string): RetainedTree | undefined {
    const retained = retainedTrees.get(uri);
    if (retained) {
        retainedTrees.delete(uri);
    }
    return retained;
}

function retainTree(entry: RetainedTree): void {
    const replaced = retainedTrees.get(entry.uri);
    if (replaced && replaced.tree !== entry.tree) {
        replaced.tree.delete();
    }
    retainedTrees.delete(entry.uri);
    retainedTrees.set(entry.uri, entry);
    while (retainedTrees.size > MAX_RETAINED_TREES) {
        const oldestUri = retainedTrees.keys().next().value as string | undefined;
        if (oldestUri === undefined) {
            break;
        }
        const oldest = retainedTrees.get(oldestUri);
        retainedTrees.delete(oldestUri);
        oldest?.tree.delete();
    }
}

function deleteTree(tree: TreeSitter.Tree | undefined): void {
    tree?.delete();
}

function utf16PointAt(text: string, offset: number): TreeSitter.Point {
    let row = 0;
    let lineStart = 0;
    for (let index = 0; index < offset; index++) {
        if (text.charCodeAt(index) === 0x0a) {
            row++;
            lineStart = index + 1;
        }
    }
    return { row, column: offset - lineStart };
}

function runtimeEdit(
    byteEdit: ParserTreeEdit,
    oldText: string,
    newText: string
): TreeSitter.Edit {
    // web-tree-sitter's string callback is UTF-16 encoded, so its runtime tree indices
    // and columns use code units even though the public Edit documentation says bytes.
    const oldMap = new PositionMap(oldText);
    const newMap = new PositionMap(newText);
    const startIndex = oldMap.byteToUtf16(byteEdit.startIndex);
    const oldEndIndex = oldMap.byteToUtf16(byteEdit.oldEndIndex);
    const newEndIndex = newMap.byteToUtf16(byteEdit.newEndIndex);
    return new TreeSitter.Edit({
        startIndex,
        oldEndIndex,
        newEndIndex,
        startPosition: utf16PointAt(oldText, startIndex),
        oldEndPosition: utf16PointAt(oldText, oldEndIndex),
        newEndPosition: utf16PointAt(newText, newEndIndex),
    });
}

function cleanupResources(): Promise<void> {
    if (!cleanupPromise) {
        cleanupPromise = (async () => {
            try {
                await parserPromise;
            } catch {
                // Initialization errors are already reported to pending parse requests.
            }
            for (const retained of retainedTrees.values()) {
                retained.tree.delete();
            }
            retainedTrees.clear();
            parserResources?.parser.delete();
            const language = parserResources?.language as
                | (TreeSitter.Language & { delete?: () => void })
                | undefined;
            language?.delete?.();
            parserResources = undefined;
            port.close();
        })();
    }
    return cleanupPromise;
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
        const { parser } = await getParser();
        if (disposed) {
            return;
        }
        const options = request.options ?? { defines: {} };
        const preprocessed = preprocessForParsing(request.uri, request.text, options);
        const fingerprint = preprocessingFingerprint(options);
        const cacheMode = options.cacheMode ?? 'document';
        const previous = cacheMode === 'document'
            ? takeRetainedTree(request.uri)
            : undefined;
        let tree: TreeSitter.Tree | undefined;
        let retained = false;

        try {
            if (previous) {
                const treeEdit = computeTreeEdit(
                    previous.preprocessedText,
                    preprocessed.text
                );
                if (treeEdit) {
                    previous.tree.edit(runtimeEdit(
                        treeEdit,
                        previous.preprocessedText,
                        preprocessed.text
                    ));
                }
            }
            const parsedTree = parser.parse(preprocessed.text, previous?.tree);
            if (!parsedTree) {
                throw new Error('SystemVerilog parser returned no tree');
            }
            tree = parsedTree;

            const document = adaptTree(tree, request, {
                text: preprocessed.text,
                sourceMap: preprocessed.sourceMap,
                sourceTexts: preprocessed.sourceTexts,
            });
            const treeMacroUsages: TreeMacroUsageContext[] = classifyTreeMacroUsages(tree);
            document.preprocessingFingerprint = fingerprint;
            const metadata = getPreprocessMetadataForWorker(preprocessed);
            document.directives = [...metadata.directives, ...document.directives];
            document.includes = [...metadata.includes, ...document.includes];
            document.diagnostics = [
                ...document.diagnostics,
                ...preprocessed.diagnostics,
                ...macroDiagnostics(document, metadata.macroCandidates, treeMacroUsages),
            ].sort(compareDiagnostics);

            if (cacheMode === 'document') {
                retainTree({
                    uri: request.uri,
                    version: request.version,
                    preprocessingFingerprint: fingerprint,
                    textHash: createHash('sha256').update(request.text).digest('hex'),
                    preprocessedText: preprocessed.text,
                    sourceMap: preprocessed.sourceMap,
                    tree,
                });
                retained = true;
            }
            if (canRespond(request.requestId)) {
                post({
                    type: 'parsed',
                    requestId: request.requestId,
                    document,
                });
            }
        } finally {
            if (previous && previous.tree !== tree) {
                deleteTree(previous.tree);
            }
            if (!retained) {
                deleteTree(tree);
            }
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
        if (disposed) {
            void cleanupResources();
        } else {
            void pump();
        }
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
            cancelled.clear();
            if (!running) {
                void cleanupResources();
            }
            return;
        case 'parse':
            if (!disposed) {
                queue.enqueue(request);
                void pump();
            }
            return;
    }
});
