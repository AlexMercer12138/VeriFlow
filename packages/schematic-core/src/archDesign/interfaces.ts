import type { WidthValue } from '@veriflow/hdl-core/model';

import {
    findInterfaceProtocol,
    recognizeModuleInterfaces,
    type InterfaceMemberDirection,
    type InterfaceProtocol,
    type InterfaceProtocolCatalog,
    type RecognizedInterface,
} from '../interfaces';
import type {
    ArchDesignInterfaceConnection,
    ArchDesignInterfaceEndpoint,
    ArchDesignInterfaceOverride,
    ArchDesignInterfacePort,
    ArchDesignInterfaceRole,
} from './model';
import { compareCodeUnits } from './ordering';
import type { ArchDesignDiagnostic } from './parser';
import type {
    ResolvedArchDesignConnection,
    ResolvedArchDesignEndpointTarget,
    ResolvedArchDesignInstance,
} from './resolution';

export type ResolvedArchDesignInterfaceRoleSource =
    | 'inferred'
    | 'override'
    | 'declared'
    | 'unknown';

export type ResolvedArchDesignInterfaceMember = Readonly<{
    member: string;
    direction: InterfaceMemberDirection;
    port: string;
    portDirection: 'input' | 'output' | 'inout';
    width: WidthValue;
    declarationOrder: number;
    targetIdentity: string;
}>;

export type ResolvedArchDesignInterfaceEndpoint = Readonly<{
    identity: string;
    endpoint: ArchDesignInterfaceEndpoint;
    protocol: string;
    protocolName: string;
    role: ArchDesignInterfaceRole | 'unknown';
    roleSource: ResolvedArchDesignInterfaceRoleSource;
    effectiveRole: ArchDesignInterfaceRole | 'unknown';
    members: readonly ResolvedArchDesignInterfaceMember[];
    declarationPath: string;
}>;

export type ResolvedArchDesignInterfaceBinding = Readonly<{
    member: string;
    direction: InterfaceMemberDirection;
    sender: ResolvedArchDesignInterfaceMember;
    receiver: ResolvedArchDesignInterfaceMember;
}>;

export type ResolvedArchDesignInterfaceOpenMember = Readonly<{
    member: string;
    direction: InterfaceMemberDirection;
    sender: ResolvedArchDesignInterfaceMember;
}>;

export type ResolvedArchDesignInterfaceDefault = Readonly<{
    member: string;
    direction: InterfaceMemberDirection;
    receiver: ResolvedArchDesignInterfaceMember;
    expression: string;
    origin: 'connection' | 'protocol';
    sourcePath: string;
    protocolExpression?: string;
}>;

export type ResolvedArchDesignInterfaceConnection = Readonly<{
    index: number;
    connection: ArchDesignInterfaceConnection;
    master?: ResolvedArchDesignInterfaceEndpoint;
    slave?: ResolvedArchDesignInterfaceEndpoint;
    bindings: readonly ResolvedArchDesignInterfaceBinding[];
    openMembers: readonly ResolvedArchDesignInterfaceOpenMember[];
    defaults: readonly ResolvedArchDesignInterfaceDefault[];
}>;

export type ResolvedArchDesignInterfaceOccupancy = Readonly<{
    connection: string;
    endpoint: string;
    member: string;
    port: string;
    targetIdentity: string;
}>;

export type ArchDesignInterfacesResolution = Readonly<{
    endpoints: readonly ResolvedArchDesignInterfaceEndpoint[];
    connections: readonly ResolvedArchDesignInterfaceConnection[];
    occupancy: readonly ResolvedArchDesignInterfaceOccupancy[];
    diagnostics: readonly ArchDesignDiagnostic[];
    warnings: readonly ArchDesignDiagnostic[];
}>;

export type ArchDesignInterfacesInput = Readonly<{
    interfacePorts: readonly ArchDesignInterfacePort[];
    interfaceOverrides: Readonly<Record<string, ArchDesignInterfaceOverride>>;
    interfaceConnections: readonly ArchDesignInterfaceConnection[];
    instances: readonly ResolvedArchDesignInstance[];
    endpointTargets: readonly ResolvedArchDesignEndpointTarget[];
    scalarConnections: readonly ResolvedArchDesignConnection[];
    catalog: InterfaceProtocolCatalog;
}>;

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
    if (value === null || typeof value !== 'object' || visited.has(value)) return value;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
        deepFreeze((value as Record<PropertyKey, unknown>)[key], visited);
    }
    return Object.freeze(value);
}

