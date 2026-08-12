import * as assert from 'assert';

import { MAX_SCHEMATIC_PLACEMENT_OFFSET } from '@veriflow/schematic-core';

import {
    MAX_SCHEMATIC_LAYOUT_COLUMN,
    MAX_SCHEMATIC_LAYOUT_NODES,
} from '../schematic/layoutStore';
import { parseWebviewCommand } from '../schematic/protocol';

const TEST_REVISION = 'snapshot:test';

function assertRejected(value: unknown): void {
    let result: ReturnType<typeof parseWebviewCommand>;
    assert.doesNotThrow(() => {
        result = parseWebviewCommand(value);
    });
    assert.strictEqual(result!, undefined);
}

function semanticLayout(nodes: Record<string, unknown> = {}): unknown {
    return {
        placement: { nodes },
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    };
}

function saveCommand(layout: unknown = semanticLayout()): unknown {
    return {
        type: 'saveLayout',
        moduleKey: 'module:top',
        revision: TEST_REVISION,
        layout,
    };
}

function testCommandsRemainStable(): void {
    assert.deepStrictEqual(parseWebviewCommand({ type: 'ready', ignored: true }), {
        type: 'ready',
    });
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'selectModule',
        moduleKey: 'module:top',
    }), { type: 'selectModule', moduleKey: 'module:top' });
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'openDefinition',
        definitionKey: 'definition:child',
    }), { type: 'openDefinition', definitionKey: 'definition:child' });
    assert.deepStrictEqual(parseWebviewCommand({ type: 'search', query: 'child*' }), {
        type: 'search', query: 'child*',
    });
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'relayoutAll',
        moduleKey: 'module:top',
        revision: 'graph:4',
    }), { type: 'relayoutAll', moduleKey: 'module:top', revision: 'graph:4' });
    for (const value of [
        null,
        {},
        { type: 'selectModule', moduleKey: '  ' },
        { type: 'openDefinition', definitionKey: '' },
        { type: 'search', query: 4 },
        { type: 'relayoutAll', moduleKey: '' },
        { type: 'relayoutAll', moduleKey: 'module:top', revision: '' },
    ]) assertRejected(value);
}

function testArchDesignCommands(): void {
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'editArchDesign',
        revision: 'ad:4',
        edit: {
            type: 'addInstance',
            instance: {
                name: 'u_core',
                module: 'core',
                parameters: { WIDTH: 8 },
                ignored: true,
            },
            ignored: true,
        },
        ignored: true,
    }), {
        type: 'editArchDesign',
        revision: 'ad:4',
        edit: {
            type: 'addInstance',
            instance: { name: 'u_core', module: 'core', parameters: { WIDTH: 8 } },
        },
    });
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'editArchDesign',
        revision: 'ad:4',
        edit: {
            type: 'connect',
            source: { kind: 'port', port: 'clk', ignored: true },
            target: { kind: 'instance', instance: 'u_core', port: 'clk' },
        },
    }), {
        type: 'editArchDesign',
        revision: 'ad:4',
        edit: {
            type: 'connect',
            source: { kind: 'port', port: 'clk' },
            target: { kind: 'instance', instance: 'u_core', port: 'clk' },
        },
    });
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'editArchDesign',
        revision: 'ad:4',
        edit: {
            type: 'setPresentation',
            presentation: {
                nodes: {
                    'instance:u_core': {
                        column: 2,
                        order: 1,
                        offset: -8,
                        userPositioned: true,
                    },
                },
                viewport: { x: 1, y: 2, zoom: 1.5 },
            },
        },
    }), {
        type: 'editArchDesign',
        revision: 'ad:4',
        edit: {
            type: 'setPresentation',
            presentation: {
                nodes: {
                    'instance:u_core': {
                        column: 2,
                        order: 1,
                        offset: -8,
                        userPositioned: true,
                    },
                },
                viewport: { x: 1, y: 2, zoom: 1.5 },
            },
        },
    });
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'exportArchDesign', revision: 'ad:4', ignored: true,
    }), { type: 'exportArchDesign', revision: 'ad:4' });

    for (const value of [
        { type: 'editArchDesign', revision: '', edit: { type: 'removePort', name: 'clk' } },
        { type: 'editArchDesign', revision: 'ad:4', edit: null },
        { type: 'editArchDesign', revision: 'ad:4', edit: { type: 'unknown' } },
        {
            type: 'editArchDesign', revision: 'ad:4',
            edit: { type: 'addPort', port: { name: 'clk', direction: 'sideways' } },
        },
        {
            type: 'editArchDesign', revision: 'ad:4',
            edit: {
                type: 'setInstanceParameter',
                instance: 'u_core',
                parameter: 'WIDTH',
                value: { object: true },
            },
        },
        { type: 'exportArchDesign', revision: 4 },
    ]) assertRejected(value);
}

