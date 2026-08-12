import type { WidthValue } from '@veriflow/hdl-core/model';

import {
    createInterfaceProtocolCatalog,
    type InterfaceProtocolCatalog,
} from '../interfaces';
import { isSafeDefaultExpression } from './defaults';
import type {
    ArchDesignDefinitionParameter,
    ArchDesignDefinitionPort,
    ArchDesignModuleDefinition,
} from './definitions';
import type {
    ArchDesign,
    ArchDesignConnection,
    ArchDesignEndpoint,
    ArchDesignInstance,
    ArchDesignInterfaceConnection,
    ArchDesignInterfaceEndpoint,
    ArchDesignInterfaceOverride,
    ArchDesignInterfacePort,
    ArchDesignParameterValue,
    ArchDesignPort,
    ArchDesignWidth,
} from './model';
import {
    resolveArchDesignInterfaces,
    type ArchDesignInterfacesResolution,
} from './interfaces';
import { compareCodeUnits } from './ordering';
import type { ArchDesignDiagnostic } from './parser';

const DEFAULT_INTERFACE_PROTOCOL_CATALOG = createInterfaceProtocolCatalog();

export type ResolvedArchDesignModuleDefinition = Readonly<{
    key: string;
    name: string;
    parameters: readonly ArchDesignDefinitionParameter[];
    ports: readonly ArchDesignDefinitionPort[];
}>;

export type ResolvedArchDesignInstance = Readonly<{
    index: number;
    nodeId: string;
    instance: ArchDesignInstance;
    definition?: ResolvedArchDesignModuleDefinition;
}>;

export type ResolvedArchDesignPort = Readonly<{
    index: number;
    nodeId: string;
    port: ArchDesignPort;
}>;

export type ArchDesignEndpointRole = 'driver' | 'load' | 'bidirectional';

export type ResolvedArchDesignEndpointTarget = Readonly<{
    identity: string;
    nodeId: string;
    defaultKey: string;
    role: ArchDesignEndpointRole;
    width: WidthValue;
    kind: 'port' | 'instance';
    port: string;
    signal?: 'value' | 'i' | 'o' | 't';
    instance?: string;
    declarationPath: string;
    declarationOrder: number;
    inoutPortWidth?: WidthValue;
}>;

export type ResolvedArchDesignEndpoint = Readonly<{
    identity: string;
    defaultKey: string;
    role: ArchDesignEndpointRole;
    width: WidthValue;
    kind: 'port' | 'instance';
    port: string;
    signal?: 'value' | 'i' | 'o' | 't';
    instance?: string;
    declarationPath: string;
    targetDeclarationOrder: number;
    inoutPortWidth?: WidthValue;
    endpoint: ArchDesignEndpoint;
    path: string;
    connectionIndex: number;
    endpointIndex: number;
    declarationOrder: number;
}>;

export type ResolvedArchDesignConnection = Readonly<{
    index: number;
    networkId: string;
    connection: ArchDesignConnection;
    endpoints: readonly ResolvedArchDesignEndpoint[];
}>;

export type ArchDesignDefaultOrigin = 'connection' | 'design' | 'implicit-inout-t';

export type ArchDesignEffectiveDefault = Readonly<{
    endpoint: string;
    expression: string;
    origin: ArchDesignDefaultOrigin;
    connection?: string;
}>;

export type ResolvedArchDesignDefault = Readonly<{
    identity: string;
    endpoint: string;
    declarationOrder: number;
    sourcePath: string;
    expression: string;
    origin: ArchDesignDefaultOrigin;
    connection?: string;
}>;

export type ResolvedArchDesignConnectionDefaultSource = Readonly<{
    connectionIndex: number;
    default: ResolvedArchDesignDefault;
}>;

export type ArchDesignResolution = Readonly<{
    moduleName: string;
    ports: readonly ResolvedArchDesignPort[];
    instances: readonly ResolvedArchDesignInstance[];
    endpointTargets: readonly ResolvedArchDesignEndpointTarget[];
    connections: readonly ResolvedArchDesignConnection[];
    interfaces: ArchDesignInterfacesResolution;
    diagnostics: readonly ArchDesignDiagnostic[];
    warnings: readonly ArchDesignDiagnostic[];
    effectiveDefaults: readonly ResolvedArchDesignDefault[];
    connectionDefaultSources: readonly ResolvedArchDesignConnectionDefaultSource[];
}>;

type DefaultSelection = Readonly<{
    expression: string;
    safe: boolean;
    sourcePath: string;
}>;

type ConnectionIndex = Readonly<{
    declaredEndpointIdentities: ReadonlySet<string>;
    definiteDriverCount: number;
    hasSource: boolean;
}>;

type DesignSnapshot = Readonly<{
    moduleName: string;
    ports: readonly ArchDesignPort[];
    instances: readonly ArchDesignInstance[];
    connections: readonly ArchDesignConnection[];
    interfacePorts: readonly ArchDesignInterfacePort[];
    interfaceOverrides: Readonly<Record<string, ArchDesignInterfaceOverride>>;
    interfaceConnections: readonly ArchDesignInterfaceConnection[];
    defaults: Readonly<Record<string, string>>;
}>;

