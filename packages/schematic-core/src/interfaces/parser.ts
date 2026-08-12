import { isSafeDefaultExpression } from '../archDesign/defaults';
import { compareCodeUnits } from '../archDesign/ordering';
import {
    INTERFACE_PROTOCOL_FORMAT,
    INTERFACE_PROTOCOL_SCHEMA_VERSION,
    type InterfaceMemberDirection,
    type InterfaceProtocol,
    type InterfaceProtocolDiagnostic,
    type InterfaceProtocolMember,
    type InterfaceProtocolReadResult,
} from './model';

type MutableRecord = Record<string, unknown>;

const PROTOCOL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MEMBER_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MEMBER_DIRECTIONS = new Set<InterfaceMemberDirection>([
    'master-to-slave',
    'slave-to-master',
]);

function isRecord(value: unknown): value is MutableRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: MutableRecord, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
    if (value === null || typeof value !== 'object' || visited.has(value)) return value;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
        deepFreeze((value as Record<PropertyKey, unknown>)[key], visited);
    }
    return Object.freeze(value);
}

function diagnostic(
    diagnostics: InterfaceProtocolDiagnostic[],
    path: string,
    code: string,
    message: string
): void {
    diagnostics.push({ path, code, message });
}

function invalidResult(
    diagnostics: InterfaceProtocolDiagnostic[]
): InterfaceProtocolReadResult {
    diagnostics.sort((left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    return deepFreeze({ status: 'invalid' as const, diagnostics });
}

function denseArraySnapshot(value: unknown): unknown[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const length = value.length;
    let ownItems = 0;
    for (const key of Object.keys(value)) {
        const index = Number(key);
        if (Number.isInteger(index) && index >= 0 && index < length && String(index) === key) {
            ownItems += 1;
        }
    }
    if (ownItems !== length) return undefined;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined;
        result.push(value[index]);
    }
    return result;
}

function arrayValue(
    value: unknown,
    path: string,
    diagnostics: InterfaceProtocolDiagnostic[]
): readonly unknown[] {
    if (!Array.isArray(value)) {
        diagnostic(diagnostics, path, 'IF_PROTOCOL_TYPE', 'Expected an array');
        return [];
    }
    const snapshot = denseArraySnapshot(value);
    if (!snapshot) {
        diagnostic(diagnostics, path, 'IF_PROTOCOL_VALUE', 'Expected a dense JSON array');
        return [];
    }
    return snapshot;
}

function recordValue(
    value: unknown,
    path: string,
    diagnostics: InterfaceProtocolDiagnostic[]
): MutableRecord {
    if (!isRecord(value)) {
        diagnostic(diagnostics, path, 'IF_PROTOCOL_TYPE', 'Expected an object');
        return Object.create(null) as MutableRecord;
    }
    return value;
}

function cloneUnknownJson(value: unknown, visited = new WeakSet<object>()): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError('Non-JSON number');
        return value;
    }
    if (typeof value !== 'object' || visited.has(value)) throw new TypeError('Non-JSON value');
    visited.add(value);
    if (Array.isArray(value)) {
        const items = denseArraySnapshot(value);
        if (!items) throw new TypeError('Sparse array');
        const result: unknown[] = [];
        for (const item of items) result.push(cloneUnknownJson(item, visited));
        return result;
    }
    const source = value as MutableRecord;
    const result = Object.create(null) as MutableRecord;
    for (const key of Object.keys(source)) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) throw new TypeError('Changed object');
        Object.defineProperty(result, key, {
            value: cloneUnknownJson(source[key], visited),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return result;
}

function cloneUnknownRoot(
    input: MutableRecord,
    format: unknown,
    schemaVersion: number
): MutableRecord {
    const result = Object.create(null) as MutableRecord;
    for (const key of Object.keys(input)) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) throw new TypeError('Changed object');
        const value = key === 'format'
            ? format
            : key === 'schemaVersion'
                ? schemaVersion
                : input[key];
        Object.defineProperty(result, key, {
            value: cloneUnknownJson(value),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    if (!Object.prototype.hasOwnProperty.call(result, 'format')) result.format = format;
    if (!Object.prototype.hasOwnProperty.call(result, 'schemaVersion')) {
        result.schemaVersion = schemaVersion;
    }
    return result;
}

function normalizeMembers(
    value: unknown,
    diagnostics: InterfaceProtocolDiagnostic[]
): InterfaceProtocolMember[] {
    const source = arrayValue(value, '$.members', diagnostics);
    const members: InterfaceProtocolMember[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < source.length; index += 1) {
        const path = `$.members[${index}]`;
        const record = recordValue(source[index], path, diagnostics);
        const nameValue = ownValue(record, 'name');
        const name = typeof nameValue === 'string' && MEMBER_NAME.test(nameValue)
            ? nameValue
            : '';
        if (!name) {
            diagnostic(
                diagnostics,
                `${path}.name`,
                'IF_PROTOCOL_MEMBER_NAME',
                'Expected a plain HDL member name'
            );
        }
        const normalizedName = name.toLowerCase();
        if (name && seen.has(normalizedName)) {
            diagnostic(
                diagnostics,
                `${path}.name`,
                'IF_PROTOCOL_DUPLICATE_MEMBER',
                `Duplicate member name: ${name}`
            );
        } else if (name) {
            seen.add(normalizedName);
        }

        const directionValue = ownValue(record, 'direction');
        const direction = typeof directionValue === 'string'
            && MEMBER_DIRECTIONS.has(directionValue as InterfaceMemberDirection)
            ? directionValue as InterfaceMemberDirection
            : undefined;
        if (!direction) {
            diagnostic(
                diagnostics,
                `${path}.direction`,
                'IF_PROTOCOL_MEMBER_DIRECTION',
                'Direction must be master-to-slave or slave-to-master'
            );
        }

        const defaultValue = ownValue(record, 'default');
        const defaultExpression = defaultValue === undefined
            ? undefined
            : typeof defaultValue === 'string' && isSafeDefaultExpression(defaultValue)
                ? defaultValue
                : undefined;
        if (defaultValue !== undefined && defaultExpression === undefined) {
            diagnostic(
                diagnostics,
                `${path}.default`,
                'IF_PROTOCOL_DEFAULT',
                'Expected a safe Verilog constant expression'
            );
        }
        if (name && direction) {
            members.push({
                name,
                direction,
                ...(defaultExpression === undefined ? {} : { defaultExpression }),
            });
        }
    }
    return members;
}

function normalizeRecognitionGroups(
    value: unknown,
    members: readonly InterfaceProtocolMember[],
    diagnostics: InterfaceProtocolDiagnostic[]
): string[][] {
    const source = arrayValue(value, '$.recognitionGroups', diagnostics);
    const knownMembers = new Map(members.map(member => [member.name.toLowerCase(), member.name]));
    const seenGroups = new Set<string>();
    const groups: string[][] = [];
    for (let index = 0; index < source.length; index += 1) {
        const path = `$.recognitionGroups[${index}]`;
        const items = arrayValue(source[index], path, diagnostics);
        if (items.length === 0) {
            diagnostic(
                diagnostics,
                path,
                'IF_PROTOCOL_RECOGNITION_GROUP',
                'Recognition group must contain at least one member'
            );
            continue;
        }
        const group: string[] = [];
        let valid = true;
        const seenMembers = new Set<string>();
        for (let memberIndex = 0; memberIndex < items.length; memberIndex += 1) {
            const itemPath = `${path}[${memberIndex}]`;
            const item = items[memberIndex];
            const normalized = typeof item === 'string' ? item.toLowerCase() : '';
            const canonical = knownMembers.get(normalized);
            if (!canonical) {
                diagnostic(
                    diagnostics,
                    itemPath,
                    'IF_PROTOCOL_RECOGNITION_MEMBER',
                    'Recognition group references an unknown member'
                );
                valid = false;
                continue;
            }
            if (seenMembers.has(normalized)) {
                diagnostic(
                    diagnostics,
                    itemPath,
                    'IF_PROTOCOL_RECOGNITION_MEMBER',
                    `Recognition group repeats member: ${canonical}`
                );
                valid = false;
                continue;
            }
            seenMembers.add(normalized);
            group.push(canonical);
        }
        if (!valid) continue;
        const groupKey = [...seenMembers].sort(compareCodeUnits).join('\0');
        if (seenGroups.has(groupKey)) {
            diagnostic(
                diagnostics,
                path,
                'IF_PROTOCOL_DUPLICATE_RECOGNITION_GROUP',
                'Duplicate recognition group'
            );
            continue;
        }
        seenGroups.add(groupKey);
        groups.push(group);
    }
    return groups;
}

function parseValue(input: unknown): InterfaceProtocolReadResult {
    if (!isRecord(input)) {
        return invalidResult([{
            path: '$',
            code: 'IF_PROTOCOL_DOCUMENT',
            message: 'Interface protocol root must be an object',
        }]);
    }
    const headerDiagnostics: InterfaceProtocolDiagnostic[] = [];
    const format = ownValue(input, 'format');
    if (format !== INTERFACE_PROTOCOL_FORMAT) {
        diagnostic(
            headerDiagnostics,
            '$.format',
            'IF_PROTOCOL_FORMAT',
            `Expected format ${INTERFACE_PROTOCOL_FORMAT}`
        );
    }
    const versionValue = ownValue(input, 'schemaVersion');
    const schemaVersion = typeof versionValue === 'number'
        && Number.isSafeInteger(versionValue)
        && versionValue > 0
        ? versionValue
        : undefined;
    if (schemaVersion === undefined) {
        diagnostic(
            headerDiagnostics,
            '$.schemaVersion',
            'IF_PROTOCOL_SCHEMA_VERSION',
            'schemaVersion must be a positive integer'
        );
    }
    if (headerDiagnostics.length > 0 || schemaVersion === undefined) {
        return invalidResult(headerDiagnostics);
    }
    if (schemaVersion !== INTERFACE_PROTOCOL_SCHEMA_VERSION) {
        return deepFreeze({
            status: 'unsupported' as const,
            schemaVersion,
            value: cloneUnknownRoot(input, format, schemaVersion),
        });
    }

    const diagnostics: InterfaceProtocolDiagnostic[] = [];
    const idValue = ownValue(input, 'id');
    const id = typeof idValue === 'string' && PROTOCOL_ID.test(idValue) ? idValue : '';
    if (!id) {
        diagnostic(diagnostics, '$.id', 'IF_PROTOCOL_ID', 'Expected a stable protocol ID');
    }
    const nameValue = ownValue(input, 'name');
    const name = typeof nameValue === 'string' && nameValue.trim().length > 0
        ? nameValue
        : '';
    if (!name) {
        diagnostic(diagnostics, '$.name', 'IF_PROTOCOL_NAME', 'Expected a non-empty name');
    }
    const separatorValue = ownValue(input, 'separator');
    const separator = typeof separatorValue === 'string' && separatorValue.length <= 16
        ? separatorValue
        : undefined;
    if (separator === undefined) {
        diagnostic(
            diagnostics,
            '$.separator',
            'IF_PROTOCOL_SEPARATOR',
            'Expected a separator string of at most 16 characters'
        );
    }
    const priorityValue = ownValue(input, 'priority');
    const priority = priorityValue === undefined
        ? 0
        : typeof priorityValue === 'number'
            && Number.isSafeInteger(priorityValue)
            && priorityValue >= 0
            ? priorityValue
            : undefined;
    if (priority === undefined) {
        diagnostic(
            diagnostics,
            '$.priority',
            'IF_PROTOCOL_PRIORITY',
            'Priority must be a non-negative safe integer'
        );
    }
    const members = normalizeMembers(ownValue(input, 'members'), diagnostics);
    const recognitionGroups = normalizeRecognitionGroups(
        ownValue(input, 'recognitionGroups'),
        members,
        diagnostics
    );
    if (diagnostics.length > 0) return invalidResult(diagnostics);

    const protocol: InterfaceProtocol = {
        format: INTERFACE_PROTOCOL_FORMAT,
        schemaVersion: INTERFACE_PROTOCOL_SCHEMA_VERSION,
        id,
        name,
        separator: separator!,
        priority: priority!,
        members,
        recognitionGroups,
    };
    return deepFreeze({ status: 'editable' as const, protocol });
}

export function parseInterfaceProtocolValue(value: unknown): InterfaceProtocolReadResult {
    try {
        return parseValue(value);
    } catch {
        return invalidResult([{
            path: '$',
            code: 'IF_PROTOCOL_VALUE',
            message: 'Interface protocol contains an unreadable or non-JSON value',
        }]);
    }
}

export function parseInterfaceProtocolText(source: string): InterfaceProtocolReadResult {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return invalidResult([{
            path: '$',
            code: 'IF_PROTOCOL_JSON_SYNTAX',
            message: 'Interface protocol is not valid JSON',
        }]);
    }
    return parseInterfaceProtocolValue(value);
}