function diagnostic(path: string, code: string, message: string): ArchDesignDiagnostic {
    return { path, code, message };
}

function cloneWidth(width: WidthValue): WidthValue {
    if (width.kind === 'known') return { kind: 'known', bits: width.bits };
    if (width.kind === 'symbolic') return { kind: 'symbolic', expression: width.expression };
    return { kind: 'unknown' };
}

function archWidth(width: ArchDesignInterfacePort['members'][number]['width']): WidthValue {
    return typeof width === 'number'
        ? { kind: 'known', bits: width }
        : { kind: 'symbolic', expression: width.expression };
}

function opposite(role: ArchDesignInterfaceRole | 'unknown'): ArchDesignInterfaceRole | 'unknown' {
    return role === 'master' ? 'slave' : role === 'slave' ? 'master' : 'unknown';
}

function expectedPortDirection(
    role: ArchDesignInterfaceRole,
    direction: InterfaceMemberDirection
): 'input' | 'output' {
    const sends = role === 'master'
        ? direction === 'master-to-slave'
        : direction === 'slave-to-master';
    return sends ? 'output' : 'input';
}

function interfaceIdentity(endpoint: ArchDesignInterfaceEndpoint): string {
    return endpoint.kind === 'port'
        ? `interface:port:${endpoint.port}`
        : `interface:instance:${endpoint.instance}:${endpoint.interface}`;
}

function targetIdentity(instanceNodeId: string, port: string): string {
    return `${instanceNodeId}:${port}`;
}

function recognizedEndpoint(
    instance: ResolvedArchDesignInstance,
    item: RecognizedInterface,
    override: ArchDesignInterfaceOverride | undefined
): ResolvedArchDesignInterfaceEndpoint {
    const endpoint = {
        kind: 'instance' as const,
        instance: instance.instance.name,
        interface: item.key,
    };
    const role = override?.role ?? item.role;
    const roleSource: ResolvedArchDesignInterfaceRoleSource = override?.role
        ? 'override'
        : item.roleSource;
    return {
        identity: interfaceIdentity(endpoint),
        endpoint,
        protocol: item.protocol,
        protocolName: item.protocolName,
        role,
        roleSource,
        effectiveRole: role,
        members: item.members.map(member => ({
            member: member.member,
            direction: member.direction,
            port: member.port,
            portDirection: member.portDirection,
            width: cloneWidth(member.width),
            declarationOrder: member.declarationOrder,
            targetIdentity: targetIdentity(instance.nodeId, member.port),
        })),
        declarationPath: `$.instances[${instance.index}]`,
    };
}

function selectedRecognition(
    instance: ResolvedArchDesignInstance,
    interfaceName: string,
    protocolId: string | undefined,
    catalog: InterfaceProtocolCatalog
): RecognizedInterface | undefined {
    if (!instance.definition) return undefined;
    const selectedCatalog = protocolId === undefined
        ? catalog
        : {
            entries: catalog.entries.filter(entry => entry.protocol.id === protocolId),
            diagnostics: [],
        };
    const result = recognizeModuleInterfaces(instance.definition.ports, selectedCatalog);
    return result.interfaces.find(item => item.key === interfaceName);
}

function instanceEndpoints(
    input: ArchDesignInterfacesInput,
    diagnostics: ArchDesignDiagnostic[]
): ResolvedArchDesignInterfaceEndpoint[] {
    const endpoints: ResolvedArchDesignInterfaceEndpoint[] = [];
    const consumedOverrides = new Set<string>();
    for (const instance of input.instances) {
        if (!instance.definition) continue;
        const recognized = recognizeModuleInterfaces(instance.definition.ports, input.catalog);
        for (const item of recognized.diagnostics) {
            diagnostics.push(diagnostic(
                `$.instances[${instance.index}]`,
                item.code === 'IF_RECOGNITION_AMBIGUOUS'
                    ? 'AD_INTERFACE_RECOGNITION_AMBIGUOUS'
                    : 'AD_INTERFACE_RECOGNITION',
                `${item.message}: ${item.protocols.join(', ')}`
            ));
        }
        for (const item of recognized.interfaces) {
            const key = `${instance.instance.name}.${item.key}`;
            const override = input.interfaceOverrides[key];
            if (override?.protocol && override.protocol !== item.protocol) continue;
            if (override) consumedOverrides.add(key);
            endpoints.push(recognizedEndpoint(instance, item, override));
        }
        const prefix = `${instance.instance.name}.`;
        for (const key of Object.keys(input.interfaceOverrides).sort(compareCodeUnits)) {
            if (!key.startsWith(prefix) || consumedOverrides.has(key)) continue;
            const interfaceName = key.slice(prefix.length);
            const override = input.interfaceOverrides[key];
            const item = selectedRecognition(
                instance,
                interfaceName,
                override.protocol,
                input.catalog
            );
            if (!item) continue;
            consumedOverrides.add(key);
            endpoints.push(recognizedEndpoint(instance, item, override));
        }
    }
    for (const key of Object.keys(input.interfaceOverrides).sort(compareCodeUnits)) {
        if (consumedOverrides.has(key)) continue;
        diagnostics.push(diagnostic(
            `$.interfaceOverrides.${key}`,
            'AD_INTERFACE_OVERRIDE_UNKNOWN',
            `Interface override ${key} does not identify a recognized interface`
        ));
    }
    return endpoints;
}

