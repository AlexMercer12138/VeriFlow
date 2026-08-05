import * as assert from 'assert';
import * as fs from 'fs';

import type { HdlDefinitionSummary } from '../core/hdl/workspaceIndexTypes';
import { buildSchematicGraph } from '../schematic/graphBuilder';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';
import { fixturePath } from './helpers/fixturePath';

async function testGoldenGraph(): Promise<void> {
    const fixture = fixturePath('hdl', 'schematic-readonly.sv');
    const document = await parseWithRealWorker(fixture, fs.readFileSync(fixture, 'utf8'));
    const module = document.modules.find(item => item.name === 'top')!;
    const graph = buildSchematicGraph(document, module, new Map());

    assert.deepStrictEqual(graph.nodes.map(node => [node.kind, node.label]), [
        ['port', 'clk'],
        ['instance', 'u_child'],
        ['expression', "1'b1"],
        ['opaque', 'next_data'],
        ['port', 'done'],
    ]);
    const child = graph.nodes.find(node => node.id === 'instance:u_child')!;
    assert.strictEqual(child.subtitle, 'child');
    assert.deepStrictEqual(child.pins.map(pin => [pin.name, pin.side]), [
        ['clk', 'left'],
        ['enable', 'left'],
        ['done', 'right'],
    ]);
    assert.strictEqual(graph.networks.find(net => net.name === 'clk')?.endpoints.length, 2);
    assert.strictEqual(graph.fileUri, document.uri);
    assert.strictEqual(graph.moduleKey, module.id);
}

async function testStructuralEdgeCases(): Promise<void> {
    const fixture = fixturePath('hdl', 'schematic-readonly.sv');
    const document = await parseWithRealWorker(fixture, fs.readFileSync(fixture, 'utf8'));
    const module = document.modules.find(item => item.name === 'edge_top')!;
    const graph = buildSchematicGraph(document, module, new Map());

    const shared = graph.nodes.find(node => node.id === 'port:shared')!;
    assert.strictEqual(shared.pins[0].direction, 'bidirectional');
    assert.strictEqual(shared.pins[0].side, 'bottom');

    const fanout = graph.networks.find(network => network.name === 'source')!;
    const expressions = graph.nodes.filter(node =>
        node.kind === 'expression' && node.label === 'source & shared'
    );
    assert.deepStrictEqual(fanout.endpoints, [
        {
            nodeId: 'port:source',
            pinId: 'port:source:source',
            role: 'driver',
        },
        {
            nodeId: 'instance:u_fanout',
            pinId: 'instance:u_fanout:clk',
            role: 'load',
        },
        {
            nodeId: 'instance:u_raw',
            pinId: 'instance:u_raw:clk',
            role: 'load',
        },
        {
            nodeId: expressions[0].id,
            pinId: `${expressions[0].id}:source`,
            role: 'load',
        },
        {
            nodeId: expressions[1].id,
            pinId: `${expressions[1].id}:source`,
            role: 'load',
        },
    ]);

    const constant = graph.nodes.find(node =>
        node.kind === 'constant' && node.label === "1'b0"
    )!;
    assert.ok(constant);
    assert.strictEqual(constant.pins[0].direction, 'driver');
    assert.ok(graph.networks.find(network => network.name === 'constant_out')
        ?.endpoints.some(endpoint => endpoint.nodeId === constant.id));

    assert.strictEqual(expressions.length, 2);
    for (const expression of expressions) {
        assert.deepStrictEqual(expression.pins.map(pin => [pin.name, pin.direction]), [
            ['source', 'load'],
            ['shared', 'load'],
            ['value', 'driver'],
        ]);
    }

    const unconnected = graph.nodes.find(node => node.id === 'instance:u_fanout')!
        .pins.find(pin => pin.name === 'enable')!;
    assert.ok(unconnected);
    assert.ok(graph.networks.every(network =>
        network.endpoints.every(endpoint => endpoint.pinId !== unconnected.id)
    ));

    assert.deepStrictEqual(
        buildSchematicGraph(document, module, new Map()),
        graph
    );
}

