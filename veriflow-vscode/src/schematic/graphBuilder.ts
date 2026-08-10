import { pinKey } from '@veriflow/schematic-core';

import type {
    ExpressionModel,
    HdlDocument,
    HdlDiagnostic,
    InstanceConnectionModel,
    InstanceModel,
    ModuleModel,
    PortModel,
    SourceSpan,
    WidthValue,
} from '../core/hdl/model';
import type {
    HdlDefinitionSummary,
    IndexedPortSummary,
} from '../core/hdl/workspaceIndexTypes';
import type {
    GraphNode,
    GraphPin,
    NetworkEndpoint,
    PinDirection,
    SchematicGraph,
    SchematicNetwork,
} from './graphModel';

type DefinitionBinding = {
    key: string;
    ports: readonly IndexedPortSummary[];
};

export type InstanceDefinitionBinding = HdlDefinitionSummary | null;

type NamedNetwork = {
    width: WidthValue;
    sourceSpan: SourceSpan;
};

type ExpressionReference = {
    name: string;
    sourceSpan: SourceSpan;
};

const unknownWidth: WidthValue = { kind: 'unknown' };

function isForeign(span: SourceSpan | undefined, documentUri: string): boolean {
    return span !== undefined
        && (span.uri !== documentUri || span.compositeParts !== undefined);
}

function portRole(direction: PortModel['direction']): PinDirection {
    if (direction === 'input') {
        return 'driver';
    }
    if (direction === 'output') {
        return 'load';
    }
    return 'bidirectional';
}

function instancePinRole(direction: IndexedPortSummary['direction']): PinDirection {
    if (direction === 'input') {
        return 'load';
    }
    if (direction === 'output') {
        return 'driver';
    }
    return 'bidirectional';
}

function localDefinition(document: HdlDocument, name: string): DefinitionBinding | undefined {
    const matches = document.modules.filter(candidate => candidate.name === name);
    if (matches.length !== 1) {
        return undefined;
    }
    const module = matches[0];
    const ownerUri = module.nameSpan.uri ?? document.uri;
    return {
        key: `module:${ownerUri}:${module.declarationSpan.start}`,
        ports: module.ports,
    };
}

function boundDefinition(
    document: HdlDocument,
    instance: InstanceModel,
    definitions: ReadonlyMap<string, InstanceDefinitionBinding>
): DefinitionBinding | undefined {
    const explicit = definitions.get(instance.id);
    if (explicit?.kind === 'module' && explicit.name === instance.moduleName) {
        return explicit;
    }
    if (definitions.has(instance.id)) {
        return undefined;
    }
    return localDefinition(document, instance.moduleName);
}

function namedNetworks(module: ModuleModel): Map<string, NamedNetwork> {
    const networks = new Map<string, NamedNetwork>();
    for (const port of module.ports) {
        networks.set(port.name, {
            width: port.width,
            sourceSpan: port.nameSpan,
        });
    }
    for (const declaration of module.nets) {
        for (const item of declaration.names) {
            if (!networks.has(item.name)) {
                networks.set(item.name, {
                    width: declaration.width,
                    sourceSpan: item.nameSpan,
                });
            }
        }
    }
    return networks;
}

function foreignPortControlSpan(
    port: PortModel,
    module: ModuleModel,
    documentUri: string
): SourceSpan | undefined {
    const group = module.portDeclarationGroups.find(candidate =>
        candidate.id === port.declarationGroupId
    );
    const inheritsSharedPrefix = port.inheritsDirection
        || port.inheritsType
        || port.inheritsPackedRange;
    const controllingSpans = [
        port.nameSpan,
        ...(inheritsSharedPrefix && group ? [group.sharedPrefixSpan] : []),
        port.directionSpan,
        port.packedRangeSpan,
        port.headerItemSpan,
        port.bodyDeclarationSpan,
    ].filter((span): span is SourceSpan => span !== undefined);
    return controllingSpans.find(span => isForeign(span, documentUri));
}

function portNode(port: PortModel, module: ModuleModel, documentUri: string): GraphNode {
    const role = portRole(port.direction);
    const readOnly = foreignPortControlSpan(port, module, documentUri) !== undefined;
    const id = `port:${port.name}`;
    return {
        id,
        kind: 'port',
        label: port.name,
        pins: [{
            id: `${id}:${port.name}`,
            name: port.name,
            direction: role,
            width: port.width,
            readOnly,
            sourceSpan: port.nameSpan,
        }],
        readOnly,
        sourceSpan: port.nameSpan,
    };
}

