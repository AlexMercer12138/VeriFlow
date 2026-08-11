import type { WidthValue } from '@veriflow/hdl-core/model';

import type {
    GraphNode,
    GraphPin,
    NetworkEndpoint,
    SchematicGraph,
    SchematicNetwork,
} from '../model';
import type { ArchDesignModuleDefinition } from './definitions';
import type { ArchDesign } from './model';
import {
    resolveArchDesign,
    type ArchDesignResolution,
    type ResolvedArchDesignDefault,
    type ResolvedArchDesignEndpointTarget,
} from './resolution';
import type { ArchDesignValidationResult } from './validation';

export type ArchDesignGraphProjection = Readonly<{
    graph: SchematicGraph;
    validation: ArchDesignValidationResult;
}>;

type PinLocation = Readonly<{
    nodeId: string;
    pinId: string;
}>;

type TopPortTargets = {
    port: string;
    targets: ResolvedArchDesignEndpointTarget[];
};

function cloneWidth(width: WidthValue): WidthValue {
    if (width.kind === 'known') return { kind: 'known', bits: width.bits };
    if (width.kind === 'symbolic') {
        return { kind: 'symbolic', expression: width.expression };
    }
    return { kind: 'unknown' };
}

function projectValidation(resolution: ArchDesignResolution): ArchDesignValidationResult {
    const diagnostics = resolution.diagnostics.map(item => Object.freeze({
        path: item.path,
        code: item.code,
        message: item.message,
    }));
    const effectiveDefaults = resolution.effectiveDefaults.map(item => Object.freeze({
        endpoint: item.endpoint,
        expression: item.expression,
        origin: item.origin,
        ...(item.connection === undefined ? {} : { connection: item.connection }),
    }));
    return Object.freeze({
        valid: diagnostics.length === 0,
        diagnostics: Object.freeze(diagnostics),
        effectiveDefaults: Object.freeze(effectiveDefaults),
    });
}

function graphPin(
    target: ResolvedArchDesignEndpointTarget,
    name: string
): GraphPin {
    return {
        id: target.identity,
        name,
        direction: target.role,
        width: cloneWidth(target.width),
        readOnly: false,
    };
}

function collectTopPorts(
    resolution: ArchDesignResolution
): TopPortTargets[] {
    const groups: TopPortTargets[] = [];
    const byPort = new Map<string, TopPortTargets>();
    for (const target of resolution.endpointTargets) {
        if (target.kind !== 'port') continue;
        const existing = byPort.get(target.port);
        if (existing) {
            existing.targets.push(target);
            continue;
        }
        const group = { port: target.port, targets: [target] };
        byPort.set(target.port, group);
        groups.push(group);
    }
    return groups;
}

function isInputPort(group: TopPortTargets): boolean {
    return group.targets.length === 1 && group.targets[0].role === 'driver';
}

function topPortNode(group: TopPortTargets): GraphNode {
    const nodeId = `port:${group.port}`;
    const signalOrder = new Map([['o', 0], ['t', 1], ['i', 2]]);
    const targets = group.targets.length === 1
        ? group.targets
        : [...group.targets].sort((left, right) =>
            (signalOrder.get(left.signal ?? '') ?? 3)
            - (signalOrder.get(right.signal ?? '') ?? 3));
    return {
        id: nodeId,
        kind: 'port',
        label: group.port,
        pins: targets.map(target => graphPin(
            target,
            group.targets.length === 1
                ? group.port
                : `${group.port}_${target.signal}`
        )),
        readOnly: false,
    };
}

function instanceTargets(
    resolution: ArchDesignResolution
): ReadonlyMap<string, readonly ResolvedArchDesignEndpointTarget[]> {
    const mutable = new Map<string, ResolvedArchDesignEndpointTarget[]>();
    for (const target of resolution.endpointTargets) {
        if (target.kind !== 'instance' || target.instance === undefined) continue;
        const targets = mutable.get(target.instance);
        if (targets) targets.push(target);
        else mutable.set(target.instance, [target]);
    }
    return mutable;
}

function constantNode(
    item: ResolvedArchDesignDefault,
    target: ResolvedArchDesignEndpointTarget
): GraphNode {
    const nodeId = `default:${item.identity}`;
    return {
        id: nodeId,
        kind: 'constant',
        label: item.expression,
        pins: [{
            id: `${nodeId}:value`,
            name: 'value',
            direction: 'driver',
            width: cloneWidth(target.width),
            readOnly: true,
        }],
        readOnly: true,
    };
}

function selectNetworkWidth(widths: readonly WidthValue[]): WidthValue {
    const first = widths[0];
    if (first?.kind === 'known' && widths.every(width =>
        width.kind === 'known' && width.bits === first.bits
    )) {
        return { kind: 'known', bits: first.bits };
    }
    if (first?.kind === 'symbolic' && widths.every(width =>
        width.kind === 'symbolic' && width.expression === first.expression
    )) {
        return { kind: 'symbolic', expression: first.expression };
    }
    return { kind: 'unknown' };
}