async function testDirectionAwareInstanceConnections(): Promise<void> {
    const fixture = fixturePath('hdl', 'schematic-readonly.sv');
    const document = await parseWithRealWorker(fixture, fs.readFileSync(fixture, 'utf8'));
    const selectedModule = document.modules.find(
        item => item.name === 'connection_direction_top'
    )!;
    const selectedGraph = buildSchematicGraph(document, selectedModule, new Map());
    const selectedInstance = selectedGraph.nodes.find(
        node => node.id === 'instance:u_selected'
    )!;
    const outputAdapter = selectedGraph.nodes.find(node => node.label === 'y[0]')!;

    assert.strictEqual(outputAdapter.kind, 'expression');
    assert.deepStrictEqual(outputAdapter.pins.map(pin => [pin.name, pin.direction]), [
        ['value', 'load'],
        ['y', 'driver'],
    ]);
    assert.deepStrictEqual(
        selectedGraph.networks.find(network => network.name === 'y[0]')?.endpoints,
        [
            {
                nodeId: selectedInstance.id,
                pinId: 'instance:u_selected:y',
                role: 'driver',
            },
            {
                nodeId: outputAdapter.id,
                pinId: `${outputAdapter.id}:value`,
                role: 'load',
            },
        ]
    );
    assert.deepStrictEqual(
        selectedGraph.networks.find(network => network.name === 'y')?.endpoints,
        [
            {
                nodeId: outputAdapter.id,
                pinId: `${outputAdapter.id}:y`,
                role: 'driver',
            },
            {
                nodeId: 'port:y',
                pinId: 'port:y:y',
                role: 'load',
            },
        ]
    );
    assert.strictEqual(
        selectedGraph.networks.find(network => network.name === 'y[0]')
            ?.endpoints.filter(endpoint => endpoint.role === 'driver').length,
        1
    );

    const inoutBoundary = selectedGraph.nodes.find(
        node => node.kind === 'opaque' && node.label === 'shared[0]'
    )!;
    assert.ok(inoutBoundary);
    assert.deepStrictEqual(inoutBoundary.pins.map(pin => [pin.name, pin.direction]), [
        ['value', 'bidirectional'],
        ['shared', 'bidirectional'],
    ]);
    assert.deepStrictEqual(
        selectedGraph.networks.find(network => network.name === 'shared[0]')?.endpoints,
        [
            {
                nodeId: selectedInstance.id,
                pinId: 'instance:u_selected:io',
                role: 'bidirectional',
            },
            {
                nodeId: inoutBoundary.id,
                pinId: `${inoutBoundary.id}:value`,
                role: 'bidirectional',
            },
        ]
    );

    const positionalModule = document.modules.find(
        item => item.name === 'positional_direction_top'
    )!;
    const positionalGraph = buildSchematicGraph(document, positionalModule, new Map());
    const positional = positionalGraph.nodes.find(
        node => node.id === 'instance:u_positional'
    )!;
    assert.deepStrictEqual(positional.pins.map(pin => [pin.name, pin.direction]), [
        ['a', 'load'],
        ['y', 'driver'],
        ['io', 'bidirectional'],
    ]);
    assert.deepStrictEqual(
        positionalGraph.networks.map(network => [
            network.name,
            network.endpoints.find(endpoint => endpoint.nodeId === positional.id)?.role,
        ]),
        [['a', 'load'], ['shared', 'bidirectional'], ['y', 'driver']]
    );
}

async function testContinuousAssignmentTargetsRemainVisible(): Promise<void> {
    const fixture = fixturePath('hdl', 'schematic-readonly.sv');
    const document = await parseWithRealWorker(fixture, fs.readFileSync(fixture, 'utf8'));
    const module = document.modules.find(item => item.name === 'assignment_target_top')!;
    const graph = buildSchematicGraph(document, module, new Map());
    const selectedAssignment = module.continuousAssignments.find(
        assignment => assignment.target.text === 'y[1]'
    )!;
    const selectedTarget = graph.nodes.find(node =>
        node.kind === 'expression'
        && node.label === 'y[1]'
        && node.sourceSpan?.start === selectedAssignment.target.span.start
    )!;

    assert.ok(selectedTarget);
    assert.deepStrictEqual(selectedTarget.pins.map(pin => [pin.name, pin.direction]), [
        ['value', 'load'],
        ['y', 'driver'],
    ]);
    assert.strictEqual(selectedTarget.sourceSpan?.uri, fixture);
    assert.ok(graph.networks.find(network => network.name === 'y')
        ?.endpoints.some(endpoint =>
            endpoint.nodeId === selectedTarget.id
            && endpoint.pinId === `${selectedTarget.id}:y`
            && endpoint.role === 'driver'
        ));
    const selectedValueNetwork = graph.networks.find(network =>
        network.endpoints.some(endpoint =>
            endpoint.nodeId === selectedTarget.id
            && endpoint.pinId === `${selectedTarget.id}:value`
        )
    )!;
    assert.strictEqual(
        selectedValueNetwork.endpoints.filter(endpoint => endpoint.role === 'driver').length,
        1
    );
    assert.strictEqual(
        selectedValueNetwork.endpoints.filter(endpoint => endpoint.role === 'load').length,
        1
    );

    const compositeAssignment = module.continuousAssignments.find(
        assignment => assignment.target.text === '{z, y[0]}'
    )!;
    const compositeTarget = graph.nodes.find(node =>
        node.kind === 'opaque'
        && node.label === '{z, y[0]}'
        && node.sourceSpan?.start === compositeAssignment.target.span.start
    )!;
    assert.ok(compositeTarget);
    assert.deepStrictEqual(compositeTarget.pins.map(pin => [pin.name, pin.direction]), [
        ['value', 'load'],
        ['z', 'bidirectional'],
        ['y', 'bidirectional'],
    ]);
    for (const targetName of ['z', 'y']) {
        assert.ok(graph.networks.find(network => network.name === targetName)
            ?.endpoints.some(endpoint =>
                endpoint.nodeId === compositeTarget.id
                && endpoint.role === 'bidirectional'
            ));
    }
    assert.ok(graph.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_UNSUPPORTED_STRUCTURAL_BOUNDARY'
        && diagnostic.span?.start === compositeAssignment.target.span.start
        && diagnostic.span?.end === compositeAssignment.target.span.end
    ));
}

