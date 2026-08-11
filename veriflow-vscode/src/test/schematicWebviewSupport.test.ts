import * as assert from 'assert';

import type { SchematicGraph } from '@veriflow/schematic-core';
import type { SchematicLayout } from '../schematic/layoutStore';
import {
    buildSchematicWebviewHtml,
    DebouncedLayoutSaveScheduler,
    formatSchematicDiagnosticDetails,
    mergeSchematicWebviewLayouts,
    navigationCommandForCell,
    projectSchematicInspector,
    summarizeSchematicSelection,
    type TimerAdapter,
} from '../schematic/webviewSupport';

function inspectorGraph(): SchematicGraph {
    return {
        fileUri: 'file:///inspector.sv',
        moduleKey: 'module:inspector:0',
        moduleName: 'inspector_top',
        nodes: [{
            id: 'port:clk',
            kind: 'port',
            label: 'clk',
            pins: [{
                id: 'port:clk:clk',
                name: 'clk',
                direction: 'driver',
                width: { kind: 'known', bits: 1 },
                readOnly: true,
            }],
            readOnly: true,
        }, {
            id: 'port:shared',
            kind: 'port',
            label: 'shared',
            pins: [{
                id: 'port:shared:shared',
                name: 'shared',
                direction: 'bidirectional',
                width: { kind: 'known', bits: 8 },
                readOnly: false,
            }],
            readOnly: false,
        }, {
            id: 'instance:u_core',
            kind: 'instance',
            label: 'u_core',
            subtitle: 'core',
            definitionKey: 'module:file:///core.sv:0',
            pins: [{
                id: 'instance:u_core:clk',
                name: 'clk',
                direction: 'load',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            }, {
                id: 'instance:u_core:data',
                name: 'data',
                direction: 'driver',
                width: { kind: 'known', bits: 8 },
                readOnly: false,
            }],
            readOnly: false,
        }, {
            id: 'instance:u_sink',
            kind: 'instance',
            label: 'u_sink',
            subtitle: 'sink',
            pins: [{
                id: 'instance:u_sink:data',
                name: 'data',
                direction: 'load',
                width: { kind: 'known', bits: 8 },
                readOnly: false,
            }],
            readOnly: false,
        }],
        networks: [{
            id: 'network:clk',
            name: 'clk',
            width: { kind: 'known', bits: 1 },
            endpoints: [{
                nodeId: 'port:clk',
                pinId: 'port:clk:clk',
                role: 'driver',
            }, {
                nodeId: 'instance:u_core',
                pinId: 'instance:u_core:clk',
                role: 'load',
            }],
        }, {
            id: 'network:data',
            name: 'bus_data',
            adapterLabel: '[7:0]',
            width: { kind: 'known', bits: 8 },
            endpoints: [{
                nodeId: 'instance:u_core',
                pinId: 'instance:u_core:data',
                role: 'driver',
            }, {
                nodeId: 'instance:u_sink',
                pinId: 'instance:u_sink:data',
                role: 'load',
            }, {
                nodeId: 'port:shared',
                pinId: 'port:shared:shared',
                role: 'bidirectional',
            }],
        }],
        diagnostics: [],
    };
}

