import * as assert from 'assert';

import { parseWebviewCommand } from '../schematic/protocol';

function assertRejected(value: unknown): void {
    let result: ReturnType<typeof parseWebviewCommand>;
    assert.doesNotThrow(() => {
        result = parseWebviewCommand(value);
    });
    assert.strictEqual(result!, undefined);
}

function testInitialContract(): void {
    assert.deepStrictEqual(parseWebviewCommand({ type: 'ready' }), { type: 'ready' });
    assert.deepStrictEqual(
        parseWebviewCommand({ type: 'selectModule', moduleKey: 'file#module:top:0' }),
        { type: 'selectModule', moduleKey: 'file#module:top:0' }
    );
    for (const value of [
        null,
        {},
        { type: 'selectModule' },
        { type: 'revealSource', span: { start: -1, end: 2 } },
    ]) {
        assert.strictEqual(parseWebviewCommand(value), undefined);
    }
}

function testEveryCommandAndSanitization(): void {
    assert.deepStrictEqual(
        parseWebviewCommand({ type: 'ready', ignored: true }),
        { type: 'ready' }
    );
    assert.deepStrictEqual(
        parseWebviewCommand({ type: 'selectModule', moduleKey: '  module:key  ', ignored: 1 }),
        { type: 'selectModule', moduleKey: '  module:key  ' }
    );
    assert.deepStrictEqual(
        parseWebviewCommand({
            type: 'openDefinition',
            definitionKey: 'definition:child',
            ignored: true,
        }),
        { type: 'openDefinition', definitionKey: 'definition:child' }
    );
    assert.deepStrictEqual(
        parseWebviewCommand({ type: 'search', query: '', ignored: true }),
        { type: 'search', query: '' }
    );
    assert.deepStrictEqual(
        parseWebviewCommand({ type: 'search', query: '  child*  ' }),
        { type: 'search', query: '  child*  ' }
    );
    assert.deepStrictEqual(
        parseWebviewCommand({ type: 'relayoutAll', moduleKey: 'module:top', ignored: true }),
        { type: 'relayoutAll', moduleKey: 'module:top' }
    );

    for (const value of [
        { type: 'selectModule', moduleKey: '' },
        { type: 'selectModule', moduleKey: ' \t ' },
        { type: 'openDefinition', definitionKey: '' },
        { type: 'openDefinition', definitionKey: '   ' },
        { type: 'relayoutAll', moduleKey: '' },
        { type: 'relayoutAll', moduleKey: '\r\n' },
        { type: 'search' },
        { type: 'search', query: 4 },
    ]) {
        assertRejected(value);
    }
}

function testLayoutValidation(): void {
    const parsed = parseWebviewCommand({
        type: 'saveLayout',
        moduleKey: 'module:top',
        layout: {
            nodes: {
                '': { x: -1, y: -2, fixed: false },
                '  ': { x: 3, y: 4, fixed: true },
                first: { x: 12, y: -8, fixed: true, edgePoints: [{ x: 1, y: 2 }] },
                second: { x: 0, y: 0, fixed: false, ignored: 'value' },
            },
            viewport: { x: -5, y: 9, zoom: 99, ignored: true },
            minimap: false,
            selectedObjectId: '',
            edges: { first: [{ x: 3, y: 4 }] },
            feedbackRoutes: [{ networkId: 'secret' }],
            ignored: true,
        },
        ignored: true,
    });
    assert.deepStrictEqual(parsed, {
        type: 'saveLayout',
        moduleKey: 'module:top',
        layout: {
            nodes: {
                '': { x: -1, y: -2, fixed: false },
                '  ': { x: 3, y: 4, fixed: true },
                first: { x: 12, y: -8, fixed: true },
                second: { x: 0, y: 0, fixed: false },
            },
            viewport: { x: -5, y: 9, zoom: 4 },
            minimap: false,
            selectedObjectId: '',
        },
    });
    assert.deepStrictEqual(
        parseWebviewCommand({
            type: 'saveLayout',
            moduleKey: 'module:top',
            layout: {
                nodes: {},
                viewport: { x: 0, y: 0, zoom: -50 },
                minimap: true,
            },
        }),
        {
            type: 'saveLayout',
            moduleKey: 'module:top',
            layout: {
                nodes: {},
                viewport: { x: 0, y: 0, zoom: 0.1 },
                minimap: true,
            },
        }
    );

    const invalidLayouts = [
        null,
        { nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, minimap: true },
        { nodes: {}, viewport: null, minimap: true },
        { nodes: {}, viewport: { x: Number.NaN, y: 0, zoom: 1 }, minimap: true },
        { nodes: {}, viewport: { x: 0, y: Number.POSITIVE_INFINITY, zoom: 1 }, minimap: true },
        { nodes: {}, viewport: { x: 0, y: 0, zoom: Number.NEGATIVE_INFINITY }, minimap: true },
        { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 }, minimap: 'yes' },
        {
            nodes: { bad: { x: Number.NaN, y: 0, fixed: false } },
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
        {
            nodes: { bad: { x: 0, y: Number.POSITIVE_INFINITY, fixed: false } },
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
        {
            nodes: { bad: { x: 0, y: 0, fixed: 'false' } },
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
        {
            nodes: {},
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
            selectedObjectId: 12,
        },
    ];
    for (const layout of invalidLayouts) {
        assertRejected({ type: 'saveLayout', moduleKey: 'module:top', layout });
    }
    assertRejected({
        type: 'saveLayout',
        moduleKey: '  ',
        layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 }, minimap: true },
    });
}