function endpoint(
    location: PinLocation,
    role: NetworkEndpoint['role']
): NetworkEndpoint {
    return { nodeId: location.nodeId, pinId: location.pinId, role };
}

export function projectArchDesignGraph(
    design: ArchDesign,
    definitions: readonly ArchDesignModuleDefinition[],
    options: Readonly<{ fileUri: string }>
): ArchDesignGraphProjection {
    const resolution = resolveArchDesign(design, definitions);
    const validation = projectValidation(resolution);
    const targetByIdentity = new Map(
        resolution.endpointTargets.map(target => [target.identity, target])
    );
    const locations = new Map<string, PinLocation>();
    const nodes: GraphNode[] = [];

    const topPorts = collectTopPorts(resolution);
    const inputPorts = topPorts.filter(isInputPort);
    const outputPorts = topPorts.filter(group => !isInputPort(group));
    const addNode = (node: GraphNode, identities: readonly string[]): void => {
        nodes.push(node);
        node.pins.forEach((pin, index) => {
            locations.set(identities[index], { nodeId: node.id, pinId: pin.id });
        });
    };
    for (const port of inputPorts) {
        const node = topPortNode(port);
        const identities = node.pins.map(pin => pin.id);
        addNode(node, identities);
    }

    const targetsByInstance = instanceTargets(resolution);
    for (const item of resolution.instances) {
        const nodeId = `instance:${item.instance.name}`;
        const targets = targetsByInstance.get(item.instance.name) ?? [];
        addNode({
            id: nodeId,
            kind: 'instance',
            label: item.instance.name,
            subtitle: item.instance.module,
            ...(item.definition === undefined
                ? {}
                : { definitionKey: item.definition.key }),
            pins: targets.map(target => graphPin(target, target.port)),
            readOnly: false,
        }, targets.map(target => target.identity));
    }

    for (const port of outputPorts) {
        const node = topPortNode(port);
        const identities = node.pins.map(pin => pin.id);
        addNode(node, identities);
    }

    const connectedDefaultIdentities = new Set(
        resolution.connectionDefaultSources.map(source => source.default.identity)
    );
    const connectedEndpointIdentities = new Set(resolution.connections.flatMap(connection =>
        connection.endpoints.map(endpoint => endpoint.identity)
    ));
    const projectedDefaults = resolution.effectiveDefaults.filter(item =>
        connectedDefaultIdentities.has(item.identity)
        || !connectedEndpointIdentities.has(item.identity)
    );
    for (const item of projectedDefaults) {
        const target = targetByIdentity.get(item.identity);
        if (!target) continue;
        const node = constantNode(item, target);
        nodes.push(node);
        locations.set(`default:${item.identity}`, {
            nodeId: node.id,
            pinId: node.pins[0].id,
        });
    }

    const defaultByConnection = new Map<number, ResolvedArchDesignDefault>();
    for (const source of resolution.connectionDefaultSources) {
        defaultByConnection.set(source.connectionIndex, source.default);
    }
    const defaultOnly = projectedDefaults.filter(item =>
        !connectedEndpointIdentities.has(item.identity)
    );

    const networks: SchematicNetwork[] = [];
    for (const connection of resolution.connections) {
        const endpoints: NetworkEndpoint[] = [];
        for (const item of connection.endpoints) {
            const location = locations.get(item.identity);
            if (location) endpoints.push(endpoint(location, item.role));
        }
        const item = defaultByConnection.get(connection.index);
        if (item) {
            const location = locations.get(`default:${item.identity}`);
            if (location) endpoints.push(endpoint(location, 'driver'));
        }
        networks.push({
            id: `network:${connection.connection.name}`,
            name: connection.connection.name,
            width: selectNetworkWidth(connection.endpoints.map(item => item.width)),
            endpoints,
        });
    }

    for (const item of defaultOnly) {
        const receiver = locations.get(item.identity);
        const driver = locations.get(`default:${item.identity}`);
        const target = targetByIdentity.get(item.identity);
        if (!receiver || !driver || !target) continue;
        networks.push({
            id: `network:default:${item.identity}`,
            name: item.endpoint,
            width: cloneWidth(target.width),
            endpoints: [
                endpoint(receiver, target.role),
                endpoint(driver, 'driver'),
            ],
        });
    }

    const graph: SchematicGraph = {
        fileUri: options.fileUri,
        moduleKey: `arch-design:${resolution.moduleName}`,
        moduleName: resolution.moduleName,
        nodes,
        networks,
        diagnostics: resolution.diagnostics.map(item => ({
            severity: 'error',
            code: item.code,
            message: `${item.path}: ${item.message}`,
        })),
    };
    return Object.freeze({ graph, validation });
}
