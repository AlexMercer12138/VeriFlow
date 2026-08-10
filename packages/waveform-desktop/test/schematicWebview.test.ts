import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _electron as electron } from 'playwright';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const schematicHtml = process.env.VERIFLOW_SCHEMATIC_HTML
    ?? path.join(repositoryRoot, 'web-dist', 'schematic', 'index.html');

function electronEnvironment(schematicPath: string): Record<string, string> {
    return {
        ...Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => (
                typeof entry[1] === 'string'
            ))
        ),
        VERIFLOW_SCHEMATIC_HTML: schematicPath,
    };
}

function createElectronFixture(): string {
    const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-schematic-'));
    writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
        private: true,
        main: 'main.cjs',
    }));
    writeFileSync(path.join(fixtureRoot, 'main.cjs'), [
        "const { app, BrowserWindow } = require('electron');",
        'app.whenReady().then(async () => {',
        '  const window = new BrowserWindow({',
        '    show: false,',
        '    width: 900,',
        '    height: 640,',
        '    webPreferences: { contextIsolation: true, nodeIntegration: false },',
        '  });',
        '  await window.loadFile(process.env.VERIFLOW_SCHEMATIC_HTML);',
        '});',
        "app.on('window-all-closed', () => app.quit());",
        '',
    ].join('\n'));
    return fixtureRoot;
}