async function testDynamicTargetsStayConservative(): Promise<void> {
    const fixture = fixturePath('hdl', 'schematic-readonly.sv');
    const document = await parseWithRealWorker(fixture, fs.readFileSync(fixture, 'utf8'));
    const module = document.modules.find(item => item.name === 'dynamic_target_top')!;
    const graph = buildSchematicGraph(document, module, new Map());
    const instance = module.instances[0];
    const connection = instance.portConnections.find(item => item.name === 'y')!;
    const assignment = module.continuousAssignments.find(
        item => item.target.text === 'y[idx]'
    )!;
    const connectionBoundary = graph.nodes.find(node =>
        node.kind === 'opaque'
        && node.sourceSpan?.start === connection.expressionSpan.start
    )!;
    const assignmentBoundary = graph.nodes.find(node =>
        node.kind === 'opaque'
        && node.sourceSpan?.start === assignment.target.span.start
    )!;

    for (const boundary of [connectionBoundary, assignmentBoundary]) {
        assert.ok(boundary);
        assert.deepStrictEqual(boundary.pins.map(pin => [pin.name, pin.direction]), [
            ['value', 'load'],
            ['y', 'bidirectional'],
            ['idx', 'bidirectional'],
        ]);
        assert.ok(boundary.pins.every(pin =>
            pin.name !== 'idx' || pin.direction !== 'driver'
        ));
    }
    const idxNetwork = graph.networks.find(network => network.name === 'idx')!;
    assert.deepStrictEqual(idxNetwork.endpoints.map(endpoint => endpoint.role), [
        'driver',
        'bidirectional',
        'bidirectional',
    ]);
    assert.strictEqual(
        idxNetwork.endpoints.filter(endpoint => endpoint.role === 'driver').length,
        1
    );
    assert.ok(graph.networks.find(network => network.name === 'y')
        ?.endpoints.some(endpoint =>
            endpoint.nodeId === connectionBoundary.id
            && endpoint.role === 'bidirectional'
        ));
    assert.ok(graph.networks.find(network => network.name === 'y')
        ?.endpoints.some(endpoint =>
            endpoint.nodeId === assignmentBoundary.id
            && endpoint.role === 'bidirectional'
        ));
}