type DesignSnapshotContext = Readonly<{
    widths: WeakMap<object, ArchDesignWidth>;
    ports: WeakMap<object, ArchDesignPort>;
    instances: WeakMap<object, ArchDesignInstance>;
    endpoints: WeakMap<object, ArchDesignEndpoint>;
    connections: WeakMap<object, ArchDesignConnection>;
    interfaceEndpoints: WeakMap<object, ArchDesignInterfaceEndpoint>;
    interfacePorts: WeakMap<object, ArchDesignInterfacePort>;
    interfaceOverrides: WeakMap<object, ArchDesignInterfaceOverride>;
    interfaceConnections: WeakMap<object, ArchDesignInterfaceConnection>;
    records: WeakMap<object, Readonly<Record<string, unknown>>>;
}>;

function snapshotArray<T>(source: readonly T[]): T[] {
    const length = source.length;
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) result.push(source[index]);
    return result;
}

function snapshotRecord<T>(
    source: Readonly<Record<string, T>>,
    context?: DesignSnapshotContext
): Readonly<Record<string, T>> {
    const cached = context?.records.get(source);
    if (cached) return cached as Readonly<Record<string, T>>;
    const result: Record<string, T> = {};
    for (const key of Object.keys(source).sort(compareCodeUnits)) {
        Object.defineProperty(result, key, {
            value: source[key],
            enumerable: true,
            configurable: false,
            writable: false,
        });
    }
    const snapshot = Object.freeze(result);
    context?.records.set(source, snapshot);
    return snapshot;
}

function snapshotDesignWidth(
    source: ArchDesignWidth,
    context: DesignSnapshotContext
): ArchDesignWidth {
    if (typeof source === 'number') return source;
    const cached = context.widths.get(source);
    if (cached) return cached;
    const expression = source.expression;
    const snapshot = Object.freeze({ expression });
    context.widths.set(source, snapshot);
    return snapshot;
}

function snapshotDesignPort(
    source: ArchDesignPort,
    context: DesignSnapshotContext
): ArchDesignPort {
    const cached = context.ports.get(source);
    if (cached) return cached;
    const name = source.name;
    const direction = source.direction;
    const sourceWidth = source.width;
    const width = sourceWidth === undefined
        ? undefined
        : snapshotDesignWidth(sourceWidth, context);
    const snapshot = Object.freeze({
        name,
        direction,
        ...(width === undefined ? {} : { width }),
    });
    context.ports.set(source, snapshot);
    return snapshot;
}

function snapshotDesignInstance(
    source: ArchDesignInstance,
    context: DesignSnapshotContext
): ArchDesignInstance {
    const cached = context.instances.get(source);
    if (cached) return cached;
    const name = source.name;
    const module = source.module;
    const parameters = source.parameters;
    const snapshot = Object.freeze({
        name,
        module,
        ...(parameters === undefined
            ? {}
            : {
                parameters: snapshotRecord<ArchDesignParameterValue>(parameters, context),
            }),
    });
    context.instances.set(source, snapshot);
    return snapshot;
}

function snapshotDesignEndpoint(
    source: ArchDesignEndpoint,
    context: DesignSnapshotContext
): ArchDesignEndpoint {
    const cached = context.endpoints.get(source);
    if (cached) return cached;
    const kind = source.kind;
    if (kind === 'port') {
        const port = source.port;
        const signal = source.signal;
        const snapshot = Object.freeze({
            kind,
            port,
            ...(signal === undefined ? {} : { signal }),
        });
        context.endpoints.set(source, snapshot);
        return snapshot;
    }
    const instance = source.instance;
    const port = source.port;
    const snapshot = Object.freeze({ kind, instance, port });
    context.endpoints.set(source, snapshot);
    return snapshot;
}

function snapshotDesignConnection(
    source: ArchDesignConnection,
    context: DesignSnapshotContext
): ArchDesignConnection {
    const cached = context.connections.get(source);
    if (cached) return cached;
    const name = source.name;
    const endpointSources = source.endpoints;
    const defaultSources = source.defaults;
    const endpointItems = snapshotArray(endpointSources);
    const defaults = defaultSources === undefined
        ? undefined
        : snapshotRecord(defaultSources, context);
    const endpoints = Object.freeze(endpointItems.map(endpoint =>
        snapshotDesignEndpoint(endpoint, context)
    ));
    const snapshot = Object.freeze({
        name,
        endpoints,
        ...(defaults === undefined ? {} : { defaults }),
    });
    context.connections.set(source, snapshot);
    return snapshot;
}

function snapshotInterfaceEndpoint(
    source: ArchDesignInterfaceEndpoint,
    context: DesignSnapshotContext
): ArchDesignInterfaceEndpoint {
    const cached = context.interfaceEndpoints.get(source);
    if (cached) return cached;
    const kind = source.kind;
    const snapshot = kind === 'port'
        ? Object.freeze({ kind, port: source.port })
        : Object.freeze({ kind, instance: source.instance, interface: source.interface });
    context.interfaceEndpoints.set(source, snapshot);
    return snapshot;
}