function testSemanticPlacementPayload(): void {
    const parsed = parseWebviewCommand(saveCommand({
        placement: {
            nodes: {
                first: {
                    column: 2,
                    order: 1,
                    yOffset: -12,
                    fixed: true,
                    ignored: true,
                },
                second: {
                    column: 1,
                    order: 0,
                    yOffset: 0,
                    fixed: false,
                },
            },
            ignored: true,
        },
        viewport: { x: -5, y: 9, zoom: 99, ignored: true },
        minimap: false,
        selectedObjectId: '',
        ignored: true,
    }));
    assert.deepStrictEqual(parsed, {
        type: 'saveLayout',
        moduleKey: 'module:top',
        revision: TEST_REVISION,
        layout: {
            placement: {
                nodes: {
                    first: { column: 2, order: 1, yOffset: -12, fixed: true },
                    second: { column: 1, order: 0, yOffset: 0, fixed: false },
                },
            },
            viewport: { x: -5, y: 9, zoom: 4 },
            minimap: false,
            selectedObjectId: '',
        },
    });
    assertRejected(saveCommand({
        nodes: { first: { x: 10, y: 20, fixed: true } },
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    }));
}

function testPlacementBounds(): void {
    const validNode = { column: 0, order: 0, yOffset: 0, fixed: true };
    for (const yOffset of [
        -MAX_SCHEMATIC_PLACEMENT_OFFSET,
        MAX_SCHEMATIC_PLACEMENT_OFFSET,
    ]) {
        assert.strictEqual(parseWebviewCommand(saveCommand(semanticLayout({
            valid: { ...validNode, yOffset },
        })))?.type, 'saveLayout');
    }
    const invalidNodes = [
        { ...validNode, column: -1 },
        { ...validNode, column: 0.5 },
        { ...validNode, column: MAX_SCHEMATIC_LAYOUT_COLUMN },
        { ...validNode, order: -1 },
        { ...validNode, order: MAX_SCHEMATIC_LAYOUT_NODES },
        { ...validNode, yOffset: Number.NaN },
        { ...validNode, yOffset: Number.POSITIVE_INFINITY },
        { ...validNode, yOffset: MAX_SCHEMATIC_PLACEMENT_OFFSET + 1 },
        { ...validNode, yOffset: -MAX_SCHEMATIC_PLACEMENT_OFFSET - 1 },
        { ...validNode, fixed: 'true' },
    ];
    for (const invalid of invalidNodes) {
        assertRejected(saveCommand(semanticLayout({ invalid })));
    }
    for (const invalid of [
        null,
        { placement: { nodes: [] }, viewport: { x: 0, y: 0, zoom: 1 }, minimap: true },
        { placement: { nodes: {} }, viewport: null, minimap: true },
        { placement: { nodes: {} }, viewport: { x: Number.NaN, y: 0, zoom: 1 }, minimap: true },
        { placement: { nodes: {} }, viewport: { x: 0, y: 0, zoom: 1 }, minimap: 'yes' },
        { placement: { nodes: {} }, viewport: { x: 0, y: 0, zoom: 1 }, minimap: true, selectedObjectId: 1 },
    ]) assertRejected(saveCommand(invalid));
}