function topEndpoints(
    input: ArchDesignInterfacesInput,
    diagnostics: ArchDesignDiagnostic[]
): ResolvedArchDesignInterfaceEndpoint[] {
    const endpoints: ResolvedArchDesignInterfaceEndpoint[] = [];
    for (let index = 0; index < input.interfacePorts.length; index += 1) {
        const port = input.interfacePorts[index];
        const path = `$.interfacePorts[${index}]`;
        const entry = findInterfaceProtocol(input.catalog, port.protocol);
        if (!entry) {
            diagnostics.push(diagnostic(
                `${path}.protocol`,
                'AD_INTERFACE_PROTOCOL_UNKNOWN',
                `No interface protocol is named ${port.protocol}`
            ));
            continue;
        }
        const protocolMembers = new Map(entry.protocol.members.map(member => [
            member.name.toLowerCase(),
            member,
        ]));
        const members: ResolvedArchDesignInterfaceMember[] = [];
        for (let memberIndex = 0; memberIndex < port.members.length; memberIndex += 1) {
            const snapshot = port.members[memberIndex];
            const member = protocolMembers.get(snapshot.member.toLowerCase());
            if (!member) {
                diagnostics.push(diagnostic(
                    `${path}.members[${memberIndex}].member`,
                    'AD_INTERFACE_MEMBER_UNKNOWN',
                    `Protocol ${port.protocol} has no member named ${snapshot.member}`
                ));
                continue;
            }
            const publicName = `${port.memberPrefix}${entry.protocol.separator}${member.name}`;
            members.push({
                member: member.name,
                direction: member.direction,
                port: publicName,
                portDirection: expectedPortDirection(port.role, member.direction),
                width: archWidth(snapshot.width),
                declarationOrder: memberIndex,
                targetIdentity: `interface:port:${port.name}:${member.name}`,
            });
        }
        const endpoint = { kind: 'port' as const, port: port.name };
        endpoints.push({
            identity: interfaceIdentity(endpoint),
            endpoint,
            protocol: entry.protocol.id,
            protocolName: entry.protocol.name,
            role: port.role,
            roleSource: 'declared',
            effectiveRole: opposite(port.role),
            members,
            declarationPath: path,
        });
    }
    return endpoints;
}

function memberMap(
    endpoint: ResolvedArchDesignInterfaceEndpoint
): ReadonlyMap<string, ResolvedArchDesignInterfaceMember> {
    return new Map(endpoint.members.map(member => [member.member.toLowerCase(), member]));
}

function checkInstanceDirections(
    endpoint: ResolvedArchDesignInterfaceEndpoint,
    path: string,
    diagnostics: ArchDesignDiagnostic[]
): void {
    if (endpoint.endpoint.kind !== 'instance' || endpoint.effectiveRole === 'unknown') return;
    for (const member of endpoint.members) {
        if (member.portDirection === 'inout') continue;
        const expected = expectedPortDirection(endpoint.effectiveRole, member.direction);
        if (member.portDirection === expected) continue;
        diagnostics.push(diagnostic(
            path,
            'AD_INTERFACE_DIRECTION',
            `Interface member ${member.port} is ${member.portDirection}, expected ${expected}`
        ));
    }
}

