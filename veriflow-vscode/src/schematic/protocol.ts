import {
    MAX_SCHEMATIC_PLACEMENT_OFFSET,
    type SchematicGraph,
} from '@veriflow/schematic-core';
import type {
    ArchDesign,
    ArchDesignEdit,
    ArchDesignEndpoint,
    ArchDesignInstance,
    ArchDesignModuleDefinition,
    ArchDesignPort,
    ArchDesignPresentation,
    ArchDesignValidationResult,
} from '@veriflow/schematic-core/arch-design';

import type { SourceSpan } from '../core/hdl/model';
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
    | { type: 'relayoutAll'; moduleKey: string; revision: string }
    | { type: 'editArchDesign'; revision: string; edit: ArchDesignEdit }
    | { type: 'exportArchDesign'; revision: string };

export type HostEvent =
    | {
        type: 'initialize';
        fileUri: string;
        modules: Array<{ key: string; name: string }>;
        selectedModuleKey: string;
        documentKind?: 'hdl' | 'arch-design';
        editable?: boolean;
    }
    | {
        type: 'graph';
        revision: string;
        graph: SchematicGraph;
        layout: SchematicLayout;
    }
    | { type: 'diagnostics'; errors: number; warnings: number }
    | { type: 'hostError'; message: string }
    | {
        type: 'archDesignState';
        status: 'editable';
        revision: string;
        design: ArchDesign;
        catalog: readonly ArchDesignModuleDefinition[];
        validation: ArchDesignValidationResult;
    }
    | {
        type: 'archDesignState';
        status: 'readonly';
        revision: string;
        reason: string;
        schemaVersion?: number;
    }
    | {
        type: 'archDesignState';
        status: 'invalid';
        revision: string;
        diagnostics: readonly Readonly<{
            path: string;
            code: string;
            message: string;
        }>[];
    };

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_AD_STRING_LENGTH = 4_096;
const MAX_AD_DICTIONARY_ENTRIES = 4_096;
const MAX_AD_PRESENTATION_NODES = 50_000;
const MAX_AD_PRESENTATION_COLUMN = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string'
        && value.length <= MAX_AD_STRING_LENGTH
        && value.trim().length > 0;
}

function identifier(value: unknown): value is string {
    return typeof value === 'string'
        && value.length <= MAX_AD_STRING_LENGTH
        && PLAIN_IDENTIFIER.test(value);
}

function ownValue(value: Record<string, unknown>, key: string): unknown {
    return Object.prototype.propertyIsEnumerable.call(value, key)
        ? value[key]
        : undefined;
}

function sourceOffset(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function finiteCoordinate(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && Math.abs(value) <= MAX_SCHEMATIC_PLACEMENT_OFFSET;
}

function boundedInteger(value: unknown, maximum: number): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        && value < maximum;
}

function defineOwn<T>(target: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function normalizeParameters(
    value: unknown
): ArchDesignInstance['parameters'] | undefined | false {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return false;
    const parameters: Record<string, string | number | boolean> = {};
    let count = 0;
    for (const key of Object.keys(value)) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key)
            || !identifier(key)) return false;
        count += 1;
        if (count > MAX_AD_DICTIONARY_ENTRIES) return false;
        const candidate = value[key];
        if (typeof candidate !== 'string'
            && typeof candidate !== 'boolean'
            && (typeof candidate !== 'number' || !Number.isFinite(candidate))) {
            return false;
        }
        if (typeof candidate === 'string' && candidate.length > MAX_AD_STRING_LENGTH) {
            return false;
        }
        defineOwn(parameters, key, candidate);
    }
    return parameters;
}

function normalizeInstance(value: unknown): ArchDesignInstance | undefined {
    if (!isRecord(value)) return undefined;
    const name = ownValue(value, 'name');
    const module = ownValue(value, 'module');
    const parameters = normalizeParameters(ownValue(value, 'parameters'));
    if (!identifier(name) || !identifier(module) || parameters === false) return undefined;
    return {
        name,
        module,
        ...(parameters === undefined ? {} : { parameters }),
    };
}

function normalizeWidth(value: unknown): ArchDesignPort['width'] | undefined | false {
    if (value === undefined) return undefined;
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value > 0 ? value : false;
    }
    if (!isRecord(value)) return false;
    const expression = ownValue(value, 'expression');
    return nonEmptyString(expression) ? { expression } : false;
}

