import { createHash } from 'crypto';

import type { PersistedWorkspaceIndex } from './workspaceIndexTypes';

type MementoLike = {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
};

const KEY = 'veriflow.hdlWorkspaceIndex.v1';
const PENDING_KEY = 'veriflow.hdlWorkspaceIndex.v1.pending';

function fingerprintKey(parserFingerprint: string, pending = false): string {
    const digest = createHash('sha256').update(parserFingerprint).digest('hex');
    return `${KEY}.${digest}${pending ? '.pending' : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isSourceFileSpan(value: unknown): boolean {
    return isRecord(value)
        && typeof value.uri === 'string'
        && isNumber(value.start)
        && isNumber(value.end);
}

function isSourceSpan(value: unknown): boolean {
    if (!isRecord(value) || !isNumber(value.start) || !isNumber(value.end)) {
        return false;
    }
    return (value.uri === undefined || typeof value.uri === 'string')
        && (value.compositeParts === undefined
            || (Array.isArray(value.compositeParts)
                && value.compositeParts.every(isSourceFileSpan)));
}

function isWidthValue(value: unknown): boolean {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        return false;
    }
    switch (value.kind) {
        case 'known':
            return isNumber(value.bits);
        case 'symbolic':
            return typeof value.expression === 'string';
        case 'unknown':
            return true;
        default:
            return false;
    }
}

function isParameterSummary(value: unknown): boolean {
    return isRecord(value)
        && typeof value.name === 'string'
        && (value.defaultExpression === undefined || typeof value.defaultExpression === 'string');
}

function isPortSummary(value: unknown): boolean {
    return isRecord(value)
        && typeof value.name === 'string'
        && (value.direction === 'input' || value.direction === 'output' || value.direction === 'inout')
        && (value.packedRange === undefined || typeof value.packedRange === 'string')
        && isWidthValue(value.width);
}

function isDefinitionSummary(value: unknown): boolean {
    return isRecord(value)
        && typeof value.key === 'string'
        && (value.kind === 'module' || value.kind === 'interface' || value.kind === 'package')
        && typeof value.name === 'string'
        && typeof value.uri === 'string'
        && isNumber(value.declarationStart)
        && isNumber(value.declarationLine)
        && Array.isArray(value.parameters)
        && value.parameters.every(isParameterSummary)
        && Array.isArray(value.ports)
        && value.ports.every(isPortSummary)
        && isStringArray(value.dependencies)
        && typeof value.modelFingerprint === 'string';
}

function isUnresolvedIncludeSummary(value: unknown): boolean {
    return isRecord(value)
        && typeof value.ownerUri === 'string'
        && typeof value.fromUri === 'string'
        && typeof value.rawPath === 'string';
}

function isDiagnostic(value: unknown): boolean {
    return isRecord(value)
        && (value.severity === 'error' || value.severity === 'warning' || value.severity === 'info')
        && typeof value.code === 'string'
        && typeof value.message === 'string'
        && (value.span === undefined || isSourceSpan(value.span));
}

function isFileSummary(value: unknown): boolean {
    return isRecord(value)
        && typeof value.uri === 'string'
        && isNumber(value.mtimeMs)
        && isNumber(value.size)
        && typeof value.contentHash === 'string'
        && (value.preprocessingFingerprint === undefined
            || typeof value.preprocessingFingerprint === 'string')
        && isStringArray(value.includeUris)
        && (value.unresolvedIncludes === undefined
            || (Array.isArray(value.unresolvedIncludes)
                && value.unresolvedIncludes.every(isUnresolvedIncludeSummary)))
        && Array.isArray(value.definitions)
        && value.definitions.every(isDefinitionSummary)
        && Array.isArray(value.diagnostics)
        && value.diagnostics.every(isDiagnostic);
}

function isPersistedWorkspaceIndex(value: unknown): value is PersistedWorkspaceIndex {
    return isRecord(value)
        && value.schemaVersion === 1
        && typeof value.parserFingerprint === 'string'
        && Array.isArray(value.files)
        && value.files.every(isFileSummary);
}

export class WorkspaceIndexStore {
    private committedKey = KEY;
    private stagedKey: string | undefined;

    constructor(private readonly state: MementoLike) {}

    load(parserFingerprint: string): PersistedWorkspaceIndex | undefined {
        this.committedKey = fingerprintKey(parserFingerprint);
        const value = this.state.get<unknown>(this.committedKey)
            ?? this.state.get<unknown>(KEY);
        return isPersistedWorkspaceIndex(value) && value.parserFingerprint === parserFingerprint
            ? value
            : undefined;
    }

    async save(value: PersistedWorkspaceIndex): Promise<void> {
        this.committedKey = fingerprintKey(value.parserFingerprint);
        await this.state.update(this.committedKey, value);
    }

    async stage(value: PersistedWorkspaceIndex): Promise<void> {
        this.stagedKey = fingerprintKey(value.parserFingerprint, true);
        await this.state.update(this.stagedKey, value);
    }

    async discardStaged(): Promise<void> {
        const key = this.stagedKey ?? PENDING_KEY;
        await this.state.update(key, undefined);
        if (this.stagedKey === key) {
            this.stagedKey = undefined;
        }
    }

    async clear(): Promise<void> {
        await Promise.all([
            this.state.update(this.committedKey, undefined),
            ...(this.committedKey === KEY
                ? []
                : [this.state.update(KEY, undefined)]),
        ]);
    }
}
