import * as assert from 'assert';

import {
    createEmptyArchDesign,
    parseArchDesignValue,
    projectArchDesignGraph,
    type ArchDesign,
    type ArchDesignModuleDefinition,
} from '@veriflow/schematic-core/arch-design';
import { createInterfaceProtocolCatalog } from '@veriflow/schematic-core/interfaces';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import {
    archDesignEndpointForPin,
    archDesignGraphsEqual,
    archDesignLayout,
    archDesignPresentationFromLayout,
    projectArchDesignInspectorData,
    toArchDesignModuleDefinitions,
} from '../archDesign/editorSupport';

function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const parsed = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (parsed.status !== 'editable') throw new Error('expected editable design');
    return parsed.design;
}

const moduleSummary: HdlDefinitionSummary = {
    key: 'module:file:///workspace/core.sv:10',
    kind: 'module',
    name: 'core',
    uri: 'file:///workspace/core.sv',
    declarationStart: 10,
    declarationLine: 2,
    parameters: [{ name: 'WIDTH', defaultExpression: '8' }],
    ports: [
        { name: 'clk', direction: 'input', width: { kind: 'known', bits: 1 } },
        {
            name: 'data_o',
            direction: 'output',
            packedRange: '[WIDTH-1:0]',
            width: { kind: 'symbolic', expression: 'WIDTH' },
        },
    ],
    dependencies: [],
    modelFingerprint: 'core-v1',
};

function definition(): ArchDesignModuleDefinition {
    return toArchDesignModuleDefinitions([moduleSummary])[0];
}

function testCatalogProjection(): void {
    const interfaceSummary: HdlDefinitionSummary = {
        ...moduleSummary,
        key: 'interface:file:///workspace/bus.sv:0',
        kind: 'interface',
        name: 'bus_if',
    };
    const projected = toArchDesignModuleDefinitions([
        interfaceSummary,
        moduleSummary,
    ]);

    assert.deepStrictEqual(projected, [{
        key: moduleSummary.key,
        name: 'core',
        parameters: [{ name: 'WIDTH', defaultExpression: '8' }],
        ports: [
            { name: 'clk', direction: 'input', width: { kind: 'known', bits: 1 } },
            {
                name: 'data_o',
                direction: 'output',
                width: { kind: 'symbolic', expression: 'WIDTH' },
            },
        ],
    }]);
    moduleSummary.parameters[0].name = 'MUTATED';
    assert.strictEqual(projected[0].parameters[0].name, 'WIDTH');
    moduleSummary.parameters[0].name = 'WIDTH';
}

function testLayoutProjection(): void {
    const design = designOf({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'gpio', direction: 'inout', width: 8 },
        ],
        instances: [{ name: 'u_core', module: 'core' }],
        defaults: { 'gpio.o': "8'b0" },
        presentation: {
            nodes: {
                'instance:u_core': {
                    column: 2,
                    order: 0,
                    offset: 12,
                    userPositioned: true,
                },
                'default:stale': { column: 1, order: 0 },
            },
            collapsedInterfaces: { 'u_core.m_axi': true },
            viewport: { x: -20, y: 30, zoom: 1.5 },
        },
    });
    const projection = projectArchDesignGraph(design, [definition()], {
        fileUri: 'file:///workspace/soc.ad',
    });

    const layout = archDesignLayout(design, projection.graph);
    assert.deepStrictEqual(layout.viewport, { x: -20, y: 30, zoom: 1.5 });
    assert.strictEqual(layout.minimap, true);
    assert.deepStrictEqual(layout.placement.nodes['instance:u_core'], {
        column: 1,
        order: 0,
        yOffset: 12,
        fixed: true,
    });

    layout.placement.nodes['instance:u_core'] = {
        column: 3,
        order: 1,
        yOffset: -8,
        fixed: true,
    };
    projection.graph.nodes.push({
        id: 'interface:port:m_link',
        kind: 'port',
        label: 'm_link',
        subtitle: 'Project Link master',
        pins: [],
        readOnly: false,
    });
    layout.placement.nodes['interface:port:m_link'] = {
        column: 4,
        order: 0,
        yOffset: 6,
        fixed: true,
    };
    const constantNode = projection.graph.nodes.find(node => node.kind === 'constant');
    assert.ok(constantNode);
    layout.placement.nodes[constantNode!.id] = {
        column: 1,
        order: 0,
        yOffset: 0,
        fixed: true,
    };
    layout.viewport = { x: 4, y: 5, zoom: 0.8 };

    const presentation = archDesignPresentationFromLayout(
        design,
        projection.graph,
        layout
    );
    assert.deepStrictEqual(Object.fromEntries(Object.entries(presentation.nodes ?? {})), {
        'port:clk': { column: 0, order: 0 },
        'port:gpio': { column: 2, order: 0 },
        'instance:u_core': {
            column: 3,
            order: 1,
            offset: -8,
            userPositioned: true,
        },
        'interface:port:m_link': {
            column: 4,
            order: 0,
            offset: 6,
            userPositioned: true,
        },
    });
    assert.deepStrictEqual(
        Object.fromEntries(Object.entries(presentation.collapsedInterfaces ?? {})),
        { 'u_core.m_axi': true }
    );
    assert.deepStrictEqual(presentation.viewport, { x: 4, y: 5, zoom: 0.8 });
}

