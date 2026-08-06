import * as assert from 'assert';

import { createSchematicProviderHarness } from './helpers/schematicProviderHarness';

async function testRevealSourceUsesOwningDocumentOffsets(): Promise<void> {
    const harness = createSchematicProviderHarness();
    const uri = 'file:///workspace/top.sv';
    const panel = await harness.resolve(uri, [`module:${uri}:0`]);

    await harness.dispatch(panel, {
        type: 'revealSource',
        span: { start: 4, end: 11 },
    });
    await harness.dispatch(panel, {
        type: 'revealSource',
        span: { uri: 'file:///workspace/defs.svh', start: 20, end: 27 },
    });
    await harness.dispatch(panel, {
        type: 'revealSource',
        span: {
            start: 100,
            end: 180,
            compositeParts: [
                { uri: 'file:///workspace/ports.svh', start: 8, end: 14 },
                { uri, start: 120, end: 150 },
            ],
        },
    });

    assert.deepStrictEqual(harness.openedText, [
        { uri, selection: { start: 4, end: 11 } },
        {
            uri: 'file:///workspace/defs.svh',
            selection: { start: 20, end: 27 },
        },
        {
            uri: 'file:///workspace/ports.svh',
            selection: { start: 8, end: 14 },
        },
    ]);
}

async function testOpenDefinitionUsesExactKeysAndPreferredPanels(): Promise<void> {
    const harness = createSchematicProviderHarness();
    const topUri = 'file:///workspace/top.sv';
    const childUri = 'file:///workspace/child.sv';
    const topFirst = `module:${topUri}:0`;
    const topSecond = `module:${topUri}:40`;
    const childFirst = `module:${childUri}:0`;
    const childSecond = `module:${childUri}:60`;
    const topPanel = await harness.resolve(topUri, [
        topFirst,
        topSecond,
        childFirst,
        childSecond,
    ]);

    await harness.dispatch(topPanel, {
        type: 'openDefinition',
        definitionKey: topSecond,
    });
    assert.strictEqual(topPanel.selectedModuleKey, topSecond);
    assert.deepStrictEqual(harness.openedSchematics, []);

    await harness.dispatch(topPanel, {
        type: 'openDefinition',
        definitionKey: childSecond,
    });
    assert.deepStrictEqual(harness.openedSchematics, [{
        uri: childUri,
        definitionKey: childSecond,
    }]);
    const firstChildPanel = await harness.resolve(childUri, [childFirst, childSecond]);
    assert.strictEqual(firstChildPanel.selectedModuleKey, childSecond);

    await harness.dispatch(firstChildPanel, {
        type: 'selectModule',
        moduleKey: childFirst,
    });
    const secondChildPanel = await harness.resolve(childUri, [childFirst, childSecond]);
    harness.registry.markFocused(firstChildPanel);
    await harness.dispatch(topPanel, {
        type: 'openDefinition',
        definitionKey: childSecond,
    });

    assert.strictEqual(firstChildPanel.selectedModuleKey, childSecond);
    assert.strictEqual(secondChildPanel.selectedModuleKey, childFirst);
    assert.strictEqual(harness.openedSchematics.length, 1);
}

async function testDiagnosticsPublishCountsAndOwningUris(): Promise<void> {
    const harness = createSchematicProviderHarness();
    const uri = 'file:///workspace/diagnostic-top.sv';
    const panel = await harness.resolve(uri, [`module:${uri}:0`]);

    assert.deepStrictEqual(
        panel.messages.filter(event => event.type === 'diagnostics').at(-1),
        { type: 'diagnostics', errors: 1, warnings: 1 }
    );
    assert.deepStrictEqual(harness.diagnostics, [
        { uri, count: 1 },
        { uri: 'file:///workspace/diagnostics.svh', count: 1 },
    ]);
    const graphEvent = panel.messages.find(event => event.type === 'graph');
    assert.ok(graphEvent?.type === 'graph');
    assert.deepStrictEqual(graphEvent.graph.diagnostics, [{
        severity: 'error',
        code: 'TEST_ERROR',
        message: 'Current-file error',
        span: { start: 2, end: 6 },
    }, {
        severity: 'warning',
        code: 'TEST_WARNING',
        message: 'Included warning',
        span: {
            start: 100,
            end: 120,
            compositeParts: [{
                uri: 'file:///workspace/diagnostics.svh',
                start: 8,
                end: 12,
            }],
        },
    }]);
}