test('schematic runtime renders every visible pin label in a local clip viewport', {
    timeout: 20_000,
}, async () => {
    const fixtureRoot = createElectronFixture();
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-schematic-user-'));
    const electronApp = await electron.launch({
        args: [fixtureRoot, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: electronEnvironment(schematicHtml),
    });
    try {
        const page = await electronApp.firstWindow();
        page.setDefaultTimeout(5_000);
        const rendererErrors: string[] = [];
        page.on('pageerror', error => rendererErrors.push(error.message));
        await page.locator('[data-testid="schematic-shell"]').waitFor();

        const nodeId = 'instance:u_runtime';
        const pins = [
            { name: 'clock', direction: 'load' },
            { name: 'result', direction: 'driver' },
            { name: 'shared', direction: 'bidirectional' },
        ] as const;
        await page.evaluate(({ selectedNodeId, selectedPins }) => {
            const graph = {
                fileUri: 'file:///runtime.sv',
                moduleKey: 'module:runtime:0',
                moduleName: 'runtime',
                nodes: [{
                    id: selectedNodeId,
                    kind: 'instance',
                    label: 'u_runtime',
                    subtitle: 'runtime_block',
                    pins: selectedPins.map(pin => ({
                        id: `${selectedNodeId}:${pin.name}`,
                        name: pin.name,
                        direction: pin.direction,
                        width: { kind: 'known', bits: 1 },
                        readOnly: false,
                    })),
                    readOnly: false,
                }],
                networks: [],
                diagnostics: [],
            };
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'initialize',
                    modules: [{ key: graph.moduleKey, name: graph.moduleName }],
                    selectedModuleKey: graph.moduleKey,
                },
            }));
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'graph',
                    revision: 'fixture:pin-labels',
                    graph,
                    layout: {
                        placement: {
                            nodes: {
                                [selectedNodeId]: {
                                    column: 0,
                                    order: 0,
                                    yOffset: 0,
                                    fixed: false,
                                },
                            },
                        },
                        viewport: { x: 0, y: 0, zoom: 1 },
                        minimap: false,
                    },
                },
            }));
        }, { selectedNodeId: nodeId, selectedPins: pins });

        await page.locator(`.x6-node[data-cell-id="${nodeId}"]`).waitFor();
        assert.equal(await page.locator('.x6-port').count(), pins.length);
        const renderedLabels = await page.locator('.x6-port-label').evaluateAll(labels =>
            labels.map(label => {
                const text = label.querySelector('text');
                const clip = text?.closest('svg.veriflow-pin-clip');
                return {
                    text: text
                        ? [...text.querySelectorAll('tspan')]
                            .map(node => node.textContent ?? '')
                            .join('')
                        : '',
                    clipWidth: Number(clip?.getAttribute('width') ?? 0),
                    clipHeight: Number(clip?.getAttribute('height') ?? 0),
                    clipOverflow: clip?.getAttribute('overflow') ?? '',
                };
            })
        );
        assert.equal(renderedLabels.length, pins.length);
        assert.deepEqual(
            renderedLabels.map(label => label.text).sort(),
            pins.map(pin => pin.name).sort()
        );
        assert.ok(renderedLabels.every(label =>
            label.clipWidth > 0
            && label.clipHeight > 0
            && label.clipOverflow === 'hidden'
        ));
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('schematic runtime separates wide adjacent-column nodes and clips labels', {
    timeout: 20_000,
}, async () => {
    const fixtureRoot = createElectronFixture();
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-schematic-user-'));
    const electronApp = await electron.launch({
        args: [fixtureRoot, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: electronEnvironment(schematicHtml),
    });
    try {
        const page = await electronApp.firstWindow();
        page.setDefaultTimeout(5_000);
        await page.locator('[data-testid="schematic-shell"]').waitFor();

        const firstId = 'instance:wide-source';
        const secondId = 'instance:wide-sink';
        const wideTitle = 'W'.repeat(25);
        await page.evaluate(({ firstNodeId, secondNodeId, title }) => {
            const graph = {
                fileUri: 'file:///wide-runtime.sv',
                moduleKey: 'module:wide-runtime:0',
                moduleName: 'wide_runtime',
                nodes: [
                    {
                        id: firstNodeId,
                        kind: 'instance',
                        label: title,
                        pins: [{
                            id: `${firstNodeId}:out`,
                            name: 'out',
                            direction: 'driver',
                            width: { kind: 'known', bits: 1 },
                            readOnly: false,
                        }],
                        readOnly: false,
                    },
                    {
                        id: secondNodeId,
                        kind: 'instance',
                        label: title,
                        pins: [{
                            id: `${secondNodeId}:in`,
                            name: 'in',
                            direction: 'load',
                            width: { kind: 'known', bits: 1 },
                            readOnly: false,
                        }],
                        readOnly: false,
                    },
                ],
                networks: [{
                    id: 'network:wide',
                    name: 'wide',
                    width: { kind: 'known', bits: 1 },
                    endpoints: [
                        { nodeId: firstNodeId, pinId: `${firstNodeId}:out`, role: 'driver' },
                        { nodeId: secondNodeId, pinId: `${secondNodeId}:in`, role: 'load' },
                    ],
                }],
                diagnostics: [],
            };
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'initialize',
                    modules: [{ key: graph.moduleKey, name: graph.moduleName }],
                    selectedModuleKey: graph.moduleKey,
                },
            }));
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'graph',
                    revision: 'fixture:wide-nodes',
                    graph,
                    layout: {
                        placement: {
                            nodes: {
                                [firstNodeId]: {
                                    column: 0,
                                    order: 0,
                                    yOffset: 0,
                                    fixed: false,
                                },
                                [secondNodeId]: {
                                    column: 1,
                                    order: 0,
                                    yOffset: 0,
                                    fixed: false,
                                },
                            },
                        },
                        viewport: { x: 0, y: 0, zoom: 1 },
                        minimap: false,
                    },
                },
            }));
        }, {
            firstNodeId: firstId,
            secondNodeId: secondId,
            title: wideTitle,
        });

        const firstBody = page.locator(
            `.x6-node[data-cell-id="${firstId}"] rect`
        ).first();
        const secondBody = page.locator(
            `.x6-node[data-cell-id="${secondId}"] rect`
        ).first();
        await firstBody.waitFor();
        await secondBody.waitFor();
        const firstBounds = await firstBody.boundingBox();
        const secondBounds = await secondBody.boundingBox();
        assert.ok(firstBounds && secondBounds);
        const horizontalGap = secondBounds.x - (firstBounds.x + firstBounds.width);
        assert.ok(
            horizontalGap >= 0,
            `wide adjacent-column nodes overlap by ${-horizontalGap}px`
        );
        const firstWidth = Number(await firstBody.getAttribute('width'));
        const secondWidth = Number(await secondBody.getAttribute('width'));
        assert.ok(firstWidth > 0);
        assert.equal(firstWidth, secondWidth);
        const fittedTitle = await page.locator(
            `.x6-node[data-cell-id="${firstId}"] .veriflow-title-clip`
        ).evaluate(clip => {
            const text = clip.querySelector('text');
            return {
                value: text?.textContent ?? '',
                renderedWidth: text instanceof SVGTextContentElement
                    ? text.getComputedTextLength()
                    : Number.POSITIVE_INFINITY,
                clipWidth: Number(clip.getAttribute('width') ?? 0),
            };
        });
        assert.ok(fittedTitle.value.endsWith('...'));
        assert.ok(fittedTitle.renderedWidth <= fittedTitle.clipWidth);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('schematic minimap keeps clipping local to each graph view', {
    timeout: 20_000,
}, async () => {
    const fixtureRoot = createElectronFixture();
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-schematic-user-'));
    const electronApp = await electron.launch({
        args: [fixtureRoot, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: electronEnvironment(schematicHtml),
    });
    try {
        const page = await electronApp.firstWindow();
        page.setDefaultTimeout(5_000);
        await page.locator('[data-testid="schematic-shell"]').waitFor();

        const firstId = 'instance:minimap-source';
        const secondId = 'instance:minimap-sink';
        await page.evaluate(({ firstNodeId, secondNodeId }) => {
            const node = (
                id: string,
                label: string,
                pinName: string,
                direction: 'driver' | 'load'
            ) => ({
                id,
                kind: 'instance',
                label,
                subtitle: `${label}_subtitle`,
                pins: [{
                    id: `${id}:${pinName}`,
                    name: pinName,
                    direction,
                    width: { kind: 'known', bits: 1 },
                    readOnly: false,
                }],
                readOnly: false,
            });
            const graph = {
                fileUri: 'file:///minimap-runtime.sv',
                moduleKey: 'module:minimap-runtime:0',
                moduleName: 'minimap_runtime',
                nodes: [
                    node(firstNodeId, 'minimap_source', 'out', 'driver'),
                    node(secondNodeId, 'minimap_sink', 'in', 'load'),
                ],
                networks: [{
                    id: 'network:minimap',
                    name: 'minimap',
                    width: { kind: 'known', bits: 1 },
                    endpoints: [
                        { nodeId: firstNodeId, pinId: `${firstNodeId}:out`, role: 'driver' },
                        { nodeId: secondNodeId, pinId: `${secondNodeId}:in`, role: 'load' },
                    ],
                }],
                diagnostics: [],
            };
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'initialize',
                    modules: [{ key: graph.moduleKey, name: graph.moduleName }],
                    selectedModuleKey: graph.moduleKey,
                },
            }));
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'graph',
                    revision: 'fixture:minimap',
                    graph,
                    layout: {
                        placement: {
                            nodes: {
                                [firstNodeId]: {
                                    column: 0,
                                    order: 0,
                                    yOffset: 0,
                                    fixed: false,
                                },
                                [secondNodeId]: {
                                    column: 1,
                                    order: 0,
                                    yOffset: 1_000,
                                    fixed: true,
                                },
                            },
                        },
                        viewport: { x: 0, y: 0, zoom: 1 },
                        minimap: true,
                    },
                },
            }));
        }, { firstNodeId: firstId, secondNodeId: secondId });

        await page.locator('#minimap .x6-node').first().waitFor();
        assert.equal(await page.locator('#canvas .x6-node').count(), 2);
        assert.equal(await page.locator('#minimap .x6-node').count(), 2);
        const clipping = await page.evaluate(() => {
            const definitions = [...document.querySelectorAll('clipPath[id]')];
            const ids = definitions.map(definition => definition.id);
            const references = [...document.querySelectorAll('[clip-path^="url(#"]')]
                .map(element => {
                    const reference = element.getAttribute('clip-path') ?? '';
                    const id = /^url\(#(.+)\)$/.exec(reference)?.[1] ?? '';
                    const ownerSvg = element.closest('svg');
                    return {
                        id,
                        documentDefinitions: definitions.filter(item => item.id === id).length,
                        localDefinitions: ownerSvg
                            ? [...ownerSvg.querySelectorAll('clipPath[id]')]
                                .filter(item => item.id === id).length
                            : 0,
                    };
                });
            const wrappers = [...document.querySelectorAll('.veriflow-text-clip')]
                .map(element => ({
                    tagName: element.tagName.toLowerCase(),
                    overflow: element.getAttribute('overflow'),
                    classes: [...element.classList],
                }));
            return { ids, references, wrappers };
        });
        assert.equal(
            new Set(clipping.ids).size,
            clipping.ids.length,
            'clipPath ids must be globally unique across main and minimap SVGs'
        );
        assert.equal(clipping.ids.length, 0);
        assert.equal(clipping.references.length, 0);
        assert.ok(clipping.references.every(reference =>
            reference.id !== ''
            && reference.documentDefinitions === 1
            && reference.localDefinitions === 1
        ));
        for (const role of ['title', 'subtitle', 'pin']) {
            const matching = clipping.wrappers.filter(wrapper =>
                wrapper.classes.includes(`veriflow-${role}-clip`)
            );
            assert.equal(matching.length, 4);
            assert.ok(matching.every(wrapper =>
                wrapper.tagName === 'svg' && wrapper.overflow === 'hidden'
            ));
        }
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('schematic drag preserves active search selection and viewport', {
    timeout: 20_000,
}, async () => {
    const fixtureRoot = createElectronFixture();
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-schematic-user-'));
    const electronApp = await electron.launch({
        args: [fixtureRoot, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: electronEnvironment(schematicHtml),
    });
    try {
        const page = await electronApp.firstWindow();
        page.setDefaultTimeout(5_000);
        const rendererErrors: string[] = [];
        page.on('pageerror', error => rendererErrors.push(error.message));
        await page.locator('[data-testid="schematic-shell"]').waitFor();
        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
            window.addEventListener('veriflow:webview-message', event => {
                state.__veriflowMessages.push((event as CustomEvent).detail);
            });
        });

        const firstId = 'instance:match-first';
        const secondId = 'instance:match-second';
        await page.evaluate(({ firstNodeId, secondNodeId }) => {
            const graph = {
                fileUri: 'file:///search-drag-runtime.sv',
                moduleKey: 'module:search-drag-runtime:0',
                moduleName: 'search_drag_runtime',
                nodes: [
                    {
                        id: firstNodeId,
                        kind: 'instance',
                        label: 'match_first',
                        pins: [],
                        readOnly: false,
                    },
                    {
                        id: secondNodeId,
                        kind: 'instance',
                        label: 'match_second',
                        pins: [],
                        readOnly: false,
                    },
                ],
                networks: [],
                diagnostics: [],
            };
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'initialize',
                    modules: [{ key: graph.moduleKey, name: graph.moduleName }],
                    selectedModuleKey: graph.moduleKey,
                },
            }));
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'graph',
                    revision: 'fixture:search-drag',
                    graph,
                    layout: {
                        placement: {
                            nodes: {
                                [firstNodeId]: {
                                    column: 0,
                                    order: 0,
                                    yOffset: 0,
                                    fixed: false,
                                },
                                [secondNodeId]: {
                                    column: 0,
                                    order: 1,
                                    yOffset: 0,
                                    fixed: false,
                                },
                            },
                        },
                        viewport: { x: 0, y: 0, zoom: 1 },
                        minimap: false,
                    },
                },
            }));
        }, { firstNodeId: firstId, secondNodeId: secondId });

        const secondBody = page.locator(
            `.x6-node[data-cell-id="${secondId}"] rect`
        ).first();
        await secondBody.waitFor();
        await page.locator('#search-button').click();
        await page.locator('#search-input').fill('match');
        await page.locator('#search-next-button').click();
        await page.locator('#selection-status').getByText(
            'instance: match_second (2/2)',
            { exact: true }
        ).waitFor();
        await page.waitForFunction(selectedObjectId => {
            const state = window as unknown as { __veriflowMessages: Array<{
                type?: string;
                layout?: { selectedObjectId?: string };
            }> };
            const saves = state.__veriflowMessages.filter(
                message => message.type === 'saveLayout'
            );
            return saves[saves.length - 1]?.layout?.selectedObjectId
                === selectedObjectId;
        }, secondId);

        const before = await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: Array<{
                type?: string;
                layout?: {
                    viewport?: { x: number; y: number; zoom: number };
                    selectedObjectId?: string;
                };
            }> };
            const saves = state.__veriflowMessages.filter(
                message => message.type === 'saveLayout'
            );
            const layout = saves[saves.length - 1]?.layout;
            return {
                saveCount: saves.length,
                viewport: layout?.viewport,
                selectedObjectId: layout?.selectedObjectId,
            };
        });
        assert.equal(before.selectedObjectId, secondId);
        assert.ok(before.viewport);

        const bounds = await secondBody.boundingBox();
        assert.ok(bounds);
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        await secondBody.dispatchEvent('mousedown', {
            button: 0,
            buttons: 1,
            clientX: centerX,
            clientY: centerY,
        });
        await page.evaluate(({ x, y }) => {
            const dispatchMouse = (
                type: 'mousemove' | 'mouseup',
                clientY: number,
                buttons: number
            ): void => {
                const target = document.elementFromPoint(x, clientY) ?? document.body;
                target.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    button: 0,
                    buttons,
                    clientX: x,
                    clientY,
                    view: window,
                }));
            };
            for (let step = 1; step <= 8; step += 1) {
                dispatchMouse('mousemove', y + step * 12, 1);
            }
            dispatchMouse('mouseup', y + 96, 0);
        }, { x: centerX, y: centerY });
        await page.waitForFunction(previousSaveCount => {
            const state = window as unknown as { __veriflowMessages: Array<{
                type?: string;
            }> };
            return state.__veriflowMessages.filter(
                message => message.type === 'saveLayout'
            ).length > previousSaveCount;
        }, before.saveCount);
        await page.waitForTimeout(400);

        const after = await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: Array<{
                type?: string;
                layout?: {
                    placement?: { nodes?: Record<string, {
                        fixed?: boolean;
                        yOffset?: number;
                    }> };
                    viewport?: { x: number; y: number; zoom: number };
                    selectedObjectId?: string;
                };
            }> };
            const saves = state.__veriflowMessages.filter(
                message => message.type === 'saveLayout'
            );
            return {
                saveCount: saves.length,
                layout: saves[saves.length - 1]?.layout,
            };
        });

        assert.equal(await page.locator('#search-input').inputValue(), 'match');
        assert.equal(
            await page.locator('#selection-status').textContent(),
            'instance: match_second (2/2)'
        );
        assert.equal(after.saveCount, before.saveCount + 1);
        assert.equal(after.layout?.selectedObjectId, secondId);
        assert.deepEqual(after.layout?.viewport, before.viewport);
        assert.equal(after.layout?.placement?.nodes?.[secondId]?.fixed, true);
        assert.notEqual(after.layout?.placement?.nodes?.[secondId]?.yOffset, 0);
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});
