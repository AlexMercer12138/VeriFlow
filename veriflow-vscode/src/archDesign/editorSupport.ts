import type { SchematicGraph } from '@veriflow/schematic-core';
import {
    isArchDesignInterfaceCollapsed,
    projectArchDesignPlacement,
    resolveArchDesign,
    type ArchDesign,
    type ArchDesignDiagnostic,
    type ArchDesignInterfaceEndpoint,
    type ArchDesignInterfaceSnapshot,
    type ArchDesignModuleDefinition,
    type ArchDesignNodePlacement,
    type ArchDesignPresentation,
} from '@veriflow/schematic-core/arch-design';
import type { InterfaceProtocolCatalog } from '@veriflow/schematic-core/interfaces';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import type { SchematicLayout } from '../schematic/layoutStore';

export { archDesignEndpointForPin } from '../schematic/webviewSupport';

export function archDesignGraphsEqual(
    left: SchematicGraph,
    right: SchematicGraph
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export type ArchDesignInspectorProtocol = Readonly<{
    id: string;
    name: string;
    source: string;
}>;

export type ArchDesignInspectorInterfaceMember = Readonly<{
    member: string;
    port: string;
    direction: 'master-to-slave' | 'slave-to-master';
    portDirection: 'input' | 'output' | 'inout';
    width: ArchDesignModuleDefinition['ports'][number]['width'];
    occupancy?: string;
}>;

export type ArchDesignInspectorInterfaceDefault = Readonly<{
    member: string;
    expression: string;
    origin: 'connection' | 'protocol';
    source: string;
    protocolExpression?: string;
}>;

export type ArchDesignInspectorInterface = Readonly<{
    identity: string;
    endpoint: ArchDesignInterfaceEndpoint;
    protocol: string;
    protocolName: string;
    role: 'master' | 'slave' | 'unknown';
    roleSource: 'inferred' | 'override' | 'declared' | 'unknown';
    topLevel: boolean;
    collapsed: boolean;
    members: readonly ArchDesignInspectorInterfaceMember[];
    missingMembers: readonly string[];
    snapshot?: ArchDesignInterfaceSnapshot;
    connection?: Readonly<{
        name: string;
        peer: string;
        peerIdentity?: string;
        defaults: readonly ArchDesignInspectorInterfaceDefault[];
        diagnostics: readonly ArchDesignDiagnostic[];
        warnings: readonly ArchDesignDiagnostic[];
    }>;
}>;

export type ArchDesignInspectorData = Readonly<{
    protocols: readonly ArchDesignInspectorProtocol[];
    interfaces: readonly ArchDesignInspectorInterface[];
}>;

function interfaceEndpointLabel(endpoint: ArchDesignInterfaceEndpoint): string {
    return endpoint.kind === 'port'
        ? endpoint.port
        : `${endpoint.instance}.${endpoint.interface}`;
}

function snapshotWidth(
    width: ArchDesignModuleDefinition['ports'][number]['width']
): ArchDesignInterfaceSnapshot['members'][number]['width'] | undefined {
    if (width.kind === 'known') return width.bits;
    if (width.kind === 'symbolic') return { expression: width.expression };
    return undefined;
}

export function projectArchDesignInspectorData(
    design: ArchDesign,
    definitions: readonly ArchDesignModuleDefinition[],
    interfaceCatalog: InterfaceProtocolCatalog
): ArchDesignInspectorData {
    const resolution = resolveArchDesign(design, definitions, interfaceCatalog);
    const occupancy = new Map(resolution.interfaces.occupancy.map(item => [
        item.targetIdentity,
        item.connection,
    ]));
    const connectionsByEndpoint = new Map<string, {
        connection: typeof resolution.interfaces.connections[number];
        peer: typeof resolution.interfaces.endpoints[number] | undefined;
    }>();
    for (const connection of resolution.interfaces.connections) {
        if (connection.master) {
            connectionsByEndpoint.set(connection.master.identity, {
                connection,
                peer: connection.slave,
            });
        }
        if (connection.slave) {
            connectionsByEndpoint.set(connection.slave.identity, {
                connection,
                peer: connection.master,
            });
        }
    }
    const protocols = interfaceCatalog.entries.map(entry => ({
        id: entry.protocol.id,
        name: entry.protocol.name,
        source: entry.source.source,
    }));
    const protocolsById = new Map(interfaceCatalog.entries.map(entry => [
        entry.protocol.id,
        entry.protocol,
    ]));
    const interfaces = resolution.interfaces.endpoints.map(endpoint => {
        const protocol = protocolsById.get(endpoint.protocol);
        const presentMembers = new Set(endpoint.members.map(member => member.member.toLowerCase()));
        const related = connectionsByEndpoint.get(endpoint.identity);
        const snapshotMembers = endpoint.members.flatMap(member => {
            const width = snapshotWidth(member.width);
            return width === undefined ? [] : [{
                member: member.member,
                port: member.port,
                width,
            }];
        });
        const canSnapshot = endpoint.endpoint.kind === 'instance'
            && endpoint.role !== 'unknown'
            && snapshotMembers.length === endpoint.members.length;
        const path = related
            ? `$.interfaceConnections[${related.connection.index}]`
            : undefined;
        return {
            identity: endpoint.identity,
            endpoint: endpoint.endpoint,
            protocol: endpoint.protocol,
            protocolName: endpoint.protocolName,
            role: endpoint.role,
            roleSource: endpoint.roleSource,
            topLevel: endpoint.endpoint.kind === 'port',
            collapsed: isArchDesignInterfaceCollapsed(design, endpoint.identity),
            members: endpoint.members.map(member => ({
                member: member.member,
                port: member.port,
                direction: member.direction,
                portDirection: member.portDirection,
                width: cloneWidth(member.width),
                ...(occupancy.has(member.targetIdentity)
                    ? { occupancy: occupancy.get(member.targetIdentity)! }
                    : {}),
            })),
            missingMembers: protocol?.members
                .filter(member => !presentMembers.has(member.name.toLowerCase()))
                .map(member => member.name) ?? [],
            ...(canSnapshot ? {
                snapshot: {
                    endpoint: endpoint.endpoint as Extract<
                        ArchDesignInterfaceEndpoint,
                        { kind: 'instance' }
                    >,
                    protocol: endpoint.protocol,
                    role: endpoint.role as 'master' | 'slave',
                    members: snapshotMembers,
                },
            } : {}),
            ...(related ? {
                connection: {
                    name: related.connection.connection.name,
                    peer: related.peer
                        ? interfaceEndpointLabel(related.peer.endpoint)
                        : 'Unresolved',
                    ...(related.peer === undefined ? {} : { peerIdentity: related.peer.identity }),
                    defaults: related.connection.defaults.map(item => ({
                        member: item.member,
                        expression: item.expression,
                        origin: item.origin,
                        source: item.sourcePath,
                        ...(item.protocolExpression === undefined
                            ? {}
                            : { protocolExpression: item.protocolExpression }),
                    })),
                    diagnostics: path === undefined ? [] : resolution.diagnostics.filter(
                        item => item.path.startsWith(path)
                    ),
                    warnings: path === undefined ? [] : resolution.warnings.filter(
                        item => item.path.startsWith(path)
                    ),
                },
            } : {}),
        };
    });
    return Object.freeze({
        protocols: Object.freeze(protocols),
        interfaces: Object.freeze(interfaces),
    });
}

function cloneWidth(
    width: ArchDesignModuleDefinition['ports'][number]['width']
): ArchDesignModuleDefinition['ports'][number]['width'] {
    if (width.kind === 'known') return { kind: 'known', bits: width.bits };
    if (width.kind === 'symbolic') {
        return { kind: 'symbolic', expression: width.expression };
    }
    return { kind: 'unknown' };
}

export function toArchDesignModuleDefinitions(
    definitions: readonly HdlDefinitionSummary[]
): ArchDesignModuleDefinition[] {
    return definitions.filter(definition => definition.kind === 'module').map(definition => ({
        key: definition.key,
        name: definition.name,
        parameters: definition.parameters.map(parameter => ({
            name: parameter.name,
            ...(parameter.defaultExpression === undefined
                ? {}
                : { defaultExpression: parameter.defaultExpression }),
        })),
        ports: definition.ports.map(port => ({
            name: port.name,
            direction: port.direction,
            width: cloneWidth(port.width),
        })),
    }));
}

export function archDesignLayout(
    design: ArchDesign,
    graph: SchematicGraph
): SchematicLayout {
    return {
        placement: projectArchDesignPlacement(design, graph),
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    };
}

function persistedPlacement(
    layout: SchematicLayout,
    nodeId: string
): ArchDesignNodePlacement | undefined {
    const placement = layout.placement.nodes[nodeId];
    if (!placement) return undefined;
    return {
        column: placement.column,
        order: placement.order,
        ...(placement.yOffset === 0 ? {} : { offset: placement.yOffset }),
        ...(placement.fixed ? { userPositioned: true } : {}),
    };
}

export function archDesignPresentationFromLayout(
    design: ArchDesign,
    graph: SchematicGraph,
    layout: SchematicLayout
): ArchDesignPresentation {
    const nodes: Record<string, ArchDesignNodePlacement> = Object.create(null);
    for (const node of graph.nodes) {
        if (node.kind !== 'port'
            && node.kind !== 'instance'
            && node.kind !== 'constant'
            && node.kind !== 'expression') continue;
        const placement = persistedPlacement(layout, node.id);
        if (placement) {
            Object.defineProperty(nodes, node.id, {
                value: placement,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    const collapsedInterfaces = design.presentation.collapsedInterfaces
        ? Object.fromEntries(Object.entries(design.presentation.collapsedInterfaces))
        : undefined;
    return {
        ...(Object.keys(nodes).length === 0 ? {} : { nodes }),
        ...(collapsedInterfaces === undefined ? {} : { collapsedInterfaces }),
    };
}
