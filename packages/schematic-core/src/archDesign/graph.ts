import type { WidthValue } from '@veriflow/hdl-core/model';

import type { InterfaceProtocolCatalog } from '../interfaces';
import type {
    GraphNode,
    GraphPin,
    NetworkEndpoint,
    SchematicGraph,
    SchematicNetwork,
} from '../model';
import type { ArchDesignModuleDefinition } from './definitions';
import type { ArchDesign } from './model';
import { compareCodeUnits } from './ordering';
import { isArchDesignInterfaceCollapsed } from './presentation';
import {
    resolveArchDesign,
    type ArchDesignResolution,
    type ResolvedArchDesignEndpointTarget,
} from './resolution';
import type {
    ResolvedArchDesignInterfaceEndpoint,
    ResolvedArchDesignInterfaceMember,
} from './interfaces';
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
    nodeId: string;
    targets: ResolvedArchDesignEndpointTarget[];
};

type InterfaceProjectionState = Readonly<{
    endpoint: ResolvedArchDesignInterfaceEndpoint;
    collapsed: boolean;
}>;

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
        warnings: resolution.warnings,
        effectiveDefaults: Object.freeze(effectiveDefaults),
    });
}

function graphPin(
    target: ResolvedArchDesignEndpointTarget,
    name: string,
    interfaceState?: InterfaceProjectionState,
    member?: ResolvedArchDesignInterfaceMember
): GraphPin {
    return {
        id: target.identity,
        name,
        direction: target.role,
        width: cloneWidth(target.width),
        readOnly: false,
        ...(interfaceState === undefined || member === undefined
            ? {}
            : { interface: interfacePinMetadata(interfaceState, 'member', member.member) }),
    };
}

function interfacePinMetadata(
    state: InterfaceProjectionState,
    kind: 'aggregate' | 'member',
    member?: string
): NonNullable<GraphPin['interface']> {
    const endpoint = state.endpoint;
    return {
        id: endpoint.identity,
        protocol: endpoint.protocol,
        protocolName: endpoint.protocolName,
        role: endpoint.role,
        roleSource: endpoint.roleSource,
        kind,
        topLevel: endpoint.endpoint.kind === 'port',
        collapsed: state.collapsed,
        ...(member === undefined ? {} : { member }),
    };
}

function aggregateDirection(
    endpoint: ResolvedArchDesignInterfaceEndpoint
): GraphPin['direction'] {
    return endpoint.effectiveRole === 'master'
        ? 'driver'
        : endpoint.effectiveRole === 'slave' ? 'load' : 'bidirectional';
}

function memberDirection(
    state: InterfaceProjectionState,
    member: ResolvedArchDesignInterfaceMember
): GraphPin['direction'] {
    const direction = member.portDirection === 'output'
        ? 'driver'
        : member.portDirection === 'input' ? 'load' : 'bidirectional';
    if (state.endpoint.endpoint.kind !== 'port') return direction;
    return direction === 'driver' ? 'load' : direction === 'load' ? 'driver' : direction;
}

function aggregatePin(state: InterfaceProjectionState): GraphPin {
    return {
        id: state.endpoint.identity,
        name: state.endpoint.endpoint.kind === 'instance'
            ? state.endpoint.endpoint.interface
            : state.endpoint.endpoint.port,
        direction: aggregateDirection(state.endpoint),
        width: { kind: 'unknown' },
        readOnly: false,
        interface: interfacePinMetadata(state, 'aggregate'),
    };
}

function interfaceMemberPin(
    state: InterfaceProjectionState,
    member: ResolvedArchDesignInterfaceMember
): GraphPin {
    return {
        id: member.targetIdentity,
        name: member.port,
        direction: memberDirection(state, member),
        width: cloneWidth(member.width),
        readOnly: false,
        interface: interfacePinMetadata(state, 'member', member.member),
    };
}

function collectTopPorts(
    resolution: ArchDesignResolution
): TopPortTargets[] {
    const byNodeId = new Map<string, ResolvedArchDesignEndpointTarget[]>();
    for (const target of resolution.endpointTargets) {
        if (target.kind !== 'port') continue;
        const existing = byNodeId.get(target.nodeId);
        if (existing) existing.push(target);
        else byNodeId.set(target.nodeId, [target]);
    }
    return resolution.ports.map(item => ({
        port: item.port.name,
        nodeId: item.nodeId,
        targets: byNodeId.get(item.nodeId) ?? [],
    }));
}

function isInputPort(group: TopPortTargets): boolean {
    return group.targets.length === 1 && group.targets[0].role === 'driver';
}

