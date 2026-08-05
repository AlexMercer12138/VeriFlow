import { createHash } from 'crypto';
import * as path from 'path';

import type { HdlDocument, ModuleModel, NamedUnitModel } from './model';
import type { HdlParserClient } from './parserClient';
import {
    canonicalizeSourceUri,
    getPreprocessMetadataForWorker,
    preprocessForParsing,
    preprocessingFingerprint,
} from './preprocessor';
import type { ResolvedIncludeInput } from './preprocessor';
import type { WorkspaceIndexStore } from './workspaceIndexStore';
import type {
    HdlDefinitionKey,
    HdlDefinitionKind,
    HdlDefinitionSummary,
    HdlFileSummary,
    HdlUnresolvedIncludeSummary,
    PersistedWorkspaceIndex,
} from './workspaceIndexTypes';

export type DuplicateDefinitionGroup = {
    name: string;
    definitions: HdlDefinitionSummary[];
};

export type WorkspaceIndexInvalidation = {
    changedUris: string[];
    affectedDocumentUris: string[];
    changedDefinitionKeys: HdlDefinitionKey[];
    parserFingerprint: string;
};

export type WorkspaceHdlWatchPlan = {
    resolvedExternalIncludeUris: string[];
    unresolvedExternalCandidateUris: string[];
};

export type WorkspaceHdlIndexOptions = {
    parser: HdlParserClient;
    store: WorkspaceIndexStore;
    parserFingerprint: string;
    defines: Record<string, string | true>;
    findFiles(roots: string[]): Promise<string[]>;
    readFile(uri: string): Promise<{
        text: string;
        version: number;
        mtimeMs: number;
        size: number;
    }>;
    includeCandidates(fromUri: string, includePath: string): string[];
    resolveInclude(fromUri: string, includePath: string): Promise<string | undefined>;
};

