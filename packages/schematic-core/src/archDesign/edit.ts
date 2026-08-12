import type {
    ArchDesign,
    ArchDesignEndpoint,
    ArchDesignExportOptions,
    ArchDesignInstance,
    ArchDesignLanguage,
    ArchDesignParameterValue,
    ArchDesignPort,
    ArchDesignPresentation,
} from './model';
import { parseArchDesignValue } from './parser';
import { serializeArchDesign } from './serializer';

export type ArchDesignEdit =
    | Readonly<{ type: 'addInstance'; instance: ArchDesignInstance }>
    | Readonly<{ type: 'renameInstance'; name: string; nextName: string }>
    | Readonly<{ type: 'removeInstance'; name: string }>
    | Readonly<{
        type: 'setInstanceParameter';
        instance: string;
        parameter: string;
        value?: ArchDesignParameterValue;
    }>
    | Readonly<{ type: 'addPort'; port: ArchDesignPort }>
    | Readonly<{ type: 'updatePort'; name: string; port: ArchDesignPort }>
    | Readonly<{ type: 'removePort'; name: string }>
    | Readonly<{
        type: 'connect';
        source: ArchDesignEndpoint;
        target: ArchDesignEndpoint;
    }>
    | Readonly<{
        type: 'disconnect';
        endpoint: ArchDesignEndpoint;
        connection: string;
    }>
    | Readonly<{ type: 'renameConnection'; name: string; nextName: string }>
    | Readonly<{ type: 'removeConnection'; name: string }>
    | Readonly<{
        type: 'setDefault';
        endpoint: string;
        expression?: string;
        connection?: string;
    }>
    | Readonly<{
        type: 'setExport';
        language?: ArchDesignLanguage;
        output?: string;
    }>
    | Readonly<{
        type: 'setPresentation';
        presentation: ArchDesignPresentation;
    }>;

export class ArchDesignEditError extends Error {
    readonly code = 'ARCH_DESIGN_EDIT';

    constructor(message: string) {
        super(message);
        this.name = 'ArchDesignEditError';
    }
}

type MutableEndpoint = {
    kind: 'port' | 'instance';
    port: string;
    signal?: 'value' | 'i' | 'o' | 't';
    instance?: string;
};

type MutableConnection = {
    name: string;
    endpoints: MutableEndpoint[];
    defaults?: Record<string, string>;
};

type MutableDesign = {
    format: string;
    schemaVersion: number;
    module: string;
    ports: Array<{
        name: string;
        direction: string;
        width?: number | { expression: string };
    }>;
    instances: Array<{
        name: string;
        module: string;
        parameters?: Record<string, ArchDesignParameterValue>;
    }>;
    connections: MutableConnection[];
    interfaceConnections: Array<{
        name: string;
        protocol?: string;
        master: { instance: string; interface: string };
        slave: { instance: string; interface: string };
        defaults?: Record<string, string>;
    }>;
    defaults: Record<string, string>;
    export: ArchDesignExportOptions;
    presentation: ArchDesignPresentation;
};

function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function mutableSnapshot(design: ArchDesign): MutableDesign {
    const parsed = parseArchDesignValue(design);
    if (parsed.status !== 'editable') {
        throw new ArchDesignEditError('Arch Design is not editable');
    }
    return JSON.parse(serializeArchDesign(parsed.design)) as MutableDesign;
}

function finish(value: MutableDesign): ArchDesign {
    const parsed = parseArchDesignValue(value);
    if (parsed.status === 'editable') return parsed.design;
    if (parsed.status === 'unsupported') {
        throw new ArchDesignEditError(
            `Arch Design schema version ${parsed.schemaVersion} is not editable`
        );
    }
    const first = parsed.diagnostics[0];
    throw new ArchDesignEditError(first
        ? `${first.path}: ${first.message}`
        : 'Arch Design edit produced an invalid document');
}