function instanceNode(
    instance: InstanceModel,
    definition: DefinitionBinding | undefined,
    documentUri: string
): GraphNode {
    const id = `instance:${instance.instanceName}`;
    const readOnly = isForeign(instance.nameSpan, documentUri);
    const ports = definition?.ports ?? [];
    const pins = ports.map(port => {
        const role = instancePinRole(port.direction);
        const connection = connectionForPort(instance, port.name, ports);
        const wildcard = instance.portConnections.find(candidate =>
            candidate.syntax === 'wildcard'
        );
        const sourceSpan = connection?.expressionSpan
            ?? wildcard?.connectionSpan;
        const pinReadOnly = readOnly || isForeign(sourceSpan, documentUri);
        return {
            id: `${id}:${port.name}`,
            name: port.name,
            direction: role,
            width: port.width,
            readOnly: pinReadOnly,
            sourceSpan,
        };
    });
    return {
        id,
        kind: 'instance',
        label: instance.instanceName,
        subtitle: instance.moduleName,
        definitionKey: definition?.key,
        pins,
        readOnly,
        sourceSpan: instance.nameSpan,
    };
}

function connectionForPort(
    instance: InstanceModel,
    portName: string,
    ports: readonly IndexedPortSummary[]
): InstanceConnectionModel | undefined {
    const named = instance.portConnections.find(connection => connection.name === portName);
    if (named) {
        return named;
    }
    const index = ports.findIndex(port => port.name === portName);
    const positional = index >= 0 ? instance.portConnections[index] : undefined;
    return positional?.syntax === 'positional' ? positional : undefined;
}

function expressionModel(connection: InstanceConnectionModel): ExpressionModel {
    return connection.expressionModel ?? {
        kind: 'unknown',
        text: connection.expression,
        span: connection.expressionSpan,
        width: unknownWidth,
    };
}

function expressionReferences(
    module: ModuleModel,
    span: SourceSpan,
    scopeNetworks: ReadonlyMap<string, NamedNetwork>
): ExpressionReference[] {
    const symbols = new Map(module.symbols.map(symbol => [symbol.id, symbol]));
    const seen = new Set<string>();
    const references: ExpressionReference[] = [];
    for (const reference of module.references) {
        if (reference.span.start < span.start
            || reference.span.end > span.end
            || reference.span.uri !== span.uri
            || reference.symbolId === undefined) {
            continue;
        }
        const name = symbols.get(reference.symbolId)?.name;
        if (!name || seen.has(name) || !scopeNetworks.has(name)) {
            continue;
        }
        seen.add(name);
        references.push({ name, sourceSpan: reference.span });
    }
    return references;
}

function sourceNode(
    id: string,
    kind: 'constant' | 'expression',
    expression: ExpressionModel,
    references: readonly ExpressionReference[],
    scopeNetworks: ReadonlyMap<string, NamedNetwork>,
    documentUri: string
): GraphNode {
    const readOnly = isForeign(expression.span, documentUri);
    const inputPins: GraphPin[] = references.map(reference => ({
        id: `${id}:${reference.name}`,
        name: reference.name,
        direction: 'load',
        width: scopeNetworks.get(reference.name)?.width ?? unknownWidth,
        readOnly: readOnly || isForeign(reference.sourceSpan, documentUri),
        sourceSpan: reference.sourceSpan,
    }));
    return {
        id,
        kind,
        label: expression.text,
        pins: [...inputPins, {
            id: `${id}:value`,
            name: 'value',
            direction: 'driver',
            width: expression.width,
            readOnly,
            sourceSpan: expression.span,
        }],
        readOnly,
        sourceSpan: expression.span,
    };
}