function testEndpointProjection(): void {
    const design = designOf({
        ports: [
            { name: 'clk', direction: 'input' },
            { name: 'gpio', direction: 'inout', width: 8 },
        ],
        instances: [{ name: 'u_core', module: 'core' }],
        defaults: { 'gpio.o': "8'b0" },
    });
    const graph = projectArchDesignGraph(design, [definition()], {
        fileUri: 'file:///workspace/soc.ad',
    }).graph;
    const clk = graph.nodes.find(node => node.id === 'port:clk')!;
    const gpio = graph.nodes.find(node => node.id === 'port:gpio')!;
    const core = graph.nodes.find(node => node.id === 'instance:u_core')!;
    const constant = graph.nodes.find(node => node.kind === 'constant')!;

    assert.deepStrictEqual(archDesignEndpointForPin(design, clk, clk.pins[0]), {
        kind: 'port', port: 'clk',
    });
    assert.deepStrictEqual(
        archDesignEndpointForPin(
            design,
            gpio,
            gpio.pins.find(pin => pin.name === 'gpio_o')!
        ),
        { kind: 'port', port: 'gpio', signal: 'o' }
    );
    assert.deepStrictEqual(
        archDesignEndpointForPin(
            design,
            core,
            core.pins.find(pin => pin.name === 'data_o')!
        ),
        { kind: 'instance', instance: 'u_core', port: 'data_o' }
    );
    assert.strictEqual(
        archDesignEndpointForPin(design, constant, constant.pins[0]),
        undefined
    );
}

function testGraphEqualityForLightweightProtocolRefresh(): void {
    const projected = projectArchDesignGraph(
        designOf({ instances: [{ name: 'u_core', module: 'core' }] }),
        [definition()],
        { fileUri: 'file:///workspace/soc.ad' }
    ).graph;
    const equal = structuredClone(projected);
    assert.strictEqual(archDesignGraphsEqual(projected, equal), true);
    equal.nodes[0].label = 'changed';
    assert.strictEqual(archDesignGraphsEqual(projected, equal), false);
}

function testResolvedInterfaceInspectorData(): void {
    const interfaceCatalog = createInterfaceProtocolCatalog([{
        source: '/workspace/protocols/link.json',
        value: {
            format: 'veriflow-interface-protocol',
            schemaVersion: 1,
            id: 'project.link',
            name: 'Project Link',
            separator: '_',
            priority: 100,
            members: [
                { name: 'request', direction: 'master-to-slave' },
                { name: 'accept', direction: 'slave-to-master', default: "1'b0" },
                { name: 'tag', direction: 'master-to-slave', default: "4'h0" },
            ],
            recognitionGroups: [['request', 'accept']],
        },
    }]);
    const definitions: ArchDesignModuleDefinition[] = [{
        key: 'master',
        name: 'master',
        parameters: [],
        ports: [
            { name: 'BUS_REQUEST', direction: 'output', width: { kind: 'known', bits: 32 } },
            { name: 'BUS_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
        ],
    }, {
        key: 'slave',
        name: 'slave',
        parameters: [],
        ports: [
            { name: 'LINK_REQUEST', direction: 'input', width: { kind: 'known', bits: 16 } },
            { name: 'LINK_ACCEPT', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 'LINK_TAG', direction: 'input', width: { kind: 'known', bits: 4 } },
        ],
    }];
    const selectedDesign = designOf({
        instances: [
            { name: 'u_master', module: 'master' },
            { name: 'u_slave', module: 'slave' },
        ],
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'LINK' },
        }],
    });

    const projected = projectArchDesignInspectorData(
        selectedDesign,
        definitions,
        interfaceCatalog
    );

    assert.deepStrictEqual(projected.protocols.find(item => item.id === 'project.link'), {
        id: 'project.link',
        name: 'Project Link',
        source: '/workspace/protocols/link.json',
    });
    const master = projected.interfaces.find(
        item => item.identity === 'interface:instance:u_master:BUS'
    );
    assert.ok(master);
    assert.strictEqual(master?.role, 'master');
    assert.strictEqual(master?.roleSource, 'inferred');
    assert.deepStrictEqual(master?.members.map(member => [
        member.member,
        member.port,
        member.occupancy,
    ]), [
        ['request', 'BUS_REQUEST', 'control'],
        ['accept', 'BUS_ACCEPT', 'control'],
    ]);
    assert.deepStrictEqual(master?.missingMembers, ['tag']);
    assert.strictEqual(master?.connection?.peer, 'u_slave.LINK');
    assert.deepStrictEqual(master?.connection?.defaults, [{
        member: 'tag',
        expression: "4'h0",
        origin: 'protocol',
        source: 'protocol:project.link:tag',
        protocolExpression: "4'h0",
    }]);
    assert.deepStrictEqual(master?.connection?.warnings.map(item => item.code), [
        'AD_INTERFACE_WIDTH',
    ]);
}

function main(): void {
    testCatalogProjection();
    testLayoutProjection();
    testEndpointProjection();
    testGraphEqualityForLightweightProtocolRefresh();
    testResolvedInterfaceInspectorData();
    console.log('Arch Design editor support tests passed');
}

main();