function testSchematicInspectorProjection(): void {
    const graph = inspectorGraph();
    assert.deepStrictEqual(
        projectSchematicInspector(graph, [], 'network:data'),
        {
            kind: 'network',
            title: 'bus_data',
            readOnly: true,
            rows: [
                { label: 'Name', value: 'bus_data' },
                { label: 'Adapter', value: '[7:0]' },
                { label: 'Width', value: '8 bits' },
                { label: 'Drivers', value: 'u_core.data' },
                { label: 'Loads', value: 'u_sink.data' },
                { label: 'Bidirectional', value: 'shared' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['instance:u_core'], undefined),
        {
            kind: 'instance',
            title: 'u_core',
            readOnly: true,
            rows: [
                { label: 'Name', value: 'u_core' },
                { label: 'Module', value: 'core' },
                { label: 'Pins', value: 'clk (input, 1 bit), data (output, 8 bits)' },
                { label: 'Definition', value: 'Available' },
                { label: 'Read-only', value: 'No' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['port:clk'], undefined),
        {
            kind: 'port',
            title: 'clk',
            readOnly: true,
            rows: [
                { label: 'Name', value: 'clk' },
                { label: 'Direction', value: 'Input' },
                { label: 'Width', value: '1 bit' },
                { label: 'Network', value: 'clk' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(
            graph,
            ['port:clk', 'instance:u_core'],
            undefined
        ),
        {
            kind: 'multiple',
            title: '2 objects selected',
            readOnly: true,
            rows: [
                { label: 'Count', value: '2' },
                { label: 'Read-only', value: 'Mixed' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['node:stale'], 'network:stale'),
        {
            kind: 'empty',
            title: 'No selection',
            readOnly: true,
            rows: [],
        }
    );
}

function testDiagnosticDetailFormatting(): void {
    assert.strictEqual(formatSchematicDiagnosticDetails([]), '');
    assert.strictEqual(formatSchematicDiagnosticDetails([{
        severity: 'error',
        code: 'HDL_BROKEN',
        message: 'Broken <declaration> & connection',
        span: { start: 1, end: 4 },
    }, {
        severity: 'warning',
        code: 'HDL_INCLUDED',
        message: 'Included source is read-only',
    }]), [
        'ERROR HDL_BROKEN: Broken <declaration> & connection',
        'WARNING HDL_INCLUDED: Included source is read-only',
    ].join('\n'));
}

function testSecureSchematicWebviewHtml(): void {
    const shell = [
        '<!doctype html>',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\';">',
        '<link rel="stylesheet" href="./index.css">',
        '<main>schematic shell</main>',
        '<script src="./index.js"></script>',
    ].join('\n');
    const html = buildSchematicWebviewHtml(shell, {
        cspSource: 'vscode-webview://schematic',
        styleUri: 'vscode-webview://schematic/index.css',
        scriptUri: 'vscode-webview://schematic/index.js',
        nonce: 'nonceValue123',
    });

    assert.match(
        html,
        /default-src 'none'; img-src vscode-webview:\/\/schematic; style-src vscode-webview:\/\/schematic 'unsafe-inline'; script-src 'nonce-nonceValue123';/
    );
    assert.ok(html.includes('href="vscode-webview://schematic/index.css"'));
    assert.ok(html.includes(
        '<script nonce="nonceValue123" src="vscode-webview://schematic/index.js"></script>'
    ));
    assert.doesNotMatch(html, /script-src 'self'/);
    assert.doesNotMatch(html, /<script(?![^>]*\bnonce=)/);
    assert.ok(html.includes('<main>schematic shell</main>'));

    assert.throws(
        () => buildSchematicWebviewHtml('<main>incomplete</main>', {
            cspSource: 'vscode-webview://schematic',
            styleUri: 'vscode-webview://schematic/index.css',
            scriptUri: 'vscode-webview://schematic/index.js',
            nonce: 'nonceValue123',
        }),
        /Content-Security-Policy placeholder/
    );
}

function layout(x: number, selectedObjectId?: string): SchematicLayout {
    return {
        placement: {
            nodes: {
                node: { column: 0, order: 0, yOffset: x, fixed: true },
            },
        },
        viewport: { x: 1, y: 2, zoom: 1 },
        minimap: true,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

function testSynchronousWebviewLayoutSnapshot(): void {
    const previous = layout(5, 'instance:previous');
    const current = layout(10, 'network:data');
    const merged = mergeSchematicWebviewLayouts(
        { 'module:previous': previous },
        'module:current',
        current
    );
    previous.placement.nodes.node.yOffset = 500;
    current.placement.nodes.node.yOffset = 1_000;

    assert.deepStrictEqual(merged, {
        'module:previous': layout(5, 'instance:previous'),
        'module:current': layout(10, 'network:data'),
    });
}

async function testModuleSafeLayoutSaveDebounce(): Promise<void> {
    let nextHandle = 0;
    const pending = new Map<number, () => void>();
    const timers: TimerAdapter<number> = {
        set(callback): number {
            nextHandle += 1;
            pending.set(nextHandle, callback);
            return nextHandle;
        },
        clear(handle): void {
            pending.delete(handle);
        },
    };
    const saves: Array<{
        moduleKey: string;
        revision: string;
        layout: SchematicLayout;
    }> = [];
    const scheduler = new DebouncedLayoutSaveScheduler(
        250,
        (moduleKey, revision, savedLayout) => saves.push({
            moduleKey,
            revision,
            layout: savedLayout,
        }),
        timers
    );
    const runPending = (): void => {
        for (const [handle, callback] of [...pending]) {
            pending.delete(handle);
            callback();
        }
    };

    const moduleA = layout(10);
    scheduler.schedule('module:a', 'revision:a1', moduleA);
    moduleA.placement.nodes.node.yOffset = 999;
    scheduler.schedule('module:b', 'revision:b1', layout(30));
    assert.strictEqual(pending.size, 2, 'module B must not cancel module A');

    runPending();
    assert.deepStrictEqual(saves.map(save => [
        save.moduleKey,
        save.revision,
        save.layout.placement.nodes.node.yOffset,
    ]), [
        ['module:a', 'revision:a1', 10],
        ['module:b', 'revision:b1', 30],
    ]);

    scheduler.schedule('module:a', 'revision:a1', layout(40));
    scheduler.schedule('module:a', 'revision:a2', layout(50));
    assert.strictEqual(pending.size, 1, 'same-module changes must debounce');
    runPending();
    assert.deepStrictEqual(saves.at(-1), {
        moduleKey: 'module:a',
        revision: 'revision:a2',
        layout: layout(50),
    });

    const flushedA = layout(60);
    scheduler.schedule('module:a', 'revision:a3', flushedA);
    flushedA.placement.nodes.node.yOffset = 600;
    scheduler.schedule('module:b', 'revision:b2', layout(70));
    scheduler.flush();
    assert.strictEqual(pending.size, 0);
    assert.deepStrictEqual(saves.slice(-2), [{
        moduleKey: 'module:a',
        revision: 'revision:a3',
        layout: layout(60),
    }, {
        moduleKey: 'module:b',
        revision: 'revision:b2',
        layout: layout(70),
    }]);
    const saveCountAfterFlush = saves.length;
    runPending();
    assert.strictEqual(saves.length, saveCountAfterFlush);

    scheduler.schedule('module:a', 'revision:a-before-switch', layout(75));
    scheduler.schedule('module:b', 'revision:b-still-pending', layout(76));
    scheduler.flushModule('module:a');
    assert.deepStrictEqual(saves.at(-1), {
        moduleKey: 'module:a',
        revision: 'revision:a-before-switch',
        layout: layout(75),
    });
    assert.strictEqual(pending.size, 1, 'module B must remain pending');
    runPending();
    assert.deepStrictEqual(saves.at(-1), {
        moduleKey: 'module:b',
        revision: 'revision:b-still-pending',
        layout: layout(76),
    });
    const saveCountAfterModuleFlush = saves.length;

    scheduler.schedule('module:a', 'revision:a4', layout(80));
    scheduler.dispose();
    assert.strictEqual(pending.size, 0);
    assert.strictEqual(saves.length, saveCountAfterModuleFlush);
}

function testExactCellNavigationCommands(): void {
    const span = { uri: 'file:///top.sv', start: 12, end: 19 };
    const reveal = navigationCommandForCell({ sourceSpan: span }, false);
    assert.deepStrictEqual(reveal, { type: 'revealSource', span });
    if (reveal?.type === 'revealSource') assert.strictEqual(reveal.span, span);

    const definitionKey = 'module:file:///child.sv:44';
    assert.deepStrictEqual(
        navigationCommandForCell({ sourceSpan: span, definitionKey }, true),
        { type: 'openDefinition', definitionKey }
    );
    assert.strictEqual(
        navigationCommandForCell({ sourceSpan: span }, true),
        undefined
    );
    assert.strictEqual(
        navigationCommandForCell({ definitionKey }, false),
        undefined
    );
    assert.strictEqual(
        navigationCommandForCell({ definitionKey: '' }, true),
        undefined
    );
}

function testSelectionStatusSummary(): void {
    assert.deepStrictEqual(
        summarizeSchematicSelection([]),
        { statusText: 'No selection' }
    );
    assert.deepStrictEqual(summarizeSchematicSelection([{
        objectId: 'network:data',
        description: 'network: data',
    }]), {
        selectedObjectId: 'network:data',
        statusText: 'network: data',
    });
    assert.deepStrictEqual(summarizeSchematicSelection([{
        objectId: 'instance:new',
        description: 'instance: new',
    }]), {
        selectedObjectId: 'instance:new',
        statusText: 'instance: new',
    });
    assert.deepStrictEqual(summarizeSchematicSelection([
        { objectId: 'port:a', description: 'port: a' },
        { objectId: 'instance:new', description: 'instance: new' },
    ]), {
        selectedObjectId: 'instance:new',
        statusText: '2 objects selected',
    });
}

void Promise.resolve()
    .then(testSecureSchematicWebviewHtml)
    .then(testDiagnosticDetailFormatting)
    .then(testSchematicInspectorProjection)
    .then(testSynchronousWebviewLayoutSnapshot)
    .then(testSelectionStatusSummary)
    .then(testExactCellNavigationCommands)
    .then(testModuleSafeLayoutSaveDebounce)
    .then(() => console.log('schematic webview support tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
