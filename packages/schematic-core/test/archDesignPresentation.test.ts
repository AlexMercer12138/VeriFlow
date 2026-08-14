import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assignColumns,
    createPlacement,
    type SchematicGraph,
} from '../src';
import {
    createEmptyArchDesign,
    isArchDesignInterfaceCollapsed,
    parseArchDesignValue,
    projectArchDesignGraph,
    projectArchDesignPlacement,
    type ArchDesign,
    type ArchDesignModuleDefinition,
    type ArchDesignPresentation,
} from '../src/archDesign';

const SOURCE_ID = 'port:source';
const FIRST_ID = 'instance:u_first';
const SECOND_ID = 'instance:u_second';
const SINK_ID = 'port:sink';
const DEFAULT_ID = 'default:instance:u_first:enable';

const stageDefinition: ArchDesignModuleDefinition = {
    key: 'rtl/stage.sv#stage',
    name: 'stage',
    parameters: [],
    ports: [
        { name: 'data_i', direction: 'input', width: { kind: 'known', bits: 1 } },
        { name: 'data_o', direction: 'output', width: { kind: 'known', bits: 1 } },
        { name: 'enable', direction: 'input', width: { kind: 'known', bits: 1 } },
    ],
};

function fixture(presentation: ArchDesignPresentation = {}): {
    design: ArchDesign;
    graph: SchematicGraph;
} {
    const parsed = parseArchDesignValue({
        ...createEmptyArchDesign('pipeline'),
        ports: [
            { name: 'source', direction: 'input' },
            { name: 'sink', direction: 'output' },
        ],
        instances: [
            { name: 'u_first', module: 'stage' },
            { name: 'u_second', module: 'stage' },
        ],
        connections: [
            {
                name: 'source',
                endpoints: [
                    { kind: 'port', port: 'source' },
                    { kind: 'instance', instance: 'u_first', port: 'data_i' },
                ],
            },
            {
                name: 'middle',
                endpoints: [
                    { kind: 'instance', instance: 'u_first', port: 'data_o' },
                    { kind: 'instance', instance: 'u_second', port: 'data_i' },
                ],
            },
            {
                name: 'sink',
                endpoints: [
                    { kind: 'instance', instance: 'u_second', port: 'data_o' },
                    { kind: 'port', port: 'sink' },
                ],
            },
        ],
        defaults: {
            'u_first.enable': "1'b1",
            'u_second.enable': "1'b1",
        },
        presentation,
    });
    if (parsed.status !== 'editable') throw new Error('expected editable design');
    const projection = projectArchDesignGraph(parsed.design, [stageDefinition], {
        fileUri: 'file:///workspace/pipeline.ad',
    });
    assert.equal(projection.validation.valid, true);
    return { design: parsed.design, graph: projection.graph };
}

function structuralDesign(
    design: ArchDesign,
    presentation: unknown
): ArchDesign {
    return { ...design, presentation } as ArchDesign;
}

function isolatedGraph(nodeIds: readonly string[]): SchematicGraph {
    return {
        fileUri: 'file:///workspace/isolated.ad',
        moduleKey: 'arch-design:isolated',
        moduleName: 'isolated',
        nodes: nodeIds.map(id => ({
            id,
            kind: 'instance',
            label: id,
            pins: [],
            readOnly: false,
        })),
        networks: [],
        diagnostics: [],
    };
}

test('projects empty presentation as automatic placement for every graph node', () => {
    const { design, graph } = fixture();

    assert.deepEqual(
        projectArchDesignPlacement(design, graph),
        createPlacement(graph, assignColumns(graph))
    );
});

test('treats recognized interfaces as collapsed unless their stable ID is explicitly false', () => {
    const { design } = fixture();
    const interfaceId = 'interface:instance:u_first:BUS';

    assert.equal(isArchDesignInterfaceCollapsed(design, interfaceId), true);
    assert.equal(isArchDesignInterfaceCollapsed(structuralDesign(design, {
        collapsedInterfaces: { [interfaceId]: false },
    }), interfaceId), false);
    assert.equal(isArchDesignInterfaceCollapsed(structuralDesign(design, {
        collapsedInterfaces: { [interfaceId]: true },
    }), interfaceId), true);
});

