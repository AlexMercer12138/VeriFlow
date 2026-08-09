import assert from 'node:assert/strict';
import test from 'node:test';

import type { SchematicGraph } from '../src/model';

function typedGraph(graph: SchematicGraph): SchematicGraph {
    return graph;
}

test('schematic graph model preserves its semantic shape', () => {
    const graph = typedGraph({
        fileUri: 'file:///top.sv',
        moduleKey: 'module:top:0',
        moduleName: 'top',
        nodes: [
            {
                id: 'port:input:data',
                kind: 'port',
                label: 'data',
                pins: [{
                    id: 'port:input:data:value',
                    name: 'data',
                    direction: 'driver',
                    width: { kind: 'known', bits: 8 },
                    readOnly: false,
                    sourceSpan: { start: 7, end: 11 },
                }],
                readOnly: false,
            },
            {
                id: 'instance:u_sink',
                kind: 'instance',
                label: 'u_sink',
                subtitle: 'sink',
                pins: [
                    {
                        id: 'instance:u_sink:data',
                        name: 'data',
                        direction: 'load',
                        width: { kind: 'symbolic', expression: 'DATA_WIDTH' },
                        readOnly: false,
                    },
                    {
                        id: 'instance:u_sink:io',
                        name: 'io',
                        direction: 'bidirectional',
                        width: { kind: 'unknown' },
                        readOnly: true,
                    },
                ],
                readOnly: false,
            },
        ],
        networks: [{
            id: 'network:data',
            name: 'data',
            width: { kind: 'known', bits: 8 },
            endpoints: [
                {
                    nodeId: 'port:input:data',
                    pinId: 'port:input:data:value',
                    role: 'driver',
                },
                {
                    nodeId: 'instance:u_sink',
                    pinId: 'instance:u_sink:data',
                    role: 'load',
                },
            ],
            sourceSpan: { start: 23, end: 27, uri: 'file:///top.sv' },
        }],
        diagnostics: [{
            severity: 'info',
            code: 'SCHEMATIC_TEST',
            message: 'typed graph',
        }],
    });

    assert.equal(graph.moduleKey, 'module:top:0');
    assert.deepEqual(graph.nodes.map(node => node.id), [
        'port:input:data',
        'instance:u_sink',
    ]);
    assert.deepEqual(graph.networks[0].endpoints.map(endpoint => endpoint.role), [
        'driver',
        'load',
    ]);
    assert.equal(graph.nodes.some(node => node.pins.some(pin =>
        Object.prototype.hasOwnProperty.call(pin, 'side'))), false);
    assert.deepEqual(graph.nodes.flatMap(node => node.pins.map(pin => pin.width)), [
        { kind: 'known', bits: 8 },
        { kind: 'symbolic', expression: 'DATA_WIDTH' },
        { kind: 'unknown' },
    ]);
    assert.deepEqual(graph.networks[0].width, { kind: 'known', bits: 8 });
});
