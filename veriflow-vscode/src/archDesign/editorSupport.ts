import type { GraphNode, GraphPin, SchematicGraph } from '@veriflow/schematic-core';
import {
    projectArchDesignPlacement,
    type ArchDesign,
    type ArchDesignEndpoint,
    type ArchDesignModuleDefinition,
    type ArchDesignNodePlacement,
    type ArchDesignPresentation,
} from '@veriflow/schematic-core/arch-design';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import type { SchematicLayout } from '../schematic/layoutStore';

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
        viewport: design.presentation.viewport
            ? { ...design.presentation.viewport }
            : { x: 0, y: 0, zoom: 1 },
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
    const graphNodeIds = new Set(graph.nodes.map(node => node.id));
    const nodeIds = [
        ...design.ports.map(port => `port:${port.name}`),
        ...design.instances.map(instance => `instance:${instance.name}`),
    ];
    const nodes: Record<string, ArchDesignNodePlacement> = Object.create(null);
    for (const nodeId of nodeIds) {
        if (!graphNodeIds.has(nodeId)) continue;
        const placement = persistedPlacement(layout, nodeId);
        if (placement) {
            Object.defineProperty(nodes, nodeId, {
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
        viewport: { ...layout.viewport },
    };
}

function ownsPin(node: GraphNode, pin: GraphPin): boolean {
    return node.pins.some(candidate => candidate.id === pin.id);
}

export function archDesignEndpointForPin(
    design: ArchDesign,
    node: GraphNode,
    pin: GraphPin
): ArchDesignEndpoint | undefined {
    if (!ownsPin(node, pin)) return undefined;
    if (node.kind === 'instance') {
        const instance = design.instances.find(candidate => candidate.name === node.label);
        return instance
            ? { kind: 'instance', instance: instance.name, port: pin.name }
            : undefined;
    }
    if (node.kind !== 'port') return undefined;
    const port = design.ports.find(candidate => candidate.name === node.label);
    if (!port) return undefined;
    if (port.direction !== 'inout') return { kind: 'port', port: port.name };
    const prefix = `${port.name}_`;
    const signal = pin.name.startsWith(prefix) ? pin.name.slice(prefix.length) : '';
    return signal === 'i' || signal === 'o' || signal === 't'
        ? { kind: 'port', port: port.name, signal }
        : undefined;
}