test('ignores inherited collapsed-interface state', () => {
    const { design } = fixture();
    const interfaceId = 'interface:instance:u_first:BUS';
    const collapsedInterfaces = Object.create({ [interfaceId]: false });

    assert.equal(isArchDesignInterfaceCollapsed(structuralDesign(design, {
        collapsedInterfaces,
    }), interfaceId), true);
});

test('maps persisted schema placement fields into shared placement fields', () => {
    const automaticFixture = fixture();
    const assignment = assignColumns(automaticFixture.graph);
    const firstColumn = assignment.nodeColumn.get(FIRST_ID)!;
    const secondColumn = assignment.nodeColumn.get(SECOND_ID)!;
    const { design, graph } = fixture({
        nodes: {
            [FIRST_ID]: {
                column: firstColumn,
                order: 0,
                offset: 13,
                userPositioned: true,
            },
            [SECOND_ID]: {
                column: secondColumn,
                order: 0,
                userPositioned: true,
            },
            [SOURCE_ID]: {
                column: secondColumn,
                order: 99,
                offset: 21,
                userPositioned: false,
            },
            [SINK_ID]: {
                column: firstColumn,
                order: 99,
                offset: 34,
            },
        },
    });

    const placement = projectArchDesignPlacement(design, graph);

    assert.deepEqual(placement.nodes[FIRST_ID], {
        column: firstColumn,
        order: 0,
        yOffset: 13,
        fixed: true,
    });
    assert.deepEqual(placement.nodes[SECOND_ID], {
        column: secondColumn,
        order: 0,
        yOffset: 0,
        fixed: true,
    });
    assert.equal(placement.nodes[SOURCE_ID].fixed, false);
    assert.equal(placement.nodes[SOURCE_ID].yOffset, 0);
    assert.equal(placement.nodes[SINK_ID].fixed, false);
    assert.equal(placement.nodes[SINK_ID].yOffset, 0);
});

test('discards stale presentation node IDs', () => {
    const { design, graph } = fixture({
        nodes: {
            removed: { column: 1, order: 0, offset: 99, userPositioned: true },
        },
    });

    const placement = projectArchDesignPlacement(design, graph);

    assert.equal(Object.prototype.hasOwnProperty.call(placement.nodes, 'removed'), false);
    assert.deepEqual(Object.keys(placement.nodes), graph.nodes.map(node => node.id));
});

test('automatically places derived default nodes missing from presentation', () => {
    const { design, graph } = fixture({
        nodes: {
            [SINK_ID]: { column: 1, order: 0, offset: 8, userPositioned: true },
        },
    });
    assert.equal(graph.nodes.some(node => node.id === DEFAULT_ID), true);

    const placement = projectArchDesignPlacement(design, graph);
    const automatic = createPlacement(graph, assignColumns(graph));

    assert.deepEqual(placement.nodes[DEFAULT_ID], automatic.nodes[DEFAULT_ID]);
});

test('normalizes duplicate persisted orders deterministically', () => {
    const automaticFixture = fixture();
    const sharedColumn = assignColumns(automaticFixture.graph).nodeColumn.get(FIRST_ID)!;
    const { design, graph } = fixture({
        nodes: {
            [FIRST_ID]: {
                column: sharedColumn,
                order: 0,
                offset: 1,
                userPositioned: true,
            },
            [SECOND_ID]: {
                column: sharedColumn,
                order: 0,
                offset: 2,
                userPositioned: true,
            },
        },
    });

    const first = projectArchDesignPlacement(design, graph);
    const second = projectArchDesignPlacement(design, graph);

    assert.deepEqual(second, first);
    assert.equal(first.nodes[FIRST_ID].column, sharedColumn);
    assert.equal(first.nodes[SECOND_ID].column, sharedColumn);
    assert.equal(first.nodes[FIRST_ID].order, 0);
    assert.equal(first.nodes[SECOND_ID].order, 1);
});