function snapshotInterfacePort(
    source: ArchDesignInterfacePort,
    context: DesignSnapshotContext
): ArchDesignInterfacePort {
    const cached = context.interfacePorts.get(source);
    if (cached) return cached;
    const name = source.name;
    const protocol = source.protocol;
    const role = source.role;
    const memberPrefix = source.memberPrefix;
    const memberSources = snapshotArray(source.members);
    const members = memberSources.map(member => Object.freeze({
        member: member.member,
        width: snapshotDesignWidth(member.width, context),
    }));
    const snapshot = Object.freeze({
        name,
        protocol,
        role,
        memberPrefix,
        members: Object.freeze(members),
    });
    context.interfacePorts.set(source, snapshot);
    return snapshot;
}

function snapshotInterfaceOverride(
    source: ArchDesignInterfaceOverride,
    context: DesignSnapshotContext
): ArchDesignInterfaceOverride {
    const cached = context.interfaceOverrides.get(source);
    if (cached) return cached;
    const protocol = source.protocol;
    const role = source.role;
    const snapshot = Object.freeze({
        ...(protocol === undefined ? {} : { protocol }),
        ...(role === undefined ? {} : { role }),
    });
    context.interfaceOverrides.set(source, snapshot);
    return snapshot;
}

function snapshotInterfaceConnection(
    source: ArchDesignInterfaceConnection,
    context: DesignSnapshotContext
): ArchDesignInterfaceConnection {
    const cached = context.interfaceConnections.get(source);
    if (cached) return cached;
    const name = source.name;
    const masterSource = source.master;
    const slaveSource = source.slave;
    const defaultsSource = source.defaults;
    const snapshot = Object.freeze({
        name,
        master: snapshotInterfaceEndpoint(masterSource, context),
        slave: snapshotInterfaceEndpoint(slaveSource, context),
        ...(defaultsSource === undefined
            ? {}
            : { defaults: snapshotRecord(defaultsSource, context) }),
    });
    context.interfaceConnections.set(source, snapshot);
    return snapshot;
}

function snapshotDesign(source: ArchDesign): DesignSnapshot {
    const moduleName = source.module;
    const portSources = source.ports;
    const instanceSources = source.instances;
    const connectionSources = source.connections;
    const interfacePortSources = source.interfacePorts ?? [];
    const interfaceOverrideSources = source.interfaceOverrides ?? {};
    const interfaceConnectionSources = source.interfaceConnections;
    const defaultSources = source.defaults;
    const portItems = snapshotArray(portSources);
    const instanceItems = snapshotArray(instanceSources);
    const connectionItems = snapshotArray(connectionSources);
    const interfacePortItems = snapshotArray(interfacePortSources);
    const interfaceConnectionItems = snapshotArray(interfaceConnectionSources);
    const context: DesignSnapshotContext = {
        widths: new WeakMap(),
        ports: new WeakMap(),
        instances: new WeakMap(),
        endpoints: new WeakMap(),
        connections: new WeakMap(),
        interfaceEndpoints: new WeakMap(),
        interfacePorts: new WeakMap(),
        interfaceOverrides: new WeakMap(),
        interfaceConnections: new WeakMap(),
        records: new WeakMap(),
    };
    const defaults = snapshotRecord(defaultSources, context);
    const ports = portItems.map(port =>
        snapshotDesignPort(port, context)
    );
    const instances = instanceItems.map(instance =>
        snapshotDesignInstance(instance, context)
    );
    const connections = connectionItems.map(connection =>
        snapshotDesignConnection(connection, context)
    );
    const interfacePorts = interfacePortItems.map(port =>
        snapshotInterfacePort(port, context)
    );
    const interfaceOverrides: Record<string, ArchDesignInterfaceOverride> = {};
    for (const key of Object.keys(interfaceOverrideSources).sort(compareCodeUnits)) {
        Object.defineProperty(interfaceOverrides, key, {
            value: snapshotInterfaceOverride(interfaceOverrideSources[key], context),
            enumerable: true,
            configurable: false,
            writable: false,
        });
    }
    const interfaceConnections = interfaceConnectionItems.map(connection =>
        snapshotInterfaceConnection(connection, context)
    );
    return Object.freeze({
        moduleName,
        ports: Object.freeze(ports),
        instances: Object.freeze(instances),
        connections: Object.freeze(connections),
        interfacePorts: Object.freeze(interfacePorts),
        interfaceOverrides: Object.freeze(interfaceOverrides),
        interfaceConnections: Object.freeze(interfaceConnections),
        defaults,
    });
}

function snapshotParameter(
    source: ArchDesignDefinitionParameter
): ArchDesignDefinitionParameter {
    const name = source.name;
    const defaultExpression = source.defaultExpression;
    return Object.freeze({
        name,
        ...(defaultExpression === undefined ? {} : { defaultExpression }),
    });
}

function snapshotWidth(source: WidthValue): WidthValue {
    const kind = source.kind;
    return kind === 'known'
        ? Object.freeze({ kind, bits: source.bits })
        : kind === 'symbolic'
            ? Object.freeze({ kind, expression: source.expression })
            : Object.freeze({ kind });
}

