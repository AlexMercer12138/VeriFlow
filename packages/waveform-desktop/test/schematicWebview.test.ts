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

test('schematic runtime renders every visible pin label with a valid clip path', {
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
                    graph,
                    layout: {
                        nodes: {
                            [selectedNodeId]: { x: 320, y: 180, fixed: false },
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
                const reference = text?.getAttribute('clip-path') ?? '';
                const match = /^url\(#(.+)\)$/.exec(reference);
                const clipId = match?.[1] ?? '';
                return {
                    text: text
                        ? [...text.querySelectorAll('tspan')]
                            .map(node => node.textContent ?? '')
                            .join('')
                        : '',
                    clipId,
                    clipExists: clipId !== ''
                        && document.getElementById(clipId)?.tagName.toLowerCase()
                            === 'clippath',
                };
            })
        );
        assert.equal(renderedLabels.length, pins.length);
        assert.deepEqual(
            renderedLabels.map(label => label.text).sort(),
            pins.map(pin => pin.name).sort()
        );
        assert.equal(new Set(renderedLabels.map(label => label.clipId)).size, pins.length);
        assert.ok(renderedLabels.every(label => label.clipExists));
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});