test('keeps boundary ports on automatic outer columns', () => {
    const automaticFixture = fixture();
    const assignment = assignColumns(automaticFixture.graph);
    const internalColumn = assignment.nodeColumn.get(FIRST_ID)!;
    const { design, graph } = fixture({
        nodes: {
            [SOURCE_ID]: {
                column: internalColumn,
                order: 7,
                offset: -5,
                userPositioned: true,
            },
            [SINK_ID]: {
                column: internalColumn,
                order: 7,
                offset: 5,
                userPositioned: true,
            },
        },
    });

    const placement = projectArchDesignPlacement(design, graph);

    assert.notEqual(assignment.nodeColumn.get(SOURCE_ID), internalColumn);
    assert.notEqual(assignment.nodeColumn.get(SINK_ID), internalColumn);
    assert.equal(placement.nodes[SOURCE_ID].column, assignment.nodeColumn.get(SOURCE_ID));
    assert.equal(placement.nodes[SINK_ID].column, assignment.nodeColumn.get(SINK_ID));
});

test('returns fresh mutable placement without mutating presentation', () => {
    const { design, graph } = fixture({
        nodes: {
            [FIRST_ID]: { column: 1, order: 0, offset: 12, userPositioned: true },
        },
        collapsedInterfaces: { bus: true },
    });
    const presentationBefore = JSON.stringify(design.presentation);

    const first = projectArchDesignPlacement(design, graph);
    const second = projectArchDesignPlacement(design, graph);

    assert.deepEqual(second, first);
    assert.notEqual(second, first);
    assert.notEqual(second.nodes, first.nodes);
    assert.equal(Object.isFrozen(first), false);
    assert.equal(Object.isFrozen(first.nodes), false);
    assert.equal(Object.isFrozen(first.nodes[FIRST_ID]), false);
    first.nodes[FIRST_ID].yOffset = 999;
    assert.equal(second.nodes[FIRST_ID].yOffset, 12);
    assert.equal(JSON.stringify(design.presentation), presentationBefore);
});

test('uses only own presentation dictionary entries without prototype pollution', () => {
    const { design: parsedDesign, graph } = fixture();
    const inherited = {
        [SECOND_ID]: { column: 1, order: 0, offset: 22, userPositioned: true },
    };
    const nodes = Object.create(inherited) as Record<string, unknown>;
    Object.defineProperty(nodes, FIRST_ID, {
        value: { column: 1, order: 0, offset: 11, userPositioned: true },
        enumerable: true,
    });
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        Object.defineProperty(nodes, key, {
            value: { column: 1, order: 0, offset: 77, userPositioned: true },
            enumerable: true,
        });
    }
    const design = structuralDesign(parsedDesign, { nodes });

    const placement = projectArchDesignPlacement(design, graph);

    assert.equal(placement.nodes[FIRST_ID].fixed, true);
    assert.equal(placement.nodes[SECOND_ID].fixed, false);
    assert.deepEqual(
        Object.keys(placement.nodes).sort(),
        graph.nodes.map(node => node.id).sort()
    );
    assert.equal(Object.getPrototypeOf(placement.nodes), Object.prototype);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        assert.equal(Object.prototype.hasOwnProperty.call(placement.nodes, key), false);
    }
    assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
});

test('preserves exact special graph node IDs as own placement entries', () => {
    const { design: parsedDesign } = fixture();
    const nodeIds = ['__proto__', 'constructor', 'prototype', 'nul\0node'];
    const graph = isolatedGraph(nodeIds);
    const nodes = Object.create(null) as Record<string, unknown>;
    nodeIds.forEach((id, index) => {
        Object.defineProperty(nodes, id, {
            value: {
                column: 0,
                order: index,
                offset: 10 + index,
                userPositioned: true,
                polluted: true,
            },
            enumerable: true,
        });
    });
    const design = structuralDesign(parsedDesign, { nodes });

    const placement = projectArchDesignPlacement(design, graph);

    assert.equal(Object.getPrototypeOf(placement.nodes), Object.prototype);
    assert.deepEqual(Object.keys(placement.nodes), nodeIds);
    nodeIds.forEach((id, index) => {
        assert.equal(Object.prototype.hasOwnProperty.call(placement.nodes, id), true);
        assert.deepEqual(placement.nodes[id], {
            column: 0,
            order: index,
            yOffset: 10 + index,
            fixed: true,
        });
    });
    assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
});