function exactIndex<T>(
    values: readonly T[],
    predicate: (value: T) => boolean,
    kind: string,
    name: string
): number {
    const matches = values.flatMap((value, index) => predicate(value) ? [index] : []);
    if (matches.length !== 1) {
        throw new ArchDesignEditError(
            matches.length === 0
                ? `${kind} not found: ${name}`
                : `${kind} is ambiguous: ${name}`
        );
    }
    return matches[0];
}

function assertUnused<T>(
    values: readonly T[],
    predicate: (value: T) => boolean,
    kind: string,
    name: string,
    ignoredIndex = -1
): void {
    if (values.some((value, index) => index !== ignoredIndex && predicate(value))) {
        throw new ArchDesignEditError(`${kind} already exists: ${name}`);
    }
}

function endpointEquals(left: MutableEndpoint, right: ArchDesignEndpoint): boolean {
    if (left.kind !== right.kind || left.port !== right.port) return false;
    if (left.kind === 'instance' && right.kind === 'instance') {
        return left.instance === right.instance;
    }
    return left.kind === 'port' && right.kind === 'port'
        && left.signal === right.signal;
}

function cloneEndpoint(endpoint: ArchDesignEndpoint): MutableEndpoint {
    return endpoint.kind === 'instance'
        ? { kind: 'instance', instance: endpoint.instance, port: endpoint.port }
        : {
            kind: 'port',
            port: endpoint.port,
            ...(endpoint.signal === undefined ? {} : { signal: endpoint.signal }),
        };
}

function endpointDefaultKey(endpoint: ArchDesignEndpoint): string {
    if (endpoint.kind === 'instance') return `${endpoint.instance}.${endpoint.port}`;
    return `${endpoint.port}.${endpoint.signal ?? 'value'}`;
}

function renameDictionaryPrefix(
    source: Record<string, string> | undefined,
    oldPrefix: string,
    nextPrefix: string
): Record<string, string> | undefined {
    if (source === undefined) return undefined;
    const result: Record<string, string> = Object.create(null);
    const renamed = new Map<string, string>();
    for (const key of Object.keys(source)) {
        const nextKey = key.startsWith(oldPrefix)
            ? `${nextPrefix}${key.slice(oldPrefix.length)}`
            : key;
        if (renamed.has(nextKey)) {
            throw new ArchDesignEditError(`Default key already exists: ${nextKey}`);
        }
        renamed.set(nextKey, source[key]);
    }
    for (const [key, expression] of renamed) setOwn(result, key, expression);
    return result;
}

function removeDictionaryPrefix(
    source: Record<string, string> | undefined,
    prefix: string
): Record<string, string> | undefined {
    if (source === undefined) return undefined;
    const result: Record<string, string> = Object.create(null);
    for (const key of Object.keys(source)) {
        if (!key.startsWith(prefix)) setOwn(result, key, source[key]);
    }
    return Object.keys(result).length === 0 ? undefined : result;
}

function renamePresentationNode(
    presentation: ArchDesignPresentation,
    oldId: string,
    nextId: string
): ArchDesignPresentation {
    const nodes = presentation.nodes;
    if (!nodes || !Object.prototype.hasOwnProperty.call(nodes, oldId)) {
        return presentation;
    }
    if (oldId !== nextId && Object.prototype.hasOwnProperty.call(nodes, nextId)) {
        throw new ArchDesignEditError(`Presentation node already exists: ${nextId}`);
    }
    const nextNodes: Record<string, ArchDesignPresentation['nodes'] extends
        Readonly<Record<string, infer T>> | undefined ? T : never> = Object.create(null);
    for (const key of Object.keys(nodes)) {
        setOwn(nextNodes, key === oldId ? nextId : key, nodes[key]);
    }
    return { ...presentation, nodes: nextNodes };
}