function testBreadthAndPrototypeSafety(): void {
    const atLimit: Record<string, unknown> = {};
    for (let index = 0; index < MAX_SCHEMATIC_LAYOUT_NODES; index += 1) {
        atLimit[`node:${index}`] = {
            column: 0,
            order: index,
            yOffset: 0,
            fixed: false,
        };
    }
    assert.strictEqual(parseWebviewCommand(saveCommand(semanticLayout(atLimit)))?.type,
        'saveLayout');
    atLimit.extra = { column: 0, order: 0, yOffset: 0, fixed: false };
    assertRejected(saveCommand(semanticLayout(atLimit)));

    const specialNodes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(specialNodes, '__proto__', {
        value: { column: 0, order: 0, yOffset: 2, fixed: true },
        enumerable: true,
    });
    const parsed = parseWebviewCommand(saveCommand(semanticLayout(specialNodes)));
    assert.strictEqual(parsed?.type, 'saveLayout');
    if (parsed?.type === 'saveLayout') {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(
            parsed.layout.placement.nodes,
            '__proto__'
        ), true);
        assert.deepStrictEqual(parsed.layout.placement.nodes['__proto__'], {
            column: 0, order: 0, yOffset: 2, fixed: true,
        });
    }
    assert.strictEqual(({} as { fixed?: boolean }).fixed, undefined);
}

function testRevisionAndSourceSpanValidation(): void {
    assert.deepStrictEqual(parseWebviewCommand(saveCommand()), saveCommand());
    for (const revision of [undefined, '', '  ', 1, null]) {
        assertRejected({
            type: 'saveLayout',
            moduleKey: 'module:top',
            revision,
            layout: semanticLayout(),
        });
    }
    assert.deepStrictEqual(parseWebviewCommand({
        type: 'revealSource',
        span: {
            start: 10,
            end: 20,
            uri: 'file:///defs.svh',
            compositeParts: [{ uri: 'file:///part.svh', start: 2, end: 4 }],
        },
    }), {
        type: 'revealSource',
        span: {
            start: 10,
            end: 20,
            uri: 'file:///defs.svh',
            compositeParts: [{ uri: 'file:///part.svh', start: 2, end: 4 }],
        },
    });
    for (const span of [
        { start: -1, end: 2 },
        { start: 3, end: 2 },
        { start: 0, end: 1, uri: '' },
        { start: 0, end: 1, compositeParts: [{}] },
        { start: 0, end: 1, compositeParts: new Array(5_001) },
    ]) assertRejected({ type: 'revealSource', span });
}

function testHostileInputs(): void {
    const throwingType = {};
    Object.defineProperty(throwingType, 'type', {
        get(): never {
            throw new Error('hostile type getter');
        },
        enumerable: true,
    });
    assertRejected(throwingType);

    const throwingPlacement = {};
    Object.defineProperty(throwingPlacement, 'nodes', {
        get(): never {
            throw new Error('hostile nodes getter');
        },
        enumerable: true,
    });
    assertRejected(saveCommand({
        placement: throwingPlacement,
        viewport: { x: 0, y: 0, zoom: 1 },
        minimap: true,
    }));
    const throwingKeys = new Proxy({}, {
        ownKeys(): never {
            throw new Error('hostile ownKeys trap');
        },
    });
    assertRejected(saveCommand(semanticLayout(throwingKeys)));
}

async function main(): Promise<void> {
    testCommandsRemainStable();
    testArchDesignCommands();
    testSemanticPlacementPayload();
    testPlacementBounds();
    testBreadthAndPrototypeSafety();
    testRevisionAndSourceSpanValidation();
    testHostileInputs();

    console.log('Schematic protocol tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
