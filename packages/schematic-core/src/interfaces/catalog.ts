import { compareCodeUnits } from '../archDesign/ordering';
import { BUILTIN_INTERFACE_PROTOCOL_VALUES } from './builtins';
import {
    type InterfaceProtocolCatalog,
    type InterfaceProtocolCatalogDiagnostic,
    type InterfaceProtocolCatalogEntry,
    type InterfaceProtocolCatalogInput,
} from './model';
import { parseInterfaceProtocolValue } from './parser';

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
    if (value === null || typeof value !== 'object' || visited.has(value)) return value;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
        deepFreeze((value as Record<PropertyKey, unknown>)[key], visited);
    }
    return Object.freeze(value);
}

export function createInterfaceProtocolCatalog(
    projectDefinitions: readonly InterfaceProtocolCatalogInput[] = []
): InterfaceProtocolCatalog {
    const entries: InterfaceProtocolCatalogEntry[] = [];
    const diagnostics: InterfaceProtocolCatalogDiagnostic[] = [];
    const indexes = new Map<string, number>();
    for (const builtin of BUILTIN_INTERFACE_PROTOCOL_VALUES) {
        const parsed = parseInterfaceProtocolValue(builtin.value);
        if (parsed.status !== 'editable') {
            throw new Error(`Invalid built-in interface protocol: ${builtin.source}`);
        }
        indexes.set(parsed.protocol.id, entries.length);
        entries.push({
            protocol: parsed.protocol,
            source: { kind: 'builtin', source: builtin.source },
        });
    }

    const builtinCount = entries.length;
    for (const definition of projectDefinitions) {
        const parsed = parseInterfaceProtocolValue(definition.value);
        if (parsed.status === 'invalid') {
            for (const item of parsed.diagnostics) {
                diagnostics.push({ ...item, source: definition.source });
            }
            continue;
        }
        if (parsed.status === 'unsupported') {
            diagnostics.push({
                source: definition.source,
                path: '$.schemaVersion',
                code: 'IF_PROTOCOL_SCHEMA_UNSUPPORTED',
                message: `Interface protocol schema version ${parsed.schemaVersion} is not supported`,
            });
            continue;
        }
        const existingIndex = indexes.get(parsed.protocol.id);
        if (existingIndex === undefined) {
            indexes.set(parsed.protocol.id, entries.length);
            entries.push({
                protocol: parsed.protocol,
                source: { kind: 'project', source: definition.source },
            });
            continue;
        }
        const previous = entries[existingIndex];
        entries[existingIndex] = {
            protocol: parsed.protocol,
            source: {
                kind: 'project',
                source: definition.source,
                overrides: previous.source.source,
            },
        };
    }
    const additions = entries.splice(builtinCount);
    additions.sort((left, right) =>
        compareCodeUnits(left.protocol.id, right.protocol.id)
        || compareCodeUnits(left.source.source, right.source.source));
    entries.push(...additions);
    diagnostics.sort((left, right) =>
        compareCodeUnits(left.source, right.source)
        || compareCodeUnits(left.path, right.path)
        || compareCodeUnits(left.code, right.code));
    return deepFreeze({ entries, diagnostics });
}

export function findInterfaceProtocol(
    catalog: InterfaceProtocolCatalog,
    id: string
): InterfaceProtocolCatalogEntry | undefined {
    return catalog.entries.find(entry => entry.protocol.id === id);
}