function removePresentationNode(
    presentation: ArchDesignPresentation,
    nodeId: string
): ArchDesignPresentation {
    const nodes = presentation.nodes;
    if (!nodes || !Object.prototype.hasOwnProperty.call(nodes, nodeId)) {
        return presentation;
    }
    const nextNodes: Record<string, typeof nodes[string]> = Object.create(null);
    for (const key of Object.keys(nodes)) {
        if (key !== nodeId) setOwn(nextNodes, key, nodes[key]);
    }
    return {
        ...presentation,
        ...(Object.keys(nextNodes).length === 0 ? { nodes: undefined } : { nodes: nextNodes }),
    };
}

function endpointMemberships(
    connections: readonly MutableConnection[],
    endpoint: ArchDesignEndpoint
): number[] {
    return connections.flatMap((connection, index) =>
        connection.endpoints.some(item => endpointEquals(item, endpoint)) ? [index] : []);
}

function mergeDefaults(
    first: Record<string, string> | undefined,
    second: Record<string, string> | undefined
): Record<string, string> | undefined {
    if (!first && !second) return undefined;
    const result: Record<string, string> = Object.create(null);
    for (const source of [first, second]) {
        for (const key of Object.keys(source ?? {})) {
            if (!Object.prototype.hasOwnProperty.call(result, key)) {
                setOwn(result, key, source![key]);
            }
        }
    }
    return result;
}

function nextNetworkName(connections: readonly MutableConnection[]): string {
    const used = new Set(connections.map(connection => connection.name));
    for (let index = 1; ; index += 1) {
        const name = `net_${index}`;
        if (!used.has(name)) return name;
    }
}

function applyConnect(
    design: MutableDesign,
    source: ArchDesignEndpoint,
    target: ArchDesignEndpoint
): void {
    if (endpointEquals(cloneEndpoint(source), target)) {
        throw new ArchDesignEditError('Cannot connect an endpoint to itself');
    }
    const sourceMemberships = endpointMemberships(design.connections, source);
    const targetMemberships = endpointMemberships(design.connections, target);
    if (sourceMemberships.length > 1 || targetMemberships.length > 1) {
        throw new ArchDesignEditError('Cannot connect an endpoint in ambiguous networks');
    }
    const sourceIndex = sourceMemberships[0];
    const targetIndex = targetMemberships[0];
    if (sourceIndex === undefined && targetIndex === undefined) {
        design.connections.push({
            name: nextNetworkName(design.connections),
            endpoints: [cloneEndpoint(source), cloneEndpoint(target)],
        });
        return;
    }
    if (sourceIndex === targetIndex) return;
    if (sourceIndex === undefined || targetIndex === undefined) {
        const connection = design.connections[sourceIndex ?? targetIndex];
        connection.endpoints.push(cloneEndpoint(
            sourceIndex === undefined ? source : target
        ));
        return;
    }
    const keepIndex = Math.min(sourceIndex, targetIndex);
    const removeIndex = Math.max(sourceIndex, targetIndex);
    const keep = design.connections[keepIndex];
    const remove = design.connections[removeIndex];
    for (const endpoint of remove.endpoints) {
        if (!keep.endpoints.some(item => endpointEquals(item, endpoint as ArchDesignEndpoint))) {
            keep.endpoints.push(endpoint);
        }
    }
    keep.defaults = mergeDefaults(keep.defaults, remove.defaults);
    design.connections.splice(removeIndex, 1);
}

function setDefault(
    target: Record<string, string>,
    endpoint: string,
    expression: string | undefined
): void {
    if (expression === undefined) delete target[endpoint];
    else setOwn(target, endpoint, expression);
}

