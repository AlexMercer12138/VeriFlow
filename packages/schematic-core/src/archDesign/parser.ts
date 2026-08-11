import {
    ARCH_DESIGN_FORMAT,
    ARCH_DESIGN_SCHEMA_VERSION,
    type ArchDesign,
    type ArchDesignConnection,
    type ArchDesignEndpoint,
    type ArchDesignExportOptions,
    type ArchDesignInstance,
    type ArchDesignInterfaceConnection,
    type ArchDesignInterfaceEndpoint,
    type ArchDesignNodePlacement,
    type ArchDesignPort,
    type ArchDesignPresentation,
    type ArchDesignViewport,
    type ArchDesignWidth,
} from './model';
import { compareCodeUnits } from './ordering';

export type ArchDesignDiagnostic = Readonly<{
    path: string;
    code: string;
    message: string;
}>;

export type ArchDesignReadResult =
    | Readonly<{ status: 'editable'; design: ArchDesign }>
    | Readonly<{
        status: 'unsupported';
        schemaVersion: number;
        value: Readonly<Record<string, unknown>>;
    }>
    | Readonly<{
        status: 'invalid';
        diagnostics: readonly ArchDesignDiagnostic[];
    }>;

type MutableRecord = Record<string, unknown>;

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const PORT_DIRECTIONS = new Set(['input', 'output', 'inout']);
const INOUT_SIGNALS = new Set(['value', 'i', 'o', 't']);
const EXPORT_LANGUAGES = new Set(['verilog', 'systemverilog']);

