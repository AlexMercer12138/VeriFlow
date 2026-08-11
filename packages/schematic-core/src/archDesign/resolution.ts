import type { WidthValue } from '@veriflow/hdl-core/model';

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
    ArchDesignPort,
} from './model';
import { compareCodeUnits } from './ordering';
import type { ArchDesignDiagnostic } from './parser';

export type ResolvedArchDesignModuleDefinition = Readonly<{
    key: string;
    name: string;
    parameters: readonly ArchDesignDefinitionParameter[];
    ports: readonly ArchDesignDefinitionPort[];
    parametersByName: ReadonlyMap<string, ArchDesignDefinitionParameter>;
}>;

export type ResolvedArchDesignInstance = Readonly<{
    index: number;
    instance: ArchDesignInstance;
    definition?: ResolvedArchDesignModuleDefinition;
}>;

export type ArchDesignEndpointRole = 'driver' | 'load' | 'bidirectional';

export type ResolvedArchDesignEndpointTarget = Readonly<{
    identity: string;
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
    connection: ArchDesignConnection;
    declaredEndpointIdentities: readonly string[];
    endpoints: readonly ResolvedArchDesignEndpoint[];
}>;

export type ArchDesignDefaultOrigin = 'connection' | 'design' | 'implicit-inout-t';

export type ArchDesignEffectiveDefault = Readonly<{
    endpoint: string;
    expression: string;
    origin: ArchDesignDefaultOrigin;
    connection?: string;
}>;

export type ArchDesignResolution = Readonly<{
    instances: readonly ResolvedArchDesignInstance[];
    endpointTargets: readonly ResolvedArchDesignEndpointTarget[];
    connections: readonly ResolvedArchDesignConnection[];
    diagnostics: readonly ArchDesignDiagnostic[];
    effectiveDefaults: readonly ArchDesignEffectiveDefault[];
}>;

type DefaultSelection = Readonly<{
    expression: string;
    safe: boolean;
}>;