function testLayoutBreadthLimit(): void {
    const boundedNodes: Record<string, unknown> = {};
    for (let index = 0; index < 50_000; index += 1) {
        boundedNodes[`node:${index}`] = { x: index, y: 0, fixed: false };
    }
    const atLimit = parseWebviewCommand({
        type: 'saveLayout',
        moduleKey: 'module:at-limit',
        layout: {
            nodes: boundedNodes,
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });
    assert.strictEqual(atLimit?.type, 'saveLayout');

    boundedNodes['node:50000'] = { x: 50_000, y: 0, fixed: false };
    const overLimit = parseWebviewCommand({
        type: 'saveLayout',
        moduleKey: 'module:over-limit',
        layout: {
            nodes: boundedNodes,
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });
    assert.strictEqual(overLimit?.type, undefined);

    const inheritedNodePrototype: Record<string, unknown> = {};
    for (let index = 0; index <= 100_000; index += 1) {
        inheritedNodePrototype[`inherited:${index}`] = { x: index, y: 0, fixed: false };
    }
    const inheritedOnlyNodes = Object.create(inheritedNodePrototype);
    const inheritedOverLimit = parseWebviewCommand({
        type: 'saveLayout',
        moduleKey: 'module:inherited-over-limit',
        layout: {
            nodes: inheritedOnlyNodes,
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });
    assert.strictEqual(inheritedOverLimit?.type, undefined);
}

function testSourceSpanValidation(): void {
    assert.deepStrictEqual(
        parseWebviewCommand({
            type: 'revealSource',
            span: { start: 3, end: 8, ignored: true },
            ignored: true,
        }),
        { type: 'revealSource', span: { start: 3, end: 8 } }
    );
    assert.deepStrictEqual(
        parseWebviewCommand({
            type: 'revealSource',
            span: {
                start: 0,
                end: 15,
                uri: 'file:///main.sv',
                compositeParts: [
                    { uri: 'file:///main.sv', start: 0, end: 5, ignored: true },
                    { uri: 'file:///main.sv', start: 5, end: 10 },
                    { uri: 'file:///include.svh', start: 100, end: 110 },
                    { uri: 'file:///main.sv', start: 10, end: 15 },
                ],
                ignored: true,
            },
        }),
        {
            type: 'revealSource',
            span: {
                start: 0,
                end: 15,
                uri: 'file:///main.sv',
                compositeParts: [
                    { uri: 'file:///main.sv', start: 0, end: 5 },
                    { uri: 'file:///main.sv', start: 5, end: 10 },
                    { uri: 'file:///include.svh', start: 100, end: 110 },
                    { uri: 'file:///main.sv', start: 10, end: 15 },
                ],
            },
        }
    );
    assert.deepStrictEqual(
        parseWebviewCommand({
            type: 'revealSource',
            span: { start: 0, end: 0, compositeParts: [] },
        }),
        { type: 'revealSource', span: { start: 0, end: 0, compositeParts: [] } }
    );

    const invalidSpans = [
        null,
        { start: -1, end: 2 },
        { start: 2, end: 1 },
        { start: 0.5, end: 2 },
        { start: 0, end: Number.NaN },
        { start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY },
        { start: 0, end: 1, uri: '' },
        { start: 0, end: 1, uri: '  ' },
        { start: 0, end: 1, compositeParts: null },
        { start: 0, end: 1, compositeParts: [{}] },
        { start: 0, end: 1, compositeParts: [{ uri: '', start: 0, end: 1 }] },
        { start: 0, end: 1, compositeParts: [{ uri: 'file:///a.sv', start: 2, end: 1 }] },
        { start: 0, end: 1, compositeParts: [{ uri: 'file:///a.sv', start: 0, end: 0.5 }] },
        {
            start: 0,
            end: 10,
            compositeParts: [
                { uri: 'file:///a.sv', start: 0, end: 5 },
                { uri: 'file:///a.sv', start: 4, end: 8 },
            ],
        },
        {
            start: 0,
            end: 10,
            compositeParts: [
                { uri: 'file:///a.sv', start: 0, end: 5 },
                { uri: 'file:///include.svh', start: 20, end: 25 },
                { uri: 'file:///a.sv', start: 4, end: 8 },
            ],
        },
    ];
    for (const span of invalidSpans) {
        assertRejected({ type: 'revealSource', span });
    }
}

function testCompositePartsBreadthLimit(): void {
    const overLimitParts = Array.from({ length: 5_001 }, (_, index) => ({
        uri: 'file:///large.sv',
        start: index,
        end: index,
    }));
    const parsed = parseWebviewCommand({
        type: 'revealSource',
        span: { start: 0, end: 5_001, compositeParts: overLimitParts },
    });
    assert.strictEqual(parsed?.type, undefined);

    const customIteratorParts: unknown[] = [];
    let iteratorAccesses = 0;
    Object.defineProperty(customIteratorParts, Symbol.iterator, {
        get(): never {
            iteratorAccesses += 1;
            throw new Error('composite iterator must not be accessed');
        },
    });
    assert.deepStrictEqual(
        parseWebviewCommand({
            type: 'revealSource',
            span: { start: 0, end: 0, compositeParts: customIteratorParts },
        }),
        { type: 'revealSource', span: { start: 0, end: 0, compositeParts: [] } }
    );
    assert.strictEqual(iteratorAccesses, 0);

    assertRejected({
        type: 'revealSource',
        span: { start: 0, end: 1, compositeParts: new Array(1) },
    });
}

function testHostileInputs(): void {
    for (const value of [
        undefined,
        true,
        1,
        1n,
        Symbol('message'),
        'ready',
        [],
        () => undefined,
        { type: 1 },
        { type: '' },
        { type: 'deleteSource' },
        { type: 'unknown', moduleKey: 'module:top' },
    ]) {
        assertRejected(value);
    }

    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.type = 'selectModule';
    nullPrototype.moduleKey = 'module:null-prototype';
    assert.deepStrictEqual(parseWebviewCommand(nullPrototype), {
        type: 'selectModule',
        moduleKey: 'module:null-prototype',
    });

    const inheritedCommand = Object.create({
        type: 'selectModule',
        moduleKey: 'module:inherited',
    });
    assertRejected(inheritedCommand);

    const inheritedNode = Object.create({ x: 0, y: 0, fixed: false });
    assertRejected({
        type: 'saveLayout',
        moduleKey: 'module:inherited-node',
        layout: {
            nodes: { inherited: inheritedNode },
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });

    const ownProto = { type: 'ready' } as Record<string, unknown>;
    Object.defineProperty(ownProto, '__proto__', {
        value: { polluted: true },
        enumerable: true,
    });
    const parsedOwnProto = parseWebviewCommand(ownProto)!;
    assert.deepStrictEqual(parsedOwnProto, { type: 'ready' });
    assert.strictEqual(Object.getPrototypeOf(parsedOwnProto), Object.prototype);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(parsedOwnProto, '__proto__'), false);
    assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined);

    const specialNodes = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(specialNodes, '__proto__', {
        value: { x: 1, y: 2, fixed: false },
        enumerable: true,
    });
    const parsedSpecialNode = parseWebviewCommand({
        type: 'saveLayout',
        moduleKey: 'module:special',
        layout: {
            nodes: specialNodes,
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });
    assert.strictEqual(parsedSpecialNode?.type, 'saveLayout');
    if (parsedSpecialNode?.type === 'saveLayout') {
        assert.strictEqual(Object.getPrototypeOf(parsedSpecialNode.layout.nodes), Object.prototype);
        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(parsedSpecialNode.layout.nodes, '__proto__'),
            true
        );
        assert.deepStrictEqual(parsedSpecialNode.layout.nodes['__proto__'], {
            x: 1,
            y: 2,
            fixed: false,
        });
    }
    assert.strictEqual(({} as { x?: number }).x, undefined);

    const cyclic: Record<string, unknown> = { type: 'ready' };
    cyclic.self = cyclic;
    assert.deepStrictEqual(parseWebviewCommand(cyclic), { type: 'ready' });

    const cyclicNode: Record<string, unknown> = {};
    cyclicNode.self = cyclicNode;
    assertRejected({
        type: 'saveLayout',
        moduleKey: 'module:cycle',
        layout: {
            nodes: { cycle: cyclicNode },
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });

    const throwingType = {};
    Object.defineProperty(throwingType, 'type', {
        get(): never {
            throw new Error('hostile type getter');
        },
        enumerable: true,
    });
    assertRejected(throwingType);

    const throwingX = { y: 0, fixed: false };
    Object.defineProperty(throwingX, 'x', {
        get(): never {
            throw new Error('hostile coordinate getter');
        },
        enumerable: true,
    });
    assertRejected({
        type: 'saveLayout',
        moduleKey: 'module:getter',
        layout: {
            nodes: { hostile: throwingX },
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });

    const throwingEntries = new Proxy({}, {
        ownKeys(): never {
            throw new Error('hostile ownKeys trap');
        },
    });
    assertRejected({
        type: 'saveLayout',
        moduleKey: 'module:proxy',
        layout: {
            nodes: throwingEntries,
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: true,
        },
    });

    const sparseHugeParts = new Array(100_000);
    assertRejected({
        type: 'revealSource',
        span: { start: 0, end: 1, compositeParts: sparseHugeParts },
    });
}

async function main(): Promise<void> {
    testInitialContract();
    testEveryCommandAndSanitization();
    testLayoutValidation();
    testLayoutBreadthLimit();
    testSourceSpanValidation();
    testCompositePartsBreadthLimit();
    testHostileInputs();

    console.log('Schematic protocol tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