async function testSelectionAndViewportPersistPerModule(): Promise<void> {
    const harness = createSchematicProviderHarness();
    const uri = 'file:///workspace/layout-top.sv';
    const firstKey = `module:${uri}:0`;
    const secondKey = `module:${uri}:40`;
    const panel = await harness.resolve(uri, [firstKey, secondKey]);
    const firstGraph = panel.messages.find(
        event => event.type === 'graph' && event.graph.moduleKey === firstKey
    );
    assert.ok(firstGraph?.type === 'graph');
    const firstLayout = {
        ...firstGraph.layout,
        viewport: { x: 120, y: 240, zoom: 1.5 },
        selectedObjectId: `node:${firstKey}`,
    };

    await harness.dispatch(panel, {
        type: 'selectModule',
        moduleKey: secondKey,
    });
    await harness.dispatch(panel, {
        type: 'saveLayout',
        moduleKey: firstKey,
        layout: firstLayout,
    });
    const secondGraph = panel.messages.find(
        event => event.type === 'graph' && event.graph.moduleKey === secondKey
    );
    assert.ok(secondGraph?.type === 'graph');
    const secondLayout = {
        ...secondGraph.layout,
        viewport: { x: -80, y: 60, zoom: 0.75 },
        selectedObjectId: `node:${secondKey}`,
    };
    await harness.dispatch(panel, {
        type: 'saveLayout',
        moduleKey: secondKey,
        layout: secondLayout,
    });

    await harness.dispatch(panel, { type: 'selectModule', moduleKey: firstKey });
    const restoredFirst = panel.messages.filter(
        event => event.type === 'graph' && event.graph.moduleKey === firstKey
    ).at(-1);
    assert.ok(restoredFirst?.type === 'graph');
    assert.deepStrictEqual(restoredFirst.layout.viewport, firstLayout.viewport);
    assert.strictEqual(
        restoredFirst.layout.selectedObjectId,
        firstLayout.selectedObjectId
    );

    await harness.dispatch(panel, { type: 'selectModule', moduleKey: secondKey });
    const restoredSecond = panel.messages.filter(
        event => event.type === 'graph' && event.graph.moduleKey === secondKey
    ).at(-1);
    assert.ok(restoredSecond?.type === 'graph');
    assert.deepStrictEqual(restoredSecond.layout.viewport, secondLayout.viewport);
    assert.strictEqual(
        restoredSecond.layout.selectedObjectId,
        secondLayout.selectedObjectId
    );

    await harness.dispatch(panel, {
        type: 'saveLayout',
        moduleKey: secondKey,
        layout: { ...secondLayout, selectedObjectId: 'network:removed' },
    });
    await harness.dispatch(panel, { type: 'selectModule', moduleKey: firstKey });
    await harness.dispatch(panel, { type: 'selectModule', moduleKey: secondKey });
    const rematchedSecond = panel.messages.filter(
        event => event.type === 'graph' && event.graph.moduleKey === secondKey
    ).at(-1);
    assert.ok(rematchedSecond?.type === 'graph');
    assert.strictEqual(rematchedSecond.layout.selectedObjectId, undefined);
}

async function main(): Promise<void> {
    await testRevealSourceUsesOwningDocumentOffsets();
    await testOpenDefinitionUsesExactKeysAndPreferredPanels();
    await testDiagnosticsPublishCountsAndOwningUris();
    await testSelectionAndViewportPersistPerModule();

    console.log('schematic integration tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
