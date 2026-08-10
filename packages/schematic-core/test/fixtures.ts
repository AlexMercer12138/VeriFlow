import {
    routeNetworks,
    type GraphNode,
    type GraphPin,
    type PinDirection,
    type RoutedSchematic,
    type RoutingGridCreateOptions,
    type RoutingGridNodeInput,
    type RoutingNetworkRequest,
    type SchematicGraph,
    type SchematicNetwork,
    type SchematicPlacement,
} from '../src';

export type RoutingFixture = Readonly<{
    nodes: readonly RoutingGridNodeInput[];
    networks: readonly RoutingNetworkRequest[];
    options?: RoutingGridCreateOptions;
}>;

export function routingNode(
    id: string,
    column: number,
    order: number,
    height = 40,
    yOffset = 0
): RoutingGridNodeInput {
    return {
        id,
        column,
        order,
        yOffset,
        size: { width: 100, height },
        pinAnchors: [
            { id: 'left', x: 0, y: height / 2 },
            { id: 'right', x: 100, y: height / 2 },
        ],
    };
}

export function threeColumnFixture(): RoutingFixture {
    return {
        nodes: [
            routingNode('source', 0, 0),
            routingNode('middle', 1, 0),
            routingNode('sink', 2, 0),
            routingNode('lower-0', 0, 1),
            routingNode('lower-1', 1, 1),
            routingNode('lower-2', 2, 1),
        ],
        networks: [{
            id: 'network:data',
            terminals: [
                { nodeId: 'source', pinId: 'right', role: 'driver' },
                { nodeId: 'sink', pinId: 'left', role: 'load' },
            ],
        }],
        options: { columnCount: 3 },
    };
}

export function routeFixture(fixture: RoutingFixture): RoutedSchematic {
    return routeNetworks(fixture.nodes, fixture.networks, fixture.options);
}

export type SchematicFixture = Readonly<{
    graph: SchematicGraph;
    placement: SchematicPlacement;
}>;

function graphPin(nodeId: string, name: string, direction: PinDirection): GraphPin {
    return {
        id: `${nodeId}:${name}`,
        name,
        direction,
        width: { kind: 'known', bits: 1 },
        readOnly: false,
    };
}

function graphNode(
    id: string,
    kind: GraphNode['kind'],
    label: string,
    pins: readonly (readonly [string, PinDirection])[],
    subtitle?: string
): GraphNode {
    return {
        id,
        kind,
        label,
        subtitle,
        pins: pins.map(([name, direction]) => graphPin(id, name, direction)),
        readOnly: false,
    };
}

function graphNetwork(
    id: string,
    name: string,
    endpoints: readonly (readonly [GraphNode, number])[]
): SchematicNetwork {
    return {
        id,
        name,
        width: { kind: 'known', bits: 1 },
        endpoints: endpoints.map(([node, pinIndex]) => ({
            nodeId: node.id,
            pinId: node.pins[pinIndex].id,
            role: node.pins[pinIndex].direction,
        })),
    };
}

