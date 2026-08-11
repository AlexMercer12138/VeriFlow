import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _electron as electron, type Locator, type Page } from 'playwright';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const schematicHtml = process.env.VERIFLOW_SCHEMATIC_HTML
    ?? path.join(repositoryRoot, 'web-dist', 'schematic', 'index.html');
const screenshotRoot = process.env.VERIFLOW_SCHEMATIC_SCREENSHOT_DIR
    ?? path.join(os.tmpdir(), 'veriflow-schematic-visual');
const pageTimeoutMs = 10_000;

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

type CapturedSchematicLayout = {
    placement?: {
        nodes?: Record<string, {
            column?: number;
            order?: number;
            yOffset?: number;
            fixed?: boolean;
        }>;
    };
    viewport?: { x: number; y: number; zoom: number };
    selectedObjectId?: string;
};

type CapturedSaveMessage = {
    type?: string;
    revision?: string;
    layout?: CapturedSchematicLayout;
};

async function capturedSaves(page: Page): Promise<CapturedSaveMessage[]> {
    return page.evaluate(() => {
        const state = window as unknown as {
            __veriflowMessages: CapturedSaveMessage[];
        };
        return state.__veriflowMessages.filter(message => message.type === 'saveLayout');
    });
}

async function inspectorRows(page: Page): Promise<Record<string, string>> {
    return page.locator('#inspector-properties').evaluate(properties =>
        Object.fromEntries([...properties.querySelectorAll('dt')].map(term => [
            term.textContent ?? '',
            term.nextElementSibling?.textContent ?? '',
        ]))
    );
}

async function dragElement(
    page: Page,
    targetOrSelector: Locator | string,
    deltaX: number,
    deltaY: number
): Promise<void> {
    const target = typeof targetOrSelector === 'string'
        ? page.locator(targetOrSelector)
        : targetOrSelector;
    await target.waitFor();
    const bounds = await target.boundingBox();
    assert.ok(bounds, `missing drag bounds for ${String(targetOrSelector)}`);
    const startX = bounds.x + bounds.width / 2;
    const startY = bounds.y + bounds.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
        await page.mouse.move(
            startX + deltaX * step / 8,
            startY + deltaY * step / 8
        );
    }
    await page.mouse.up();
}

async function verticalNodeOrder(page: Page, nodeIds: readonly string[]): Promise<string[]> {
    const centers = await Promise.all(nodeIds.map(async nodeId => {
        const bounds = await page.locator(
            `.x6-node[data-cell-id="${nodeId}"] rect`
        ).first().boundingBox();
        assert.ok(bounds, `missing node bounds for ${nodeId}`);
        return { nodeId, y: bounds.y + bounds.height / 2 };
    }));
    return centers.sort((left, right) => left.y - right.y
        || left.nodeId.localeCompare(right.nodeId)).map(entry => entry.nodeId);
}

type VisualPinDirection = 'driver' | 'load';

function visualSchematicFixture() {
    const pin = (nodeId: string, name: string, direction: VisualPinDirection) => ({
        id: `${nodeId}:${name}`,
        name,
        direction,
        width: { kind: 'known', bits: 1 },
        readOnly: false,
    });
    const node = (
        id: string,
        kind: 'port' | 'instance',
        label: string,
        pins: readonly (readonly [string, VisualPinDirection])[],
        subtitle?: string
    ) => ({
        id,
        kind,
        label,
        subtitle,
        pins: pins.map(([name, direction]) => pin(id, name, direction)),
        readOnly: false,
    });
    const inputA = node('port:visual-input-a', 'port', 'input_a', [['value', 'driver']]);
    const inputB = node('port:visual-input-b', 'port', 'input_b', [['value', 'driver']]);
    const wide = node(
        'instance:visual-wide',
        'instance',
        'wide_source_with_a_title_that_must_stay_inside_the_module',
        [
            ['seed_input_with_a_long_name', 'load'],
            ['lane_a_output_with_a_long_name', 'driver'],
            ['lane_b_output', 'driver'],
            ['lane_c_output', 'driver'],
            ['fanout_output', 'driver'],
            ['cross_a_output', 'driver'],
            ['spare_input', 'load'],
            ['spare_output', 'driver'],
        ],
        'wide_source_subtitle_that_is_intentionally_long'
    );
    const crossSource = node('instance:visual-cross-source', 'instance', 'cross_source', [
        ['seed', 'load'],
        ['cross_b_output', 'driver'],
    ]);
    const top = node('instance:visual-top', 'instance', 'top_stage', [
        ['lane_a', 'load'],
        ['fanout', 'load'],
        ['cross_b', 'load'],
        ['result', 'driver'],
    ]);
    const middle = node('instance:visual-middle', 'instance', 'middle_stage', [
        ['lane_b', 'load'],
        ['fanout', 'load'],
    ]);
    const bottom = node('instance:visual-bottom', 'instance', 'bottom_stage', [
        ['lane_c', 'load'],
        ['fanout', 'load'],
        ['cross_a', 'load'],
    ]);
    const output = node('port:visual-output', 'port', 'result_out', [['value', 'load']]);
    const feedbackTopDriver = node(
        'instance:visual-feedback-top-driver',
        'instance',
        'feedback_top_driver',
        [['out', 'driver']]
    );
    const feedbackTopLoad = node(
        'instance:visual-feedback-top-load',
        'instance',
        'feedback_top_load',
        [['in', 'load']]
    );
    const feedbackBottomDriver = node(
        'instance:visual-feedback-bottom-driver',
        'instance',
        'feedback_bottom_driver',
        [['out', 'driver']]
    );
    const feedbackBottomLoad = node(
        'instance:visual-feedback-bottom-load',
        'instance',
        'feedback_bottom_load',
        [['in', 'load']]
    );
    const empty = node('instance:visual-empty', 'instance', 'empty_island', []);
    const endpoint = (selectedNode: ReturnType<typeof node>, index: number) => ({
        nodeId: selectedNode.id,
        pinId: selectedNode.pins[index].id,
        role: selectedNode.pins[index].direction,
    });
    const network = (
        id: string,
        name: string,
        selected: readonly (readonly [ReturnType<typeof node>, number])[]
    ) => ({
        id,
        name,
        width: { kind: 'known', bits: 1 },
        endpoints: selected.map(([selectedNode, index]) => endpoint(selectedNode, index)),
    });
    const graph = {
        fileUri: 'file:///visual-runtime.sv',
        moduleKey: 'module:visual-runtime:0',
        moduleName: 'visual_runtime',
        nodes: [
            inputA,
            inputB,
            wide,
            crossSource,
            top,
            middle,
            bottom,
            feedbackTopDriver,
            feedbackTopLoad,
            feedbackBottomDriver,
            feedbackBottomLoad,
            empty,
            output,
        ],
        networks: [
            network('network:visual-seed-a', 'seed_a', [[inputA, 0], [wide, 0]]),
            network('network:visual-seed-b', 'seed_b', [[inputB, 0], [crossSource, 0]]),
            network('network:visual-lane-a', 'lane_a_long_visible_name', [[wide, 1], [top, 0]]),
            network('network:visual-lane-b', 'lane_b', [[wide, 2], [middle, 0]]),
            network('network:visual-lane-c', 'lane_c', [[wide, 3], [bottom, 0]]),
            network('network:visual-fanout', 'fanout', [
                [wide, 4],
                [top, 1],
                [middle, 1],
                [bottom, 1],
            ]),
            network('network:visual-cross-a', 'cross_a', [[wide, 5], [bottom, 2]]),
            network('network:visual-cross-b', 'cross_b', [[crossSource, 1], [top, 2]]),
            network('network:visual-result', 'result', [[top, 3], [output, 0]]),
            network('network:visual-feedback-top', 'feedback_top', [
                [feedbackTopDriver, 0],
                [feedbackTopLoad, 0],
            ]),
            network('network:visual-feedback-bottom', 'feedback_bottom', [
                [feedbackBottomDriver, 0],
                [feedbackBottomLoad, 0],
            ]),
        ],
        diagnostics: [],
    };
    const fixed = (column: number, order: number, yOffset = 0) => ({
        column,
        order,
        yOffset,
        fixed: true,
    });
    return {
        graph,
        layout: {
            placement: {
                nodes: {
                    [wide.id]: fixed(1, 1),
                    [crossSource.id]: fixed(1, 2),
                    [top.id]: fixed(2, 1),
                    [middle.id]: fixed(2, 2),
                    [bottom.id]: fixed(2, 3),
                    [feedbackTopLoad.id]: fixed(1, 0, -100),
                    [feedbackTopDriver.id]: fixed(2, 0, -100),
                    [feedbackBottomLoad.id]: fixed(1, 3, 160),
                    [feedbackBottomDriver.id]: fixed(2, 4, 160),
                    [empty.id]: fixed(1, 4, 240),
                },
            },
            viewport: { x: 24, y: 24, zoom: 1 },
            minimap: true,
        },
    };
}

