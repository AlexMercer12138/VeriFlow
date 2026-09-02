import type {
    ArchDesign,
    ArchDesignConnection,
    ArchDesignEndpoint,
    ArchDesignInstance,
    ArchDesignInterfaceConnection,
    ArchDesignInterfaceEndpoint,
    ArchDesignInterfaceOverride,
    ArchDesignInterfacePort,
    ArchDesignNodePlacement,
    ArchDesignPort,
    ArchDesignPresentation,
    ArchDesignWidth,
} from './model';
import { createEmptyArchDesign } from './model';
import { compareCodeUnits } from './ordering';

function sortedRecord<T>(
    value: Readonly<Record<string, T>>,
    transform: (item: T) => unknown = item => item
): Record<string, unknown> {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort(compareCodeUnits)) {
        result[key] = transform(value[key]);
    }
    return result;
}

function widthValue(width: ArchDesignWidth): unknown {
    return typeof width === 'number' ? width : { expression: width.expression };
}

function portValue(port: ArchDesignPort): unknown {
    return {
        name: port.name,
        direction: port.direction,
        ...(port.width !== undefined ? { width: widthValue(port.width) } : {}),
    };
}

function instanceValue(instance: ArchDesignInstance): unknown {
    return {
        name: instance.name,
        module: instance.module,
        ...(instance.definitionKey !== undefined
            ? { definitionKey: instance.definitionKey }
            : {}),
        ...(instance.parameters
            ? { parameters: sortedRecord(instance.parameters) }
            : {}),
    };
}

function endpointValue(endpoint: ArchDesignEndpoint): unknown {
    if (endpoint.kind === 'port') {
        return {
            kind: endpoint.kind,
            port: endpoint.port,
            ...(endpoint.signal ? { signal: endpoint.signal } : {}),
        };
    }
    return {
        kind: endpoint.kind,
        instance: endpoint.instance,
        port: endpoint.port,
    };
}

function connectionValue(connection: ArchDesignConnection): unknown {
    return {
        name: connection.name,
        endpoints: connection.endpoints.map(endpointValue),
        ...(connection.defaults ? { defaults: sortedRecord(connection.defaults) } : {}),
    };
}

function interfaceEndpointValue(endpoint: ArchDesignInterfaceEndpoint): unknown {
    if (endpoint.kind === 'port') {
        return { kind: endpoint.kind, port: endpoint.port };
    }
    return {
        kind: endpoint.kind,
        instance: endpoint.instance,
        interface: endpoint.interface,
    };
}

function interfacePortValue(port: ArchDesignInterfacePort): unknown {
    return {
        name: port.name,
        protocol: port.protocol,
        role: port.role,
        memberPrefix: port.memberPrefix,
        members: port.members.map(member => ({
            member: member.member,
            width: widthValue(member.width),
        })),
    };
}

function interfaceOverrideValue(value: ArchDesignInterfaceOverride): unknown {
    return {
        ...(value.protocol ? { protocol: value.protocol } : {}),
        ...(value.role ? { role: value.role } : {}),
    };
}

function interfaceConnectionValue(connection: ArchDesignInterfaceConnection): unknown {
    return {
        name: connection.name,
        master: interfaceEndpointValue(connection.master),
        slave: interfaceEndpointValue(connection.slave),
        ...(connection.defaults ? { defaults: sortedRecord(connection.defaults) } : {}),
    };
}

function placementValue(placement: ArchDesignNodePlacement): unknown {
    return {
        column: placement.column,
        order: placement.order,
        ...(placement.offset !== undefined ? { offset: placement.offset } : {}),
        ...(placement.userPositioned !== undefined
            ? { userPositioned: placement.userPositioned }
            : {}),
    };
}

function presentationValue(presentation: ArchDesignPresentation): unknown {
    return {
        ...(presentation.nodes
            ? { nodes: sortedRecord(presentation.nodes, placementValue) }
            : {}),
        ...(presentation.collapsedInterfaces
            ? { collapsedInterfaces: sortedRecord(presentation.collapsedInterfaces) }
            : {}),
    };
}

function serializableArchDesign(design: ArchDesign): unknown {
    return {
        format: design.format,
        schemaVersion: design.schemaVersion,
        module: design.module,
        ports: design.ports.map(portValue),
        instances: design.instances.map(instanceValue),
        connections: design.connections.map(connectionValue),
        interfacePorts: design.interfacePorts.map(interfacePortValue),
        interfaceOverrides: sortedRecord(design.interfaceOverrides, interfaceOverrideValue),
        interfaceConnections: design.interfaceConnections.map(interfaceConnectionValue),
        defaults: sortedRecord(design.defaults),
        export: {
            ...(design.export.language ? { language: design.export.language } : {}),
            ...(design.export.output ? { output: design.export.output } : {}),
        },
        presentation: presentationValue(design.presentation),
    };
}

export function serializeArchDesign(design: ArchDesign): string {
    return `${JSON.stringify(serializableArchDesign(design), null, 2)}\n`;
}

export function createEmptyArchDesignText(module: string): string {
    return serializeArchDesign(createEmptyArchDesign(module));
}