function targetBoundaryNode(
    id: string,
    kind: 'expression' | 'opaque',
    expression: ExpressionModel,
    references: readonly ExpressionReference[],
    scopeNetworks: ReadonlyMap<string, NamedNetwork>,
    role: 'driver' | 'bidirectional',
    documentUri: string
): GraphNode {
    const readOnly = isForeign(expression.span, documentUri);
    const valueRole = role === 'driver' ? 'load' : 'bidirectional';
    const referenceRole = kind === 'opaque' ? 'bidirectional' : role;
    const targetPins: GraphPin[] = references.map(reference => ({
        id: `${id}:${reference.name}`,
        name: reference.name,
        direction: referenceRole,
        width: scopeNetworks.get(reference.name)?.width ?? unknownWidth,
        readOnly: readOnly || isForeign(reference.sourceSpan, documentUri),
        sourceSpan: reference.sourceSpan,
    }));
    return {
        id,
        kind,
        label: expression.text,
        subtitle: kind === 'opaque' ? 'structural boundary' : undefined,
        pins: [{
            id: `${id}:value`,
            name: 'value',
            direction: valueRole,
            width: expression.width,
            readOnly,
            sourceSpan: expression.span,
        }, ...targetPins],
        readOnly,
        sourceSpan: expression.span,
    };
}

function addEndpoint(
    network: SchematicNetwork,
    node: GraphNode,
    pin: GraphPin
): void {
    network.endpoints.push({ nodeId: node.id, pinId: pin.id, role: pin.direction });
}

function foreignDiagnostic(node: GraphNode, span: SourceSpan | undefined): HdlDiagnostic {
    return {
        severity: 'info',
        code: 'HDL_FOREIGN_SOURCE_READ_ONLY',
        message: `${node.label} originates from an included source and is read-only here.`,
        span,
    };
}

function foreignPinDiagnostic(node: GraphNode, pin: GraphPin): HdlDiagnostic {
    return {
        severity: 'info',
        code: 'HDL_FOREIGN_SOURCE_READ_ONLY',
        message: `${node.label}.${pin.name} originates from an included source and is read-only here.`,
        span: pin.sourceSpan,
    };
}

function sourceOrder(
    span: SourceSpan | undefined,
    module: ModuleModel
): readonly [number, number, string] {
    if (!span) {
        return [Number.MAX_SAFE_INTEGER, 0, ''];
    }
    const navigationSpan = span.compositeParts?.[0] ?? span;
    const parts = module.declarationSpan.compositeParts;
    if (!parts) {
        return [0, navigationSpan.start, navigationSpan.uri ?? ''];
    }
    const partIndex = parts.findIndex(part =>
        part.uri === navigationSpan.uri
        && navigationSpan.start >= part.start
        && navigationSpan.end <= part.end
    );
    if (partIndex >= 0) {
        return [partIndex, navigationSpan.start - parts[partIndex].start, ''];
    }
    return [Number.MAX_SAFE_INTEGER, navigationSpan.start, navigationSpan.uri ?? ''];
}

function compareSourceOrder(left: GraphNode, right: GraphNode, module: ModuleModel): number {
    const leftOrder = sourceOrder(left.sourceSpan, module);
    const rightOrder = sourceOrder(right.sourceSpan, module);
    return leftOrder[0] - rightOrder[0]
        || leftOrder[1] - rightOrder[1]
        || leftOrder[2].localeCompare(rightOrder[2])
        || left.id.localeCompare(right.id);
}