function normalizePort(value: unknown): ArchDesignPort | undefined {
    if (!isRecord(value)) return undefined;
    const name = ownValue(value, 'name');
    const direction = ownValue(value, 'direction');
    const width = normalizeWidth(ownValue(value, 'width'));
    if (!identifier(name)
        || (direction !== 'input' && direction !== 'output' && direction !== 'inout')
        || width === false) return undefined;
    return {
        name,
        direction,
        ...(width === undefined ? {} : { width }),
    };
}

function normalizeEndpoint(value: unknown): ArchDesignEndpoint | undefined {
    if (!isRecord(value)) return undefined;
    const kind = ownValue(value, 'kind');
    const port = ownValue(value, 'port');
    if (!identifier(port)) return undefined;
    if (kind === 'instance') {
        const instance = ownValue(value, 'instance');
        return identifier(instance) ? { kind, instance, port } : undefined;
    }
    if (kind !== 'port') return undefined;
    const signal = ownValue(value, 'signal');
    return signal === undefined
        ? { kind, port }
        : signal === 'value' || signal === 'i' || signal === 'o' || signal === 't'
            ? { kind, port, signal }
            : undefined;
}

function normalizePresentationNodes(
    value: unknown
): ArchDesignPresentation['nodes'] | undefined | false {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return false;
    const nodes: Record<string, NonNullable<ArchDesignPresentation['nodes']>[string]> = {};
    let count = 0;
    for (const key of Object.keys(value)) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key)
            || !nonEmptyString(key)) return false;
        count += 1;
        if (count > MAX_AD_PRESENTATION_NODES) return false;
        const candidate = value[key];
        if (!isRecord(candidate)) return false;
        const column = ownValue(candidate, 'column');
        const order = ownValue(candidate, 'order');
        const offset = ownValue(candidate, 'offset');
        const userPositioned = ownValue(candidate, 'userPositioned');
        if (!boundedInteger(column, MAX_AD_PRESENTATION_COLUMN)
            || !boundedInteger(order, MAX_AD_PRESENTATION_NODES)
            || (offset !== undefined && !finiteCoordinate(offset))
            || (userPositioned !== undefined && typeof userPositioned !== 'boolean')) {
            return false;
        }
        defineOwn(nodes, key, {
            column,
            order,
            ...(offset === undefined ? {} : { offset }),
            ...(userPositioned === undefined ? {} : { userPositioned }),
        });
    }
    return nodes;
}

function normalizeBooleanDictionary(
    value: unknown
): Readonly<Record<string, boolean>> | undefined | false {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return false;
    const result: Record<string, boolean> = {};
    let count = 0;
    for (const key of Object.keys(value)) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key)
            || !nonEmptyString(key)) return false;
        count += 1;
        if (count > MAX_AD_DICTIONARY_ENTRIES || typeof value[key] !== 'boolean') {
            return false;
        }
        defineOwn(result, key, value[key] as boolean);
    }
    return result;
}

function normalizeArchDesignPresentation(value: unknown): ArchDesignPresentation | undefined {
    if (!isRecord(value)) return undefined;
    const nodes = normalizePresentationNodes(ownValue(value, 'nodes'));
    const collapsedInterfaces = normalizeBooleanDictionary(
        ownValue(value, 'collapsedInterfaces')
    );
    if (nodes === false || collapsedInterfaces === false) return undefined;
    const viewportValue = ownValue(value, 'viewport');
    let viewport: ArchDesignPresentation['viewport'];
    if (viewportValue !== undefined) {
        if (!isRecord(viewportValue)) return undefined;
        const x = ownValue(viewportValue, 'x');
        const y = ownValue(viewportValue, 'y');
        const zoom = ownValue(viewportValue, 'zoom');
        if (!finiteCoordinate(x) || !finiteCoordinate(y)
            || typeof zoom !== 'number' || !Number.isFinite(zoom)
            || zoom < 0.1 || zoom > 4) return undefined;
        viewport = { x, y, zoom };
    }
    return {
        ...(nodes === undefined ? {} : { nodes }),
        ...(collapsedInterfaces === undefined ? {} : { collapsedInterfaces }),
        ...(viewport === undefined ? {} : { viewport }),
    };
}

