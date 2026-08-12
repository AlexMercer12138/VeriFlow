import type { SchematicGraph } from '@veriflow/schematic-core';
import {
    projectArchDesignPlacement,
    type ArchDesign,
    type ArchDesignModuleDefinition,
    type ArchDesignNodePlacement,
    type ArchDesignPresentation,
} from '@veriflow/schematic-core/arch-design';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import type { SchematicLayout } from '../schematic/layoutStore';

export { archDesignEndpointForPin } from '../schematic/webviewSupport';

export function archDesignGraphsEqual(
    left: SchematicGraph,
    right: SchematicGraph
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
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