test('reads only matching values once from a substantially larger dictionary', () => {
    const { design: parsedDesign } = fixture();
    const graphNodeCount = 128;
    const dictionaryEntryCount = 2_048;
    const nodeIds = Array.from(
        { length: graphNodeCount },
        (_, index) => `node:${index}`
    );
    const graph = isolatedGraph(nodeIds);
    const matchingReads = new Array<number>(graphNodeCount).fill(0);
    let staleReads = 0;
    const nodes = Object.create(null) as Record<string, unknown>;
    nodeIds.forEach((id, index) => {
        Object.defineProperty(nodes, id, {
            enumerable: true,
            get() {
                matchingReads[index] += 1;
                return {
                    column: 0,
                    order: index,
                    offset: index,
                    userPositioned: true,
                };
            },
        });
    });
    for (let index = graphNodeCount; index < dictionaryEntryCount; index += 1) {
        Object.defineProperty(nodes, `stale:${index}`, {
            enumerable: true,
            get() {
                staleReads += 1;
                return {
                    column: 0,
                    order: index,
                    offset: index,
                    userPositioned: true,
                };
            },
        });
    }
    const design = structuralDesign(parsedDesign, { nodes });

    const placement = projectArchDesignPlacement(design, graph);

    assert.equal(Object.keys(nodes).length, dictionaryEntryCount);
    assert.equal(matchingReads.every(reads => reads === 1), true);
    assert.equal(
        matchingReads.reduce((total, reads) => total + reads, 0),
        graphNodeCount
    );
    assert.equal(staleReads, 0);
    assert.equal(Object.keys(placement.nodes).length, graphNodeCount);
    assert.equal(placement.nodes[`node:${graphNodeCount - 1}`].yOffset, 127);
});

test('ignores array-shaped presentation node dictionaries', () => {
    const { design: parsedDesign, graph } = fixture();
    const nodes: unknown[] = [];
    Object.defineProperty(nodes, FIRST_ID, {
        value: { column: 1, order: 0, offset: 41, userPositioned: true },
        enumerable: true,
    });
    const design = structuralDesign(parsedDesign, { nodes });

    assert.deepEqual(
        projectArchDesignPlacement(design, graph),
        createPlacement(graph, assignColumns(graph))
    );
});

test('snapshots every dictionary slot before reading entry fields', () => {
    const { design: parsedDesign, graph } = fixture();
    const slotReads = { first: 0, second: 0 };
    const originalSecond = {
        column: 2,
        order: 0,
        offset: 2,
        userPositioned: true,
    };
    const replacementSecond = {
        column: 2,
        order: 0,
        offset: 99,
        userPositioned: true,
    };
    const nodes = Object.create(null) as Record<string, unknown>;
    const first = {
        order: 0,
        offset: 1,
        userPositioned: true,
    } as Record<string, unknown>;
    Object.defineProperty(first, 'column', {
        enumerable: true,
        get() {
            Object.defineProperty(nodes, SECOND_ID, {
                value: replacementSecond,
                enumerable: true,
                configurable: true,
                writable: true,
            });
            return 1;
        },
    });
    Object.defineProperties(nodes, {
        [FIRST_ID]: {
            enumerable: true,
            configurable: true,
            get() {
                slotReads.first += 1;
                return first;
            },
        },
        [SECOND_ID]: {
            enumerable: true,
            configurable: true,
            get() {
                slotReads.second += 1;
                return originalSecond;
            },
        },
    });
    const design = structuralDesign(parsedDesign, { nodes });

    const placement = projectArchDesignPlacement(design, graph);

    assert.deepEqual(slotReads, { first: 1, second: 1 });
    assert.equal(placement.nodes[FIRST_ID].yOffset, 1);
    assert.equal(placement.nodes[SECOND_ID].yOffset, 2);
});