async function testExternalDefinitionBinding(): Promise<void> {
    const uri = 'memory:/external-top.sv';
    const source = [
        'module external_top(input logic a, output logic y);',
        '    external_child u_external(.a(a), .y(y));',
        '    external_child u_wildcard(.*);',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(uri, source);
    const module = document.modules[0];
    const definition: HdlDefinitionSummary = {
        key: 'module:file:///lib/external-child.sv:17',
        kind: 'module',
        name: 'external_child',
        uri: 'file:///lib/external-child.sv',
        declarationStart: 17,
        declarationLine: 2,
        parameters: [],
        ports: [
            { name: 'a', direction: 'input', width: { kind: 'known', bits: 1 } },
            { name: 'b', direction: 'input', width: { kind: 'known', bits: 1 } },
            { name: 'y', direction: 'output', width: { kind: 'known', bits: 1 } },
        ],
        dependencies: [],
        modelFingerprint: 'fixture',
    };
    const graph = buildSchematicGraph(document, module, new Map(
        module.instances.map(instance => [instance.id, definition])
    ));
    const node = graph.nodes.find(candidate => candidate.id === 'instance:u_external')!;

    assert.strictEqual(node.definitionKey, definition.key);
    assert.deepStrictEqual(node.pins.map(pin => pin.name), ['a', 'b', 'y']);
    assert.ok(graph.networks.every(network =>
        network.endpoints.every(endpoint => endpoint.pinId !== 'instance:u_external:b')
    ));
    for (const pinName of ['a', 'y']) {
        assert.ok(graph.networks.find(network => network.name === pinName)
            ?.endpoints.some(endpoint =>
                endpoint.pinId === `instance:u_wildcard:${pinName}`
            ));
    }
    assert.ok(graph.networks.every(network =>
        network.endpoints.every(endpoint => endpoint.pinId !== 'instance:u_wildcard:b')
    ));

    const firstInstance = module.instances[0];
    const wrongBinding = { ...definition, name: 'different_child' };
    const unboundGraph = buildSchematicGraph(
        document,
        module,
        new Map([[firstInstance.id, wrongBinding]])
    );
    const unbound = unboundGraph.nodes.find(
        candidate => candidate.id === 'instance:u_external'
    )!;
    assert.strictEqual(unbound.definitionKey, undefined);
    assert.deepStrictEqual(unbound.pins, []);
}

async function testDuplicateLocalDefinitionIsUnbound(): Promise<void> {
    const uri = 'memory:/duplicate-local.sv';
    const source = [
        'module duplicate(input logic first); endmodule',
        'module duplicate(input logic second, output logic result); endmodule',
        'module duplicate_top(input logic first, output logic result);',
        '    duplicate u_duplicate(.first(first), .result(result));',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(uri, source);
    const module = document.modules.find(item => item.name === 'duplicate_top')!;
    const graph = buildSchematicGraph(document, module, new Map());
    const instance = graph.nodes.find(node => node.id === 'instance:u_duplicate')!;

    assert.strictEqual(instance.definitionKey, undefined);
    assert.deepStrictEqual(instance.pins, []);
}

async function testWorkspaceAmbiguitySuppressesLocalFallback(): Promise<void> {
    const uri = 'memory:/ambiguous-workspace.sv';
    const source = [
        'module shared_child(input logic value); endmodule',
        'module ambiguous_top(input logic value);',
        '    shared_child u_shared(.value(value));',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(uri, source);
    const module = document.modules.find(item => item.name === 'ambiguous_top')!;
    const parsedInstance = module.instances[0];
    const bindings = new Map<string, HdlDefinitionSummary | null>([
        [parsedInstance.id, null],
    ]);
    const graph = buildSchematicGraph(document, module, bindings);
    const instance = graph.nodes.find(node => node.id === 'instance:u_shared')!;

    assert.strictEqual(instance.definitionKey, undefined);
    assert.deepStrictEqual(instance.pins, []);
}

async function testIncludedObjectsAreReadOnly(): Promise<void> {
    const parent = fixturePath('hdl', 'schematic-includes.sv');
    const ports = fixturePath('hdl', 'schematic-ports.svh');
    const body = fixturePath('hdl', 'schematic-body.svh');
    const item = fixturePath('hdl', 'schematic-instance-item.svh');
    const child = fixturePath('hdl', 'schematic-child.svh');
    const expression = fixturePath('hdl', 'schematic-expression.svh');
    const portPrefix = fixturePath('hdl', 'schematic-port-prefix.svh');
    const document = await parseWithRealWorker(parent, fs.readFileSync(parent, 'utf8'), {
        defines: {},
        resolvedIncludes: [
            {
                fromUri: parent,
                rawPath: 'schematic-child.svh',
                resolvedUri: child,
                text: fs.readFileSync(child, 'utf8'),
            },
            {
                fromUri: parent,
                rawPath: 'schematic-ports.svh',
                resolvedUri: ports,
                text: fs.readFileSync(ports, 'utf8'),
            },
            {
                fromUri: parent,
                rawPath: 'schematic-body.svh',
                resolvedUri: body,
                text: fs.readFileSync(body, 'utf8'),
            },
            {
                fromUri: parent,
                rawPath: 'schematic-instance-item.svh',
                resolvedUri: item,
                text: fs.readFileSync(item, 'utf8'),
            },
            {
                fromUri: parent,
                rawPath: 'schematic-expression.svh',
                resolvedUri: expression,
                text: fs.readFileSync(expression, 'utf8'),
            },
            {
                fromUri: parent,
                rawPath: 'schematic-port-prefix.svh',
                resolvedUri: portPrefix,
                text: fs.readFileSync(portPrefix, 'utf8'),
            },
        ],
    });
    const module = document.modules.find(item => item.name === 'include_top')!;
    const graph = buildSchematicGraph(document, module, new Map());
    const local = graph.nodes.find(node => node.id === 'port:local_clk')!;
    const includedPort = graph.nodes.find(node => node.id === 'port:included_enable')!;
    const includedInstance = graph.nodes.find(
        node => node.id === 'instance:included_instance'
    )!;

    assert.strictEqual(local.readOnly, false);
    assert.strictEqual(includedPort.readOnly, true);
    assert.strictEqual(includedPort.pins[0].readOnly, true);
    assert.strictEqual(includedPort.sourceSpan?.uri, ports);
    assert.strictEqual(includedPort.sourceSpan?.compositeParts, undefined);
    assert.strictEqual(includedInstance.readOnly, true);
    assert.ok(includedInstance.pins.every(pin => pin.readOnly));
    assert.strictEqual(includedInstance.sourceSpan?.uri, body);
    assert.strictEqual(includedInstance.sourceSpan?.compositeParts, undefined);
    assert.deepStrictEqual(
        graph.nodes.filter(node => node.kind === 'instance').map(node => node.label),
        [
            'local_before',
            'included_instance',
            'local_after',
            'foreign_instance',
            'local_expression_instance',
            'local_group_before',
            'included_group',
            'local_group_after',
        ]
    );
    for (const localName of ['local_group_before', 'local_group_after']) {
        assert.strictEqual(
            graph.nodes.find(node => node.id === `instance:${localName}`)?.readOnly,
            false
        );
    }
    const includedGroup = graph.nodes.find(node => node.id === 'instance:included_group')!;
    assert.strictEqual(includedGroup.readOnly, true);
    assert.strictEqual(includedGroup.sourceSpan?.uri, item);
    const foreignDefinition = document.modules.find(node => node.name === 'foreign_child')!;
    assert.strictEqual(
        graph.nodes.find(node => node.id === 'instance:foreign_instance')?.definitionKey,
        `module:${child}:${foreignDefinition.declarationSpan.start}`
    );
    const expressionInstance = graph.nodes.find(
        node => node.id === 'instance:local_expression_instance'
    )!;
    const expressionPin = expressionInstance.pins.find(pin => pin.name === 'clk')!;
    assert.strictEqual(expressionInstance.readOnly, false);
    assert.strictEqual(expressionPin.readOnly, true);
    assert.strictEqual(expressionPin.sourceSpan?.uri, expression);
    assert.strictEqual(expressionPin.sourceSpan?.compositeParts, undefined);
    assert.strictEqual(
        expressionInstance.pins.find(pin => pin.name === 'enable')?.readOnly,
        false
    );
    assert.ok(graph.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_FOREIGN_SOURCE_READ_ONLY'
        && diagnostic.span?.uri === expression
    ));
    assert.ok(graph.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_FOREIGN_SOURCE_READ_ONLY'
        && diagnostic.span?.uri === ports
    ));
    assert.ok(graph.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_FOREIGN_SOURCE_READ_ONLY'
        && diagnostic.span?.uri === body
    ));

    const inheritedModule = document.modules.find(
        item => item.name === 'inherited_port_top'
    )!;
    const inheritedModel = inheritedModule.ports.find(
        port => port.name === 'local_inherited'
    )!;
    assert.strictEqual(inheritedModel.inheritsDirection, true);
    assert.strictEqual(inheritedModel.inheritsType, true);
    const inheritedGraph = buildSchematicGraph(document, inheritedModule, new Map());
    const inheritedPort = inheritedGraph.nodes.find(
        node => node.id === 'port:local_inherited'
    )!;
    assert.strictEqual(inheritedPort.readOnly, true);
    assert.strictEqual(inheritedPort.pins[0].readOnly, true);
    assert.strictEqual(inheritedPort.sourceSpan?.uri, parent);
    assert.strictEqual(inheritedPort.sourceSpan?.compositeParts, undefined);
    assert.ok(inheritedGraph.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_FOREIGN_SOURCE_READ_ONLY'
        && diagnostic.span?.uri === portPrefix
    ));
}

async function main(): Promise<void> {
    await testGoldenGraph();
    await testStructuralEdgeCases();
    await testDirectionAwareInstanceConnections();
    await testDynamicTargetsStayConservative();
    await testContinuousAssignmentTargetsRemainVisible();
    await testExternalDefinitionBinding();
    await testDuplicateLocalDefinitionIsUnbound();
    await testWorkspaceAmbiguitySuppressesLocalFallback();
    await testIncludedObjectsAreReadOnly();

    console.log('Schematic graph tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