export function applyArchDesignEdit(
    design: ArchDesign,
    edit: ArchDesignEdit
): ArchDesign {
    const mutable = mutableSnapshot(design);
    switch (edit.type) {
        case 'addInstance':
            assertUnused(
                mutable.instances,
                instance => instance.name === edit.instance.name,
                'Instance',
                edit.instance.name
            );
            mutable.instances.push(JSON.parse(JSON.stringify(edit.instance)));
            break;
        case 'renameInstance': {
            const index = exactIndex(
                mutable.instances,
                instance => instance.name === edit.name,
                'Instance',
                edit.name
            );
            assertUnused(
                mutable.instances,
                instance => instance.name === edit.nextName,
                'Instance',
                edit.nextName,
                index
            );
            mutable.instances[index].name = edit.nextName;
            for (const connection of mutable.connections) {
                for (const endpoint of connection.endpoints) {
                    if (endpoint.kind === 'instance' && endpoint.instance === edit.name) {
                        endpoint.instance = edit.nextName;
                    }
                }
                connection.defaults = renameDictionaryPrefix(
                    connection.defaults,
                    `${edit.name}.`,
                    `${edit.nextName}.`
                );
            }
            for (const connection of mutable.interfaceConnections) {
                if (connection.master.instance === edit.name) {
                    connection.master.instance = edit.nextName;
                }
                if (connection.slave.instance === edit.name) {
                    connection.slave.instance = edit.nextName;
                }
            }
            mutable.defaults = renameDictionaryPrefix(
                mutable.defaults,
                `${edit.name}.`,
                `${edit.nextName}.`
            ) ?? {};
            mutable.presentation = renamePresentationNode(
                mutable.presentation,
                `instance:${edit.name}`,
                `instance:${edit.nextName}`
            );
            break;
        }
        case 'removeInstance': {
            const index = exactIndex(
                mutable.instances,
                instance => instance.name === edit.name,
                'Instance',
                edit.name
            );
            mutable.instances.splice(index, 1);
            mutable.connections = mutable.connections.flatMap(connection => {
                connection.endpoints = connection.endpoints.filter(endpoint =>
                    endpoint.kind !== 'instance' || endpoint.instance !== edit.name);
                connection.defaults = removeDictionaryPrefix(
                    connection.defaults,
                    `${edit.name}.`
                );
                return connection.endpoints.length === 0 ? [] : [connection];
            });
            mutable.interfaceConnections = mutable.interfaceConnections.filter(connection =>
                connection.master.instance !== edit.name
                && connection.slave.instance !== edit.name);
            mutable.defaults = removeDictionaryPrefix(
                mutable.defaults,
                `${edit.name}.`
            ) ?? {};
            mutable.presentation = removePresentationNode(
                mutable.presentation,
                `instance:${edit.name}`
            );
            break;
        }
        case 'setInstanceParameter': {
            const index = exactIndex(
                mutable.instances,
                instance => instance.name === edit.instance,
                'Instance',
                edit.instance
            );
            const instance = mutable.instances[index];
            const parameters: Record<string, ArchDesignParameterValue> = Object.create(null);
            for (const key of Object.keys(instance.parameters ?? {})) {
                setOwn(parameters, key, instance.parameters![key]);
            }
            if (edit.value === undefined) delete parameters[edit.parameter];
            else setOwn(parameters, edit.parameter, edit.value);
            instance.parameters = Object.keys(parameters).length === 0
                ? undefined
                : parameters;
            break;
        }
        case 'addPort':
            assertUnused(
                mutable.ports,
                port => port.name === edit.port.name,
                'Port',
                edit.port.name
            );
            mutable.ports.push(JSON.parse(JSON.stringify(edit.port)));
            break;
        case 'updatePort': {
            const index = exactIndex(
                mutable.ports,
                port => port.name === edit.name,
                'Port',
                edit.name
            );
            assertUnused(
                mutable.ports,
                port => port.name === edit.port.name,
                'Port',
                edit.port.name,
                index
            );
            mutable.ports[index] = JSON.parse(JSON.stringify(edit.port));
            if (edit.name !== edit.port.name) {
                for (const connection of mutable.connections) {
                    for (const endpoint of connection.endpoints) {
                        if (endpoint.kind === 'port' && endpoint.port === edit.name) {
                            endpoint.port = edit.port.name;
                        }
                    }
                    connection.defaults = renameDictionaryPrefix(
                        connection.defaults,
                        `${edit.name}.`,
                        `${edit.port.name}.`
                    );
                }
                mutable.defaults = renameDictionaryPrefix(
                    mutable.defaults,
                    `${edit.name}.`,
                    `${edit.port.name}.`
                ) ?? {};
                mutable.presentation = renamePresentationNode(
                    mutable.presentation,
                    `port:${edit.name}`,
                    `port:${edit.port.name}`
                );
            }
            break;
        }
        case 'removePort': {
            const index = exactIndex(
                mutable.ports,
                port => port.name === edit.name,
                'Port',
                edit.name
            );
            mutable.ports.splice(index, 1);
            mutable.connections = mutable.connections.flatMap(connection => {
                connection.endpoints = connection.endpoints.filter(endpoint =>
                    endpoint.kind !== 'port' || endpoint.port !== edit.name);
                connection.defaults = removeDictionaryPrefix(
                    connection.defaults,
                    `${edit.name}.`
                );
                return connection.endpoints.length === 0 ? [] : [connection];
            });
            mutable.defaults = removeDictionaryPrefix(
                mutable.defaults,
                `${edit.name}.`
            ) ?? {};
            mutable.presentation = removePresentationNode(
                mutable.presentation,
                `port:${edit.name}`
            );
            break;
        }
        case 'connect':
            applyConnect(mutable, edit.source, edit.target);
            break;
        case 'disconnect': {
            const index = exactIndex(
                mutable.connections,
                connection => connection.name === edit.connection,
                'Connection',
                edit.connection
            );
            const connection = mutable.connections[index];
            const endpointIndex = exactIndex(
                connection.endpoints,
                endpoint => endpointEquals(endpoint, edit.endpoint),
                'Connection endpoint',
                edit.connection
            );
            connection.endpoints.splice(endpointIndex, 1);
            if (connection.defaults !== undefined) {
                delete connection.defaults[endpointDefaultKey(edit.endpoint)];
                if (Object.keys(connection.defaults).length === 0) {
                    connection.defaults = undefined;
                }
            }
            if (connection.endpoints.length === 0) mutable.connections.splice(index, 1);
            break;
        }
        case 'renameConnection': {
            const index = exactIndex(
                mutable.connections,
                connection => connection.name === edit.name,
                'Connection',
                edit.name
            );
            assertUnused(
                mutable.connections,
                connection => connection.name === edit.nextName,
                'Connection',
                edit.nextName,
                index
            );
            mutable.connections[index].name = edit.nextName;
            break;
        }
        case 'removeConnection': {
            const index = exactIndex(
                mutable.connections,
                connection => connection.name === edit.name,
                'Connection',
                edit.name
            );
            mutable.connections.splice(index, 1);
            break;
        }
        case 'setDefault':
            if (edit.connection === undefined) {
                setDefault(mutable.defaults, edit.endpoint, edit.expression);
            } else {
                const index = exactIndex(
                    mutable.connections,
                    connection => connection.name === edit.connection,
                    'Connection',
                    edit.connection
                );
                const defaults: Record<string, string> = Object.create(null);
                for (const key of Object.keys(mutable.connections[index].defaults ?? {})) {
                    setOwn(defaults, key, mutable.connections[index].defaults![key]);
                }
                setDefault(defaults, edit.endpoint, edit.expression);
                mutable.connections[index].defaults = Object.keys(defaults).length === 0
                    ? undefined
                    : defaults;
            }
            break;
        case 'setExport':
            mutable.export = {
                ...(edit.language === undefined ? {} : { language: edit.language }),
                ...(edit.output === undefined ? {} : { output: edit.output }),
            };
            break;
        case 'setPresentation':
            mutable.presentation = JSON.parse(JSON.stringify(edit.presentation));
            break;
    }
    return finish(mutable);
}
