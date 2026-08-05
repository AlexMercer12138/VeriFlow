import * as assert from 'assert';

import type { SchematicLayout } from '../schematic/layoutStore';
import {
    DebouncedLayoutSaveScheduler,
    navigationCommandForCell,
    placeSchematicNetworkLabel,
    summarizeSchematicSelection,
    type SchematicPoint,
    type SchematicRect,
    type TimerAdapter,
} from '../schematic/webviewSupport';

function layout(x: number): SchematicLayout {
    return {
        nodes: { node: { x, y: 20, fixed: true } },
        viewport: { x: 1, y: 2, zoom: 1 },
        minimap: true,
    };
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
    const saves: Array<{ moduleKey: string; layout: SchematicLayout }> = [];
    const scheduler = new DebouncedLayoutSaveScheduler(
        250,
        (moduleKey, savedLayout) => saves.push({ moduleKey, layout: savedLayout }),
        timers
    );
    const runPending = (): void => {
        for (const [handle, callback] of [...pending]) {
            pending.delete(handle);
            callback();
        }
    };

    const moduleA = layout(10);
    scheduler.schedule('module:a', moduleA);
    moduleA.nodes.node.x = 999;
    scheduler.schedule('module:b', layout(30));
    assert.strictEqual(pending.size, 2, 'module B must not cancel module A');

    runPending();
    assert.deepStrictEqual(saves.map(save => [
        save.moduleKey,
        save.layout.nodes.node.x,
    ]), [
        ['module:a', 10],
        ['module:b', 30],
    ]);

    scheduler.schedule('module:a', layout(40));
    scheduler.schedule('module:a', layout(50));
    assert.strictEqual(pending.size, 1, 'same-module changes must debounce');
    runPending();
    assert.deepStrictEqual(saves.at(-1), {
        moduleKey: 'module:a',
        layout: layout(50),
    });

    scheduler.schedule('module:a', layout(60));
    scheduler.schedule('module:b', layout(70));
    scheduler.dispose();
    assert.strictEqual(pending.size, 0);
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
    .then(testNetworkLabelPlacementAvoidsNodes)
    .then(testSelectionStatusSummary)
    .then(testExactCellNavigationCommands)
    .then(testModuleSafeLayoutSaveDebounce)
    .then(() => console.log('schematic webview support tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