function snapshotPort(source: ArchDesignDefinitionPort): ArchDesignDefinitionPort {
    const name = source.name;
    const direction = source.direction;
    const width = snapshotWidth(source.width);
    return Object.freeze({ name, direction, width });
}

function snapshotDefinition(
    source: ArchDesignModuleDefinition
): ResolvedArchDesignModuleDefinition {
    const key = source.key;
    const name = source.name;
    const parameterSources = source.parameters;
    const portSources = source.ports;
    const parameters = snapshotArray(parameterSources).map(snapshotParameter);
    const ports = snapshotArray(portSources).map(snapshotPort);
    return Object.freeze({
        key,
        name,
        parameters: Object.freeze(parameters),
        ports: Object.freeze(ports),
    });
}

function snapshotDefinitions(
    sources: readonly ArchDesignModuleDefinition[]
): readonly ResolvedArchDesignModuleDefinition[] {
    const definitions = snapshotArray(sources).map(snapshotDefinition);
    definitions.sort((left, right) =>
        compareCodeUnits(left.name, right.name) || compareCodeUnits(left.key, right.key));
    return Object.freeze(definitions);
}

function definitionsByName(
    definitions: readonly ResolvedArchDesignModuleDefinition[]
): ReadonlyMap<string, readonly ResolvedArchDesignModuleDefinition[]> {
    const mutable = new Map<string, ResolvedArchDesignModuleDefinition[]>();
    for (const definition of definitions) {
        const matches = mutable.get(definition.name);
        if (matches) matches.push(definition);
        else mutable.set(definition.name, [definition]);
    }
    const result = new Map<string, readonly ResolvedArchDesignModuleDefinition[]>();
    for (const [name, matches] of mutable) result.set(name, Object.freeze(matches));
    return result;
}

function diagnostic(path: string, code: string, message: string): ArchDesignDiagnostic {
    return Object.freeze({ path, code, message });
}

function topWidth(port: ArchDesignPort): WidthValue {
    const width = port.width;
    if (width === undefined) return Object.freeze({ kind: 'known', bits: 1 });
    return typeof width === 'number'
        ? Object.freeze({ kind: 'known', bits: width })
        : Object.freeze({ kind: 'symbolic', expression: width.expression });
}

function target(
    value: Omit<ResolvedArchDesignEndpointTarget, 'declarationOrder'>,
    declarationOrder: number
): ResolvedArchDesignEndpointTarget {
    return Object.freeze({ ...value, declarationOrder });
}

function addTarget(
    targets: ResolvedArchDesignEndpointTarget[],
    byIdentity: Map<string, ResolvedArchDesignEndpointTarget>,
    byDefaultKey: Map<string, ResolvedArchDesignEndpointTarget[]>,
    value: Omit<ResolvedArchDesignEndpointTarget, 'declarationOrder'>
): ResolvedArchDesignEndpointTarget {
    const result = target(value, targets.length);
    targets.push(result);
    byIdentity.set(result.identity, result);
    const sameKey = byDefaultKey.get(result.defaultKey);
    if (sameKey) sameKey.push(result);
    else byDefaultKey.set(result.defaultKey, [result]);
    return result;
}

function addTopPortTargets(
    declaration: ResolvedArchDesignPort,
    targets: ResolvedArchDesignEndpointTarget[],
    byIdentity: Map<string, ResolvedArchDesignEndpointTarget>,
    byDefaultKey: Map<string, ResolvedArchDesignEndpointTarget[]>
): void {
    const { port, index, nodeId } = declaration;
    const width = topWidth(port);
    const path = `$.ports[${index}]`;
    const add = (signal: 'value' | 'i' | 'o' | 't', role: ArchDesignEndpointRole) =>
        addTarget(targets, byIdentity, byDefaultKey, {
            identity: `${nodeId}:${signal}`,
            nodeId,
            defaultKey: `${port.name}.${signal}`,
            role,
            width,
            kind: 'port',
            port: port.name,
            signal,
            declarationPath: path,
            ...(signal === 't' ? { inoutPortWidth: width } : {}),
        });
    if (port.direction === 'inout') {
        add('i', 'driver');
        add('o', 'load');
        add('t', 'load');
    } else {
        add('value', port.direction === 'input' ? 'driver' : 'load');
    }
}

function addInstanceTargets(
    instance: ResolvedArchDesignInstance,
    targets: ResolvedArchDesignEndpointTarget[],
    byIdentity: Map<string, ResolvedArchDesignEndpointTarget>,
    byDefaultKey: Map<string, ResolvedArchDesignEndpointTarget[]>
): void {
    if (!instance.definition) return;
    const seenPorts = new Set<string>();
    for (const port of instance.definition.ports) {
        if (seenPorts.has(port.name)) continue;
        seenPorts.add(port.name);
        addTarget(targets, byIdentity, byDefaultKey, {
            identity: `${instance.nodeId}:${port.name}`,
            nodeId: instance.nodeId,
            defaultKey: `${instance.instance.name}.${port.name}`,
            role: port.direction === 'input'
                ? 'load'
                : port.direction === 'output'
                    ? 'driver'
                    : 'bidirectional',
            width: port.width,
            kind: 'instance',
            instance: instance.instance.name,
            port: port.name,
            declarationPath: `$.instances[${instance.index}]`,
        });
    }
}