export function buildSchematicGraph(
    document: HdlDocument,
    module: ModuleModel,
    definitions: ReadonlyMap<string, InstanceDefinitionBinding>
): SchematicGraph {
    const scopeNetworks = namedNetworks(module);
    const networks = new Map<string, SchematicNetwork>();
    const structuralNodes: GraphNode[] = [];
    const structuralDiagnostics: HdlDiagnostic[] = [];
    const inputNodes = module.ports
        .filter(port => port.direction === 'input')
        .map(port => portNode(port, module, document.uri));
    const inoutNodes = module.ports
        .filter(port => port.direction === 'inout')
        .map(port => portNode(port, module, document.uri));
    const outputNodes = module.ports
        .filter(port => port.direction === 'output')
        .map(port => portNode(port, module, document.uri));

    const getNamedNetwork = (name: string): SchematicNetwork | undefined => {
        const model = scopeNetworks.get(name);
        if (!model) {
            return undefined;
        }
        let network = networks.get(name);
        if (!network) {
            network = {
                id: `network:${name}`,
                name,
                width: model.width,
                endpoints: [],
                sourceSpan: model.sourceSpan,
            };
            networks.set(name, network);
        }
        return network;
    };

    for (const node of [...inputNodes, ...inoutNodes, ...outputNodes]) {
        addEndpoint(getNamedNetwork(node.label)!, node, node.pins[0]);
    }

    for (const instance of module.instances) {
        const definition = boundDefinition(document, instance, definitions);
        const node = instanceNode(instance, definition, document.uri);
        structuralNodes.push(node);
        if (!definition) {
            continue;
        }
        for (const pin of node.pins) {
            const connection = connectionForPort(instance, pin.name, definition.ports);
            if (!connection) {
                const wildcard = instance.portConnections.some(candidate =>
                    candidate.syntax === 'wildcard'
                );
                const network = wildcard ? getNamedNetwork(pin.name) : undefined;
                if (network) {
                    addEndpoint(network, node, pin);
                }
                continue;
            }
            if (connection.expression.length === 0) {
                continue;
            }
            const expression = expressionModel(connection);
            if (expression.kind === 'identifier') {
                const network = getNamedNetwork(expression.text);
                if (network) {
                    addEndpoint(network, node, pin);
                    continue;
                }
            }

            const expressionId = `expression:${connection.expressionSpan.uri ?? document.uri}`
                + `:${connection.expressionSpan.start}`;
            const references = expressionReferences(
                module,
                connection.expressionSpan,
                scopeNetworks
            );
            if (pin.direction !== 'load') {
                const targetRole = pin.direction === 'driver'
                    ? 'driver'
                    : 'bidirectional';
                const exactSelect = pin.direction === 'driver'
                    && expression.kind === 'select'
                    && references.length === 1;
                const boundaryId = exactSelect
                    ? expressionId
                    : `opaque:connection:${connection.expressionSpan.uri ?? document.uri}`
                        + `:${connection.expressionSpan.start}`;
                const boundaryNode = targetBoundaryNode(
                    boundaryId,
                    exactSelect ? 'expression' : 'opaque',
                    expression,
                    references,
                    scopeNetworks,
                    targetRole,
                    document.uri
                );
                structuralNodes.push(boundaryNode);
                const network: SchematicNetwork = {
                    id: `network:${boundaryId}`,
                    name: connection.expression,
                    width: expression.width,
                    endpoints: [],
                    sourceSpan: connection.expressionSpan,
                };
                addEndpoint(network, node, pin);
                addEndpoint(network, boundaryNode, boundaryNode.pins[0]);
                networks.set(network.id, network);
                for (const targetPin of boundaryNode.pins.slice(1)) {
                    addEndpoint(getNamedNetwork(targetPin.name)!, boundaryNode, targetPin);
                }
                continue;
            }
            const expressionNode = sourceNode(
                expressionId,
                'expression',
                expression,
                references,
                scopeNetworks,
                document.uri
            );
            structuralNodes.push(expressionNode);
            const network: SchematicNetwork = {
                id: `network:${expressionId}`,
                name: connection.expression,
                width: expression.width,
                endpoints: [],
                sourceSpan: connection.expressionSpan,
            };
            addEndpoint(network, expressionNode, expressionNode.pins.at(-1)!);
            addEndpoint(network, node, pin);
            networks.set(network.id, network);
            for (const dependency of expressionNode.pins.slice(0, -1)) {
                addEndpoint(getNamedNetwork(dependency.name)!, expressionNode, dependency);
            }
        }
    }

    for (const assignment of module.continuousAssignments) {
        const directTarget = assignment.target.kind === 'identifier'
            ? getNamedNetwork(assignment.target.text)
            : undefined;
        const targetReferences = expressionReferences(
            module,
            assignment.target.span,
            scopeNetworks
        );
        const exactSelect = assignment.target.kind === 'select'
            && targetReferences.length === 1;
        const kind = assignment.value.kind === 'constant' ? 'constant' : 'expression';
        const id = `${kind}:${assignment.value.span.uri ?? document.uri}`
            + `:${assignment.value.span.start}`;
        const references = expressionReferences(module, assignment.value.span, scopeNetworks);
        const node = sourceNode(
            id,
            kind,
            assignment.value,
            references,
            scopeNetworks,
            document.uri
        );
        structuralNodes.push(node);
        for (const dependency of node.pins.slice(0, -1)) {
            addEndpoint(getNamedNetwork(dependency.name)!, node, dependency);
        }
        if (directTarget) {
            addEndpoint(directTarget, node, node.pins.at(-1)!);
            continue;
        }

        const targetId = exactSelect
            ? `expression-target:${assignment.target.span.uri ?? document.uri}`
                + `:${assignment.target.span.start}`
            : `opaque:assignment-target:${assignment.target.span.uri ?? document.uri}`
                + `:${assignment.target.span.start}`;
        const targetNode = targetBoundaryNode(
            targetId,
            exactSelect ? 'expression' : 'opaque',
            assignment.target,
            targetReferences,
            scopeNetworks,
            'driver',
            document.uri
        );
        structuralNodes.push(targetNode);
        const valueNetwork: SchematicNetwork = {
            id: `network:${targetId}`,
            name: assignment.target.text,
            width: assignment.target.width,
            endpoints: [],
            sourceSpan: assignment.target.span,
        };
        addEndpoint(valueNetwork, node, node.pins.at(-1)!);
        addEndpoint(valueNetwork, targetNode, targetNode.pins[0]);
        networks.set(valueNetwork.id, valueNetwork);
        for (const targetPin of targetNode.pins.slice(1)) {
            addEndpoint(getNamedNetwork(targetPin.name)!, targetNode, targetPin);
        }
        if (!exactSelect) {
            structuralDiagnostics.push({
                severity: 'info',
                code: 'HDL_UNSUPPORTED_STRUCTURAL_BOUNDARY',
                message: `Continuous assignment target ${assignment.target.text} is shown as an opaque structural boundary.`,
                span: assignment.target.span,
            });
        }
    }

    for (const opaque of module.opaqueRegions) {
        const id = `opaque:${opaque.id}`;
        const readOnly = isForeign(opaque.span, document.uri);
        const pins = opaque.boundaryNames.map(name => ({
            id: `${id}:${name}`,
            name,
            direction: 'bidirectional' as const,
            width: scopeNetworks.get(name)?.width ?? unknownWidth,
            readOnly,
            sourceSpan: opaque.span,
        }));
        const node: GraphNode = {
            id,
            kind: 'opaque',
            label: opaque.boundaryNames.length === 1
                ? opaque.boundaryNames[0]
                : opaque.reason,
            subtitle: opaque.reason,
            pins,
            readOnly,
            sourceSpan: opaque.span,
        };
        structuralNodes.push(node);
        for (const pin of pins) {
            const network = getNamedNetwork(pin.name);
            if (network) {
                addEndpoint(network, node, pin);
            }
        }
    }

    structuralNodes.sort((left, right) => compareSourceOrder(left, right, module));
    const nodes = [...inputNodes, ...inoutNodes, ...structuralNodes, ...outputNodes];
    const nodeOrder = new Map(nodes.map((node, index) => [node.id, index]));
    const pinOrder = new Map(nodes.flatMap(node =>
        node.pins.map((pin, index) => [pinKey(node.id, pin.id), index] as const)
    ));
    const compareEndpoints = (left: NetworkEndpoint, right: NetworkEndpoint): number =>
        (nodeOrder.get(left.nodeId) ?? 0) - (nodeOrder.get(right.nodeId) ?? 0)
        || (pinOrder.get(pinKey(left.nodeId, left.pinId)) ?? 0)
            - (pinOrder.get(pinKey(right.nodeId, right.pinId)) ?? 0)
        || left.pinId.localeCompare(right.pinId);
    for (const network of networks.values()) {
        network.endpoints.sort(compareEndpoints);
    }

    return {
        fileUri: document.uri,
        moduleKey: module.id,
        moduleName: module.name,
        nodes,
        networks: [...networks.values()],
        diagnostics: [
            ...document.diagnostics,
            ...structuralDiagnostics,
            ...nodes.filter(node => node.readOnly).map(node => {
                const port = node.kind === 'port'
                    ? module.ports.find(candidate => candidate.name === node.label)
                    : undefined;
                const span = port
                    ? foreignPortControlSpan(port, module, document.uri)
                    : node.sourceSpan;
                return foreignDiagnostic(node, span);
            }),
            ...nodes.flatMap(node => node.readOnly ? [] : node.pins
                .filter(pin => pin.readOnly)
                .map(pin => foreignPinDiagnostic(node, pin))),
        ],
    };
}
