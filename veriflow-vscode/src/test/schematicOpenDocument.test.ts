import * as assert from 'assert';

import { buildSchematicGraph } from '../schematic/graphBuilder';
import { createWorkspaceIndexHarness } from './helpers/workspaceIndexFixture';

async function testLiveOpenDocumentResolvesIncludesWithoutCommitting(): Promise<void> {
    const parentUri = 'file:///ws/top.sv';
    const portsUri = 'file:///ws/ports.svh';
    const bodyUri = 'file:///ws/body.svh';
    const harness = createWorkspaceIndexHarness({
        [parentUri]: 'module stale_disk_parent; endmodule',
        [portsUri]: 'input logic included_i',
        [bodyUri]: 'child u_child(.value(included_i));',
    });
    const liveText = [
        'module live_top (',
        '`include "ports.svh"',
        ');',
        '`include "body.svh"',
        'endmodule',
    ].join('\n');
    try {
        const document = await harness.index.parseOpenDocument(
            parentUri,
            17,
            liveText
        );
        const module = document.modules[0];
        assert.strictEqual(document.version, 17);
        assert.strictEqual(module.name, 'live_top');
        assert.deepStrictEqual(module.ports.map(port => port.name), ['included_i']);
        assert.strictEqual(module.ports[0].nameSpan.uri, portsUri);
        assert.deepStrictEqual(module.instances.map(instance => instance.instanceName), [
            'u_child',
        ]);
        assert.strictEqual(module.instances[0].nameSpan.uri, bodyUri);
        assert.ok(!document.diagnostics.some(diagnostic =>
            diagnostic.code === 'HDL_INCLUDE_UNRESOLVED'
        ));

        const graph = buildSchematicGraph(document, module, new Map());
        const includedPort = graph.nodes.find(node => node.id === 'port:included_i');
        const includedInstance = graph.nodes.find(node => node.id === 'instance:u_child');
        assert.strictEqual(includedPort?.readOnly, true);
        assert.strictEqual(includedPort?.sourceSpan?.uri, portsUri);
        assert.strictEqual(includedInstance?.readOnly, true);
        assert.strictEqual(includedInstance?.sourceSpan?.uri, bodyUri);

        assert.strictEqual(harness.parserCalls.at(-1)?.priority, 'interactive');
        assert.deepStrictEqual(
            harness.parserOptions.at(-1)?.resolvedIncludes?.map(include => include.resolvedUri),
            [bodyUri, portsUri]
        );
        assert.strictEqual(harness.index.getFile(parentUri), undefined);
        assert.strictEqual(harness.persistedWrites.length, 0);
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

async function testLiveOpenDocumentHonorsPreAbortedSignal(): Promise<void> {
    const parentUri = 'file:///ws/top.sv';
    const harness = createWorkspaceIndexHarness({
        [parentUri]: 'module top; endmodule',
    });
    const controller = new AbortController();
    controller.abort();
    try {
        await assert.rejects(
            harness.index.parseOpenDocument(
                parentUri,
                1,
                'module live_top; endmodule',
                controller.signal
            ),
            error => error instanceof Error && error.name === 'AbortError'
        );
        assert.strictEqual(harness.parserCalls.length, 0);
        assert.strictEqual(harness.persistedWrites.length, 0);
    } finally {
        harness.index.dispose();
        await harness.dispose();
    }
}

void testLiveOpenDocumentResolvesIncludesWithoutCommitting()
    .then(testLiveOpenDocumentHonorsPreAbortedSignal)
    .then(() => console.log('schematic open document tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