function addOccupancy(
    result: ResolvedArchDesignInterfaceOccupancy[],
    seen: Map<string, string>,
    connection: ArchDesignInterfaceConnection,
    endpoint: ResolvedArchDesignInterfaceEndpoint,
    member: ResolvedArchDesignInterfaceMember,
    path: string,
    scalarOccupied: ReadonlySet<string>,
    diagnostics: ArchDesignDiagnostic[]
): void {
    const previous = seen.get(member.targetIdentity);
    if (previous) {
        diagnostics.push(diagnostic(
            path,
            'AD_INTERFACE_MEMBER_OCCUPIED',
            `Interface member ${member.port} is already owned by ${previous}`
        ));
        return;
    }
    if (scalarOccupied.has(member.targetIdentity)) {
        diagnostics.push(diagnostic(
            path,
            'AD_INTERFACE_MEMBER_OCCUPIED',
            `Interface member ${member.port} is also used by a scalar connection`
        ));
    }
    seen.set(member.targetIdentity, connection.name);
    result.push({
        connection: connection.name,
        endpoint: endpoint.identity,
        member: member.member,
        port: member.port,
        targetIdentity: member.targetIdentity,
    });
}

function expandConnection(
    index: number,
    connection: ArchDesignInterfaceConnection,
    master: ResolvedArchDesignInterfaceEndpoint | undefined,
    slave: ResolvedArchDesignInterfaceEndpoint | undefined,
    protocol: InterfaceProtocol | undefined,
    occupancy: ResolvedArchDesignInterfaceOccupancy[],
    occupied: Map<string, string>,
    scalarOccupied: ReadonlySet<string>,
    diagnostics: ArchDesignDiagnostic[],
    warnings: ArchDesignDiagnostic[]
): ResolvedArchDesignInterfaceConnection {
    const bindings: ResolvedArchDesignInterfaceBinding[] = [];
    const openMembers: ResolvedArchDesignInterfaceOpenMember[] = [];
    const defaults: ResolvedArchDesignInterfaceDefault[] = [];
    if (!master || !slave || !protocol) {
        return { index, connection, master, slave, bindings, openMembers, defaults };
    }
    const masterMembers = memberMap(master);
    const slaveMembers = memberMap(slave);
    for (const protocolMember of protocol.members) {
        const masterMember = masterMembers.get(protocolMember.name.toLowerCase());
        const slaveMember = slaveMembers.get(protocolMember.name.toLowerCase());
        const sender = protocolMember.direction === 'master-to-slave'
            ? masterMember
            : slaveMember;
        const receiver = protocolMember.direction === 'master-to-slave'
            ? slaveMember
            : masterMember;
        if (masterMember) addOccupancy(
            occupancy, occupied, connection, master, masterMember,
            `$.interfaceConnections[${index}].master`, scalarOccupied, diagnostics
        );
        if (slaveMember) addOccupancy(
            occupancy, occupied, connection, slave, slaveMember,
            `$.interfaceConnections[${index}].slave`, scalarOccupied, diagnostics
        );
        if (sender && receiver) {
            bindings.push({
                member: protocolMember.name,
                direction: protocolMember.direction,
                sender,
                receiver,
            });
            if (sender.width.kind === 'known'
                && receiver.width.kind === 'known'
                && sender.width.bits !== receiver.width.bits) {
                warnings.push(diagnostic(
                    `$.interfaceConnections[${index}]`,
                    'AD_INTERFACE_WIDTH',
                    `Interface member ${protocolMember.name} connects ${sender.width.bits} bits to ${receiver.width.bits} bits`
                ));
            }
            continue;
        }
        if (sender) {
            openMembers.push({
                member: protocolMember.name,
                direction: protocolMember.direction,
                sender,
            });
            continue;
        }
        if (!receiver) continue;
        const connectionExpression = connection.defaults?.[protocolMember.name];
        const expression = connectionExpression ?? protocolMember.defaultExpression;
        if (expression === undefined) {
            diagnostics.push(diagnostic(
                `$.interfaceConnections[${index}]`,
                'AD_INTERFACE_DEFAULT_MISSING',
                `Receiver member ${receiver.port} has no sender or default`
            ));
            continue;
        }
        defaults.push({
            member: protocolMember.name,
            direction: protocolMember.direction,
            receiver,
            expression,
            origin: connectionExpression === undefined ? 'protocol' : 'connection',
            sourcePath: connectionExpression === undefined
                ? `protocol:${protocol.id}:${protocolMember.name}`
                : `$.interfaceConnections[${index}].defaults.${protocolMember.name}`,
            ...(protocolMember.defaultExpression === undefined
                ? {}
                : { protocolExpression: protocolMember.defaultExpression }),
        });
    }
    const protocolMemberNames = new Set(protocol.members.map(member => member.name));
    for (const key of Object.keys(connection.defaults ?? {}).sort(compareCodeUnits)) {
        if (protocolMemberNames.has(key)) continue;
        diagnostics.push(diagnostic(
            `$.interfaceConnections[${index}].defaults.${key}`,
            'AD_INTERFACE_DEFAULT_MEMBER',
            `Protocol ${protocol.id} has no member named ${key}`
        ));
    }
    return { index, connection, master, slave, bindings, openMembers, defaults };
}