async function actualCanvasPixelStats(page: Page): Promise<{
    width: number;
    height: number;
    nonBackgroundPixels: number;
    inkPixels: number;
    coloredPixels: number;
}> {
    const screenshot = await page.locator('#canvas').screenshot({ type: 'png' });
    return page.evaluate(async base64 => {
        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('2D raster context unavailable');
        context.drawImage(image, 0, 0);
        image.close();
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const histogram = new Map<number, number>();
        let backgroundPixels = 0;
        let inkPixels = 0;
        let coloredPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            const key = (red << 16) | (green << 8) | blue;
            const count = (histogram.get(key) ?? 0) + 1;
            histogram.set(key, count);
            backgroundPixels = Math.max(backgroundPixels, count);
            if (red * 3 + green * 6 + blue < 180 * 10) inkPixels += 1;
            if (Math.max(red, green, blue) - Math.min(red, green, blue) > 35) {
                coloredPixels += 1;
            }
        }
        return {
            width: canvas.width,
            height: canvas.height,
            nonBackgroundPixels: canvas.width * canvas.height - backgroundPixels,
            inkPixels,
            coloredPixels,
        };
    }, screenshot.toString('base64'));
}

async function renderedGeometry(page: Page): Promise<{
    nodeCount: number;
    edgeCount: number;
    labelCount: number;
    pinCount: number;
    textOverflow: string[];
    pinOverflow: string[];
    segmentNodeIntersections: string[];
    differentNetworkOverlaps: string[];
    junctionCount: number;
    fanoutJunctionIds: string[];
    junctionDirectionFailures: string[];
    documentOverflow: boolean;
    toolbarOverlaps: string[];
    portTitles: Record<string, string>;
    portTitleOverflow: string[];
    nodeBorderContrast: number;
    textContrast: number;
    wireContrast: number;
}> {
    return page.evaluate(() => {
        type Point = { x: number; y: number };
        type Segment = {
            id: string;
            networkId: string;
            start: Point;
            end: Point;
        };
        const tolerance = 0.75;
        const contains = (outer: DOMRect, inner: DOMRect): boolean =>
            inner.left >= outer.left - tolerance
            && inner.top >= outer.top - tolerance
            && inner.right <= outer.right + tolerance
            && inner.bottom <= outer.bottom + tolerance;
        const overlaps = (left: DOMRect, right: DOMRect): boolean =>
            Math.max(left.left, right.left) < Math.min(left.right, right.right) - tolerance
            && Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom) - tolerance;
        const screenPoint = (path: SVGPathElement, point: DOMPoint): Point => {
            const matrix = path.getScreenCTM();
            if (!matrix) throw new Error('edge path has no screen transform');
            const transformed = point.matrixTransform(matrix);
            return { x: transformed.x, y: transformed.y };
        };
        const svgViewportBounds = (element: SVGSVGElement): DOMRect => {
            const matrix = element.getScreenCTM();
            if (!matrix) throw new Error('text clip has no screen transform');
            const width = element.width.baseVal.value;
            const height = element.height.baseVal.value;
            const corners = [
                new DOMPoint(0, 0),
                new DOMPoint(width, 0),
                new DOMPoint(width, height),
                new DOMPoint(0, height),
            ].map(point => point.matrixTransform(matrix));
            const xs = corners.map(point => point.x);
            const ys = corners.map(point => point.y);
            const left = Math.min(...xs);
            const top = Math.min(...ys);
            return new DOMRect(
                left,
                top,
                Math.max(...xs) - left,
                Math.max(...ys) - top
            );
        };
        const segments: Segment[] = [...document.querySelectorAll<SVGGElement>(
            '#canvas .x6-edge[data-cell-id]'
        )].map(cell => {
            const path = cell.querySelector<SVGPathElement>(':scope > path:nth-child(2)');
            if (!path || path.getTotalLength() <= 0) {
                throw new Error(`edge ${cell.dataset.cellId} has no rendered path`);
            }
            const id = cell.dataset.cellId ?? '';
            return {
                id,
                networkId: id.replace(/:segment:\d+$/, ''),
                start: screenPoint(path, path.getPointAtLength(0)),
                end: screenPoint(path, path.getPointAtLength(path.getTotalLength())),
            };
        });
        const nodeCells = [...document.querySelectorAll<SVGGElement>(
            '#canvas .x6-node[data-cell-id]'
        )].filter(cell => !(cell.dataset.cellId ?? '').includes(':junction:'));
        const nodeBodies = nodeCells.map(cell => {
            const body = cell.querySelector<SVGRectElement>(':scope > rect');
            if (!body) throw new Error(`node ${cell.dataset.cellId} has no body`);
            return { id: cell.dataset.cellId ?? '', bounds: body.getBoundingClientRect() };
        });
        const segmentNodeIntersections = segments.flatMap(segment => {
            const horizontal = Math.abs(segment.start.y - segment.end.y) <= tolerance;
            const vertical = Math.abs(segment.start.x - segment.end.x) <= tolerance;
            if (!horizontal && !vertical) return [`${segment.id}:non-orthogonal`];
            return nodeBodies.flatMap(node => {
                const crosses = horizontal
                    ? segment.start.y > node.bounds.top + tolerance
                        && segment.start.y < node.bounds.bottom - tolerance
                        && Math.max(
                            Math.min(segment.start.x, segment.end.x),
                            node.bounds.left + tolerance
                        ) < Math.min(
                            Math.max(segment.start.x, segment.end.x),
                            node.bounds.right - tolerance
                        ) - tolerance
                    : segment.start.x > node.bounds.left + tolerance
                        && segment.start.x < node.bounds.right - tolerance
                        && Math.max(
                            Math.min(segment.start.y, segment.end.y),
                            node.bounds.top + tolerance
                        ) < Math.min(
                            Math.max(segment.start.y, segment.end.y),
                            node.bounds.bottom - tolerance
                        ) - tolerance;
                return crosses ? [`${segment.id}->${node.id}`] : [];
            });
        });
        const differentNetworkOverlaps: string[] = [];
        for (let left = 0; left < segments.length; left += 1) {
            for (let right = left + 1; right < segments.length; right += 1) {
                const first = segments[left];
                const second = segments[right];
                if (first.networkId === second.networkId) continue;
                const firstHorizontal = Math.abs(first.start.y - first.end.y) <= tolerance;
                const secondHorizontal = Math.abs(second.start.y - second.end.y) <= tolerance;
                const firstVertical = Math.abs(first.start.x - first.end.x) <= tolerance;
                const secondVertical = Math.abs(second.start.x - second.end.x) <= tolerance;
                const horizontalOverlap = firstHorizontal && secondHorizontal
                    && Math.abs(first.start.y - second.start.y) <= tolerance
                    && Math.max(
                        Math.min(first.start.x, first.end.x),
                        Math.min(second.start.x, second.end.x)
                    ) < Math.min(
                        Math.max(first.start.x, first.end.x),
                        Math.max(second.start.x, second.end.x)
                    ) - tolerance;
                const verticalOverlap = firstVertical && secondVertical
                    && Math.abs(first.start.x - second.start.x) <= tolerance
                    && Math.max(
                        Math.min(first.start.y, first.end.y),
                        Math.min(second.start.y, second.end.y)
                    ) < Math.min(
                        Math.max(first.start.y, first.end.y),
                        Math.max(second.start.y, second.end.y)
                    ) - tolerance;
                if (horizontalOverlap || verticalOverlap) {
                    differentNetworkOverlaps.push(`${first.id}<->${second.id}`);
                }
            }
        }
        const textOverflow = nodeCells.flatMap(cell => {
            const body = cell.querySelector<SVGRectElement>(':scope > rect')
                ?.getBoundingClientRect();
            if (!body) return [`${cell.dataset.cellId}:missing-body`];
            return [...cell.querySelectorAll<SVGSVGElement>('.veriflow-text-clip')]
                .flatMap(clip => contains(body, svgViewportBounds(clip))
                    ? []
                    : [`${cell.dataset.cellId}:${clip.className.baseVal}`]);
        });
        const pinOverflow = nodeCells.flatMap(cell => {
            const body = cell.querySelector<SVGRectElement>(':scope > rect')
                ?.getBoundingClientRect();
            if (!body) return [`${cell.dataset.cellId}:missing-body`];
            return [...cell.querySelectorAll<SVGGElement>('.x6-port')].flatMap(port => {
                const bounds = port.querySelector<SVGElement>('.x6-port-body, circle')
                    ?.getBoundingClientRect();
                if (!bounds) return [`${cell.dataset.cellId}:missing-pin-body`];
                const centerX = bounds.left + bounds.width / 2;
                const centerY = bounds.top + bounds.height / 2;
                const onSide = Math.abs(centerX - body.left) <= 4
                    || Math.abs(centerX - body.right) <= 4;
                return onSide && centerY >= body.top - tolerance && centerY <= body.bottom + tolerance
                    ? []
                    : [`${cell.dataset.cellId}:${port.getAttribute('port') ?? 'pin'}`];
            });
        });
        const portCells = nodeCells.filter(cell =>
            (cell.dataset.cellId ?? '').startsWith('port:')
        );
        const portTitles = Object.fromEntries(portCells.map(cell => {
            const title = cell.querySelector<SVGTextElement>('.veriflow-title-clip text');
            const visibleText = [...(title?.querySelectorAll(':scope > tspan') ?? [])]
                .map(node => node.textContent ?? '')
                .join('');
            return [cell.dataset.cellId ?? '', visibleText];
        }));
        const portTitleOverflow = portCells.flatMap(cell => {
            const body = cell.querySelector<SVGRectElement>(':scope > rect')
                ?.getBoundingClientRect();
            const clip = cell.querySelector<SVGSVGElement>('.veriflow-title-clip');
            if (!body || !clip) return [`${cell.dataset.cellId}:missing-title`];
            return contains(body, svgViewportBounds(clip))
                ? []
                : [`${cell.dataset.cellId}:title-overflow`];
        });
        const parseColor = (value: string): [number, number, number] => {
            const values = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
            if (!values || values.length !== 3 || values.some(Number.isNaN)) {
                throw new Error(`unsupported computed color: ${value}`);
            }
            return values as [number, number, number];
        };
        const luminance = (color: [number, number, number]): number => {
            const channels = color.map(value => {
                const normalized = value / 255;
                return normalized <= 0.04045
                    ? normalized / 12.92
                    : ((normalized + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const contrast = (foreground: string, background: string): number => {
            const first = luminance(parseColor(foreground));
            const second = luminance(parseColor(background));
            return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        };
        const background = getComputedStyle(document.querySelector('#canvas-region')!)
            .backgroundColor;
        const sampleNode = nodeCells.find(cell =>
            (cell.dataset.cellId ?? '').startsWith('instance:')
        );
        const sampleBody = sampleNode?.querySelector<SVGRectElement>(':scope > rect');
        const sampleTitle = sampleNode?.querySelector<SVGTextElement>(
            '.veriflow-title-clip text'
        );
        const sampleWire = document.querySelector<SVGPathElement>(
            '#canvas .x6-edge[data-cell-id] > path:nth-child(2)'
        );
        if (!sampleBody || !sampleTitle || !sampleWire) {
            throw new Error('contrast samples are missing');
        }
        const junctionCells = [...document.querySelectorAll<SVGGElement>(
            '#canvas .x6-node[data-cell-id*=":junction:"]'
        )];
        const fanoutJunctionIds = junctionCells
            .map(junction => junction.dataset.cellId ?? '')
            .filter(id => id.startsWith('network:visual-fanout:junction:'));
        const junctionDirectionFailures = junctionCells.flatMap(junction => {
            const id = junction.dataset.cellId ?? '';
            const networkId = id.replace(/:junction:\d+$/, '');
            const bounds = junction.getBoundingClientRect();
            const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
            const directions = new Set<string>();
            for (const segment of segments.filter(candidate => candidate.networkId === networkId)) {
                const horizontal = Math.abs(segment.start.y - segment.end.y) <= tolerance;
                const vertical = Math.abs(segment.start.x - segment.end.x) <= tolerance;
                const left = Math.min(segment.start.x, segment.end.x);
                const right = Math.max(segment.start.x, segment.end.x);
                const top = Math.min(segment.start.y, segment.end.y);
                const bottom = Math.max(segment.start.y, segment.end.y);
                if (horizontal
                    && Math.abs(segment.start.y - center.y) <= tolerance
                    && center.x >= left - tolerance
                    && center.x <= right + tolerance) {
                    if (left < center.x - tolerance) directions.add('west');
                    if (right > center.x + tolerance) directions.add('east');
                }
                if (vertical
                    && Math.abs(segment.start.x - center.x) <= tolerance
                    && center.y >= top - tolerance
                    && center.y <= bottom + tolerance) {
                    if (top < center.y - tolerance) directions.add('north');
                    if (bottom > center.y + tolerance) directions.add('south');
                }
            }
            return directions.size >= 3 ? [] : [`${id}:${[...directions].join(',')}`];
        });
        const toolbarItems = [...document.querySelectorAll<HTMLElement>(
            '#toolbar > :not([hidden])'
        )].filter(element => element.getBoundingClientRect().width > 0);
        const toolbarOverlaps: string[] = [];
        for (let left = 0; left < toolbarItems.length; left += 1) {
            for (let right = left + 1; right < toolbarItems.length; right += 1) {
                if (overlaps(
                    toolbarItems[left].getBoundingClientRect(),
                    toolbarItems[right].getBoundingClientRect()
                )) {
                    toolbarOverlaps.push(`${toolbarItems[left].id}<->${toolbarItems[right].id}`);
                }
            }
        }
        return {
            nodeCount: nodeCells.length,
            edgeCount: segments.length,
            labelCount: document.querySelectorAll('#canvas [class*="edge-label"] text').length,
            pinCount: document.querySelectorAll('#canvas .x6-port').length,
            textOverflow,
            pinOverflow,
            segmentNodeIntersections,
            differentNetworkOverlaps,
            junctionCount: junctionCells.length,
            fanoutJunctionIds,
            junctionDirectionFailures,
            documentOverflow: document.documentElement.scrollWidth
                > document.documentElement.clientWidth,
            toolbarOverlaps,
            portTitles,
            portTitleOverflow,
            nodeBorderContrast: contrast(getComputedStyle(sampleBody).stroke, background),
            textContrast: contrast(getComputedStyle(sampleTitle).fill, background),
            wireContrast: contrast(getComputedStyle(sampleWire).stroke, background),
        };
    });
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
        page.setDefaultTimeout(pageTimeoutMs);
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
        page.setDefaultTimeout(pageTimeoutMs);
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
        page.setDefaultTimeout(pageTimeoutMs);
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
        page.setDefaultTimeout(pageTimeoutMs);
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

test('schematic selection boxes persist single and rubberband batch moves once', {
    timeout: 60_000,
}, async () => {
    const fixtureRoot = createElectronFixture();
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-schematic-user-'));
    const electronApp = await electron.launch({
        args: [fixtureRoot, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: electronEnvironment(schematicHtml),
    });
    try {
        const page = await electronApp.firstWindow();
        page.setDefaultTimeout(pageTimeoutMs);
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

        const nodeIds = [
            'instance:selection-first',
            'instance:selection-second',
            'instance:selection-third',
        ] as const;
        const runtimeGraph = {
            fileUri: 'file:///selection-box-runtime.sv',
            moduleKey: 'module:selection-box-runtime:0',
            moduleName: 'selection_box_runtime',
            nodes: nodeIds.map(nodeId => ({
                id: nodeId,
                kind: 'instance',
                label: nodeId.replace('instance:selection-', ''),
                pins: [],
                readOnly: false,
            })),
            networks: [],
            diagnostics: [],
        };
        const initialLayout: CapturedSchematicLayout = {
            placement: {
                nodes: Object.fromEntries(nodeIds.map((nodeId, order) => [
                    nodeId,
                    { column: 0, order, yOffset: 0, fixed: false },
                ])),
            },
            viewport: { x: 0, y: 0, zoom: 1 },
        };
        const sendGraph = async (
            revision: string,
            layout: CapturedSchematicLayout
        ): Promise<void> => {
            await page.evaluate(({ graph, selectedLayout, selectedRevision }) => {
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
                        revision: selectedRevision,
                        graph,
                        layout: selectedLayout,
                    },
                }));
            }, { graph: runtimeGraph, selectedLayout: layout, selectedRevision: revision });
            await page.locator(
                `.x6-node[data-cell-id="${nodeIds[0]}"]`
            ).first().waitFor();
            await page.waitForFunction(expectedNodeIds => {
                const renderedIds = [...document.querySelectorAll(
                    '.x6-node[data-cell-id]'
                )].map(element => element.getAttribute('data-cell-id'));
                return renderedIds.length === expectedNodeIds.length
                    && expectedNodeIds.every(nodeId =>
                        renderedIds.filter(candidate => candidate === nodeId).length === 1
                    );
            }, nodeIds);
        };
        const clearMessages = async (): Promise<void> => {
            await page.evaluate(() => {
                const state = window as unknown as { __veriflowMessages: unknown[] };
                state.__veriflowMessages = [];
            });
        };
        const waitForSave = async (): Promise<void> => {
            await page.waitForFunction(() => {
                const state = window as unknown as {
                    __veriflowMessages: CapturedSaveMessage[];
                };
                return state.__veriflowMessages.some(
                    message => message.type === 'saveLayout'
                );
            });
            await page.waitForTimeout(400);
        };
        const dragNodeView = async (nodeId: string, deltaY: number): Promise<void> => {
            const body = page.locator(
                `.x6-node[data-cell-id="${nodeId}"] rect`
            ).first();
            const bounds = await body.boundingBox();
            assert.ok(bounds);
            const x = bounds.x + bounds.width / 2;
            const y = bounds.y + bounds.height / 2;
            await body.dispatchEvent('mousedown', {
                button: 0,
                buttons: 1,
                clientX: x,
                clientY: y,
            });
            await page.evaluate(({ clientX, clientY, dy }) => {
                for (let step = 1; step <= 8; step += 1) {
                    document.dispatchEvent(new MouseEvent('mousemove', {
                        bubbles: true,
                        button: 0,
                        buttons: 1,
                        clientX,
                        clientY: clientY + dy * step / 8,
                        view: window,
                    }));
                }
                document.dispatchEvent(new MouseEvent('mouseup', {
                    bubbles: true,
                    button: 0,
                    buttons: 0,
                    clientX,
                    clientY: clientY + dy,
                    view: window,
                }));
            }, { clientX: x, clientY: y, dy: deltaY });
        };
        const semanticOrder = (layout: CapturedSchematicLayout): string[] =>
            [...nodeIds].sort((left, right) =>
                (layout.placement?.nodes?.[left]?.order ?? 0)
                    - (layout.placement?.nodes?.[right]?.order ?? 0)
            );

        await sendGraph('fixture:selection-single', initialLayout);
        await page.locator(
            `.x6-node[data-cell-id="${nodeIds[0]}"] rect`
        ).first().click();
        const singleBoxSelector =
            `.x6-widget-selection-box[data-cell-id="${nodeIds[0]}"]`;
        const singleBox = page.locator(singleBoxSelector);
        await singleBox.waitFor();
        await page.waitForTimeout(400);
        await clearMessages();
        const singleBounds = await singleBox.boundingBox();
        const thirdBounds = await page.locator(
            `.x6-node[data-cell-id="${nodeIds[2]}"] rect`
        ).first().boundingBox();
        assert.ok(singleBounds && thirdBounds);
        await dragElement(
            page,
            singleBoxSelector,
            0,
            thirdBounds.y + thirdBounds.height + 32
                - (singleBounds.y + singleBounds.height / 2)
        );
        await waitForSave();

        const singleSaves = await capturedSaves(page);
        assert.equal(singleSaves.length, 1);
        const singleLayout = singleSaves[0].layout!;
        assert.equal(singleSaves[0].revision, 'fixture:selection-single');
        assert.equal(singleLayout.placement?.nodes?.[nodeIds[0]]?.fixed, true);
        assert.deepEqual(semanticOrder(singleLayout), [
            nodeIds[1],
            nodeIds[2],
            nodeIds[0],
        ]);
        assert.deepEqual(singleLayout.viewport, initialLayout.viewport);
        assert.equal(singleLayout.selectedObjectId, nodeIds[0]);

        await sendGraph('fixture:selection-single-reload', singleLayout);
        assert.deepEqual(await verticalNodeOrder(page, nodeIds), [
            nodeIds[1],
            nodeIds[2],
            nodeIds[0],
        ]);
        assert.equal(
            await page.locator('#selection-status').textContent(),
            'instance: first'
        );

        await sendGraph('fixture:selection-multi', initialLayout);
        await clearMessages();
        const firstBounds = await page.locator(
            `.x6-node[data-cell-id="${nodeIds[0]}"] rect`
        ).first().boundingBox();
        const secondBounds = await page.locator(
            `.x6-node[data-cell-id="${nodeIds[1]}"] rect`
        ).first().boundingBox();
        const canvasBounds = await page.locator('#canvas').boundingBox();
        assert.ok(firstBounds && secondBounds && canvasBounds);
        const startX = Math.min(
            canvasBounds.x + canvasBounds.width - 4,
            Math.max(
                firstBounds.x + firstBounds.width,
                secondBounds.x + secondBounds.width
            ) + 12
        );
        const startY = Math.max(
            canvasBounds.y + 4,
            Math.min(firstBounds.y, secondBounds.y) + 4
        );
        const endX = Math.max(
            canvasBounds.x + 4,
            Math.min(firstBounds.x, secondBounds.x) + 4
        );
        const endY = Math.max(
            firstBounds.y + firstBounds.height,
            secondBounds.y + secondBounds.height
        ) + 12;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(endX, endY, { steps: 8 });
        await page.mouse.up();
        const rubberbandSelection = await page.locator(
            '.x6-widget-selection-box[data-cell-id]'
        ).evaluateAll(elements => elements.map(element =>
            element.getAttribute('data-cell-id')
        ));
        assert.deepEqual(rubberbandSelection.sort(), [...nodeIds.slice(0, 2)].sort());
        await page.waitForTimeout(400);

        const selectionSaves = await capturedSaves(page);
        assert.equal(selectionSaves.length, 1);
        const selectionLayout = selectionSaves[0].layout;
        assert.ok(nodeIds.every(nodeId =>
            selectionLayout?.placement?.nodes?.[nodeId]?.fixed !== true
        ));
        await clearMessages();
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 0);

        await dragNodeView(nodeIds[0], 32);
        await waitForSave();
        const nodeViewSaves = await capturedSaves(page);
        assert.equal(nodeViewSaves.length, 1);
        const nodeViewLayout = nodeViewSaves[0].layout!;
        assert.equal(nodeViewLayout.placement?.nodes?.[nodeIds[0]]?.fixed, true);
        assert.equal(nodeViewLayout.placement?.nodes?.[nodeIds[1]]?.fixed, false);
        assert.equal(nodeViewLayout.placement?.nodes?.[nodeIds[2]]?.fixed, false);
        const retainedSelection = await page.locator(
            '.x6-widget-selection-box[data-cell-id]'
        ).evaluateAll(elements => elements.map(element =>
            element.getAttribute('data-cell-id')
        ));
        assert.deepEqual(retainedSelection.sort(), [...nodeIds.slice(0, 2)].sort());
        await clearMessages();

        const multiBoxSelector =
            `.x6-widget-selection-box[data-cell-id="${nodeIds[0]}"]`;
        const multiBoxBounds = await page.locator(multiBoxSelector).boundingBox();
        const stationaryThirdBounds = await page.locator(
            `.x6-node[data-cell-id="${nodeIds[2]}"] rect`
        ).first().boundingBox();
        assert.ok(multiBoxBounds && stationaryThirdBounds);
        await dragElement(
            page,
            multiBoxSelector,
            0,
            stationaryThirdBounds.y + stationaryThirdBounds.height + 48
                - (multiBoxBounds.y + multiBoxBounds.height / 2)
        );
        await waitForSave();

        const multiSaves = await capturedSaves(page);
        assert.equal(multiSaves.length, 1);
        assert.equal(multiSaves[0].revision, 'fixture:selection-multi');
        const multiLayout = multiSaves[0].layout!;
        assert.equal(multiLayout.placement?.nodes?.[nodeIds[0]]?.fixed, true);
        assert.equal(multiLayout.placement?.nodes?.[nodeIds[1]]?.fixed, true);
        assert.equal(multiLayout.placement?.nodes?.[nodeIds[2]]?.fixed, false);
        assert.deepEqual(semanticOrder(multiLayout), [
            nodeIds[2],
            nodeIds[0],
            nodeIds[1],
        ]);
        assert.deepEqual(multiLayout.viewport, initialLayout.viewport);

        await sendGraph('fixture:selection-multi-reload', multiLayout);
        assert.deepEqual(await verticalNodeOrder(page, nodeIds), [
            nodeIds[2],
            nodeIds[0],
            nodeIds[1],
        ]);
        assert.deepEqual(rendererErrors, []);

        const immediatelyClearedNodes = await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'initialize',
                    modules: [],
                    selectedModuleKey: '',
                },
            }));
            return document.querySelectorAll('.x6-node[data-cell-id]').length;
        });
        assert.equal(immediatelyClearedNodes, 0);
        await sendGraph('fixture:selection-after-clear', multiLayout);
        assert.deepEqual(await verticalNodeOrder(page, nodeIds), [
            nodeIds[2],
            nodeIds[0],
            nodeIds[1],
        ]);

        await page.waitForTimeout(400);
        await clearMessages();
        await page.evaluate(() => {
            const state = window as unknown as {
                __veriflowOriginalQueueMicrotask?: typeof window.queueMicrotask;
                __veriflowQueuedMicrotasks?: VoidFunction[];
            };
            state.__veriflowOriginalQueueMicrotask = window.queueMicrotask.bind(window);
            state.__veriflowQueuedMicrotasks = [];
            window.queueMicrotask = callback => {
                state.__veriflowQueuedMicrotasks!.push(callback);
            };
        });
        await dragNodeView(nodeIds[1], 32);
        const staleCallbackCount = await page.evaluate(() => {
            const state = window as unknown as {
                __veriflowOriginalQueueMicrotask?: typeof window.queueMicrotask;
                __veriflowQueuedMicrotasks?: VoidFunction[];
            };
            if (state.__veriflowOriginalQueueMicrotask) {
                window.queueMicrotask = state.__veriflowOriginalQueueMicrotask;
            }
            return state.__veriflowQueuedMicrotasks?.length ?? 0;
        });
        assert.equal(staleCallbackCount, 1);
        await sendGraph('fixture:selection-stale-refresh', initialLayout);
        await clearMessages();
        const executedStaleCallbacks = await page.evaluate(() => {
            const state = window as unknown as {
                __veriflowOriginalQueueMicrotask?: typeof window.queueMicrotask;
                __veriflowQueuedMicrotasks?: VoidFunction[];
            };
            const callbacks = state.__veriflowQueuedMicrotasks ?? [];
            delete state.__veriflowOriginalQueueMicrotask;
            delete state.__veriflowQueuedMicrotasks;
            callbacks.forEach(callback => callback());
            return callbacks.length;
        });
        assert.equal(executedStaleCallbacks, 1);
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 0);
        assert.deepEqual(await verticalNodeOrder(page, nodeIds), [...nodeIds]);
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('schematic runtime paints obstacle-free geometry at desktop and narrow viewports', {
    timeout: 30_000,
}, async () => {
    rmSync(screenshotRoot, { recursive: true, force: true });
    mkdirSync(screenshotRoot, { recursive: true });
    const fixtureRoot = createElectronFixture();
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-schematic-user-'));
    const electronApp = await electron.launch({
        args: [fixtureRoot, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: electronEnvironment(schematicHtml),
    });
    try {
        const page = await electronApp.firstWindow();
        page.setDefaultTimeout(pageTimeoutMs);
        const rendererErrors: string[] = [];
        page.on('pageerror', error => rendererErrors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') rendererErrors.push(message.text());
        });
        await page.locator('[data-testid="schematic-shell"]').waitFor();
        await page.evaluate(() => {
            const state = window as unknown as {
                __veriflowMessages: CapturedSaveMessage[];
            };
            state.__veriflowMessages = [];
            window.addEventListener('veriflow:webview-message', event => {
                state.__veriflowMessages.push(
                    (event as CustomEvent<CapturedSaveMessage>).detail
                );
            });
        });
        const fixture = visualSchematicFixture();
        await page.evaluate(({ graph, layout }) => {
            const root = document.documentElement.style;
            root.setProperty('--vscode-editor-background', '#181818');
            root.setProperty('--vscode-editorWidget-background', '#202020');
            root.setProperty('--vscode-editor-foreground', '#d4d4d4');
            root.setProperty('--vscode-descriptionForeground', '#a0a0a0');
            root.setProperty('--vscode-editorWidget-border', '#303030');
            root.setProperty('--vscode-panel-border', '#2b2b2b');
            root.setProperty('--vscode-focusBorder', '#4daafc');
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
                    revision: 'fixture:visual-geometry',
                    graph,
                    layout,
                },
            }));
        }, fixture);

        await page.locator('#canvas .x6-node[data-cell-id="instance:visual-wide"]').waitFor();
        await page.locator('#minimap:not([hidden]) .x6-node').first().waitFor();
        await page.locator('#selection-status').getByText(
            'No selection',
            { exact: true }
        ).waitFor();
        await page.locator('#inspector-title').getByText(
            'No selection',
            { exact: true }
        ).waitFor();
        const desktopInspectorBounds = await page.locator('#inspector').boundingBox();
        assert.ok(desktopInspectorBounds);
        assert.ok(
            desktopInspectorBounds.width >= 270 && desktopInspectorBounds.width <= 290,
            JSON.stringify(desktopInspectorBounds)
        );
        const fanoutSegments = page.locator(
            '#canvas .x6-edge[data-cell-id^="network:visual-fanout:segment:"]'
        );
        const fanoutSegmentCount = await fanoutSegments.count();
        assert.ok(fanoutSegmentCount >= 3);
        const ordinaryFanoutStroke = await fanoutSegments.first().locator(
            ':scope > path:nth-child(2)'
        ).evaluate(element => getComputedStyle(element).stroke);
        const fanoutJunction = page.locator(
            '#canvas .x6-node[data-cell-id^="network:visual-fanout:junction:"] > circle'
        ).first();
        const junctionBeforeDrag = await fanoutJunction.boundingBox();
        assert.ok(junctionBeforeDrag);
        await dragElement(page, fanoutJunction, 32, 24);
        const junctionAfterDrag = await fanoutJunction.boundingBox();
        assert.ok(junctionAfterDrag);
        assert.ok(
            Math.abs(junctionAfterDrag.x - junctionBeforeDrag.x) < 0.5
                && Math.abs(junctionAfterDrag.y - junctionBeforeDrag.y) < 0.5,
            JSON.stringify({ junctionBeforeDrag, junctionAfterDrag })
        );
        await fanoutSegments.first().locator(
            ':scope > path[stroke="transparent"][cursor="pointer"]'
        ).evaluate(element => {
            const path = element as SVGPathElement;
            const matrix = path.getScreenCTM();
            if (!matrix) throw new Error('fanout hit path has no screen transform');
            const midpoint = path.getPointAtLength(path.getTotalLength() / 2)
                .matrixTransform(matrix);
            const dispatch = (type: 'mousedown' | 'mouseup' | 'click', buttons: number) => {
                path.dispatchEvent(new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    button: 0,
                    buttons,
                    clientX: midpoint.x,
                    clientY: midpoint.y,
                }));
            };
            dispatch('mousedown', 1);
            dispatch('mouseup', 0);
            dispatch('click', 0);
        });
        await page.locator('#selection-status').getByText(
            'network: fanout',
            { exact: true }
        ).waitFor();
        const selectedNetwork = await page.evaluate(({ ordinaryStroke }) => {
            const segmentCells = [...document.querySelectorAll<SVGGElement>(
                '#canvas .x6-edge[data-cell-id^="network:visual-fanout:segment:"]'
            )];
            const selectedStrokes = segmentCells.map(cell => getComputedStyle(
                cell.querySelector<SVGPathElement>(':scope > path:nth-child(2)')!
            ).stroke);
            const selectedStroke = selectedStrokes[0] ?? '';
            const selectedJunctions = [...document.querySelectorAll<SVGGElement>(
                '#canvas .x6-node[data-cell-id^="network:visual-fanout:junction:"]'
            )].filter(cell => getComputedStyle(
                cell.querySelector<SVGCircleElement>(':scope > circle')!
            ).stroke === selectedStroke);
            return {
                ordinaryStroke,
                selectedStrokes,
                highlightedSegments: selectedStrokes.filter(stroke =>
                    stroke === selectedStroke && stroke !== ordinaryStroke
                ).length,
                highlightedJunctions: selectedJunctions.length,
                selectionBoxes: document.querySelectorAll(
                    '.x6-widget-selection-box[data-cell-id^="network:visual-fanout:"]'
                ).length,
            };
        }, { ordinaryStroke: ordinaryFanoutStroke });
        assert.equal(
            selectedNetwork.highlightedSegments,
            fanoutSegmentCount,
            JSON.stringify(selectedNetwork)
        );
        assert.ok(selectedNetwork.highlightedJunctions > 0);
        assert.equal(selectedNetwork.selectionBoxes, 0);
        await page.waitForFunction(selectedObjectId => {
            const state = window as unknown as {
                __veriflowMessages: CapturedSaveMessage[];
            };
            const saves = state.__veriflowMessages.filter(message =>
                message.type === 'saveLayout'
            );
            return saves[saves.length - 1]?.layout?.selectedObjectId === selectedObjectId;
        }, 'network:visual-fanout');
        assert.equal(await page.locator('#selection-status').textContent(), 'network: fanout');
        await page.locator('#inspector-title').getByText(
            'fanout',
            { exact: true }
        ).waitFor();
        const networkInspector = await inspectorRows(page);
        assert.equal(networkInspector.Name, 'fanout');
        assert.match(networkInspector.Drivers, /wide_source/);
        assert.match(networkInspector.Loads, /top_stage/);

        const inspectViewport = async (
            name: 'desktop' | 'narrow'
        ): Promise<void> => {
            const geometry = await renderedGeometry(page);
            assert.equal(geometry.nodeCount, 13);
            assert.ok(geometry.edgeCount > fixture.graph.networks.length);
            assert.equal(geometry.labelCount, 0);
            assert.equal(geometry.pinCount, 26);
            assert.deepEqual(geometry.textOverflow, []);
            assert.deepEqual(geometry.pinOverflow, []);
            assert.deepEqual(geometry.segmentNodeIntersections, []);
            assert.deepEqual(geometry.differentNetworkOverlaps, []);
            assert.ok(geometry.junctionCount > 0, `${name} rendered no junctions`);
            assert.ok(
                geometry.fanoutJunctionIds.length > 0,
                `${name} rendered no fanout junction`
            );
            assert.deepEqual(geometry.junctionDirectionFailures, []);
            assert.equal(geometry.documentOverflow, false);
            assert.deepEqual(geometry.toolbarOverlaps, []);
            assert.deepEqual(geometry.portTitles, {
                'port:visual-input-a': 'input_a',
                'port:visual-input-b': 'input_b',
                'port:visual-output': 'result_out',
            });
            assert.deepEqual(geometry.portTitleOverflow, []);
            assert.ok(geometry.nodeBorderContrast >= 3, JSON.stringify(geometry));
            assert.ok(geometry.textContrast >= 4.5, JSON.stringify(geometry));
            assert.ok(geometry.wireContrast >= 3, JSON.stringify(geometry));

            const pixels = await actualCanvasPixelStats(page);
            assert.ok(pixels.width > 0 && pixels.height > 0);
            assert.ok(pixels.nonBackgroundPixels > 2_000, JSON.stringify(pixels));
            assert.ok(pixels.inkPixels > 500, JSON.stringify(pixels));
            assert.ok(pixels.coloredPixels > 50, JSON.stringify(pixels));
            await page.screenshot({
                path: path.join(screenshotRoot, `${name}.png`),
                fullPage: true,
            });
        };

        await inspectViewport('desktop');
        await electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].setSize(440, 640);
        });
        await page.waitForFunction(() => window.innerWidth <= 440 && window.innerHeight <= 640);
        await inspectViewport('narrow');
        const narrowCanvasBounds = await page.locator('#canvas-region').boundingBox();
        const narrowInspectorBounds = await page.locator('#inspector').boundingBox();
        assert.ok(narrowCanvasBounds && narrowInspectorBounds);
        assert.ok(
            narrowCanvasBounds.x + narrowCanvasBounds.width
                <= narrowInspectorBounds.x + 0.5,
            JSON.stringify({ narrowCanvasBounds, narrowInspectorBounds })
        );
        const narrowInspectorValueBounds = await page.locator(
            '#inspector-properties dd'
        ).first().boundingBox();
        assert.ok(narrowInspectorValueBounds);
        assert.ok(
            narrowInspectorValueBounds.width >= narrowInspectorBounds.width * 0.85,
            JSON.stringify({ narrowInspectorBounds, narrowInspectorValueBounds })
        );
        const wideModuleBody = page.locator(
            '#canvas .x6-node[data-cell-id="instance:visual-wide"] > rect:first-child'
        );
        const wideModuleBounds = await wideModuleBody.boundingBox();
        assert.ok(wideModuleBounds);
        const visibleLeft = Math.max(wideModuleBounds.x, narrowCanvasBounds.x);
        const visibleRight = Math.min(
            wideModuleBounds.x + wideModuleBounds.width,
            narrowCanvasBounds.x + narrowCanvasBounds.width
        );
        const visibleTop = Math.max(wideModuleBounds.y, narrowCanvasBounds.y);
        const visibleBottom = Math.min(
            wideModuleBounds.y + wideModuleBounds.height,
            narrowCanvasBounds.y + narrowCanvasBounds.height
        );
        assert.ok(visibleRight > visibleLeft && visibleBottom > visibleTop);
        await page.mouse.click(
            (visibleLeft + visibleRight) / 2,
            (visibleTop + visibleBottom) / 2
        );
        await page.locator('#selection-status').getByText(
            'instance: wide_source_with_a_title_that_must_stay_inside_the_module',
            { exact: true }
        ).waitFor();
        assert.equal(await page.locator(
            '.x6-widget-selection-box[data-cell-id="instance:visual-wide"]'
        ).count(), 1);
        const restoredFanoutStroke = await fanoutSegments.first().locator(
            ':scope > path:nth-child(2)'
        ).evaluate(element => getComputedStyle(element).stroke);
        assert.equal(restoredFanoutStroke, ordinaryFanoutStroke);
        await page.locator('#inspector-title').getByText(
            'wide_source_with_a_title_that_must_stay_inside_the_module',
            { exact: true }
        ).waitFor();
        const instanceInspector = await inspectorRows(page);
        assert.equal(
            instanceInspector.Name,
            'wide_source_with_a_title_that_must_stay_inside_the_module'
        );
        assert.equal(
            instanceInspector.Module,
            'wide_source_subtitle_that_is_intentionally_long'
        );
        assert.equal(instanceInspector.Definition, 'Unavailable');
        const canvasBeforeCollapse = await page.locator('#canvas-region').boundingBox();
        const svgBeforeCollapse = await page.locator(
            '#canvas.x6-graph > svg.x6-graph-svg'
        ).boundingBox();
        assert.ok(canvasBeforeCollapse);
        assert.ok(svgBeforeCollapse);
        await page.locator('#inspector-toggle-button').click({ force: true });
        await page.locator('#inspector').waitFor({ state: 'hidden' });
        assert.equal(
            await page.locator('#inspector-toggle-button').getAttribute('aria-expanded'),
            'false'
        );
        const canvasAfterCollapse = await page.locator('#canvas-region').boundingBox();
        assert.ok(canvasAfterCollapse);
        assert.ok(
            canvasAfterCollapse.width > canvasBeforeCollapse.width,
            JSON.stringify({ canvasBeforeCollapse, canvasAfterCollapse })
        );
        assert.ok(
            canvasAfterCollapse.x + canvasAfterCollapse.width <= 440.5,
            JSON.stringify(canvasAfterCollapse)
        );
        await page.waitForFunction(expectedWidth => {
            const svg = document.querySelector<SVGSVGElement>(
                '#canvas.x6-graph > svg.x6-graph-svg'
            );
            return svg !== null
                && svg.getBoundingClientRect().width >= expectedWidth - 0.5;
        }, canvasAfterCollapse.width);
        const svgAfterCollapse = await page.locator(
            '#canvas.x6-graph > svg.x6-graph-svg'
        ).boundingBox();
        assert.ok(svgAfterCollapse);
        assert.ok(
            svgAfterCollapse.width > svgBeforeCollapse.width,
            JSON.stringify({ svgBeforeCollapse, svgAfterCollapse })
        );
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});