export function adversarialSchematicFixture(): SchematicFixture {
    const inputA = graphNode('port:input-a', 'port', 'input_a', [['value', 'driver']]);
    const inputB = graphNode('port:input-b', 'port', 'input_b', [['value', 'driver']]);
    const wide = graphNode(
        'instance:wide-source',
        'instance',
        'wide_source_with_a_title_that_must_never_escape_the_module_body',
        [
            ['seed_input_with_a_long_declared_name', 'load'],
            ['lane_a_output_with_a_long_declared_name', 'driver'],
            ['lane_b_output', 'driver'],
            ['lane_c_output', 'driver'],
            ['fanout_output', 'driver'],
            ['cross_a_output', 'driver'],
            ['unused_input', 'load'],
            ['unused_output', 'driver'],
            ['feedback_top_input', 'load'],
            ['feedback_bottom_input', 'load'],
            ['spare_input', 'load'],
            ['spare_output', 'driver'],
        ],
        'wide_source_subtitle_that_is_also_intentionally_long'
    );
    const crossSource = graphNode('instance:cross-source-low', 'instance', 'cross_low', [
        ['seed', 'load'],
        ['cross_b_output', 'driver'],
    ]);
    const middleTop = graphNode('instance:middle-top', 'instance', 'm_top', [
        ['lane_a_input', 'load'],
        ['fanout_top', 'load'],
        ['cross_b_input', 'load'],
        ['result', 'driver'],
    ]);
    const middleMid = graphNode('instance:middle-mid', 'instance', 'm_mid', [
        ['lane_b_input', 'load'],
        ['fanout_mid', 'load'],
    ]);
    const middleBottom = graphNode('instance:middle-bottom', 'instance', 'm_bottom', [
        ['lane_c_input', 'load'],
        ['fanout_bottom', 'load'],
        ['cross_a_input', 'load'],
    ]);
    const output = graphNode('port:output', 'port', 'result_out', [['value', 'load']]);
    const feedbackTopDriver = graphNode(
        'instance:feedback-top-driver',
        'instance',
        'feedback_top_driver',
        [['out', 'driver']]
    );
    const feedbackTopLoad = graphNode(
        'instance:feedback-top-load',
        'instance',
        'feedback_top_load',
        [['in', 'load']]
    );
    const feedbackBottomDriver = graphNode(
        'instance:feedback-bottom-driver',
        'instance',
        'feedback_bottom_driver',
        [['out', 'driver']]
    );
    const feedbackBottomLoad = graphNode(
        'instance:feedback-bottom-load',
        'instance',
        'feedback_bottom_load',
        [['in', 'load']]
    );
    const empty = graphNode(
        'instance:empty-island',
        'instance',
        'empty_disconnected_module',
        []
    );

    const graph: SchematicGraph = {
        fileUri: 'file:///adversarial.sv',
        moduleKey: 'module:adversarial:0',
        moduleName: 'adversarial',
        nodes: [
            inputA,
            inputB,
            wide,
            crossSource,
            middleTop,
            middleMid,
            middleBottom,
            feedbackTopDriver,
            feedbackTopLoad,
            feedbackBottomDriver,
            feedbackBottomLoad,
            empty,
            output,
        ],
        networks: [
            graphNetwork('network:seed-a', 'seed_a', [[inputA, 0], [wide, 0]]),
            graphNetwork('network:seed-b', 'seed_b', [[inputB, 0], [crossSource, 0]]),
            graphNetwork(
                'network:lane-a',
                'lane_a_with_an_intentionally_long_network_label',
                [[wide, 1], [middleTop, 0]]
            ),
            graphNetwork('network:lane-b', 'lane_b', [[wide, 2], [middleMid, 0]]),
            graphNetwork('network:lane-c', 'lane_c', [[wide, 3], [middleBottom, 0]]),
            graphNetwork('network:fanout', 'fanout', [
                [wide, 4],
                [middleTop, 1],
                [middleMid, 1],
                [middleBottom, 1],
            ]),
            graphNetwork('network:cross-a', 'cross_a', [[wide, 5], [middleBottom, 2]]),
            graphNetwork('network:cross-b', 'cross_b', [[crossSource, 1], [middleTop, 2]]),
            graphNetwork('network:result', 'result', [[middleTop, 3], [output, 0]]),
            graphNetwork('network:feedback-top', 'feedback_top', [
                [feedbackTopDriver, 0],
                [feedbackTopLoad, 0],
            ]),
            graphNetwork('network:feedback-bottom', 'feedback_bottom', [
                [feedbackBottomDriver, 0],
                [feedbackBottomLoad, 0],
            ]),
        ],
        diagnostics: [],
    };

    const fixed = (
        column: number,
        order: number,
        yOffset = 0
    ): SchematicPlacement['nodes'][string] => ({
        column,
        order,
        yOffset,
        fixed: true,
    });
    return {
        graph,
        placement: {
            nodes: {
                [wide.id]: fixed(1, 1),
                [crossSource.id]: fixed(1, 2),
                [middleTop.id]: fixed(2, 1),
                [middleMid.id]: fixed(2, 2),
                [middleBottom.id]: fixed(2, 3),
                [feedbackTopLoad.id]: fixed(1, 0, -80),
                [feedbackTopDriver.id]: fixed(2, 0, -80),
                [feedbackBottomLoad.id]: fixed(1, 3, 80),
                [feedbackBottomDriver.id]: fixed(2, 4, 80),
                [empty.id]: fixed(1, 4),
            },
        },
    };
}