export function resolveArchDesignInterfaces(
    input: ArchDesignInterfacesInput
): ArchDesignInterfacesResolution {
    const diagnostics: ArchDesignDiagnostic[] = [];
    const warnings: ArchDesignDiagnostic[] = [];
    const endpoints = [
        ...instanceEndpoints(input, diagnostics),
        ...topEndpoints(input, diagnostics),
    ];
    const byIdentity = new Map(endpoints.map(endpoint => [endpoint.identity, endpoint]));
    const scalarOccupied = new Set(input.scalarConnections.flatMap(connection =>
        connection.endpoints.map(endpoint => endpoint.identity)));
    const occupiedEndpoints = new Map<string, string>();
    const occupiedMembers = new Map<string, string>();
    const occupancy: ResolvedArchDesignInterfaceOccupancy[] = [];
    const connections: ResolvedArchDesignInterfaceConnection[] = [];

    for (let index = 0; index < input.interfaceConnections.length; index += 1) {
        const connection = input.interfaceConnections[index];
        const masterPath = `$.interfaceConnections[${index}].master`;
        const slavePath = `$.interfaceConnections[${index}].slave`;
        const master = byIdentity.get(interfaceIdentity(connection.master));
        const slave = byIdentity.get(interfaceIdentity(connection.slave));
        if (!master) diagnostics.push(diagnostic(
            masterPath,
            'AD_INTERFACE_ENDPOINT_UNKNOWN',
            'Master endpoint does not identify a resolved interface'
        ));
        if (!slave) diagnostics.push(diagnostic(
            slavePath,
            'AD_INTERFACE_ENDPOINT_UNKNOWN',
            'Slave endpoint does not identify a resolved interface'
        ));
        for (const [endpoint, path] of [[master, masterPath], [slave, slavePath]] as const) {
            if (!endpoint) continue;
            const previous = occupiedEndpoints.get(endpoint.identity);
            if (previous) {
                diagnostics.push(diagnostic(
                    path,
                    'AD_INTERFACE_ENDPOINT_DUPLICATE',
                    `Interface endpoint is already connected by ${previous}`
                ));
            } else {
                occupiedEndpoints.set(endpoint.identity, connection.name);
            }
        }
        if (master && master.effectiveRole !== 'master') diagnostics.push(diagnostic(
            masterPath,
            'AD_INTERFACE_ROLE',
            'Master endpoint must have effective Master role'
        ));
        if (slave && slave.effectiveRole !== 'slave') diagnostics.push(diagnostic(
            slavePath,
            'AD_INTERFACE_ROLE',
            'Slave endpoint must have effective Slave role'
        ));
        if (master) checkInstanceDirections(master, masterPath, diagnostics);
        if (slave) checkInstanceDirections(slave, slavePath, diagnostics);
        let protocol: InterfaceProtocol | undefined;
        if (master && slave && master.protocol !== slave.protocol) {
            diagnostics.push(diagnostic(
                `$.interfaceConnections[${index}]`,
                'AD_INTERFACE_PROTOCOL',
                `Interface protocols ${master.protocol} and ${slave.protocol} do not match`
            ));
        } else {
            protocol = master
                ? findInterfaceProtocol(input.catalog, master.protocol)?.protocol
                : slave
                    ? findInterfaceProtocol(input.catalog, slave.protocol)?.protocol
                    : undefined;
        }
        connections.push(expandConnection(
            index,
            connection,
            master,
            slave,
            protocol,
            occupancy,
            occupiedMembers,
            scalarOccupied,
            diagnostics,
            warnings
        ));
    }

    diagnostics.sort((left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    warnings.sort((left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    return deepFreeze({ endpoints, connections, occupancy, diagnostics, warnings });
}
