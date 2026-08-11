import type {
    ArchDesign,
    ArchDesignConnection,
    ArchDesignEndpoint,
    ArchDesignInstance,
    ArchDesignInterfaceConnection,
    ArchDesignInterfaceEndpoint,
    ArchDesignNodePlacement,
    ArchDesignPort,
    ArchDesignPresentation,
    ArchDesignWidth,
} from './model';
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
    return {
        instance: endpoint.instance,
        interface: endpoint.interface,
    };
}

function interfaceConnectionValue(connection: ArchDesignInterfaceConnection): unknown {
    return {
        name: connection.name,
        ...(connection.protocol ? { protocol: connection.protocol } : {}),
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
        ...(presentation.viewport
            ? {
                viewport: {
                    x: presentation.viewport.x,
                    y: presentation.viewport.y,
                    zoom: presentation.viewport.zoom,
                },
            }
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