function resolvedEndpoint(
    endpoint: ArchDesignEndpoint,
    targetValue: ResolvedArchDesignEndpointTarget,
    path: string,
    connectionIndex: number,
    endpointIndex: number,
    declarationOrder: number
): ResolvedArchDesignEndpoint {
    return Object.freeze({
        identity: targetValue.identity,
        defaultKey: targetValue.defaultKey,
        role: targetValue.role,
        width: targetValue.width,
        kind: targetValue.kind,
        port: targetValue.port,
        ...(targetValue.signal === undefined ? {} : { signal: targetValue.signal }),
        ...(targetValue.instance === undefined ? {} : { instance: targetValue.instance }),
        declarationPath: targetValue.declarationPath,
        targetDeclarationOrder: targetValue.declarationOrder,
        ...(targetValue.inoutPortWidth === undefined
            ? {}
            : { inoutPortWidth: targetValue.inoutPortWidth }),
        endpoint,
        path,
        connectionIndex,
        endpointIndex,
        declarationOrder,
    });
}

function inspectDefault(
    key: string,
    expression: string,
    path: string,
    byDefaultKey: ReadonlyMap<string, readonly ResolvedArchDesignEndpointTarget[]>,
    diagnostics: ArchDesignDiagnostic[],
    connection?: ResolvedArchDesignConnection,
    connectionIndex?: ConnectionIndex
): readonly [ResolvedArchDesignEndpointTarget, DefaultSelection] | undefined {
    const safe = isSafeDefaultExpression(expression);
    if (!safe) {
        diagnostics.push(diagnostic(
            path,
            'AD_DEFAULT_EXPRESSION',
            'Default must be a safe Verilog constant expression'
        ));
    }
    const matches = byDefaultKey.get(key) ?? [];
    if (matches.length !== 1) {
        diagnostics.push(diagnostic(
            path,
            'AD_DEFAULT_ENDPOINT',
            `Default key ${key} does not identify one endpoint`
        ));
        return undefined;
    }
    const endpoint = matches[0];
    if (connection && !connectionIndex?.declaredEndpointIdentities.has(endpoint.identity)) {
        diagnostics.push(diagnostic(
            path,
            'AD_DEFAULT_CONNECTION',
            `Default endpoint ${key} is absent from connection ${connection.connection.name}`
        ));
        return undefined;
    }
    if (endpoint.role !== 'load') {
        diagnostics.push(diagnostic(
            path,
            'AD_DEFAULT_RECEIVER',
            `Default endpoint ${key} is not a receiver`
        ));
        return undefined;
    }
    return Object.freeze([endpoint, Object.freeze({ expression, safe, sourcePath: path })]);
}

function defaultEntries(value: Readonly<Record<string, string>>): readonly string[] {
    return Object.freeze(Object.keys(value).sort(compareCodeUnits));
}

function appendNamed<T>(target: Map<string, T[]>, name: string, item: T): void {
    const existing = target.get(name);
    if (existing) existing.push(item);
    else target.set(name, [item]);
}

function declarationId(
    kind: 'port' | 'instance' | 'network',
    name: string,
    index: number,
    seen: Set<string>,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): string {
    const base = `${kind}:${name}`;
    if (!seen.has(name)) {
        seen.add(name);
        return base;
    }
    diagnostics.push(diagnostic(
        path,
        'AD_DUPLICATE_NAME',
        `Duplicate name: ${name}`
    ));
    return `${base}:declaration:${index}`;
}