function topPortNode(group: TopPortTargets): GraphNode {
    const nodeId = group.nodeId;
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

function targetsByNode(
    resolution: ArchDesignResolution,
    kind: ResolvedArchDesignEndpointTarget['kind']
): ReadonlyMap<string, readonly ResolvedArchDesignEndpointTarget[]> {
    const mutable = new Map<string, ResolvedArchDesignEndpointTarget[]>();
    for (const target of resolution.endpointTargets) {
        if (target.kind !== kind) continue;
        const targets = mutable.get(target.nodeId);
        if (targets) targets.push(target);
        else mutable.set(target.nodeId, [target]);
    }
    return mutable;
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
    options: Readonly<{
        fileUri: string;
        interfaceCatalog?: InterfaceProtocolCatalog;
    }>
): ArchDesignGraphProjection {
    const resolution = resolveArchDesign(design, definitions, options.interfaceCatalog);
    const validation = projectValidation(resolution);
    const locations = new Map<string, PinLocation>();
    const nodes: GraphNode[] = [];

    const requestedCollapse = new Map(resolution.interfaces.endpoints.map(item => [
        item.identity,
        isArchDesignInterfaceCollapsed(design, item.identity),
    ]));
    const expandedByConnection = new Set<string>();
    for (const connection of resolution.interfaces.connections) {
        const endpoints = [connection.master, connection.slave].filter(
            (item): item is ResolvedArchDesignInterfaceEndpoint => item !== undefined
        );
        if (endpoints.some(item => requestedCollapse.get(item.identity) === false)) {
            endpoints.forEach(item => expandedByConnection.add(item.identity));
        }
    }
    const interfaceStates = resolution.interfaces.endpoints.map(endpoint => ({
        endpoint,
        collapsed: (requestedCollapse.get(endpoint.identity) ?? true)
            && !expandedByConnection.has(endpoint.identity),
    }));
    const interfaceStateByIdentity = new Map(interfaceStates.map(state => [
        state.endpoint.identity,
        state,
    ]));
    const interfaceMemberByTarget = new Map(interfaceStates.flatMap(state =>
        state.endpoint.members.map(member => [
            member.targetIdentity,
            { state, member },
        ] as const)
    ));
    const scalarOccupied = new Set(resolution.connections.flatMap(connection =>
        connection.endpoints.map(item => item.identity)
    ));

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


    const topInterfaceStates = interfaceStates.filter(state =>
        state.endpoint.endpoint.kind === 'port'
    );
    const topInterfaceNode = (state: InterfaceProjectionState): GraphNode => {
        const endpoint = state.endpoint;
        const pins = state.collapsed
            ? [aggregatePin(state)]
            : endpoint.members.map(member => interfaceMemberPin(state, member));
        return {
            id: endpoint.identity,
            kind: 'port',
            label: endpoint.endpoint.kind === 'port'
                ? endpoint.endpoint.port
                : endpoint.identity,
            subtitle: `${endpoint.protocolName} ${endpoint.role}`,
            pins,
            readOnly: false,
        };
    };
    const topSlaveInterfaces = topInterfaceStates.filter(state =>
        state.endpoint.role === 'slave'
    );
    const topOtherInterfaces = topInterfaceStates.filter(state =>
        state.endpoint.role !== 'slave'
    );
    for (const state of topSlaveInterfaces) {
        const node = topInterfaceNode(state);
        addNode(node, state.collapsed
            ? [state.endpoint.identity]
            : state.endpoint.members.map(member => member.targetIdentity));
    }

    const targetsByInstance = targetsByNode(resolution, 'instance');
    for (const item of resolution.instances) {
        const nodeId = item.nodeId;
        const targets = targetsByInstance.get(nodeId) ?? [];
        const aggregateAdded = new Set<string>();
        const pins: GraphPin[] = [];
        const identities: string[] = [];
        for (const target of targets) {
            const membership = interfaceMemberByTarget.get(target.identity);
            if (!membership) {
                pins.push(graphPin(target, target.port));
                identities.push(target.identity);
                continue;
            }
            const { state, member } = membership;
            if (!state.collapsed || scalarOccupied.has(target.identity)) {
                pins.push(graphPin(target, target.port, state, member));
                identities.push(target.identity);
                continue;
            }
            if (aggregateAdded.has(state.endpoint.identity)) continue;
            aggregateAdded.add(state.endpoint.identity);
            pins.push(aggregatePin(state));
            identities.push(state.endpoint.identity);
        }
        addNode({
            id: nodeId,
            kind: 'instance',
            label: item.instance.name,
            subtitle: item.instance.module,
            ...(item.definition === undefined
                ? {}
                : { definitionKey: item.definition.key }),
            pins,
            readOnly: false,
        }, identities);
    }

    const targetsByLogic = targetsByNode(resolution, 'logic');
    for (const item of resolution.logic) {
        const targets = targetsByLogic.get(item.nodeId) ?? [];
        addNode({
            id: item.nodeId,
            kind: item.logic.operation === 'constant' ? 'constant' : 'expression',
            label: item.logic.name,
            subtitle: item.logic.operation,
            pins: targets.map(target => graphPin(target, target.port)),
            readOnly: false,
        }, targets.map(target => target.identity));
    }

    for (const port of outputPorts) {
        const node = topPortNode(port);
        const identities = node.pins.map(pin => pin.id);
        addNode(node, identities);
    }
    for (const state of topOtherInterfaces) {
        const node = topInterfaceNode(state);
        addNode(node, state.collapsed
            ? [state.endpoint.identity]
            : state.endpoint.members.map(member => member.targetIdentity));
    }

    const networks: SchematicNetwork[] = [];
    for (const connection of resolution.connections) {
        const endpoints: NetworkEndpoint[] = [];
        for (const item of connection.endpoints) {
            const location = locations.get(item.identity);
            if (location) endpoints.push(endpoint(location, item.role));
        }
        networks.push({
            id: connection.networkId,
            name: connection.connection.name,
            width: selectNetworkWidth(connection.endpoints.map(item => item.width)),
            endpoints,
        });
    }

    for (const connection of resolution.interfaces.connections) {
        const collapsed = connection.master !== undefined
            && connection.slave !== undefined
            && interfaceStateByIdentity.get(connection.master.identity)?.collapsed === true
            && interfaceStateByIdentity.get(connection.slave.identity)?.collapsed === true;
        const protocolEndpoint = connection.master ?? connection.slave;
        if (collapsed && connection.master && connection.slave && protocolEndpoint) {
            const master = locations.get(connection.master.identity);
            const slave = locations.get(connection.slave.identity);
            if (!master || !slave) continue;
            networks.push({
                id: `network:interface:${connection.connection.name}`,
                name: connection.connection.name,
                width: { kind: 'unknown' },
                endpoints: [endpoint(master, 'driver'), endpoint(slave, 'load')],
                renderWidth: 4,
                interface: {
                    id: `interface-connection:${connection.connection.name}`,
                    connection: connection.connection.name,
                    protocol: protocolEndpoint.protocol,
                    protocolName: protocolEndpoint.protocolName,
                    collapsed: true,
                },
            });
            continue;
        }
        if (!protocolEndpoint) continue;
        const members = [
            ...connection.bindings.map(item => ({
                member: item.member,
                width: item.sender.width,
                endpoints: [
                    [item.sender.targetIdentity, 'driver' as const],
                    [item.receiver.targetIdentity, 'load' as const],
                ] as const,
                order: Math.min(item.sender.declarationOrder, item.receiver.declarationOrder),
            })),
            ...connection.defaults.map(item => ({
                member: item.member,
                width: item.receiver.width,
                endpoints: [
                    [item.receiver.targetIdentity, 'load' as const],
                ] as const,
                order: item.receiver.declarationOrder,
            })),
        ].sort((left, right) => left.order - right.order
            || compareCodeUnits(left.member, right.member));
        for (const member of members) {
            const endpoints = member.endpoints.flatMap(([identity, role]) => {
                const location = locations.get(identity);
                return location ? [endpoint(location, role)] : [];
            });
            networks.push({
                id: `network:interface:${connection.connection.name}:${member.member}`,
                name: `${connection.connection.name}.${member.member}`,
                width: cloneWidth(member.width),
                endpoints,
                interface: {
                    id: `interface-connection:${connection.connection.name}`,
                    connection: connection.connection.name,
                    protocol: protocolEndpoint.protocol,
                    protocolName: protocolEndpoint.protocolName,
                    collapsed: false,
                    member: member.member,
                },
            });
        }
    }

    const graph: SchematicGraph = {
        fileUri: options.fileUri,
        moduleKey: `arch-design:${resolution.moduleName}`,
        moduleName: resolution.moduleName,
        nodes,
        networks,
        diagnostics: [
            ...resolution.diagnostics.map(item => ({
                severity: 'error' as const,
                code: item.code,
                message: `${item.path}: ${item.message}`,
            })),
            ...resolution.warnings.map(item => ({
                severity: 'warning' as const,
                code: item.code,
                message: `${item.path}: ${item.message}`,
            })),
        ],
    };
    return Object.freeze({ graph, validation });
}
