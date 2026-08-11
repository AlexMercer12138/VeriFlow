import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assignColumns,
    createPlacement,
    type SchematicGraph,
} from '../src';
import {
    createEmptyArchDesign,
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

test('projects empty presentation as automatic placement for every graph node', () => {
    const { design, graph } = fixture();

    assert.deepEqual(
        projectArchDesignPlacement(design, graph),
        createPlacement(graph, assignColumns(graph))
    );
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
        viewport: { x: 10, y: 20, zoom: 1.5 },
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
        viewport: 0,
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
        viewport: {
            enumerable: true,
            get() {
                reads.viewport += 1;
                return { x: 1, y: 2, zoom: 3 };
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
        viewport: 0,
        inherited: 0,
    });
    assert.deepEqual(graph, graphBefore);
});