function normalizeArchDesignEdit(value: unknown): ArchDesignEdit | undefined {
    if (!isRecord(value)) return undefined;
    const type = ownValue(value, 'type');
    switch (type) {
        case 'addInstance': {
            const instance = normalizeInstance(ownValue(value, 'instance'));
            return instance ? { type, instance } : undefined;
        }
        case 'renameInstance':
        case 'renameConnection': {
            const name = ownValue(value, 'name');
            const nextName = ownValue(value, 'nextName');
            return identifier(name) && identifier(nextName)
                ? { type, name, nextName }
                : undefined;
        }
        case 'removeInstance':
        case 'removePort':
        case 'removeConnection': {
            const name = ownValue(value, 'name');
            return identifier(name) ? { type, name } : undefined;
        }
        case 'setInstanceParameter': {
            const instance = ownValue(value, 'instance');
            const parameter = ownValue(value, 'parameter');
            const parameterValue = ownValue(value, 'value');
            if (!identifier(instance) || !identifier(parameter)) return undefined;
            if (parameterValue !== undefined
                && typeof parameterValue !== 'string'
                && typeof parameterValue !== 'boolean'
                && (typeof parameterValue !== 'number' || !Number.isFinite(parameterValue))) {
                return undefined;
            }
            if (typeof parameterValue === 'string'
                && parameterValue.length > MAX_AD_STRING_LENGTH) return undefined;
            return {
                type,
                instance,
                parameter,
                ...(parameterValue === undefined ? {} : { value: parameterValue }),
            };
        }
        case 'addPort': {
            const port = normalizePort(ownValue(value, 'port'));
            return port ? { type, port } : undefined;
        }
        case 'updatePort': {
            const name = ownValue(value, 'name');
            const port = normalizePort(ownValue(value, 'port'));
            return identifier(name) && port ? { type, name, port } : undefined;
        }
        case 'connect': {
            const source = normalizeEndpoint(ownValue(value, 'source'));
            const target = normalizeEndpoint(ownValue(value, 'target'));
            return source && target ? { type, source, target } : undefined;
        }
        case 'disconnect': {
            const connection = ownValue(value, 'connection');
            const endpoint = normalizeEndpoint(ownValue(value, 'endpoint'));
            return identifier(connection) && endpoint
                ? { type, connection, endpoint }
                : undefined;
        }
        case 'setDefault': {
            const endpoint = ownValue(value, 'endpoint');
            const expression = ownValue(value, 'expression');
            const connection = ownValue(value, 'connection');
            if (!nonEmptyString(endpoint)
                || (expression !== undefined && !nonEmptyString(expression))
                || (connection !== undefined && !identifier(connection))) return undefined;
            return {
                type,
                endpoint,
                ...(expression === undefined ? {} : { expression }),
                ...(connection === undefined ? {} : { connection }),
            };
        }
        case 'setExport': {
            const language = ownValue(value, 'language');
            const output = ownValue(value, 'output');
            if (language !== undefined
                && language !== 'verilog'
                && language !== 'systemverilog') return undefined;
            if (output !== undefined && !nonEmptyString(output)) return undefined;
            return {
                type,
                ...(language === undefined ? {} : { language }),
                ...(output === undefined ? {} : { output }),
            };
        }
        case 'setPresentation': {
            const presentation = normalizeArchDesignPresentation(
                ownValue(value, 'presentation')
            );
            return presentation ? { type, presentation } : undefined;
        }
        default:
            return undefined;
    }
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
                const revision = ownValue(value, 'revision');
                return nonEmptyString(moduleKey) && nonEmptyString(revision)
                    ? { type: 'relayoutAll', moduleKey, revision }
                    : undefined;
            }
            case 'editArchDesign': {
                const revision = ownValue(value, 'revision');
                const edit = normalizeArchDesignEdit(ownValue(value, 'edit'));
                return nonEmptyString(revision) && edit
                    ? { type: 'editArchDesign', revision, edit }
                    : undefined;
            }
            case 'exportArchDesign': {
                const revision = ownValue(value, 'revision');
                return nonEmptyString(revision)
                    ? { type: 'exportArchDesign', revision }
                    : undefined;
            }
            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
}