function hash(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function contentHash(text: string): string {
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function workspaceCacheFingerprint(
    parserFingerprint: string,
    defines: Record<string, string | true>
): string {
    return hash({
        parserFingerprint,
        defines: Object.entries(defines).sort(([left], [right]) => left.localeCompare(right)),
    });
}

function compareDefinitions(
    left: HdlDefinitionSummary,
    right: HdlDefinitionSummary
): number {
    return left.name.localeCompare(right.name)
        || left.uri.localeCompare(right.uri)
        || left.declarationStart - right.declarationStart;
}

function definitionKey(
    kind: HdlDefinitionKind,
    uri: string,
    declarationStart: number
): string {
    return `${kind}:${uri}:${declarationStart}`;
}

function namedUnitSummary(
    unit: NamedUnitModel,
    uri: string,
    sources: Array<[string, string]>
): HdlDefinitionSummary {
    return {
        key: definitionKey(unit.kind, uri, unit.declarationSpan.start),
        kind: unit.kind,
        name: unit.name,
        uri,
        declarationStart: unit.declarationSpan.start,
        declarationLine: unit.declarationLine,
        parameters: [],
        ports: [],
        dependencies: [],
        modelFingerprint: hash({ unit, sources }),
    };
}

function moduleSummary(
    module: ModuleModel,
    uri: string,
    sources: Array<[string, string]>
): HdlDefinitionSummary {
    return {
        key: definitionKey('module', uri, module.declarationSpan.start),
        kind: 'module',
        name: module.name,
        uri,
        declarationStart: module.declarationSpan.start,
        declarationLine: module.declarationLine,
        parameters: module.parameters.map(parameter => ({
            name: parameter.name,
            ...(parameter.defaultExpression === undefined
                ? {}
                : { defaultExpression: parameter.defaultExpression }),
        })),
        ports: module.ports.map(port => ({
            name: port.name,
            direction: port.direction,
            ...(port.packedRange === undefined ? {} : { packedRange: port.packedRange }),
            width: port.width,
        })),
        dependencies: [...new Set(module.instances.map(instance => instance.moduleName))].sort(),
        modelFingerprint: hash({ module, sources }),
    };
}

function isHdlUri(uri: string): boolean {
    let pathname = uri;
    try {
        pathname = new URL(uri).pathname;
    } catch {
        // Non-URL parser inputs still use their path suffix.
    }
    return ['.v', '.sv', '.vh', '.svh'].includes(path.posix.extname(pathname).toLowerCase());
}

function isUriWithinRoot(uri: string, root: string): boolean {
    return uri === root || uri.startsWith(root.endsWith('/') ? root : `${root}/`);
}

type FileInput = {
    text: string;
    version: number;
    mtimeMs: number;
    size: number;
};

type DocumentCacheEntry = {
    contentHash: string;
    mtimeMs: number;
    size: number;
    preprocessingFingerprint: string;
    resolvedIncludes: ResolvedIncludeInput[];
    document: HdlDocument;
};

type BatchState = {
    files: Map<string, HdlFileSummary>;
    documents: Map<string, DocumentCacheEntry>;
    reads: Map<string, FileInput>;
    changedUris: Set<string>;
    affectedDocumentUris: Set<string>;
    visitedUris: Set<string>;
};

type PreparedDocument = {
    input: FileInput;
    contentHash: string;
    preprocessingFingerprint: string;
    resolvedIncludes: ResolvedIncludeInput[];
};

export class WorkspaceHdlIndex {
    private files = new Map<string, HdlFileSummary>();
    private documents = new Map<string, DocumentCacheEntry>();
    private readonly listeners = new Set<(event: WorkspaceIndexInvalidation) => void>();
    private defines: Record<string, string | true>;
    private writeTail: Promise<void> = Promise.resolve();
    private disposed = false;

    constructor(private readonly options: WorkspaceHdlIndexOptions) {
        this.defines = { ...options.defines };
    }

    async load(): Promise<void> {
        return this.runExclusive(async () => {
            const persisted = this.options.store.load(workspaceCacheFingerprint(
                this.options.parserFingerprint,
                this.defines
            ));
            if (!persisted) {
                return;
            }
            this.files = new Map(persisted.files.map(file => [
                canonicalizeSourceUri(file.uri),
                file,
            ]));
            this.documents = new Map();
        });
    }

    async scan(roots: string[], signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        return this.runExclusive(async () => {
            this.checkpoint(signal);
            const found = await this.options.findFiles(roots);
            this.checkpoint(signal);
            const uris = [...new Set(found
                .map(uri => canonicalizeSourceUri(uri))
                .filter(isHdlUri))].sort();
            const canonicalRoots = roots.map(root => canonicalizeSourceUri(root));
            const previousFiles = this.files;
            const batch = this.createBatch();
            await this.processUris(uris, batch, this.defines, signal, true);
            for (const uri of [...batch.files.keys()]) {
                if (canonicalRoots.some(root => isUriWithinRoot(uri, root))
                    && !batch.visitedUris.has(uri)) {
                    batch.files.delete(uri);
                    batch.documents.delete(uri);
                    batch.changedUris.add(uri);
                    batch.affectedDocumentUris.add(uri);
                }
            }
            await this.commitBatch(previousFiles, batch, signal);
        });
    }

    async refreshUri(uri: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const canonicalUri = canonicalizeSourceUri(uri);
        return this.runExclusive(async () => {
            const unresolvedOwners = await this.getNewlyResolvedOwners(
                canonicalUri,
                signal
            );
            const previousFiles = this.files;
            const batch = this.createBatch();
            await this.processUris(
                [
                    canonicalUri,
                    ...this.getDependentsOfInclude(canonicalUri),
                    ...unresolvedOwners,
                ],
                batch,
                this.defines,
                signal,
                true
            );
            await this.commitBatch(previousFiles, batch, signal);
        });
    }

    async removeUri(uri: string): Promise<void> {
        const canonicalUri = canonicalizeSourceUri(uri);
        return this.runExclusive(async () => {
            const dependents = this.getDependentsOfInclude(canonicalUri);
            if (!this.files.has(canonicalUri) && dependents.length === 0) {
                return;
            }
            const previousFiles = this.files;
            const batch = this.createBatch();
            batch.files.delete(canonicalUri);
            batch.documents.delete(canonicalUri);
            batch.changedUris.add(canonicalUri);
            batch.affectedDocumentUris.add(canonicalUri);
            const readableDependents: string[] = [];
            for (const dependent of dependents) {
                try {
                    await this.readFile(dependent, batch);
                    readableDependents.push(dependent);
                } catch {
                    batch.files.delete(dependent);
                    batch.documents.delete(dependent);
                    batch.changedUris.add(dependent);
                    batch.affectedDocumentUris.add(dependent);
                }
            }
            await this.processUris(
                readableDependents,
                batch,
                this.defines,
                undefined,
                true,
                false,
                new Set([canonicalUri])
            );
            await this.commitBatch(previousFiles, batch);
            this.options.parser.invalidate(canonicalUri);
        });
    }

    async updateConfiguration(defines: Record<string, string | true>): Promise<void> {
        const nextDefines = { ...defines };
        return this.runExclusive(async () => {
            if (preprocessingFingerprint({ defines: this.defines })
                === preprocessingFingerprint({ defines: nextDefines })) {
                return;
            }
            this.options.parser.clearCache();
            const previousFiles = this.files;
            const batch = this.createBatch();
            await this.processUris(
                [...this.files.keys()],
                batch,
                nextDefines,
                undefined,
                false,
                true
            );
            await this.commitBatch(previousFiles, batch, undefined, nextDefines);
        });
    }

    getDefinition(key: HdlDefinitionKey): HdlDefinitionSummary | undefined {
        return this.getAllDefinitions().find(definition => definition.key === key);
    }

    getFile(uri: string): HdlFileSummary | undefined {
        return this.files.get(canonicalizeSourceUri(uri));
    }

    getWatchPlan(roots: string[]): WorkspaceHdlWatchPlan {
        const canonicalRoots = roots.map(root => canonicalizeSourceUri(root));
        const isExternal = (uri: string): boolean => !canonicalRoots.some(root =>
            isUriWithinRoot(uri, root)
        );
        const resolvedExternalIncludeUris = new Set<string>();
        const unresolvedExternalCandidateUris = new Set<string>();
        for (const file of this.files.values()) {
            for (const includeUri of file.includeUris) {
                const canonicalUri = canonicalizeSourceUri(includeUri);
                if (isExternal(canonicalUri)) {
                    resolvedExternalIncludeUris.add(canonicalUri);
                }
            }
            for (const include of file.unresolvedIncludes ?? []) {
                for (const candidate of this.options.includeCandidates(
                    include.fromUri,
                    include.rawPath
                )) {
                    const canonicalUri = canonicalizeSourceUri(candidate);
                    if (isExternal(canonicalUri)) {
                        unresolvedExternalCandidateUris.add(canonicalUri);
                    }
                }
            }
        }
        return {
            resolvedExternalIncludeUris: [...resolvedExternalIncludeUris].sort(),
            unresolvedExternalCandidateUris: [...unresolvedExternalCandidateUris].sort(),
        };
    }

    getDependentsOfInclude(uri: string): string[] {
        const canonicalUri = canonicalizeSourceUri(uri);
        return [...this.files.values()]
            .filter(file => file.uri !== canonicalUri && file.includeUris.includes(canonicalUri))
            .map(file => file.uri)
            .sort();
    }

    async canResolveUnresolvedInclude(uri: string, signal?: AbortSignal): Promise<boolean> {
        signal?.throwIfAborted();
        const canonicalUri = canonicalizeSourceUri(uri);
        return this.runExclusive(async () => {
            this.checkpoint(signal);
            const owners = await this.getNewlyResolvedOwners(canonicalUri, signal);
            this.checkpoint(signal);
            return owners.length > 0;
        });
    }

    async resolveDefinition(key: HdlDefinitionKey): Promise<{
        summary: HdlDefinitionSummary;
        document: HdlDocument;
        module?: ModuleModel;
    }> {
        return this.runExclusive(async () => {
            let summary = this.getDefinition(key);
            if (!summary) {
                throw new Error(`HDL definition not found: ${key}`);
            }
            const batch = this.createBatch();
            const prepared = await this.prepareDocument(
                summary.uri,
                batch,
                this.defines
            );
            const currentFile = batch.files.get(summary.uri);
            let document: HdlDocument;
            if (!currentFile || !this.isPreparedFresh(currentFile, prepared)) {
                const previousFiles = this.files;
                await this.processUris(
                    [summary.uri, ...this.getDependentsOfInclude(summary.uri)],
                    batch,
                    this.defines,
                    undefined,
                    true
                );
                await this.commitBatch(previousFiles, batch);
                summary = this.getDefinition(key);
                if (!summary) {
                    throw new Error(`HDL definition not found after refresh: ${key}`);
                }
                const refreshed = this.documents.get(summary.uri);
                if (!refreshed) {
                    throw new Error(`HDL document not found after refresh: ${summary.uri}`);
                }
                document = refreshed.document;
            } else {
                const cached = this.documents.get(summary.uri);
                if (cached
                    && cached.contentHash === prepared.contentHash
                    && cached.preprocessingFingerprint === prepared.preprocessingFingerprint) {
                    document = cached.document;
                } else {
                    document = await this.options.parser.parse(
                        summary.uri,
                        prepared.input.version,
                        prepared.input.text,
                        { defines: this.defines, resolvedIncludes: prepared.resolvedIncludes },
                        'background'
                    );
                    this.documents.set(summary.uri, {
                        contentHash: prepared.contentHash,
                        mtimeMs: prepared.input.mtimeMs,
                        size: prepared.input.size,
                        preprocessingFingerprint: prepared.preprocessingFingerprint,
                        resolvedIncludes: prepared.resolvedIncludes,
                        document,
                    });
                }
            }
            const module = summary.kind === 'module'
                ? document.modules.find(candidate =>
                    canonicalizeSourceUri(candidate.nameSpan.uri ?? document!.uri) === summary.uri
                    && definitionKey(
                        'module',
                        summary.uri,
                        candidate.declarationSpan.start
                    ) === summary.key
                )
                : undefined;
            if (summary.kind === 'module' && !module) {
                throw new Error(`Exact HDL module not found for definition: ${key}`);
            }
            return { summary, document, module };
        });
    }

    findDefinitions(name: string, kind?: HdlDefinitionKind): HdlDefinitionSummary[] {
        return this.getAllDefinitions(kind).filter(definition => definition.name === name);
    }

    getAllDefinitions(kind?: HdlDefinitionKind): HdlDefinitionSummary[] {
        return [...this.files.values()]
            .flatMap(file => file.definitions)
            .filter(definition => kind === undefined || definition.kind === kind)
            .sort(compareDefinitions);
    }

    getDuplicateGroups(): DuplicateDefinitionGroup[] {
        const byName = new Map<string, HdlDefinitionSummary[]>();
        for (const definition of this.getAllDefinitions()) {
            const definitions = byName.get(definition.name) ?? [];
            definitions.push(definition);
            byName.set(definition.name, definitions);
        }
        return [...byName.entries()]
            .filter(([, definitions]) => definitions.length > 1)
            .map(([name, definitions]) => ({ name, definitions }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    onDidInvalidate(listener: (event: WorkspaceIndexInvalidation) => void): {
        dispose(): void;
    } {
        if (!this.disposed) {
            this.listeners.add(listener);
        }
        return { dispose: () => this.listeners.delete(listener) };
    }

    dispose(): void {
        this.disposed = true;
        this.listeners.clear();
    }

    private createBatch(): BatchState {
        return {
            files: new Map(this.files),
            documents: new Map(this.documents),
            reads: new Map(),
            changedUris: new Set(),
            affectedDocumentUris: new Set(),
            visitedUris: new Set(),
        };
    }

    private async processUris(
        initialUris: string[],
        batch: BatchState,
        defines: Record<string, string | true>,
        signal: AbortSignal | undefined,
        trackPhysicalChanges: boolean,
        forceAffected = false,
        excludedUris: ReadonlySet<string> = new Set()
    ): Promise<void> {
        const pending = [...new Set(initialUris.map(uri => canonicalizeSourceUri(uri)))]
            .filter(uri => isHdlUri(uri) && !excludedUris.has(uri));
        const processed = new Set<string>();
        while (pending.length > 0) {
            pending.sort();
            const uri = pending.shift()!;
            if (processed.has(uri)) {
                continue;
            }
            this.checkpoint(signal);
            const includes = await this.processUri(
                uri,
                batch,
                defines,
                signal,
                trackPhysicalChanges,
                forceAffected,
                excludedUris
            );
            processed.add(uri);
            batch.visitedUris.add(uri);
            for (const includeUri of includes) {
                if (isHdlUri(includeUri)
                    && !excludedUris.has(includeUri)
                    && !processed.has(includeUri)
                    && !pending.includes(includeUri)) {
                    pending.push(includeUri);
                }
            }
        }
    }

    private async processUri(
        uri: string,
        batch: BatchState,
        defines: Record<string, string | true>,
        signal: AbortSignal | undefined,
        trackPhysicalChanges: boolean,
        forceAffected: boolean,
        excludedUris: ReadonlySet<string>
    ): Promise<string[]> {
        const prepared = await this.prepareDocument(
            uri,
            batch,
            defines,
            signal,
            excludedUris
        );
        const current = batch.files.get(uri);
        const sourceChanged = !current
            || current.mtimeMs !== prepared.input.mtimeMs
            || current.size !== prepared.input.size
            || current.contentHash !== prepared.contentHash;
        if (trackPhysicalChanges && sourceChanged) {
            batch.changedUris.add(uri);
        }
        const cached = batch.documents.get(uri);
        if (cached
            && cached.mtimeMs === prepared.input.mtimeMs
            && cached.size === prepared.input.size
            && cached.contentHash === prepared.contentHash
            && cached.preprocessingFingerprint === prepared.preprocessingFingerprint) {
            if (forceAffected) {
                batch.affectedDocumentUris.add(uri);
            }
            return cached.resolvedIncludes.map(include => include.resolvedUri);
        }
        if (!cached && current && this.isPreparedFresh(current, prepared)) {
            return prepared.resolvedIncludes.map(include => include.resolvedUri);
        }
        if (sourceChanged
            || forceAffected
            || (cached
                && cached.preprocessingFingerprint !== prepared.preprocessingFingerprint)) {
            batch.affectedDocumentUris.add(uri);
        }
        this.checkpoint(signal);
        const document: HdlDocument = await this.options.parser.parse(
            uri,
            prepared.input.version,
            prepared.input.text,
            { defines, resolvedIncludes: prepared.resolvedIncludes },
            'background'
        );
        this.checkpoint(signal);
        const sourceHashes = new Map<string, string>([[uri, prepared.contentHash]]);
        for (const include of prepared.resolvedIncludes) {
            sourceHashes.set(
                canonicalizeSourceUri(include.resolvedUri),
                contentHash(include.text)
            );
        }
        const sources = [...sourceHashes.entries()].sort(([left], [right]) =>
            left.localeCompare(right)
        );
        const definitions = [
            ...document.modules
                .filter(module => canonicalizeSourceUri(module.nameSpan.uri ?? uri) === uri)
                .map(module => moduleSummary(module, uri, sources)),
            ...document.interfaces
                .filter(unit => canonicalizeSourceUri(unit.nameSpan.uri ?? uri) === uri)
                .map(unit => namedUnitSummary(unit, uri, sources)),
            ...document.packages
                .filter(unit => canonicalizeSourceUri(unit.nameSpan.uri ?? uri) === uri)
                .map(unit => namedUnitSummary(unit, uri, sources)),
        ].sort(compareDefinitions);
        const includeUris = [...new Set(document.includes
            .map(include => include.resolvedUri)
            .filter((resolvedUri): resolvedUri is string => resolvedUri !== undefined)
            .map(resolvedUri => canonicalizeSourceUri(resolvedUri)))].sort();
        const unresolvedByKey = new Map<string, HdlUnresolvedIncludeSummary>();
        for (const include of document.includes) {
            if (include.resolvedUri !== undefined || !include.path) {
                continue;
            }
            const unresolved: HdlUnresolvedIncludeSummary = {
                ownerUri: uri,
                fromUri: canonicalizeSourceUri(include.span.uri ?? uri),
                rawPath: include.path,
            };
            unresolvedByKey.set(
                `${unresolved.fromUri}\0${unresolved.rawPath}`,
                unresolved
            );
        }
        const unresolvedIncludes = [...unresolvedByKey.values()].sort((left, right) =>
            left.ownerUri.localeCompare(right.ownerUri)
            || left.fromUri.localeCompare(right.fromUri)
            || left.rawPath.localeCompare(right.rawPath)
        );
        if (!cached && current && !sourceChanged && (
            JSON.stringify(current.includeUris) !== JSON.stringify(includeUris)
            || JSON.stringify(current.definitions.map(definition => [
                definition.key,
                definition.modelFingerprint,
            ])) !== JSON.stringify(definitions.map(definition => [
                definition.key,
                definition.modelFingerprint,
            ]))
            || JSON.stringify(current.diagnostics) !== JSON.stringify(document.diagnostics)
        )) {
            batch.affectedDocumentUris.add(uri);
        }
        batch.files.set(uri, {
            uri,
            mtimeMs: prepared.input.mtimeMs,
            size: prepared.input.size,
            contentHash: prepared.contentHash,
            preprocessingFingerprint: prepared.preprocessingFingerprint,
            includeUris,
            unresolvedIncludes,
            definitions,
            diagnostics: document.diagnostics,
        });
        batch.documents.set(uri, {
            contentHash: prepared.contentHash,
            mtimeMs: prepared.input.mtimeMs,
            size: prepared.input.size,
            preprocessingFingerprint: prepared.preprocessingFingerprint,
            resolvedIncludes: prepared.resolvedIncludes,
            document,
        });
        return prepared.resolvedIncludes.map(include => include.resolvedUri);
    }

    private isPreparedFresh(
        current: HdlFileSummary,
        prepared: PreparedDocument
    ): boolean {
        if (current.unresolvedIncludes === undefined) {
            return false;
        }
        if (current.preprocessingFingerprint === undefined
            || current.preprocessingFingerprint !== prepared.preprocessingFingerprint) {
            return false;
        }
        if (current.mtimeMs !== prepared.input.mtimeMs
            || current.size !== prepared.input.size
            || current.contentHash !== prepared.contentHash) {
            return false;
        }
        const includeTexts = new Map<string, string>();
        for (const include of prepared.resolvedIncludes) {
            includeTexts.set(canonicalizeSourceUri(include.resolvedUri), include.text);
        }
        const includeUris = [...includeTexts.keys()].sort();
        if (JSON.stringify(current.includeUris) !== JSON.stringify(includeUris)) {
            return false;
        }
        return includeUris.every(uri => {
            const persisted = this.files.get(uri);
            const text = includeTexts.get(uri);
            return persisted !== undefined
                && text !== undefined
                && persisted.contentHash === contentHash(text);
        });
    }

    private async getNewlyResolvedOwners(
        targetUri: string,
        signal?: AbortSignal
    ): Promise<string[]> {
        const owners = new Set<string>();
        for (const file of this.files.values()) {
            for (const include of file.unresolvedIncludes ?? []) {
                this.checkpoint(signal);
                const resolved = await this.options.resolveInclude(
                    include.fromUri,
                    include.rawPath
                );
                this.checkpoint(signal);
                if (resolved
                    && canonicalizeSourceUri(resolved) === targetUri) {
                    owners.add(canonicalizeSourceUri(include.ownerUri));
                }
            }
        }
        return [...owners].sort();
    }

    private async prepareDocument(
        uri: string,
        batch: BatchState,
        defines: Record<string, string | true>,
        signal?: AbortSignal,
        excludedUris: ReadonlySet<string> = new Set()
    ): Promise<PreparedDocument> {
        const input = await this.readFile(uri, batch, signal);
        const resolvedIncludes = await this.resolveIncludes(
            uri,
            input.text,
            batch,
            defines,
            signal,
            excludedUris
        );
        return {
            input,
            contentHash: contentHash(input.text),
            preprocessingFingerprint: preprocessingFingerprint({
                defines,
                resolvedIncludes,
            }),
            resolvedIncludes,
        };
    }

    private async resolveIncludes(
        uri: string,
        text: string,
        batch: BatchState,
        defines: Record<string, string | true>,
        signal?: AbortSignal,
        excludedUris: ReadonlySet<string> = new Set()
    ): Promise<ResolvedIncludeInput[]> {
        const resolved = new Map<string, ResolvedIncludeInput>();
        const attempted = new Set<string>();
        while (true) {
            this.checkpoint(signal);
            const current = [...resolved.values()].sort((left, right) =>
                left.fromUri.localeCompare(right.fromUri)
                || left.rawPath.localeCompare(right.rawPath)
                || left.resolvedUri.localeCompare(right.resolvedUri)
            );
            const preprocessed = preprocessForParsing(uri, text, {
                defines,
                resolvedIncludes: current,
            });
            this.checkpoint(signal);
            const includes = getPreprocessMetadataForWorker(preprocessed).includes;
            let added = false;
            for (const include of includes) {
                if (!include.path) {
                    continue;
                }
                const fromUri = canonicalizeSourceUri(include.span.uri ?? uri);
                const key = `${fromUri}\0${include.path}`;
                if (attempted.has(key)) {
                    continue;
                }
                attempted.add(key);
                const resolvedUri = await this.options.resolveInclude(fromUri, include.path);
                this.checkpoint(signal);
                if (!resolvedUri) {
                    continue;
                }
                const canonicalResolvedUri = canonicalizeSourceUri(resolvedUri);
                if (excludedUris.has(canonicalResolvedUri)) {
                    continue;
                }
                const input = await this.readFile(canonicalResolvedUri, batch, signal);
                resolved.set(key, {
                    fromUri,
                    rawPath: include.path,
                    resolvedUri: canonicalResolvedUri,
                    text: input.text,
                });
                added = true;
            }
            if (!added) {
                return current;
            }
        }
    }

    private async readFile(
        uri: string,
        batch: BatchState,
        signal?: AbortSignal
    ): Promise<FileInput> {
        const canonicalUri = canonicalizeSourceUri(uri);
        const cached = batch.reads.get(canonicalUri);
        if (cached) {
            return cached;
        }
        this.checkpoint(signal);
        const input = await this.options.readFile(canonicalUri);
        this.checkpoint(signal);
        batch.reads.set(canonicalUri, input);
        return input;
    }

    private async commitBatch(
        previousFiles: Map<string, HdlFileSummary>,
        batch: BatchState,
        signal?: AbortSignal,
        nextDefines?: Record<string, string | true>
    ): Promise<void> {
        this.checkpoint(signal);
        const snapshot = this.persistedSnapshot(
            batch.files,
            nextDefines ?? this.defines
        );
        if (signal) {
            try {
                await this.options.store.stage(snapshot);
            } catch (error) {
                await this.discardStagedBestEffort();
                throw error;
            }
            try {
                this.checkpoint(signal);
            } catch (error) {
                await this.discardStagedBestEffort();
                throw error;
            }
            try {
                await this.options.store.save(snapshot);
            } catch (error) {
                await this.discardStagedBestEffort();
                throw error;
            }
            await this.discardStagedBestEffort();
        } else {
            await this.options.store.save(snapshot);
        }
        this.files = batch.files;
        this.documents = batch.documents;
        if (nextDefines) {
            this.defines = { ...nextDefines };
        }

        const previousDefinitions = new Map(
            [...previousFiles.values()].flatMap(file => file.definitions)
                .map(definition => [definition.key, definition] as const)
        );
        const nextDefinitions = new Map(
            [...batch.files.values()].flatMap(file => file.definitions)
                .map(definition => [definition.key, definition] as const)
        );
        const changedDefinitionKeys = [...new Set([
            ...previousDefinitions.keys(),
            ...nextDefinitions.keys(),
        ])].filter(key =>
            previousDefinitions.get(key)?.modelFingerprint
                !== nextDefinitions.get(key)?.modelFingerprint
        ).sort();
        const event: WorkspaceIndexInvalidation = {
            changedUris: [...batch.changedUris].sort(),
            affectedDocumentUris: [...batch.affectedDocumentUris].sort(),
            changedDefinitionKeys,
            parserFingerprint: this.options.parserFingerprint,
        };
        if (event.changedUris.length > 0
            || event.affectedDocumentUris.length > 0
            || event.changedDefinitionKeys.length > 0) {
            this.emit(event);
        }
    }

    private persistedSnapshot(
        files: Map<string, HdlFileSummary>,
        defines: Record<string, string | true>
    ): PersistedWorkspaceIndex {
        return {
            schemaVersion: 1,
            parserFingerprint: workspaceCacheFingerprint(
                this.options.parserFingerprint,
                defines
            ),
            files: [...files.values()].sort((left, right) =>
                left.uri.localeCompare(right.uri)
            ),
        };
    }

    private async discardStagedBestEffort(): Promise<void> {
        try {
            await this.options.store.discardStaged();
        } catch {
            // Pending snapshots are never read and cleanup must not mask commit state.
        }
    }

    private emit(event: WorkspaceIndexInvalidation): void {
        if (this.disposed) {
            return;
        }
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch {
                // One consumer must not prevent other invalidation listeners from running.
            }
        }
    }

    private checkpoint(signal?: AbortSignal): void {
        this.ensureActive();
        signal?.throwIfAborted();
    }

    private ensureActive(): void {
        if (this.disposed) {
            throw new Error('Workspace HDL index is disposed');
        }
    }

    private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writeTail.then(async () => {
            this.ensureActive();
            return operation();
        });
        this.writeTail = result.then(() => undefined, () => undefined);
        return result;
    }
}