function snapshotArray<T>(source: readonly T[]): T[] {
    const length = source.length;
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) result.push(source[index]);
    return result;
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
    const parametersByName = new Map<string, ArchDesignDefinitionParameter>();
    for (const parameter of [...parameters].sort((left, right) =>
        compareCodeUnits(left.name, right.name))) {
        parametersByName.set(parameter.name, parameter);
    }
    return Object.freeze({
        key,
        name,
        parameters: Object.freeze(parameters),
        ports: Object.freeze(ports),
        parametersByName,
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
    port: ArchDesignPort,
    index: number,
    targets: ResolvedArchDesignEndpointTarget[],
    byIdentity: Map<string, ResolvedArchDesignEndpointTarget>,
    byDefaultKey: Map<string, ResolvedArchDesignEndpointTarget[]>,
    byPort: Map<string, ResolvedArchDesignEndpointTarget[]>
): void {
    const width = topWidth(port);
    const path = `$.ports[${index}]`;
    const add = (signal: 'value' | 'i' | 'o' | 't', role: ArchDesignEndpointRole) =>
        addTarget(targets, byIdentity, byDefaultKey, {
            identity: `port:${port.name}:${signal}`,
            defaultKey: `${port.name}.${signal}`,
            role,
            width,
            kind: 'port',
            port: port.name,
            signal,
            declarationPath: path,
            ...(signal === 't' ? { inoutPortWidth: width } : {}),
        });
    const portTargets = port.direction === 'inout'
        ? [add('i', 'driver'), add('o', 'load'), add('t', 'load')]
        : [add('value', port.direction === 'input' ? 'driver' : 'load')];
    byPort.set(port.name, portTargets);
}

function addInstanceTargets(
    instance: ResolvedArchDesignInstance,
    targets: ResolvedArchDesignEndpointTarget[],
    byIdentity: Map<string, ResolvedArchDesignEndpointTarget>,
    byDefaultKey: Map<string, ResolvedArchDesignEndpointTarget[]>
): void {
    if (!instance.definition) return;
    for (const port of instance.definition.ports) {
        addTarget(targets, byIdentity, byDefaultKey, {
            identity: `instance:${instance.instance.name}:${port.name}`,
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

function validateNetwork(
    connection: ResolvedArchDesignConnection,
    diagnostics: ArchDesignDiagnostic[]
): void {
    const drivers = connection.endpoints.filter(endpoint => endpoint.role === 'driver');
    for (const extraDriver of drivers.slice(1)) {
        diagnostics.push(diagnostic(
            extraDriver.path,
            'AD_MULTIPLE_DRIVERS',
            `Connection ${connection.connection.name} has more than one definite driver`
        ));
    }

    let knownWidth: number | undefined;
    for (const endpoint of connection.endpoints) {
        if (endpoint.signal === 't' || endpoint.width.kind !== 'known') continue;
        if (knownWidth === undefined) knownWidth = endpoint.width.bits;
        else if (endpoint.width.bits !== knownWidth) {
            diagnostics.push(diagnostic(
                endpoint.path,
                'AD_WIDTH_MISMATCH',
                `Endpoint width ${endpoint.width.bits} does not match network width ${knownWidth}`
            ));
        }
    }

    for (const endpoint of connection.endpoints) {
        if (endpoint.signal !== 't' || endpoint.inoutPortWidth?.kind !== 'known') continue;
        const portBits = endpoint.inoutPortWidth.bits;
        const invalidPeer = connection.endpoints.some(peer =>
            peer !== endpoint
            && peer.width.kind === 'known'
            && peer.width.bits !== 1
            && peer.width.bits !== portBits);
        if (invalidPeer) {
            diagnostics.push(diagnostic(
                endpoint.path,
                'AD_INOUT_T_WIDTH',
                `Inout t must connect to width 1 or the ${portBits}-bit inout width`
            ));
        }
    }
}

function inspectDefault(
    key: string,
    expression: string,
    path: string,
    byDefaultKey: ReadonlyMap<string, readonly ResolvedArchDesignEndpointTarget[]>,
    diagnostics: ArchDesignDiagnostic[],
    connection?: ResolvedArchDesignConnection
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
    if (connection && !connection.declaredEndpointIdentities.includes(endpoint.identity)) {
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
    return Object.freeze([endpoint, Object.freeze({ expression, safe })]);
}

function defaultEntries(value: Readonly<Record<string, string>>): readonly string[] {
    return Object.freeze(Object.keys(value).sort(compareCodeUnits));
}

export function resolveArchDesign(
    design: ArchDesign,
    definitionSources: readonly ArchDesignModuleDefinition[]
): ArchDesignResolution {
    const catalog = definitionsByName(snapshotDefinitions(definitionSources));
    const resolvedInstances: ResolvedArchDesignInstance[] = [];
    const diagnostics: ArchDesignDiagnostic[] = [];

    for (let index = 0; index < design.instances.length; index += 1) {
        const instance = design.instances[index];
        const matches = catalog.get(instance.module) ?? [];
        const modulePath = `$.instances[${index}].module`;
        if (matches.length === 0) {
            diagnostics.push(diagnostic(
                modulePath,
                'AD_MODULE_UNRESOLVED',
                `No module definition is named ${instance.module}`
            ));
            resolvedInstances.push(Object.freeze({ index, instance }));
            continue;
        }
        if (matches.length > 1) {
            diagnostics.push(diagnostic(
                modulePath,
                'AD_MODULE_AMBIGUOUS',
                `More than one module definition is named ${instance.module}`
            ));
            resolvedInstances.push(Object.freeze({ index, instance }));
            continue;
        }

        const definition = matches[0];
        resolvedInstances.push(Object.freeze({ index, instance, definition }));
        const parameters = instance.parameters;
        if (!parameters) continue;
        for (const key of Object.keys(parameters).sort(compareCodeUnits)) {
            if (definition.parametersByName.has(key)) continue;
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
    const topTargetsByPort = new Map<string, ResolvedArchDesignEndpointTarget[]>();
    for (let index = 0; index < design.ports.length; index += 1) {
        addTopPortTargets(
            design.ports[index],
            index,
            targets,
            targetsByIdentity,
            targetsByDefaultKey,
            topTargetsByPort
        );
    }
    for (const instance of resolvedInstances) {
        addInstanceTargets(instance, targets, targetsByIdentity, targetsByDefaultKey);
    }

    const instancesByName = new Map(resolvedInstances.map(item => [item.instance.name, item]));
    const seenEndpoints = new Set<string>();
    const connectedEndpoints = new Map<string, ResolvedArchDesignEndpoint>();
    const resolvedConnections: ResolvedArchDesignConnection[] = [];
    let endpointDeclarationOrder = 0;

    const resolveEndpointTarget = (
        endpoint: ArchDesignEndpoint,
        path: string
    ): ResolvedArchDesignEndpointTarget | undefined => {
        if (endpoint.kind === 'port') {
            const candidates = topTargetsByPort.get(endpoint.port);
            if (!candidates) {
                diagnostics.push(diagnostic(
                    `${path}.port`,
                    'AD_ENDPOINT_UNKNOWN',
                    `No top-level port is named ${endpoint.port}`
                ));
                return undefined;
            }
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

        const instance = instancesByName.get(endpoint.instance);
        if (!instance) {
            diagnostics.push(diagnostic(
                `${path}.instance`,
                'AD_ENDPOINT_UNKNOWN',
                `No instance is named ${endpoint.instance}`
            ));
            return undefined;
        }
        if (!instance.definition) return undefined;
        const result = targetsByIdentity.get(
            `instance:${endpoint.instance}:${endpoint.port}`
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
        connectionIndex < design.connections.length;
        connectionIndex += 1) {
        const connection = design.connections[connectionIndex];
        const declaredEndpointIdentities: string[] = [];
        const endpoints: ResolvedArchDesignEndpoint[] = [];
        for (let endpointIndex = 0;
            endpointIndex < connection.endpoints.length;
            endpointIndex += 1) {
            const endpoint = connection.endpoints[endpointIndex];
            const path = `$.connections[${connectionIndex}].endpoints[${endpointIndex}]`;
            const targetValue = resolveEndpointTarget(endpoint, path);
            if (!targetValue) continue;
            declaredEndpointIdentities.push(targetValue.identity);
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
        }
        const resolved = Object.freeze({
            index: connectionIndex,
            connection,
            declaredEndpointIdentities: Object.freeze(declaredEndpointIdentities),
            endpoints: Object.freeze(endpoints),
        });
        resolvedConnections.push(resolved);
        validateNetwork(resolved, diagnostics);
    }

    for (let index = 0; index < design.interfaceConnections.length; index += 1) {
        diagnostics.push(diagnostic(
            `$.interfaceConnections[${index}]`,
            'AD_INTERFACE_UNSUPPORTED',
            'Interface connections are not supported by scalar validation'
        ));
    }

    const designDefaults = new Map<string, DefaultSelection>();
    for (const key of defaultEntries(design.defaults)) {
        const expression = design.defaults[key];
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
                connection
            );
            if (inspected) selections.set(inspected[0].identity, inspected[1]);
        }
    }

    const driverCountByConnection = resolvedConnections.map(connection =>
        connection.endpoints.filter(endpoint => endpoint.role === 'driver').length);
    const effectiveDefaults: ArchDesignEffectiveDefault[] = [];
    for (const endpoint of targets) {
        if (endpoint.role !== 'load') continue;
        const connected = connectedEndpoints.get(endpoint.identity);
        if (connected && driverCountByConnection[connected.connectionIndex] > 0) continue;

        const connectionSelection = connected
            ? connectionDefaults.get(connected.connectionIndex)?.get(endpoint.identity)
            : undefined;
        const designSelection = designDefaults.get(endpoint.identity);
        const selection = connectionSelection ?? designSelection;
        if (selection) {
            if (selection.safe) {
                effectiveDefaults.push(Object.freeze({
                    endpoint: endpoint.defaultKey,
                    expression: selection.expression,
                    origin: connectionSelection ? 'connection' : 'design',
                    ...(connectionSelection && connected
                        ? { connection: design.connections[connected.connectionIndex].name }
                        : {}),
                }));
            }
            continue;
        }
        if (endpoint.kind === 'port' && endpoint.signal === 't') {
            effectiveDefaults.push(Object.freeze({
                endpoint: endpoint.defaultKey,
                expression: "1'b1",
                origin: 'implicit-inout-t',
            }));
            continue;
        }
        diagnostics.push(diagnostic(
            connected?.path ?? endpoint.declarationPath,
            'AD_UNDRIVEN_INPUT',
            `Receiver ${endpoint.defaultKey} has no definite driver or default`
        ));
    }

    diagnostics.sort((left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    return Object.freeze({
        instances: Object.freeze(resolvedInstances),
        endpointTargets: Object.freeze(targets),
        connections: Object.freeze(resolvedConnections),
        diagnostics: Object.freeze(diagnostics),
        effectiveDefaults: Object.freeze(effectiveDefaults),
    });
}