export function resolveArchDesign(
    design: ArchDesign,
    definitionSources: readonly ArchDesignModuleDefinition[],
    interfaceCatalog: InterfaceProtocolCatalog = DEFAULT_INTERFACE_PROTOCOL_CATALOG
): ArchDesignResolution {
    const designSnapshot = snapshotDesign(design);
    const moduleName = designSnapshot.moduleName;
    const definitions = snapshotDefinitions(definitionSources);
    const catalog = definitionsByName(definitions);
    const parameterNamesByDefinition = new Map(definitions.map(definition => [
        definition,
        new Set(definition.parameters.map(parameter => parameter.name)),
    ]));
    const diagnostics: ArchDesignDiagnostic[] = [];
    const resolvedPorts: ResolvedArchDesignPort[] = [];
    const portsByName = new Map<string, ResolvedArchDesignPort[]>();
    const seenPortNames = new Set<string>();
    for (let index = 0; index < designSnapshot.ports.length; index += 1) {
        const port = designSnapshot.ports[index];
        const nodeId = declarationId(
            'port',
            port.name,
            index,
            seenPortNames,
            `$.ports[${index}].name`,
            diagnostics
        );
        const resolved = Object.freeze({ index, nodeId, port });
        resolvedPorts.push(resolved);
        appendNamed(portsByName, port.name, resolved);
    }

    const resolvedInstances: ResolvedArchDesignInstance[] = [];
    const instancesByName = new Map<string, ResolvedArchDesignInstance[]>();
    const seenInstanceNames = new Set<string>();

    for (let index = 0; index < designSnapshot.instances.length; index += 1) {
        const instance = designSnapshot.instances[index];
        const nodeId = declarationId(
            'instance',
            instance.name,
            index,
            seenInstanceNames,
            `$.instances[${index}].name`,
            diagnostics
        );
        const matches = catalog.get(instance.module) ?? [];
        const modulePath = `$.instances[${index}].module`;
        if (matches.length === 0) {
            diagnostics.push(diagnostic(
                modulePath,
                'AD_MODULE_UNRESOLVED',
                `No module definition is named ${instance.module}`
            ));
            const resolved = Object.freeze({ index, nodeId, instance });
            resolvedInstances.push(resolved);
            appendNamed(instancesByName, instance.name, resolved);
            continue;
        }
        if (matches.length > 1) {
            diagnostics.push(diagnostic(
                modulePath,
                'AD_MODULE_AMBIGUOUS',
                `More than one module definition is named ${instance.module}`
            ));
            const resolved = Object.freeze({ index, nodeId, instance });
            resolvedInstances.push(resolved);
            appendNamed(instancesByName, instance.name, resolved);
            continue;
        }

        const definition = matches[0];
        const resolved = Object.freeze({ index, nodeId, instance, definition });
        resolvedInstances.push(resolved);
        appendNamed(instancesByName, instance.name, resolved);
        const seenDefinitionPorts = new Set<string>();
        for (const port of definition.ports) {
            if (!seenDefinitionPorts.has(port.name)) {
                seenDefinitionPorts.add(port.name);
                continue;
            }
            diagnostics.push(diagnostic(
                modulePath,
                'AD_DEFINITION_PORT_DUPLICATE',
                `Module ${instance.module} repeats port ${port.name}`
            ));
        }
        const parameters = instance.parameters;
        if (!parameters) continue;
        for (const key of Object.keys(parameters).sort(compareCodeUnits)) {
            if (parameterNamesByDefinition.get(definition)?.has(key)) continue;
            diagnostics.push(diagnostic(
                `$.instances[${index}].parameters.${key}`,
                'AD_PARAMETER_UNKNOWN',
                `Parameter ${key} is not declared by module ${instance.module}`
            ));
        }
    }

    const targets: ResolvedArchDesignEndpointTarget[] = [];
    const targetsByIdentity = new Map<string, ResolvedArchDesignEndpointTarget>();
    const targetsByDefaultKey = new Map<string, ResolvedArchDesignEndpointTarget[]>();
    for (const port of resolvedPorts) {
        addTopPortTargets(
            port,
            targets,
            targetsByIdentity,
            targetsByDefaultKey
        );
    }
    for (const instance of resolvedInstances) {
        addInstanceTargets(instance, targets, targetsByIdentity, targetsByDefaultKey);
    }

    const targetsByNodeId = new Map<string, ResolvedArchDesignEndpointTarget[]>();
    for (const item of targets) appendNamed(targetsByNodeId, item.nodeId, item);
    const seenEndpoints = new Set<string>();
    const connectedEndpoints = new Map<string, ResolvedArchDesignEndpoint>();
    const resolvedConnections: ResolvedArchDesignConnection[] = [];
    const connectionIndexes: ConnectionIndex[] = [];
    const seenConnectionNames = new Set<string>();
    let endpointDeclarationOrder = 0;

    const resolveEndpointTarget = (
        endpoint: ArchDesignEndpoint,
        path: string
    ): ResolvedArchDesignEndpointTarget | undefined => {
        if (endpoint.kind === 'port') {
            const declarations = portsByName.get(endpoint.port);
            if (!declarations) {
                diagnostics.push(diagnostic(
                    `${path}.port`,
                    'AD_ENDPOINT_UNKNOWN',
                    `No top-level port is named ${endpoint.port}`
                ));
                return undefined;
            }
            if (declarations.length !== 1) {
                diagnostics.push(diagnostic(
                    `${path}.port`,
                    'AD_ENDPOINT_AMBIGUOUS',
                    `More than one top-level port is named ${endpoint.port}`
                ));
                return undefined;
            }
            const candidates = targetsByNodeId.get(declarations[0].nodeId) ?? [];
            if (candidates.length === 1) {
                if (endpoint.signal === undefined || endpoint.signal === 'value') {
                    return candidates[0];
                }
            } else if (
                endpoint.signal === 'i'
                || endpoint.signal === 'o'
                || endpoint.signal === 't'
            ) {
                return candidates.find(candidate => candidate.signal === endpoint.signal);
            }
            diagnostics.push(diagnostic(
                `${path}.signal`,
                'AD_PORT_SIGNAL',
                candidates.length === 1
                    ? 'Input and output ports use only the value signal'
                    : 'Inout ports require an explicit i, o, or t signal'
            ));
            return undefined;
        }

        const instances = instancesByName.get(endpoint.instance);
        if (!instances) {
            diagnostics.push(diagnostic(
                `${path}.instance`,
                'AD_ENDPOINT_UNKNOWN',
                `No instance is named ${endpoint.instance}`
            ));
            return undefined;
        }
        if (instances.length !== 1) {
            diagnostics.push(diagnostic(
                `${path}.instance`,
                'AD_ENDPOINT_AMBIGUOUS',
                `More than one instance is named ${endpoint.instance}`
            ));
            return undefined;
        }
        const instance = instances[0];
        if (!instance.definition) return undefined;
        const result = targetsByIdentity.get(
            `${instance.nodeId}:${endpoint.port}`
        );
        if (!result) {
            diagnostics.push(diagnostic(
                `${path}.port`,
                'AD_ENDPOINT_UNKNOWN',
                `Module ${instance.instance.module} has no port named ${endpoint.port}`
            ));
        }
        return result;
    };

    for (let connectionIndex = 0;
        connectionIndex < designSnapshot.connections.length;
        connectionIndex += 1) {
        const connection = designSnapshot.connections[connectionIndex];
        const networkId = declarationId(
            'network',
            connection.name,
            connectionIndex,
            seenConnectionNames,
            `$.connections[${connectionIndex}].name`,
            diagnostics
        );
        const declaredEndpointIdentities = new Set<string>();
        const knownWidthCounts = new Map<number, number>();
        const inoutTEndpoints: ResolvedArchDesignEndpoint[] = [];
        const endpoints: ResolvedArchDesignEndpoint[] = [];
        let definiteDriverCount = 0;
        let hasSource = false;
        let knownEndpointCount = 0;
        let knownNetworkWidth: number | undefined;
        for (let endpointIndex = 0;
            endpointIndex < connection.endpoints.length;
            endpointIndex += 1) {
            const endpoint = connection.endpoints[endpointIndex];
            const path = `$.connections[${connectionIndex}].endpoints[${endpointIndex}]`;
            const targetValue = resolveEndpointTarget(endpoint, path);
            if (!targetValue) continue;
            declaredEndpointIdentities.add(targetValue.identity);
            if (seenEndpoints.has(targetValue.identity)) {
                diagnostics.push(diagnostic(
                    path,
                    'AD_ENDPOINT_DUPLICATE',
                    `Endpoint ${targetValue.defaultKey} is declared more than once`
                ));
                continue;
            }
            seenEndpoints.add(targetValue.identity);
            const result = resolvedEndpoint(
                endpoint,
                targetValue,
                path,
                connectionIndex,
                endpointIndex,
                endpointDeclarationOrder
            );
            endpointDeclarationOrder += 1;
            endpoints.push(result);
            connectedEndpoints.set(result.identity, result);
            if (result.role === 'driver' || result.role === 'bidirectional') {
                hasSource = true;
            }
            if (result.role === 'driver') {
                if (definiteDriverCount > 0) {
                    diagnostics.push(diagnostic(
                        result.path,
                        'AD_MULTIPLE_DRIVERS',
                        `Connection ${connection.name} has more than one definite driver`
                    ));
                }
                definiteDriverCount += 1;
            }
            if (result.signal !== 't' && result.width.kind === 'known') {
                if (knownNetworkWidth === undefined) knownNetworkWidth = result.width.bits;
                else if (result.width.bits !== knownNetworkWidth) {
                    diagnostics.push(diagnostic(
                        result.path,
                        'AD_WIDTH_MISMATCH',
                        `Endpoint width ${result.width.bits} does not match network width ${knownNetworkWidth}`
                    ));
                }
            }
            if (result.width.kind === 'known') {
                knownEndpointCount += 1;
                knownWidthCounts.set(
                    result.width.bits,
                    (knownWidthCounts.get(result.width.bits) ?? 0) + 1
                );
            }
            if (result.signal === 't') inoutTEndpoints.push(result);
        }
        for (const endpoint of inoutTEndpoints) {
            if (endpoint.inoutPortWidth?.kind !== 'known') continue;
            const portBits = endpoint.inoutPortWidth.bits;
            const allowedKnownCount = (knownWidthCounts.get(1) ?? 0)
                + (portBits === 1 ? 0 : knownWidthCounts.get(portBits) ?? 0);
            if (knownEndpointCount > allowedKnownCount) {
                diagnostics.push(diagnostic(
                    endpoint.path,
                    'AD_INOUT_T_WIDTH',
                    `Inout t must connect to width 1 or the ${portBits}-bit inout width`
                ));
            }
        }
        const resolved = Object.freeze({
            index: connectionIndex,
            networkId,
            connection,
            endpoints: Object.freeze(endpoints),
        });
        resolvedConnections.push(resolved);
        connectionIndexes.push(Object.freeze({
            declaredEndpointIdentities,
            definiteDriverCount,
            hasSource,
        }));
    }

    const interfaces = resolveArchDesignInterfaces({
        interfacePorts: designSnapshot.interfacePorts,
        interfaceOverrides: designSnapshot.interfaceOverrides,
        interfaceConnections: designSnapshot.interfaceConnections,
        instances: resolvedInstances,
        endpointTargets: targets,
        scalarConnections: resolvedConnections,
        catalog: interfaceCatalog,
    });
    diagnostics.push(...interfaces.diagnostics);
    const interfaceOccupiedTargets = new Set(
        interfaces.occupancy.map(item => item.targetIdentity)
    );

    const designDefaults = new Map<string, DefaultSelection>();
    for (const key of defaultEntries(designSnapshot.defaults)) {
        const expression = designSnapshot.defaults[key];
        const inspected = inspectDefault(
            key,
            expression,
            `$.defaults.${key}`,
            targetsByDefaultKey,
            diagnostics
        );
        if (inspected) designDefaults.set(inspected[0].identity, inspected[1]);
    }

    const connectionDefaults = new Map<number, Map<string, DefaultSelection>>();
    for (const connection of resolvedConnections) {
        const defaults = connection.connection.defaults;
        if (!defaults) continue;
        const selections = new Map<string, DefaultSelection>();
        connectionDefaults.set(connection.index, selections);
        for (const key of defaultEntries(defaults)) {
            const expression = defaults[key];
            const inspected = inspectDefault(
                key,
                expression,
                `$.connections[${connection.index}].defaults.${key}`,
                targetsByDefaultKey,
                diagnostics,
                connection,
                connectionIndexes[connection.index]
            );
            if (inspected) selections.set(inspected[0].identity, inspected[1]);
        }
    }

    const effectiveDefaults: ResolvedArchDesignDefault[] = [];
    for (const endpoint of targets) {
        if (endpoint.role !== 'load') continue;
        if (interfaceOccupiedTargets.has(endpoint.identity)) continue;
        const connected = connectedEndpoints.get(endpoint.identity);
        if (
            connected
            && connectionIndexes[connected.connectionIndex].hasSource
        ) continue;

        const connectionSelection = connected
            ? connectionDefaults.get(connected.connectionIndex)?.get(endpoint.identity)
            : undefined;
        const designSelection = designDefaults.get(endpoint.identity);
        const selection = connectionSelection ?? designSelection;
        if (selection) {
            if (selection.safe) {
                effectiveDefaults.push(Object.freeze({
                    identity: endpoint.identity,
                    endpoint: endpoint.defaultKey,
                    declarationOrder: endpoint.declarationOrder,
                    sourcePath: selection.sourcePath,
                    expression: selection.expression,
                    origin: connectionSelection ? 'connection' : 'design',
                    ...(connectionSelection && connected
                        ? {
                            connection: resolvedConnections[connected.connectionIndex]
                                .connection.name,
                        }
                        : {}),
                }));
            }
            continue;
        }
        if (endpoint.kind === 'port' && endpoint.signal === 't') {
            effectiveDefaults.push(Object.freeze({
                identity: endpoint.identity,
                endpoint: endpoint.defaultKey,
                declarationOrder: endpoint.declarationOrder,
                sourcePath: endpoint.declarationPath,
                expression: "1'b1",
                origin: 'implicit-inout-t',
            }));
            continue;
        }
        if (connected) continue;
        diagnostics.push(diagnostic(
            endpoint.declarationPath,
            'AD_UNDRIVEN_INPUT',
            `Receiver ${endpoint.defaultKey} has no definite driver or default`
        ));
    }

    const defaultsByIdentity = new Map(effectiveDefaults.map(item => [item.identity, item]));
    const connectionDefaultSources: ResolvedArchDesignConnectionDefaultSource[] = [];
    for (const connection of resolvedConnections) {
        if (connectionIndexes[connection.index].hasSource) continue;
        const candidates = connection.endpoints.flatMap(endpoint => {
            const candidate = defaultsByIdentity.get(endpoint.identity);
            return candidate ? [candidate] : [];
        }).sort((left, right) => left.declarationOrder - right.declarationOrder);
        if (candidates.length === 0) {
            for (const endpoint of connection.endpoints) {
                if (endpoint.role !== 'load') continue;
                diagnostics.push(diagnostic(
                    endpoint.path,
                    'AD_UNDRIVEN_INPUT',
                    `Receiver ${endpoint.defaultKey} has no definite driver or default`
                ));
            }
            continue;
        }
        const expression = candidates[0].expression;
        const conflicting = candidates.filter((candidate, index) =>
            index > 0 && candidate.expression !== expression
        );
        if (conflicting.length > 0) {
            for (const candidate of conflicting) {
                diagnostics.push(diagnostic(
                    candidate.sourcePath,
                    'AD_DEFAULT_CONFLICT',
                    `Defaults on connection ${connection.connection.name} must use one expression`
                ));
            }
            continue;
        }
        connectionDefaultSources.push(Object.freeze({
            connectionIndex: connection.index,
            default: candidates[0],
        }));
    }

    diagnostics.sort((left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    return Object.freeze({
        moduleName,
        ports: Object.freeze(resolvedPorts),
        instances: Object.freeze(resolvedInstances),
        endpointTargets: Object.freeze(targets),
        connections: Object.freeze(resolvedConnections),
        interfaces,
        diagnostics: Object.freeze(diagnostics),
        warnings: interfaces.warnings,
        effectiveDefaults: Object.freeze(effectiveDefaults),
        connectionDefaultSources: Object.freeze(connectionDefaultSources),
    });
}