function isRecord(value: unknown): value is MutableRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(record: MutableRecord, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function dictionary<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

function snapshotOwnRecord(value: MutableRecord): MutableRecord {
    const result: MutableRecord = {};
    for (const key of Object.keys(value)) {
        Object.defineProperty(result, key, {
            value: value[key],
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return result;
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
    diagnostics: ArchDesignDiagnostic[],
    path: string,
    code: string,
    message: string
): void {
    diagnostics.push({ path, code, message });
}

function invalidResult(diagnostics: ArchDesignDiagnostic[]): ArchDesignReadResult {
    diagnostics.sort((left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    return deepFreeze({ status: 'invalid' as const, diagnostics });
}

function validIdentifier(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): string {
    if (typeof value !== 'string' || !PLAIN_IDENTIFIER.test(value)) {
        diagnostic(
            diagnostics,
            path,
            'AD_IDENTIFIER',
            'Expected a plain Verilog identifier'
        );
        return '';
    }
    return value;
}

function nonEmptyString(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[],
    code = 'AD_VALUE'
): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        diagnostic(diagnostics, path, code, 'Expected a non-empty string');
        return '';
    }
    return value;
}

function recordValue(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): MutableRecord {
    if (!isRecord(value)) {
        diagnostic(diagnostics, path, 'AD_TYPE', 'Expected an object');
        return dictionary();
    }
    return value;
}

function arrayValue(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): readonly unknown[] {
    if (!Array.isArray(value)) {
        diagnostic(diagnostics, path, 'AD_TYPE', 'Expected an array');
        return [];
    }
    if (!hasDenseOwnItems(value)) {
        diagnostic(diagnostics, path, 'AD_VALUE', 'Expected a dense JSON array');
        return [];
    }
    return value;
}

function hasDenseOwnItems(source: readonly unknown[]): boolean {
    const length = source.length;
    let ownItemCount = 0;
    for (const key of Object.keys(source)) {
        const index = Number(key);
        if (
            Number.isInteger(index)
            && index >= 0
            && index < length
            && String(index) === key
        ) {
            ownItemCount += 1;
        }
    }
    return ownItemCount === length;
}

function visitArray(
    source: readonly unknown[],
    visit: (item: unknown, index: number) => void
): void {
    const length = source.length;
    for (let index = 0; index < length; index += 1) {
        visit(source[index], index);
    }
}

function normalizeWidth(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignWidth | undefined {
    if (typeof value === 'number') {
        if (Number.isSafeInteger(value) && value > 0) return value;
        diagnostic(diagnostics, path, 'AD_VALUE', 'Width must be a positive integer');
        return undefined;
    }
    if (isRecord(value)) {
        const expression = nonEmptyString(
            ownValue(value, 'expression'),
            `${path}.expression`,
            diagnostics
        );
        return expression ? { expression } : undefined;
    }
    diagnostic(diagnostics, path, 'AD_TYPE', 'Expected a width integer or expression');
    return undefined;
}

function normalizeStringDictionary(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): Record<string, string> {
    const source = recordValue(value, path, diagnostics);
    const result = dictionary<string>();
    for (const key of Object.keys(source)) {
        const item = nonEmptyString(source[key], `${path}.${key}`, diagnostics);
        if (item) result[key] = item;
    }
    return result;
}

function normalizeParameters(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): Record<string, string | number | boolean> {
    const source = recordValue(value, path, diagnostics);
    const result = dictionary<string | number | boolean>();
    for (const key of Object.keys(source)) {
        const item = source[key];
        if (
            typeof item === 'string'
            || typeof item === 'boolean'
            || (typeof item === 'number' && Number.isFinite(item))
        ) {
            result[key] = item;
        } else {
            diagnostic(
                diagnostics,
                `${path}.${key}`,
                'AD_TYPE',
                'Expected a string, finite number, or boolean parameter value'
            );
        }
    }
    return result;
}

function duplicateName(
    name: string,
    path: string,
    seen: Set<string>,
    diagnostics: ArchDesignDiagnostic[]
): void {
    if (!name) return;
    if (seen.has(name)) {
        diagnostic(diagnostics, path, 'AD_DUPLICATE_NAME', `Duplicate name: ${name}`);
    } else {
        seen.add(name);
    }
}

function normalizePorts(
    value: unknown,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignPort[] {
    const source = arrayValue(value, '$.ports', diagnostics);
    const result: ArchDesignPort[] = [];
    const names = new Set<string>();
    visitArray(source, (item, index) => {
        const path = `$.ports[${index}]`;
        const record = recordValue(item, path, diagnostics);
        const name = validIdentifier(ownValue(record, 'name'), `${path}.name`, diagnostics);
        duplicateName(name, `${path}.name`, names, diagnostics);
        const directionValue = ownValue(record, 'direction');
        const direction = typeof directionValue === 'string'
            && PORT_DIRECTIONS.has(directionValue)
            ? directionValue as ArchDesignPort['direction']
            : undefined;
        if (!direction) {
            diagnostic(
                diagnostics,
                `${path}.direction`,
                'AD_VALUE',
                'Direction must be input, output, or inout'
            );
        }
        const widthValue = ownValue(record, 'width');
        const width = widthValue === undefined
            ? undefined
            : normalizeWidth(widthValue, `${path}.width`, diagnostics);
        if (name && direction) result.push({ name, direction, ...(width ? { width } : {}) });
    });
    return result;
}

function normalizeInstances(
    value: unknown,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignInstance[] {
    const source = arrayValue(value, '$.instances', diagnostics);
    const result: ArchDesignInstance[] = [];
    const names = new Set<string>();
    visitArray(source, (item, index) => {
        const path = `$.instances[${index}]`;
        const record = recordValue(item, path, diagnostics);
        const name = validIdentifier(ownValue(record, 'name'), `${path}.name`, diagnostics);
        duplicateName(name, `${path}.name`, names, diagnostics);
        const module = validIdentifier(ownValue(record, 'module'), `${path}.module`, diagnostics);
        const parameterValue = ownValue(record, 'parameters');
        const parameters = parameterValue === undefined
            ? undefined
            : normalizeParameters(parameterValue, `${path}.parameters`, diagnostics);
        if (name && module) {
            result.push({ name, module, ...(parameters ? { parameters } : {}) });
        }
    });
    return result;
}

function normalizeEndpoint(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignEndpoint | undefined {
    const record = recordValue(value, path, diagnostics);
    const kind = ownValue(record, 'kind');
    if (kind === 'port') {
        const port = validIdentifier(ownValue(record, 'port'), `${path}.port`, diagnostics);
        const signalValue = ownValue(record, 'signal');
        const signal = signalValue === undefined
            ? undefined
            : typeof signalValue === 'string' && INOUT_SIGNALS.has(signalValue)
                ? signalValue as 'value' | 'i' | 'o' | 't'
                : undefined;
        if (signalValue !== undefined && signal === undefined) {
            diagnostic(
                diagnostics,
                `${path}.signal`,
                'AD_VALUE',
                'Port signal must be value, i, o, or t'
            );
        }
        return port ? { kind, port, ...(signal ? { signal } : {}) } : undefined;
    }
    if (kind === 'instance') {
        const instance = validIdentifier(
            ownValue(record, 'instance'),
            `${path}.instance`,
            diagnostics
        );
        const port = validIdentifier(ownValue(record, 'port'), `${path}.port`, diagnostics);
        return instance && port ? { kind, instance, port } : undefined;
    }
    diagnostic(
        diagnostics,
        `${path}.kind`,
        'AD_VALUE',
        'Endpoint kind must be port or instance'
    );
    return undefined;
}

function normalizeConnections(
    value: unknown,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignConnection[] {
    const source = arrayValue(value, '$.connections', diagnostics);
    const result: ArchDesignConnection[] = [];
    const names = new Set<string>();
    visitArray(source, (item, index) => {
        const path = `$.connections[${index}]`;
        const record = recordValue(item, path, diagnostics);
        const name = validIdentifier(ownValue(record, 'name'), `${path}.name`, diagnostics);
        duplicateName(name, `${path}.name`, names, diagnostics);
        const endpointValues = arrayValue(
            ownValue(record, 'endpoints'),
            `${path}.endpoints`,
            diagnostics
        );
        const endpoints: ArchDesignEndpoint[] = [];
        visitArray(endpointValues, (endpoint, endpointIndex) => {
            const normalized = normalizeEndpoint(
                endpoint,
                `${path}.endpoints[${endpointIndex}]`,
                diagnostics
            );
            if (normalized) endpoints.push(normalized);
        });
        const defaultsValue = ownValue(record, 'defaults');
        const defaults = defaultsValue === undefined
            ? undefined
            : normalizeStringDictionary(defaultsValue, `${path}.defaults`, diagnostics);
        if (name) result.push({ name, endpoints, ...(defaults ? { defaults } : {}) });
    });
    return result;
}

function normalizeInterfaceEndpoint(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignInterfaceEndpoint | undefined {
    const record = recordValue(value, path, diagnostics);
    const instance = validIdentifier(
        ownValue(record, 'instance'),
        `${path}.instance`,
        diagnostics
    );
    const interfaceName = validIdentifier(
        ownValue(record, 'interface'),
        `${path}.interface`,
        diagnostics
    );
    return instance && interfaceName ? { instance, interface: interfaceName } : undefined;
}

function normalizeInterfaceConnections(
    value: unknown,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignInterfaceConnection[] {
    const source = arrayValue(value, '$.interfaceConnections', diagnostics);
    const result: ArchDesignInterfaceConnection[] = [];
    const names = new Set<string>();
    visitArray(source, (item, index) => {
        const path = `$.interfaceConnections[${index}]`;
        const record = recordValue(item, path, diagnostics);
        const name = validIdentifier(ownValue(record, 'name'), `${path}.name`, diagnostics);
        duplicateName(name, `${path}.name`, names, diagnostics);
        const protocolValue = ownValue(record, 'protocol');
        const protocol = protocolValue === undefined
            ? undefined
            : nonEmptyString(protocolValue, `${path}.protocol`, diagnostics);
        const master = normalizeInterfaceEndpoint(
            ownValue(record, 'master'),
            `${path}.master`,
            diagnostics
        );
        const slave = normalizeInterfaceEndpoint(
            ownValue(record, 'slave'),
            `${path}.slave`,
            diagnostics
        );
        const defaultsValue = ownValue(record, 'defaults');
        const defaults = defaultsValue === undefined
            ? undefined
            : normalizeStringDictionary(defaultsValue, `${path}.defaults`, diagnostics);
        if (name && master && slave) {
            result.push({
                name,
                ...(protocol ? { protocol } : {}),
                master,
                slave,
                ...(defaults ? { defaults } : {}),
            });
        }
    });
    return result;
}

function normalizeExport(
    value: unknown,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignExportOptions {
    const record = recordValue(value, '$.export', diagnostics);
    const languageValue = ownValue(record, 'language');
    const language = languageValue === undefined
        ? undefined
        : typeof languageValue === 'string' && EXPORT_LANGUAGES.has(languageValue)
            ? languageValue as 'verilog' | 'systemverilog'
            : undefined;
    if (languageValue !== undefined && language === undefined) {
        diagnostic(
            diagnostics,
            '$.export.language',
            'AD_VALUE',
            'Language must be verilog or systemverilog'
        );
    }
    const outputValue = ownValue(record, 'output');
    const output = outputValue === undefined
        ? undefined
        : nonEmptyString(outputValue, '$.export.output', diagnostics);
    return { ...(language ? { language } : {}), ...(output ? { output } : {}) };
}

function normalizePlacement(
    value: unknown,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignNodePlacement | undefined {
    const record = recordValue(value, path, diagnostics);
    const columnValue = ownValue(record, 'column');
    const column = typeof columnValue === 'number'
        && Number.isSafeInteger(columnValue)
        && columnValue >= 0
        ? columnValue
        : undefined;
    if (column === undefined) {
        diagnostic(diagnostics, `${path}.column`, 'AD_VALUE', 'Column must be a non-negative integer');
    }
    const orderValue = ownValue(record, 'order');
    const order = typeof orderValue === 'number'
        && Number.isSafeInteger(orderValue)
        && orderValue >= 0
        ? orderValue
        : undefined;
    if (order === undefined) {
        diagnostic(diagnostics, `${path}.order`, 'AD_VALUE', 'Order must be a non-negative integer');
    }
    const offsetValue = ownValue(record, 'offset');
    const offset = offsetValue === undefined
        ? undefined
        : typeof offsetValue === 'number' && Number.isFinite(offsetValue)
            ? offsetValue
            : undefined;
    if (offsetValue !== undefined && offset === undefined) {
        diagnostic(diagnostics, `${path}.offset`, 'AD_VALUE', 'Offset must be a finite number');
    }
    const positionedValue = ownValue(record, 'userPositioned');
    const userPositioned = positionedValue === undefined
        ? undefined
        : typeof positionedValue === 'boolean'
            ? positionedValue
            : undefined;
    if (positionedValue !== undefined && userPositioned === undefined) {
        diagnostic(
            diagnostics,
            `${path}.userPositioned`,
            'AD_TYPE',
            'userPositioned must be a boolean'
        );
    }
    return column === undefined || order === undefined
        ? undefined
        : {
            column,
            order,
            ...(offset !== undefined ? { offset } : {}),
            ...(userPositioned !== undefined ? { userPositioned } : {}),
        };
}

function normalizeViewport(
    value: unknown,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignViewport | undefined {
    const path = '$.presentation.viewport';
    const record = recordValue(value, path, diagnostics);
    const xValue = ownValue(record, 'x');
    const yValue = ownValue(record, 'y');
    const zoomValue = ownValue(record, 'zoom');
    const x = typeof xValue === 'number' && Number.isFinite(xValue) ? xValue : undefined;
    const y = typeof yValue === 'number' && Number.isFinite(yValue) ? yValue : undefined;
    const zoom = typeof zoomValue === 'number' && Number.isFinite(zoomValue) && zoomValue > 0
        ? zoomValue
        : undefined;
    if (x === undefined) diagnostic(diagnostics, `${path}.x`, 'AD_VALUE', 'x must be finite');
    if (y === undefined) diagnostic(diagnostics, `${path}.y`, 'AD_VALUE', 'y must be finite');
    if (zoom === undefined) {
        diagnostic(diagnostics, `${path}.zoom`, 'AD_VALUE', 'zoom must be positive and finite');
    }
    return x === undefined || y === undefined || zoom === undefined
        ? undefined
        : { x, y, zoom };
}

function normalizePresentation(
    value: unknown,
    diagnostics: ArchDesignDiagnostic[]
): ArchDesignPresentation {
    const record = recordValue(value, '$.presentation', diagnostics);
    const nodesValue = ownValue(record, 'nodes');
    let nodes: Record<string, ArchDesignNodePlacement> | undefined;
    if (nodesValue !== undefined) {
        nodes = dictionary<ArchDesignNodePlacement>();
        const source = recordValue(nodesValue, '$.presentation.nodes', diagnostics);
        for (const key of Object.keys(source)) {
            const placement = normalizePlacement(
                source[key],
                `$.presentation.nodes.${key}`,
                diagnostics
            );
            if (placement) nodes[key] = placement;
        }
    }
    const collapsedValue = ownValue(record, 'collapsedInterfaces');
    let collapsedInterfaces: Record<string, boolean> | undefined;
    if (collapsedValue !== undefined) {
        collapsedInterfaces = dictionary<boolean>();
        const source = recordValue(
            collapsedValue,
            '$.presentation.collapsedInterfaces',
            diagnostics
        );
        for (const key of Object.keys(source)) {
            const item = source[key];
            if (typeof item === 'boolean') {
                collapsedInterfaces[key] = item;
            } else {
                diagnostic(
                    diagnostics,
                    `$.presentation.collapsedInterfaces.${key}`,
                    'AD_TYPE',
                    'Collapsed state must be a boolean'
                );
            }
        }
    }
    const viewportValue = ownValue(record, 'viewport');
    const viewport = viewportValue === undefined
        ? undefined
        : normalizeViewport(viewportValue, diagnostics);
    return {
        ...(nodes ? { nodes } : {}),
        ...(collapsedInterfaces ? { collapsedInterfaces } : {}),
        ...(viewport ? { viewport } : {}),
    };
}

function cloneUnknownJson(value: unknown, visiting = new WeakSet<object>()): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object') throw new TypeError('Unsupported non-JSON value');
    if (visiting.has(value)) throw new TypeError('Cyclic value');
    visiting.add(value);
    try {
        if (Array.isArray(value)) {
            if (!hasDenseOwnItems(value)) throw new TypeError('Sparse array');
            const result: unknown[] = [];
            const length = value.length;
            for (let index = 0; index < length; index += 1) {
                result.push(cloneUnknownJson(value[index], visiting));
            }
            return result;
        }
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            Object.defineProperty(result, key, {
                value: cloneUnknownJson((value as MutableRecord)[key], visiting),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
        return result;
    } finally {
        visiting.delete(value);
    }
}

function parseValue(input: unknown): ArchDesignReadResult {
    if (!isRecord(input)) {
        return invalidResult([{
            path: '$',
            code: 'AD_DOCUMENT',
            message: 'Arch Design root must be an object',
        }]);
    }
    const value = snapshotOwnRecord(input);
    const headerDiagnostics: ArchDesignDiagnostic[] = [];
    const format = ownValue(value, 'format');
    if (format !== ARCH_DESIGN_FORMAT) {
        diagnostic(
            headerDiagnostics,
            '$.format',
            'AD_FORMAT',
            `Expected format ${ARCH_DESIGN_FORMAT}`
        );
    }
    const versionValue = ownValue(value, 'schemaVersion');
    const schemaVersion = typeof versionValue === 'number'
        && Number.isSafeInteger(versionValue)
        && versionValue > 0
        ? versionValue
        : undefined;
    if (schemaVersion === undefined) {
        diagnostic(
            headerDiagnostics,
            '$.schemaVersion',
            'AD_SCHEMA_VERSION',
            'schemaVersion must be a positive integer'
        );
    }
    if (headerDiagnostics.length > 0 || schemaVersion === undefined) {
        return invalidResult(headerDiagnostics);
    }
    if (schemaVersion !== ARCH_DESIGN_SCHEMA_VERSION) {
        const snapshot = cloneUnknownJson(value) as Readonly<Record<string, unknown>>;
        return deepFreeze({ status: 'unsupported' as const, schemaVersion, value: snapshot });
    }

    const diagnostics: ArchDesignDiagnostic[] = [];
    const module = validIdentifier(ownValue(value, 'module'), '$.module', diagnostics);
    const ports = normalizePorts(ownValue(value, 'ports'), diagnostics);
    const instances = normalizeInstances(ownValue(value, 'instances'), diagnostics);
    const connections = normalizeConnections(ownValue(value, 'connections'), diagnostics);
    const interfaceConnections = normalizeInterfaceConnections(
        ownValue(value, 'interfaceConnections'),
        diagnostics
    );
    const defaults = normalizeStringDictionary(ownValue(value, 'defaults'), '$.defaults', diagnostics);
    const exportOptions = normalizeExport(ownValue(value, 'export'), diagnostics);
    const presentation = normalizePresentation(ownValue(value, 'presentation'), diagnostics);
    if (diagnostics.length > 0) return invalidResult(diagnostics);

    const design: ArchDesign = {
        format: ARCH_DESIGN_FORMAT,
        schemaVersion: ARCH_DESIGN_SCHEMA_VERSION,
        module,
        ports,
        instances,
        connections,
        interfaceConnections,
        defaults,
        export: exportOptions,
        presentation,
    };
    return deepFreeze({ status: 'editable' as const, design });
}

export function parseArchDesignValue(value: unknown): ArchDesignReadResult {
    try {
        return parseValue(value);
    } catch {
        return invalidResult([{
            path: '$',
            code: 'AD_VALUE',
            message: 'Arch Design contains an unreadable or non-JSON value',
        }]);
    }
}

export function parseArchDesignText(source: string): ArchDesignReadResult {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        return invalidResult([{
            path: '$',
            code: 'AD_JSON_SYNTAX',
            message: 'Arch Design is not valid JSON',
        }]);
    }
    return parseArchDesignValue(value);
}