test('snapshots aliased entry fields once into detached placements', () => {
    const { design: parsedDesign, graph } = fixture();
    const reads = { column: 0, order: 0, offset: 0, userPositioned: 0 };
    const shared = {} as Record<string, unknown>;
    for (const [field, value] of [
        ['column', 1],
        ['order', 0],
        ['offset', 23],
        ['userPositioned', true],
    ] as const) {
        Object.defineProperty(shared, field, {
            enumerable: true,
            get() {
                reads[field] += 1;
                return value;
            },
        });
    }
    const nodes = {
        [FIRST_ID]: shared,
        [SECOND_ID]: shared,
    };
    const design = structuralDesign(parsedDesign, { nodes });

    const placement = projectArchDesignPlacement(design, graph);

    assert.deepEqual(reads, {
        column: 1,
        order: 1,
        offset: 1,
        userPositioned: 1,
    });
    assert.deepEqual(placement.nodes[FIRST_ID], {
        column: 1,
        order: 0,
        yOffset: 23,
        fixed: true,
    });
    assert.deepEqual(placement.nodes[SECOND_ID], {
        column: 1,
        order: 1,
        yOffset: 23,
        fixed: true,
    });
    assert.notEqual(placement.nodes[FIRST_ID], placement.nodes[SECOND_ID]);
    placement.nodes[FIRST_ID].yOffset = 100;
    assert.equal(placement.nodes[SECOND_ID].yOffset, 23);
});

test('snapshots caller-owned getter fields once and does not mutate graph', () => {
    const { design: parsedDesign, graph } = fixture();
    const graphBefore = structuredClone(graph);
    const reads = {
        presentation: 0,
        nodes: 0,
        entry: 0,
        column: 0,
        order: 0,
        offset: 0,
        userPositioned: 0,
        collapsedInterfaces: 0,
        inherited: 0,
    };
    const entry = {} as Record<string, unknown>;
    for (const [field, value] of [
        ['column', 1],
        ['order', 0],
        ['offset', 17],
        ['userPositioned', true],
    ] as const) {
        Object.defineProperty(entry, field, {
            enumerable: true,
            get() {
                reads[field] += 1;
                return value;
            },
        });
    }
    const inherited = {} as Record<string, unknown>;
    Object.defineProperty(inherited, SECOND_ID, {
        enumerable: true,
        get() {
            reads.inherited += 1;
            return entry;
        },
    });
    const nodes = Object.create(inherited) as Record<string, unknown>;
    Object.defineProperty(nodes, FIRST_ID, {
        enumerable: true,
        get() {
            reads.entry += 1;
            return entry;
        },
    });
    const presentation = {} as Record<string, unknown>;
    Object.defineProperties(presentation, {
        nodes: {
            enumerable: true,
            get() {
                reads.nodes += 1;
                return nodes;
            },
        },
        collapsedInterfaces: {
            enumerable: true,
            get() {
                reads.collapsedInterfaces += 1;
                return { bus: true };
            },
        },
    });
    const design = { ...parsedDesign } as unknown as Record<string, unknown>;
    Object.defineProperty(design, 'presentation', {
        enumerable: true,
        get() {
            reads.presentation += 1;
            return presentation;
        },
    });

    const placement = projectArchDesignPlacement(design as ArchDesign, graph);

    assert.equal(placement.nodes[FIRST_ID].yOffset, 17);
    assert.equal(placement.nodes[FIRST_ID].fixed, true);
    assert.equal(placement.nodes[SECOND_ID].fixed, false);
    assert.deepEqual(reads, {
        presentation: 1,
        nodes: 1,
        entry: 1,
        column: 1,
        order: 1,
        offset: 1,
        userPositioned: 1,
        collapsedInterfaces: 0,
        inherited: 0,
    });
    assert.deepEqual(graph, graphBefore);
});
