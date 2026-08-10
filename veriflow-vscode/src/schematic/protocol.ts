import type { SourceSpan } from '../core/hdl/model';
import type { SchematicGraph } from './graphModel';
import {
    normalizeSchematicLayout,
    type SchematicLayout,
} from './layoutStore';

/** Bounds source-map work while accommodating deeply composed include expansions. */
const MAX_COMPOSITE_PARTS = 5_000;

export type WebviewCommand =
    | { type: 'ready' }
    | { type: 'selectModule'; moduleKey: string }
    | {
        type: 'saveLayout';
        moduleKey: string;
        revision: string;
        layout: SchematicLayout;
    }
    | { type: 'revealSource'; span: SourceSpan }
    | { type: 'openDefinition'; definitionKey: string }
    | { type: 'search'; query: string }
    | { type: 'relayoutAll'; moduleKey: string };

export type HostEvent =
    | {
        type: 'initialize';
        fileUri: string;
        modules: Array<{ key: string; name: string }>;
        selectedModuleKey: string;
    }
    | {
        type: 'graph';
        revision: string;
        graph: SchematicGraph;
        layout: SchematicLayout;
    }
    | { type: 'diagnostics'; errors: number; warnings: number }
    | { type: 'hostError'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
    return Object.prototype.propertyIsEnumerable.call(value, key)
        ? value[key]
        : undefined;
}

function sourceOffset(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeSourceSpan(value: unknown): SourceSpan | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const start = ownValue(value, 'start');
    const end = ownValue(value, 'end');
    const uri = ownValue(value, 'uri');
    const compositeParts = ownValue(value, 'compositeParts');
    if (!sourceOffset(start)
        || !sourceOffset(end)
        || start > end
        || (uri !== undefined && !nonEmptyString(uri))) {
        return undefined;
    }

    let parts: unknown[] | undefined;
    let partCount = 0;
    if (compositeParts !== undefined) {
        if (!Array.isArray(compositeParts)) {
            return undefined;
        }
        parts = compositeParts;
        partCount = parts.length;
        if (partCount > MAX_COMPOSITE_PARTS) {
            return undefined;
        }
    }

    const span: SourceSpan = { start, end };
    if (uri !== undefined) {
        span.uri = uri;
    }
    if (parts !== undefined) {
        const normalizedParts: NonNullable<SourceSpan['compositeParts']> = [];
        for (let index = 0; index < partCount; index += 1) {
            if (!Object.prototype.propertyIsEnumerable.call(parts, index)) {
                return undefined;
            }
            const candidate = parts[index];
            if (!isRecord(candidate)) {
                return undefined;
            }
            const partUri = ownValue(candidate, 'uri');
            const partStart = ownValue(candidate, 'start');
            const partEnd = ownValue(candidate, 'end');
            if (!nonEmptyString(partUri)
                || !sourceOffset(partStart)
                || !sourceOffset(partEnd)
                || partStart > partEnd) {
                return undefined;
            }
            const part = { uri: partUri, start: partStart, end: partEnd };
            normalizedParts.push(part);
        }
        span.compositeParts = normalizedParts;
    }
    return span;
}

export function parseWebviewCommand(value: unknown): WebviewCommand | undefined {
    try {
        if (!isRecord(value)) {
            return undefined;
        }

        const type = ownValue(value, 'type');
        if (typeof type !== 'string') {
            return undefined;
        }

        switch (type) {
            case 'ready':
                return { type: 'ready' };
            case 'selectModule': {
                const moduleKey = ownValue(value, 'moduleKey');
                return nonEmptyString(moduleKey)
                    ? { type: 'selectModule', moduleKey }
                    : undefined;
            }
            case 'saveLayout': {
                const moduleKey = ownValue(value, 'moduleKey');
                const revision = ownValue(value, 'revision');
                if (!nonEmptyString(moduleKey) || !nonEmptyString(revision)) {
                    return undefined;
                }
                const layout = normalizeSchematicLayout(ownValue(value, 'layout'));
                return layout
                    ? { type: 'saveLayout', moduleKey, revision, layout }
                    : undefined;
            }
            case 'revealSource': {
                const span = normalizeSourceSpan(ownValue(value, 'span'));
                return span ? { type: 'revealSource', span } : undefined;
            }
            case 'openDefinition': {
                const definitionKey = ownValue(value, 'definitionKey');
                return nonEmptyString(definitionKey)
                    ? { type: 'openDefinition', definitionKey }
                    : undefined;
            }
            case 'search': {
                const query = ownValue(value, 'query');
                return typeof query === 'string' ? { type: 'search', query } : undefined;
            }
            case 'relayoutAll': {
                const moduleKey = ownValue(value, 'moduleKey');
                return nonEmptyString(moduleKey)
                    ? { type: 'relayoutAll', moduleKey }
                    : undefined;
            }
            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
}
