import * as assert from 'assert';

import type { SchematicLayout } from '../schematic/layoutStore';
import {
    buildSchematicWebviewHtml,
    DebouncedLayoutSaveScheduler,
    formatSchematicDiagnosticDetails,
    mergeSchematicWebviewLayouts,
    navigationCommandForCell,
    placeSchematicNetworkLabel,
    summarizeSchematicSelection,
    type SchematicRect,
    type TimerAdapter,
} from '../schematic/webviewSupport';

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
        nodes: { node: { x, y: 20, fixed: true } },
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
    previous.nodes.node.x = 500;
    current.nodes.node.x = 1_000;

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
    moduleA.nodes.node.x = 999;
    scheduler.schedule('module:b', 'revision:b1', layout(30));
    assert.strictEqual(pending.size, 2, 'module B must not cancel module A');

    runPending();
    assert.deepStrictEqual(saves.map(save => [
        save.moduleKey,
        save.revision,
        save.layout.nodes.node.x,
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
    flushedA.nodes.node.x = 600;
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

    scheduler.schedule('module:a', 'revision:a4', layout(80));
    scheduler.dispose();
    assert.strictEqual(pending.size, 0);
    assert.strictEqual(saves.length, saveCountAfterFlush);
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

function rectanglesOverlap(left: SchematicRect, right: SchematicRect): boolean {
    return left.x < right.x + right.width
        && left.x + left.width > right.x
        && left.y < right.y + right.height
        && left.y + left.height > right.y;
}

function testNonLabelSegmentSkipsPlacementScan(): void {
    const nodeBounds = new Proxy([] as SchematicRect[], {
        get(): never {
            throw new Error('node bounds scanned');
        },
    });
    let placement: ReturnType<typeof placeSchematicNetworkLabel> | undefined;

    assert.doesNotThrow(() => {
        placement = placeSchematicNetworkLabel(
            [{ x: 0, y: 0 }, { x: 100, y: 0 }],
            nodeBounds,
            'fanout',
            1
        );
    }, 'a non-label fanout segment must not scan node bounds');
    assert.strictEqual(placement, undefined);
}

function testNetworkLabelPlacementAvoidsNodes(): void {
    const route = [
        { x: 20, y: 100 },
        { x: 160, y: 100 },
        { x: 160, y: 220 },
        { x: 300, y: 220 },
    ];
    const nodeBounds = [
        { x: 0, y: 76, width: 40, height: 48 },
        { x: 105, y: 130, width: 110, height: 60 },
        { x: 280, y: 196, width: 40, height: 48 },
    ];
    const placement = placeSchematicNetworkLabel(
        route,
        nodeBounds,
        'long_fanout_control_bus'
    );

    assert.notStrictEqual(placement.position.distance, 0.5);
    assert.ok(
        nodeBounds.every(node => !rectanglesOverlap(placement.bounds, node)),
        'the complete label rectangle must avoid every node rectangle'
    );
    assert.deepStrictEqual(
        placeSchematicNetworkLabel(route, nodeBounds, 'long_fanout_control_bus'),
        placement,
        'identical graph geometry must produce identical label placement'
    );
}

void Promise.resolve()
    .then(testSecureSchematicWebviewHtml)
    .then(testDiagnosticDetailFormatting)
    .then(testSynchronousWebviewLayoutSnapshot)
    .then(testNonLabelSegmentSkipsPlacementScan)
    .then(testNetworkLabelPlacementAvoidsNodes)
    .then(testSelectionStatusSummary)
    .then(testExactCellNavigationCommands)
    .then(testModuleSafeLayoutSaveDebounce)
    .then(() => console.log('schematic webview support tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
