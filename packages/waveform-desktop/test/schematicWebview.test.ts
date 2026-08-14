import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _electron as electron, type Locator, type Page } from 'playwright';
import type { SchematicGraph } from '@veriflow/schematic-core';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const schematicHtml = process.env.VERIFLOW_SCHEMATIC_HTML
    ?? path.join(repositoryRoot, 'web-dist', 'schematic', 'index.html');
const screenshotRoot = process.env.VERIFLOW_SCHEMATIC_SCREENSHOT_DIR
    ?? path.join(os.tmpdir(), 'veriflow-schematic-visual');
const interfaceScreenshotRoot = process.env.VERIFLOW_SCHEMATIC_INTERFACE_SCREENSHOT_DIR
    ?? path.join(os.tmpdir(), 'veriflow-schematic-interface-visual');
const pageTimeoutMs = 10_000;

async function waitForSchematicRuntime(page: Page): Promise<void> {
    await page.locator(
        '[data-testid="schematic-shell"][data-runtime-ready="true"]'
    ).waitFor();
}

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
    const inout = node('port:visual-inout', 'port', 'shared_io', [
        ['shared_io_o', 'load'],
        ['shared_io_t', 'load'],
        ['shared_io_i', 'driver'],
    ]);
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
            inout,
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
                .flatMap(clip => {
                    const title = clip.classList.contains('veriflow-title-clip')
                        ? clip.querySelector<SVGTextElement>('text')
                        : undefined;
                    const contained = contains(body, svgViewportBounds(clip))
                        && (title === undefined
                            || (title !== null && contains(body, title.getBoundingClientRect())));
                    return contained
                        ? []
                        : [`${cell.dataset.cellId}:${clip.className.baseVal}`];
                });
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
            const title = clip?.querySelector<SVGTextElement>('text');
            if (!body || !clip || !title) return [`${cell.dataset.cellId}:missing-title`];
            return contains(body, svgViewportBounds(clip))
                && contains(body, title.getBoundingClientRect())
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

async function exerciseArchDesignConnections(page: Page): Promise<void> {
    page.setDefaultTimeout(pageTimeoutMs * 2);
    if (await page.locator('#inspector').isHidden()) {
        await page.locator('#inspector-toggle-button').click({ force: true });
        await page.locator('#inspector').waitFor({ state: 'visible' });
    }
    await assertHdlPinsCannotAuthorConnections(page);
    await page.evaluate(() => {
        const state = window as unknown as { __veriflowMessages: unknown[] };
        state.__veriflowMessages = [];
    });

    const design = {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'authoring_top',
        ports: [],
        instances: [
            { name: 'u_source', module: 'source' },
            { name: 'u_sink', module: 'sink' },
        ],
        connections: [],
        interfaceConnections: [],
        defaults: {},
        export: {},
        presentation: {},
    };
    const catalog = [{
        key: 'module:file:///source.sv:0',
        name: 'source',
        parameters: [],
        ports: [{
            name: 'out',
            direction: 'output',
            width: { kind: 'known', bits: 1 },
        }],
    }, {
        key: 'module:file:///sink.sv:0',
        name: 'sink',
        parameters: [],
        ports: [{
            name: 'in',
            direction: 'input',
            width: { kind: 'known', bits: 1 },
        }],
    }];
    const disconnectedGraph = {
        fileUri: 'file:///authoring.ad',
        moduleKey: 'arch-design:authoring_top',
        moduleName: 'authoring_top',
        nodes: [{
            id: 'instance:u_source',
            kind: 'instance',
            label: 'u_source',
            subtitle: 'source',
            definitionKey: catalog[0].key,
            pins: [{
                id: 'instance:u_source:out',
                name: 'out',
                direction: 'driver',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            }],
            readOnly: false,
        }, {
            id: 'instance:u_sink',
            kind: 'instance',
            label: 'u_sink',
            subtitle: 'sink',
            definitionKey: catalog[1].key,
            pins: [{
                id: 'instance:u_sink:in',
                name: 'in',
                direction: 'load',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            }],
            readOnly: false,
        }],
        networks: [],
        diagnostics: [],
    };
    const layout = {
        placement: {
            nodes: {
                'instance:u_source': {
                    column: 0,
                    order: 0,
                    yOffset: 0,
                    fixed: false,
                },
                'instance:u_sink': {
                    column: 1,
                    order: 0,
                    yOffset: 0,
                    fixed: false,
                },
            },
        },
        viewport: { x: 16, y: 16, zoom: 1 },
        minimap: false,
    };
    const publish = async (
        revision: string,
        selectedDesign: Record<string, unknown>,
        selectedGraph: Record<string, unknown>
    ): Promise<void> => {
        await page.evaluate(({ revision, design, catalog, graph, layout }) => {
            const graphIdentity = graph as {
                fileUri: string;
                moduleKey: string;
                moduleName: string;
            };
            for (const data of [{
                type: 'initialize',
                fileUri: graphIdentity.fileUri,
                modules: [{
                    key: graphIdentity.moduleKey,
                    name: graphIdentity.moduleName,
                }],
                selectedModuleKey: graphIdentity.moduleKey,
                documentKind: 'arch-design',
                editable: true,
            }, {
                type: 'graph',
                revision,
                graph,
                layout,
            }, {
                type: 'archDesignState',
                status: 'editable',
                revision,
                design,
                catalog,
                validation: { valid: true, diagnostics: [], warnings: [], effectiveDefaults: [] },
            }]) {
                window.dispatchEvent(new MessageEvent('message', { data }));
            }
        }, { revision, design: selectedDesign, catalog, graph: selectedGraph, layout });
    };

    await publish('fixture:ad-connect:1', design, disconnectedGraph);
    await page.locator('#connect-button').click();
    assert.equal(
        await page.locator('#connect-button').getAttribute('aria-pressed'),
        'true'
    );
    const sourcePin = page.locator(
        '.x6-node[data-cell-id="instance:u_source"] .x6-port-body[port="instance:u_source:out"]'
    );
    const targetPin = page.locator(
        '.x6-node[data-cell-id="instance:u_sink"] .x6-port-body[port="instance:u_sink:in"]'
    );
    const connectionPreview = page.locator(
        '#canvas .x6-edge[data-cell-id="veriflow:connection-preview"]'
    );
    await targetPin.click();
    await targetPin.click();
    await connectionPreview.waitFor({ state: 'detached' });
    await targetPin.click();
    await page.locator('#connect-button').click();
    await connectionPreview.waitFor({ state: 'detached' });
    await page.locator('#connect-button').click();
    await targetPin.click();
    await publish('fixture:ad-connect:refresh', design, disconnectedGraph);
    await connectionPreview.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#canvas .veriflow-connection-pending').count(), 0);
    if (await page.locator('#connect-button').getAttribute('aria-pressed') !== 'true') {
        await page.locator('#connect-button').click();
    }
    const sinkNode = page.locator('.x6-node[data-cell-id="instance:u_sink"]');
    await sinkNode.locator('rect').first().click({ position: { x: 40, y: 24 } });
    await page.locator(
        '.x6-widget-selection-box[data-cell-id="instance:u_sink"]'
    ).waitFor();
    const selectedTargetBounds = await targetPin.boundingBox();
    assert.ok(selectedTargetBounds);
    await page.mouse.click(
        selectedTargetBounds.x + selectedTargetBounds.width / 2,
        selectedTargetBounds.y + selectedTargetBounds.height / 2
    );
    assert.equal(
        await targetPin.evaluate(element =>
            element.classList.contains('veriflow-connection-pending')
        ),
        true
    );
    await connectionPreview.waitFor({ state: 'attached' });
    const sourceNode = page.locator('.x6-node[data-cell-id="instance:u_source"]');
    await sourceNode.locator('rect').first().click({ position: { x: 40, y: 24 } });
    await page.locator(
        '.x6-widget-selection-box[data-cell-id="instance:u_source"]'
    ).waitFor();
    const canvasBounds = await page.locator('#canvas').boundingBox();
    assert.ok(canvasBounds);
    await page.mouse.move(
        canvasBounds.x + canvasBounds.width / 2,
        canvasBounds.y + canvasBounds.height / 2
    );
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(
        canvasBounds.x + canvasBounds.width / 2 - 96,
        canvasBounds.y + canvasBounds.height / 2 + 48,
        { steps: 4 }
    );
    await page.mouse.up({ button: 'right' });
    assert.equal(
        await targetPin.evaluate(element =>
            element.classList.contains('veriflow-connection-pending')
        ),
        true
    );
    const selectedSourceBounds = await sourcePin.boundingBox();
    assert.ok(selectedSourceBounds);
    await page.mouse.click(
        selectedSourceBounds.x + selectedSourceBounds.width / 2,
        selectedSourceBounds.y + selectedSourceBounds.height / 2
    );
    assert.equal(
        await page.locator('#connect-button').getAttribute('aria-pressed'),
        'true'
    );
    assert.equal(
        await targetPin.evaluate(element =>
            element.classList.contains('veriflow-connection-pending')
        ),
        false
    );
    await page.waitForFunction(() => (window as unknown as {
        __veriflowMessages: Array<{ type?: string }>;
    }).__veriflowMessages.some(message => message.type === 'saveLayout'));
    await page.evaluate(() => {
        for (const revision of [
            'fixture:ad-connect:pan-saved:1',
            'fixture:ad-connect:pan-saved:2',
        ]) {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'archDesignLayoutSaved',
                revision,
            } }));
        }
    });
    await page.waitForFunction(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
        }> };
        return state.__veriflowMessages.some(message => message.type === 'editArchDesign');
    });
    await page.waitForFunction(() =>
        document.querySelectorAll('#canvas .x6-edge').length === 0
    );
    assert.equal(await page.locator('#canvas .x6-edge').count(), 0);
    const editMessages = await page.evaluate(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
        }> };
        return state.__veriflowMessages.filter(message =>
            message.type === 'editArchDesign'
        );
    });
    assert.deepEqual(editMessages, [{
        type: 'editArchDesign',
        revision: 'fixture:ad-connect:pan-saved:2',
        edit: {
            type: 'connect',
            source: { kind: 'instance', instance: 'u_source', port: 'out' },
            target: { kind: 'instance', instance: 'u_sink', port: 'in' },
        },
    }]);
    assert.equal(await page.locator('#connect-button').isDisabled(), true);

    const connectedDesign = {
        ...design,
        connections: [{
            name: 'net_1',
            endpoints: [
                { kind: 'instance', instance: 'u_source', port: 'out' },
                { kind: 'instance', instance: 'u_sink', port: 'in' },
            ],
        }],
    };
    const connectedGraph = {
        ...disconnectedGraph,
        networks: [{
            id: 'network:net_1',
            name: 'net_1',
            width: { kind: 'known', bits: 1 },
            endpoints: [{
                nodeId: 'instance:u_source',
                pinId: 'instance:u_source:out',
                role: 'driver',
            }, {
                nodeId: 'instance:u_sink',
                pinId: 'instance:u_sink:in',
                role: 'load',
            }],
        }],
    };
    await publish('fixture:ad-connect:2', connectedDesign, connectedGraph);
    const canonicalSegments = page.locator(
        '#canvas .x6-edge > path:nth-child(2)'
    );
    await canonicalSegments.first().waitFor({ state: 'attached' });
    await page.waitForFunction(() => [...document.querySelectorAll<SVGPathElement>(
        '#canvas .x6-edge > path:nth-child(2)'
    )].every(path => path.getTotalLength() > 0));
    const nonOrthogonalSegments = await canonicalSegments.evaluateAll(paths =>
        paths.filter(path => {
            const segment = path as SVGPathElement;
            const start = segment.getPointAtLength(0);
            const end = segment.getPointAtLength(segment.getTotalLength());
            return Math.abs(start.x - end.x) > 0.5
                && Math.abs(start.y - end.y) > 0.5;
        }).length
    );
    assert.equal(nonOrthogonalSegments, 0);
    await canonicalSegments.first().click({ force: true });
    await page.locator('#connection-name').fill('payload');
    await page.locator('#connection-name').press('Tab');
    await page.waitForFunction(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
            edit?: { type?: string };
        }> };
        return state.__veriflowMessages.some(message =>
            message.type === 'editArchDesign'
            && message.edit?.type === 'renameConnection'
        );
    });
    const renameMessage = await page.evaluate(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
            revision?: string;
            edit?: { type?: string };
        }> };
        return state.__veriflowMessages.find(message =>
            message.type === 'editArchDesign'
            && message.edit?.type === 'renameConnection'
        );
    });
    assert.deepEqual(renameMessage, {
        type: 'editArchDesign',
        revision: 'fixture:ad-connect:2',
        edit: { type: 'renameConnection', name: 'net_1', nextName: 'payload' },
    });

    const renamedDesign = {
        ...connectedDesign,
        connections: [{
            name: 'payload',
            endpoints: connectedDesign.connections[0].endpoints,
        }],
    };
    const renamedGraph = {
        ...connectedGraph,
        networks: [{
            ...connectedGraph.networks[0],
            id: 'network:payload',
            name: 'payload',
        }],
    };
    await publish('fixture:ad-connect:3', renamedDesign, renamedGraph);
    await page.locator(
        '#canvas .x6-edge[data-cell-id^="network:payload:segment:"] > path:nth-child(2)'
    ).first().click({ force: true });
    await page.locator('#default-u_sink\\.in').fill("1'b0");
    await page.locator('#default-u_sink\\.in').press('Tab');
    await page.waitForFunction(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
            edit?: { type?: string };
        }> };
        return state.__veriflowMessages.some(message =>
            message.type === 'editArchDesign'
            && message.edit?.type === 'setDefault'
        );
    });
    const defaultMessage = await page.evaluate(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
            revision?: string;
            edit?: { type?: string };
        }> };
        return state.__veriflowMessages.find(message =>
            message.type === 'editArchDesign'
            && message.edit?.type === 'setDefault'
        );
    });
    assert.deepEqual(defaultMessage, {
        type: 'editArchDesign',
        revision: 'fixture:ad-connect:3',
        edit: {
            type: 'setDefault',
            connection: 'payload',
            endpoint: 'u_sink.in',
            expression: "1'b0",
        },
    });

    const defaultedDesign = {
        ...renamedDesign,
        connections: [{
            ...renamedDesign.connections[0],
            defaults: { 'u_sink.in': "1'b0" },
        }],
    };
    await publish('fixture:ad-connect:4', defaultedDesign, renamedGraph);
    await page.locator(
        '#canvas .x6-edge[data-cell-id^="network:payload:segment:"] > path:nth-child(2)'
    ).first().click({ force: true });
    await page.locator('#delete-button').click();
    await page.waitForFunction(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
            edit?: { type?: string };
        }> };
        return state.__veriflowMessages.some(message =>
            message.type === 'editArchDesign'
            && message.edit?.type === 'removeConnection'
        );
    });
    const removeMessage = await page.evaluate(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
            revision?: string;
            edit?: { type?: string };
        }> };
        return state.__veriflowMessages.find(message =>
            message.type === 'editArchDesign'
            && message.edit?.type === 'removeConnection'
        );
    });
    assert.deepEqual(removeMessage, {
        type: 'editArchDesign',
        revision: 'fixture:ad-connect:4',
        edit: { type: 'removeConnection', name: 'payload' },
    });

    await page.setViewportSize({ width: 440, height: 640 });
    const narrowLayout = await page.evaluate(() => {
        const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
        const canvas = document.querySelector<HTMLElement>('#canvas-region')!;
        const inspector = document.querySelector<HTMLElement>('#inspector')!;
        const visibleToolbarGroups = [...toolbar.children].filter(element =>
            !(element as HTMLElement).hidden
            && element.getBoundingClientRect().width > 0
        );
        const overlaps = (left: DOMRect, right: DOMRect): boolean =>
            Math.max(left.left, right.left) < Math.min(left.right, right.right)
            && Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom);
        return {
            documentOverflow: document.documentElement.scrollWidth
                > document.documentElement.clientWidth,
            canvasInspectorOverlap: overlaps(
                canvas.getBoundingClientRect(),
                inspector.getBoundingClientRect()
            ),
            toolbarOverlap: visibleToolbarGroups.some((left, index) =>
                visibleToolbarGroups.slice(index + 1).some(right => overlaps(
                    left.getBoundingClientRect(),
                    right.getBoundingClientRect()
                ))
            ),
        };
    });
    assert.deepEqual(narrowLayout, {
        documentOverflow: false,
        canvasInspectorOverlap: false,
        toolbarOverlap: false,
    });
}

async function assertHdlPinsCannotAuthorConnections(page: Page): Promise<void> {
    await page.evaluate(() => {
        const graph = {
            fileUri: 'file:///readonly.sv',
            moduleKey: 'module:readonly:0',
            moduleName: 'readonly',
            nodes: [{
                id: 'instance:source',
                kind: 'instance',
                label: 'source',
                pins: [{
                    id: 'instance:source:out',
                    name: 'out',
                    direction: 'driver',
                    width: { kind: 'known', bits: 1 },
                    readOnly: false,
                }],
                readOnly: false,
            }, {
                id: 'instance:sink',
                kind: 'instance',
                label: 'sink',
                pins: [{
                    id: 'instance:sink:in',
                    name: 'in',
                    direction: 'load',
                    width: { kind: 'known', bits: 1 },
                    readOnly: false,
                }],
                readOnly: false,
            }],
            networks: [],
            diagnostics: [],
        };
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'initialize',
            fileUri: graph.fileUri,
            modules: [{ key: graph.moduleKey, name: graph.moduleName }],
            selectedModuleKey: graph.moduleKey,
            documentKind: 'hdl',
            editable: false,
        } }));
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'graph',
            revision: 'fixture:hdl',
            graph,
            layout: {
                placement: { nodes: {
                    'instance:source': { column: 0, order: 0, yOffset: 0, fixed: false },
                    'instance:sink': { column: 1, order: 0, yOffset: 0, fixed: false },
                } },
                viewport: { x: 16, y: 16, zoom: 1 },
                minimap: false,
            },
        } }));
    });
    assert.equal(await page.locator('#authoring-actions').isHidden(), true);
    const sourcePin = page.locator(
        '.x6-node[data-cell-id="instance:source"] .x6-port-body'
    );
    const targetPin = page.locator(
        '.x6-node[data-cell-id="instance:sink"] .x6-port-body'
    );
    await sourcePin.waitFor({ state: 'visible' });
    await targetPin.waitFor({ state: 'visible' });
    const sourceBounds = await sourcePin.boundingBox();
    const targetBounds = await targetPin.boundingBox();
    assert.ok(sourceBounds && targetBounds);
    await page.mouse.move(sourceBounds.x + 2, sourceBounds.y + 2);
    await page.mouse.down();
    await page.mouse.move(targetBounds.x + 2, targetBounds.y + 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await page.locator('#canvas .x6-edge').count(), 0);
    const messages = await page.evaluate(() => {
        const state = window as unknown as { __veriflowMessages: Array<{
            type?: string;
        }> };
        return state.__veriflowMessages;
    });
    assert.equal(messages.some(message => message.type === 'editArchDesign'), false);
}

function archDesignInteractionFixture(moduleName = 'interaction_top') {
    const sourceId = 'instance:u_source';
    const sinkId = 'instance:u_sink';
    const graph = {
        fileUri: `file:///${moduleName}.ad`,
        moduleKey: `arch-design:${moduleName}`,
        moduleName,
        nodes: [{
            id: sourceId,
            kind: 'instance',
            label: 'u_source',
            subtitle: 'source',
            pins: [{
                id: `${sourceId}:out`,
                name: 'out',
                direction: 'driver',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            }],
            readOnly: false,
        }, {
            id: sinkId,
            kind: 'instance',
            label: 'u_sink',
            subtitle: 'sink',
            pins: [{
                id: `${sinkId}:in`,
                name: 'in',
                direction: 'load',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            }],
            readOnly: false,
        }],
        networks: [{
            id: 'network:payload',
            name: 'payload',
            width: { kind: 'known', bits: 1 },
            endpoints: [
                { nodeId: sourceId, pinId: `${sourceId}:out`, role: 'driver' },
                { nodeId: sinkId, pinId: `${sinkId}:in`, role: 'load' },
            ],
        }],
        diagnostics: [],
    };
    return {
        graph,
        design: {
            format: 'vik-veriflow.arch-design',
            schemaVersion: 1,
            module: moduleName,
            ports: [],
            instances: [
                { name: 'u_source', module: 'source' },
                { name: 'u_sink', module: 'sink' },
            ],
            connections: [{
                name: 'payload',
                endpoints: [
                    { kind: 'instance', instance: 'u_source', port: 'out' },
                    { kind: 'instance', instance: 'u_sink', port: 'in' },
                ],
            }],
            interfaceConnections: [],
            defaults: {},
            export: {},
            presentation: {},
        },
        layout: {
            placement: { nodes: {
                [sourceId]: { column: 0, order: 0, yOffset: 0, fixed: false },
                [sinkId]: { column: 1, order: 0, yOffset: 0, fixed: false },
            } },
            viewport: { x: 0, y: 0, zoom: 1 },
            minimap: false,
        },
        catalog: [{
            key: 'module:file:///source.sv:0',
            name: 'source',
            parameters: [],
            ports: [{
                name: 'out',
                direction: 'output',
                width: { kind: 'known', bits: 1 },
            }],
        }, {
            key: 'module:file:///sink.sv:0',
            name: 'sink',
            parameters: [],
            ports: [{
                name: 'in',
                direction: 'input',
                width: { kind: 'known', bits: 1 },
            }],
        }],
    };
}

async function publishArchDesignFixture(
    page: Page,
    revision: string,
    fixture = archDesignInteractionFixture(),
    graphOptions: { fitOnFirstRender?: boolean } = {}
): Promise<void> {
    await page.evaluate(({ revision, fixture, graphOptions }) => {
        for (const data of [{
            type: 'initialize',
            fileUri: fixture.graph.fileUri,
            modules: [{ key: fixture.graph.moduleKey, name: fixture.graph.moduleName }],
            selectedModuleKey: fixture.graph.moduleKey,
            documentKind: 'arch-design',
            editable: true,
        }, {
            type: 'graph',
            revision,
            graph: fixture.graph,
            layout: fixture.layout,
            ...graphOptions,
        }, {
            type: 'archDesignState',
            status: 'editable',
            revision,
            design: fixture.design,
            catalog: fixture.catalog,
            validation: { valid: true, diagnostics: [], warnings: [], effectiveDefaults: [] },
        }]) {
            window.dispatchEvent(new MessageEvent('message', { data }));
        }
    }, { revision, fixture, graphOptions });
}

function archDesignInterfaceFixture(
    expanded = false,
    topInterface: { name: string; memberPrefix: string } = {
        name: 'm_link',
        memberPrefix: 'M_LINK',
    }
) {
    const interfacePin = (
        id: string,
        name: string,
        direction: 'driver' | 'load' | 'bidirectional',
        role: 'master' | 'slave' | 'unknown',
        topLevel = false
    ) => ({
        id,
        name,
        direction,
        width: { kind: 'unknown' },
        readOnly: false,
        interface: {
            id,
            protocol: 'project.link',
            protocolName: 'Project Link',
            role,
            roleSource: role === 'unknown' ? 'unknown' : topLevel ? 'declared' : 'inferred',
            kind: 'aggregate',
            topLevel,
            collapsed: true,
        },
    });
    const memberPin = (
        interfaceId: string,
        nodeId: string,
        name: string,
        member: string,
        direction: 'driver' | 'load',
        role: 'master' | 'slave'
    ) => ({
        id: `${nodeId}:${name}`,
        name,
        direction,
        width: { kind: 'known', bits: member === 'request' ? 32 : 1 },
        readOnly: false,
        interface: {
            id: interfaceId,
            protocol: 'project.link',
            protocolName: 'Project Link',
            role,
            roleSource: 'inferred',
            kind: 'member',
            topLevel: false,
            collapsed: false,
            member,
        },
    });
    const interfaceIds = {
        masterFree: 'interface:instance:u_master_free:M_FREE',
        slaveFree: 'interface:instance:u_slave_free:S_FREE',
        slaveOtherProtocol: 'interface:instance:u_slave_other:S_OTHER',
        slaveMemberOccupied: 'interface:instance:u_slave_occupied:S_OCCUPIED',
        unknown: 'interface:instance:u_unknown:BUS',
        masterConnected: 'interface:instance:u_master_connected:M_LINK',
        slaveConnected: 'interface:instance:u_slave_connected:S_LINK',
        boundaryMaster: 'interface:instance:u_boundary_master:M_BOUNDARY',
        top: `interface:port:${topInterface.name}`,
        topFree: 'interface:port:m_free',
    };
    const node = (
        id: string,
        label: string,
        subtitle: string,
        pins: unknown[],
        kind: 'instance' | 'port' = 'instance'
    ) => ({ id, kind, label, subtitle, pins, readOnly: false });
    const masterFreeNode = 'instance:u_master_free';
    const nodes = [
        node(masterFreeNode, 'u_master_free', 'master', [
            {
                id: `${masterFreeNode}:irq`,
                name: 'irq',
                direction: 'driver',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            },
            ...(expanded ? [
                memberPin(
                    interfaceIds.masterFree,
                    masterFreeNode,
                    'M_FREE_REQUEST',
                    'request',
                    'driver',
                    'master'
                ),
                memberPin(
                    interfaceIds.masterFree,
                    masterFreeNode,
                    'M_FREE_ACCEPT',
                    'accept',
                    'load',
                    'master'
                ),
            ] : [interfacePin(
                interfaceIds.masterFree,
                'M_FREE',
                'driver',
                'master'
            )]),
        ]),
        node('instance:u_slave_free', 'u_slave_free', 'slave', [interfacePin(
            interfaceIds.slaveFree,
            'S_FREE',
            'load',
            'slave'
        )]),
        node('instance:u_slave_other', 'u_slave_other', 'slave', [{
            ...interfacePin(
                interfaceIds.slaveOtherProtocol,
                'S_OTHER',
                'load',
                'slave'
            ),
            interface: {
                ...interfacePin(
                    interfaceIds.slaveOtherProtocol,
                    'S_OTHER',
                    'load',
                    'slave'
                ).interface,
                protocol: 'project.other',
                protocolName: 'Project Other',
            },
        }]),
        node('instance:u_slave_occupied', 'u_slave_occupied', 'slave', [interfacePin(
            interfaceIds.slaveMemberOccupied,
            'S_OCCUPIED',
            'load',
            'slave'
        )]),
        node('instance:u_unknown', 'u_unknown', 'unknown', [interfacePin(
            interfaceIds.unknown,
            'BUS',
            'bidirectional',
            'unknown'
        )]),
        node('instance:u_master_connected', 'u_master_connected', 'master', [interfacePin(
            interfaceIds.masterConnected,
            'M_LINK',
            'driver',
            'master'
        )]),
        node('instance:u_slave_connected', 'u_slave_connected', 'slave', [interfacePin(
            interfaceIds.slaveConnected,
            'S_LINK',
            'load',
            'slave'
        )]),
        node('instance:u_boundary_master', 'u_boundary_master', 'master', [interfacePin(
            interfaceIds.boundaryMaster,
            'M_BOUNDARY',
            'driver',
            'master'
        )]),
        node('port:clk', 'clk', '', [{
            id: 'port:clk:value',
            name: 'clk',
            direction: 'driver',
            width: { kind: 'known', bits: 1 },
            readOnly: false,
        }], 'port'),
        node(`interface:port:${topInterface.name}`, topInterface.name, 'Project Link master', [interfacePin(
            interfaceIds.top,
            topInterface.memberPrefix,
            'load',
            'master',
            true
        )], 'port'),
        node('interface:port:m_free', 'm_free', 'Project Link master', [interfacePin(
            interfaceIds.topFree,
            'm_free',
            'load',
            'master',
            true
        )], 'port'),
    ];
    const networks: SchematicGraph['networks'] = [{
        id: 'network:interface:control',
        name: 'control',
        width: { kind: 'unknown' },
        renderWidth: 4,
        endpoints: [
            {
                nodeId: 'instance:u_master_connected',
                pinId: interfaceIds.masterConnected,
                role: 'driver',
            },
            {
                nodeId: 'instance:u_slave_connected',
                pinId: interfaceIds.slaveConnected,
                role: 'load',
            },
        ],
        interface: {
            id: 'interface-connection:control',
            connection: 'control',
            protocol: 'project.link',
            protocolName: 'Project Link',
            collapsed: true,
        },
    }, {
        id: 'network:interface:boundary',
        name: 'boundary',
        width: { kind: 'unknown' },
        renderWidth: 4,
        endpoints: [
            {
                nodeId: 'instance:u_boundary_master',
                pinId: interfaceIds.boundaryMaster,
                role: 'driver',
            },
            {
                nodeId: `interface:port:${topInterface.name}`,
                pinId: interfaceIds.top,
                role: 'load',
            },
        ],
        interface: {
            id: 'interface-connection:boundary',
            connection: 'boundary',
            protocol: 'project.link',
            protocolName: 'Project Link',
            collapsed: true,
        },
    }];
    const graph = {
        fileUri: 'file:///interface-authoring.ad',
        moduleKey: 'arch-design:interface_authoring',
        moduleName: 'interface_authoring',
        nodes,
        networks,
        diagnostics: [],
    };
    const layout = {
        placement: { nodes: Object.fromEntries(nodes.map((item, index) => [item.id, {
            column: item.id === `interface:port:${topInterface.name}` ? 2 : index % 3,
            order: Math.floor(index / 3),
            yOffset: 0,
            fixed: false,
        }])) },
        viewport: { x: 24, y: 20, zoom: 0.85 },
        minimap: false,
    };
    const interfaceItem = (
        identity: string,
        endpoint: Record<string, string>,
        role: 'master' | 'slave' | 'unknown',
        options: Record<string, unknown> = {}
    ) => ({
        identity,
        endpoint,
        protocol: 'project.link',
        protocolName: 'Project Link',
        role,
        roleSource: role === 'unknown' ? 'unknown' : endpoint.kind === 'port'
            ? 'declared' : 'inferred',
        topLevel: endpoint.kind === 'port',
        collapsed: !expanded,
        members: [
            {
                member: 'request',
                port: `${endpoint.interface ?? endpoint.port}_REQUEST`,
                direction: 'master-to-slave',
                portDirection: role === 'slave' ? 'input' : 'output',
                width: { kind: 'known', bits: 32 },
            },
            {
                member: 'accept',
                port: `${endpoint.interface ?? endpoint.port}_ACCEPT`,
                direction: 'slave-to-master',
                portDirection: role === 'slave' ? 'output' : 'input',
                width: { kind: 'known', bits: 1 },
            },
        ],
        missingMembers: ['tag'],
        ...(endpoint.kind === 'instance' && role !== 'unknown' ? {
            snapshot: {
                endpoint,
                protocol: 'project.link',
                role,
                members: [
                    {
                        member: 'request',
                        port: `${endpoint.interface}_REQUEST`,
                        width: 32,
                    },
                    {
                        member: 'accept',
                        port: `${endpoint.interface}_ACCEPT`,
                        width: 1,
                    },
                ],
            },
        } : {}),
        ...options,
    });
    const inspector = {
        protocols: [{
            id: 'project.link',
            name: 'Project Link',
            source: '/workspace/protocols/link.json',
        }],
        interfaces: [
            interfaceItem(interfaceIds.masterFree, {
                kind: 'instance', instance: 'u_master_free', interface: 'M_FREE',
            }, 'master'),
            interfaceItem(interfaceIds.slaveFree, {
                kind: 'instance', instance: 'u_slave_free', interface: 'S_FREE',
            }, 'slave'),
            {
                ...interfaceItem(interfaceIds.slaveOtherProtocol, {
                    kind: 'instance', instance: 'u_slave_other', interface: 'S_OTHER',
                }, 'slave'),
                protocol: 'project.other',
                protocolName: 'Project Other',
            },
            interfaceItem(interfaceIds.slaveMemberOccupied, {
                kind: 'instance', instance: 'u_slave_occupied', interface: 'S_OCCUPIED',
            }, 'slave', {
                members: [{
                    member: 'request',
                    port: 'S_OCCUPIED_REQUEST',
                    direction: 'master-to-slave',
                    portDirection: 'input',
                    width: { kind: 'known', bits: 32 },
                    occupancy: 'scalar_request',
                }, {
                    member: 'accept',
                    port: 'S_OCCUPIED_ACCEPT',
                    direction: 'slave-to-master',
                    portDirection: 'output',
                    width: { kind: 'known', bits: 1 },
                }],
            }),
            interfaceItem(interfaceIds.unknown, {
                kind: 'instance', instance: 'u_unknown', interface: 'BUS',
            }, 'unknown'),
            interfaceItem(interfaceIds.masterConnected, {
                kind: 'instance', instance: 'u_master_connected', interface: 'M_LINK',
            }, 'master', {
                connection: {
                    name: 'control',
                    peer: 'u_slave_connected.S_LINK',
                    peerIdentity: interfaceIds.slaveConnected,
                    defaults: [{
                        member: 'tag',
                        expression: "4'h0",
                        origin: 'protocol',
                        source: 'protocol:project.link:tag',
                        protocolExpression: "4'h0",
                    }],
                    diagnostics: [],
                    warnings: [{
                        path: '$.interfaceConnections[0]',
                        code: 'AD_INTERFACE_WIDTH',
                        message: 'Interface member request connects 32 bits to 16 bits',
                    }],
                },
            }),
            interfaceItem(interfaceIds.slaveConnected, {
                kind: 'instance', instance: 'u_slave_connected', interface: 'S_LINK',
            }, 'slave', {
                connection: {
                    name: 'control',
                    peer: 'u_master_connected.M_LINK',
                    peerIdentity: interfaceIds.masterConnected,
                    defaults: [{
                        member: 'tag',
                        expression: "4'h0",
                        origin: 'protocol',
                        source: 'protocol:project.link:tag',
                        protocolExpression: "4'h0",
                    }],
                    diagnostics: [],
                    warnings: [],
                },
            }),
            interfaceItem(interfaceIds.boundaryMaster, {
                kind: 'instance', instance: 'u_boundary_master', interface: 'M_BOUNDARY',
            }, 'master', {
                connection: {
                    name: 'boundary',
                    peer: topInterface.name,
                    peerIdentity: interfaceIds.top,
                    defaults: [],
                    diagnostics: [],
                    warnings: [],
                },
            }),
            interfaceItem(interfaceIds.top, {
                kind: 'port', port: topInterface.name,
            }, 'master', {
                connection: {
                    name: 'boundary',
                    peer: 'u_boundary_master.M_BOUNDARY',
                    peerIdentity: interfaceIds.boundaryMaster,
                    defaults: [],
                    diagnostics: [],
                    warnings: [],
                },
            }),
            interfaceItem(interfaceIds.topFree, { kind: 'port', port: 'm_free' }, 'master'),
        ],
    };
    const design = {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'interface_authoring',
        ports: [{ name: 'clk', direction: 'input', width: 1 }],
        instances: nodes.filter(item => item.kind === 'instance').map(item => ({
            name: item.label,
            module: item.subtitle,
        })),
        connections: [],
        interfacePorts: [{
            name: topInterface.name,
            protocol: 'project.link',
            role: 'master',
            memberPrefix: topInterface.memberPrefix,
            members: [{ member: 'request', width: 8 }],
        }, {
            name: 'm_free',
            protocol: 'project.link',
            role: 'master',
            memberPrefix: 'M_FREE',
            members: [{ member: 'request', width: 32 }, { member: 'accept', width: 1 }],
        }],
        interfaceOverrides: {},
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'instance', instance: 'u_master_connected', interface: 'M_LINK' },
            slave: { kind: 'instance', instance: 'u_slave_connected', interface: 'S_LINK' },
        }, {
            name: 'boundary',
            master: { kind: 'instance', instance: 'u_boundary_master', interface: 'M_BOUNDARY' },
            slave: { kind: 'port', port: topInterface.name },
        }],
        defaults: {},
        export: {},
        presentation: {
            collapsedInterfaces: {
                [interfaceIds.masterFree]: !expanded,
            },
            viewport: layout.viewport,
        },
    };
    const catalog = nodes.filter(item => item.kind === 'instance').map(item => ({
        key: `module:file:///${item.subtitle}.sv:0`,
        name: item.subtitle,
        parameters: [],
        ports: item.label === 'u_master_free' ? [
            { name: 'irq', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 'M_FREE_REQUEST', direction: 'output', width: { kind: 'known', bits: 32 } },
            { name: 'M_FREE_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
        ] : [],
    }));
    return { graph, layout, design, catalog, inspector, interfaceIds };
}

function archDesignExpandedConnectedInterfaceFixture() {
    const fixture = archDesignInterfaceFixture(true);
    const connectedPin = (
        interfaceId: string,
        nodeId: string,
        name: string,
        member: 'request' | 'accept',
        direction: 'driver' | 'load',
        role: 'master' | 'slave'
    ) => ({
        id: `${nodeId}:${name}`,
        name,
        direction,
        width: { kind: 'known', bits: member === 'request' ? 32 : 1 },
        readOnly: false,
        interface: {
            id: interfaceId,
            protocol: 'project.link',
            protocolName: 'Project Link',
            role,
            roleSource: 'inferred',
            kind: 'member',
            topLevel: false,
            collapsed: false,
            member,
        },
    });
    const masterNodeId = 'instance:u_master_connected';
    const slaveNodeId = 'instance:u_slave_connected';
    const masterPins = [
        connectedPin(
            fixture.interfaceIds.masterConnected,
            masterNodeId,
            'M_LINK_REQUEST',
            'request',
            'driver',
            'master'
        ),
        connectedPin(
            fixture.interfaceIds.masterConnected,
            masterNodeId,
            'M_LINK_ACCEPT',
            'accept',
            'load',
            'master'
        ),
    ];
    const slavePins = [
        connectedPin(
            fixture.interfaceIds.slaveConnected,
            slaveNodeId,
            'S_LINK_REQUEST',
            'request',
            'load',
            'slave'
        ),
        connectedPin(
            fixture.interfaceIds.slaveConnected,
            slaveNodeId,
            'S_LINK_ACCEPT',
            'accept',
            'driver',
            'slave'
        ),
    ];
    fixture.graph.nodes = fixture.graph.nodes.map(node => {
        if (node.id === masterNodeId) return { ...node, pins: masterPins };
        if (node.id === slaveNodeId) return { ...node, pins: slavePins };
        return node;
    });
    fixture.graph.networks = [
        ...fixture.graph.networks.filter(network => network.id !== 'network:interface:control'),
        {
            id: 'network:interface:control:request',
            name: 'control_request',
            width: { kind: 'known', bits: 32 },
            endpoints: [
                { nodeId: masterNodeId, pinId: masterPins[0].id, role: 'driver' },
                { nodeId: slaveNodeId, pinId: slavePins[0].id, role: 'load' },
            ],
            interface: {
                id: 'interface-connection:control',
                connection: 'control',
                protocol: 'project.link',
                protocolName: 'Project Link',
                collapsed: false,
                member: 'request',
            },
        },
        {
            id: 'network:interface:control:accept',
            name: 'control_accept',
            width: { kind: 'known', bits: 1 },
            endpoints: [
                { nodeId: slaveNodeId, pinId: slavePins[1].id, role: 'driver' },
                { nodeId: masterNodeId, pinId: masterPins[1].id, role: 'load' },
            ],
            interface: {
                id: 'interface-connection:control',
                connection: 'control',
                protocol: 'project.link',
                protocolName: 'Project Link',
                collapsed: false,
                member: 'accept',
            },
        },
    ];
    fixture.inspector.interfaces = fixture.inspector.interfaces.map(item => {
        if (item.identity === fixture.interfaceIds.masterConnected) {
            return {
                ...item,
                collapsed: false,
                members: item.members.map(member => ({ ...member, occupancy: 'control' })),
            };
        }
        if (item.identity === fixture.interfaceIds.slaveConnected) {
            return { ...item, collapsed: false };
        }
        return item;
    });
    fixture.design.presentation.collapsedInterfaces = {
        ...fixture.design.presentation.collapsedInterfaces,
        [fixture.interfaceIds.masterConnected]: false,
        [fixture.interfaceIds.slaveConnected]: false,
    };
    return fixture;
}

async function publishArchDesignInterfaceFixture(
    page: Page,
    revision: string,
    expanded = false,
    initialize = true,
    fixture = archDesignInterfaceFixture(expanded)
): Promise<void> {
    await page.evaluate(({ revision, fixture, initialize }) => {
        const events = [{
            type: 'graph',
            revision,
            graph: fixture.graph,
            layout: fixture.layout,
            fitOnFirstRender: false,
        }, {
            type: 'archDesignState',
            status: 'editable',
            revision,
            design: fixture.design,
            catalog: fixture.catalog,
            validation: { valid: true, diagnostics: [], warnings: [], effectiveDefaults: [] },
            inspector: fixture.inspector,
        }];
        if (initialize) events.unshift({
            type: 'initialize',
            fileUri: fixture.graph.fileUri,
            modules: [{ key: fixture.graph.moduleKey, name: fixture.graph.moduleName }],
            selectedModuleKey: fixture.graph.moduleKey,
            documentKind: 'arch-design',
            editable: true,
        } as never);
        for (const data of events) {
            window.dispatchEvent(new MessageEvent('message', { data }));
        }
    }, { revision, fixture, initialize });
}

async function captureWebviewMessages(page: Page): Promise<void> {
    await page.evaluate(() => {
        const state = window as unknown as { __veriflowMessages: unknown[] };
        state.__veriflowMessages = [];
        window.addEventListener('veriflow:webview-message', event => {
            state.__veriflowMessages.push((event as CustomEvent).detail);
        });
    });
}

async function archDesignEditMessages(page: Page): Promise<Array<{
    type?: string;
    revision?: string;
    edit?: Record<string, unknown>;
}>> {
    return page.evaluate(() => (window as unknown as {
        __veriflowMessages: Array<{
            type?: string;
            revision?: string;
            edit?: Record<string, unknown>;
        }>;
    }).__veriflowMessages.filter(message => message.type === 'editArchDesign'));
}

function lastItem<T>(items: readonly T[]): T | undefined {
    return items[items.length - 1];
}

test('Arch Design interface pins drive Inspector actions and survive graph refreshes', {
    timeout: 40_000,
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
        await waitForSchematicRuntime(page);
        await captureWebviewMessages(page);
        const fixture = archDesignInterfaceFixture();
        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:inspect');
        await page.waitForTimeout(100);
        assert.deepEqual(rendererErrors, []);

        const masterAggregate = page.locator(
            '.x6-node[data-cell-id="instance:u_master_free"] '
            + `.x6-port-body[port="${fixture.interfaceIds.masterFree}"]`
        );
        const masterAggregateLabel = masterAggregate.locator('..').locator('.x6-port-label');
        const slaveAggregate = page.locator(
            '.x6-node[data-cell-id="instance:u_slave_free"] '
            + `.x6-port-body[port="${fixture.interfaceIds.slaveFree}"]`
        );
        await page.locator('#connect-button').click();
        assert.equal(
            await page.locator('#connect-button').getAttribute('aria-pressed'),
            'true'
        );
        assert.equal(await masterAggregateLabel.evaluate(element => [
            element,
            ...element.querySelectorAll('[magnet]'),
        ].some(candidate => candidate.getAttribute('magnet') === 'true')), false);
        const edgesBeforeLabelDrag = await page.locator('#canvas .x6-edge').count();
        const editsBeforeLabelDrag = (await archDesignEditMessages(page)).length;
        const savesBeforeLabelDrag = await capturedSaves(page);
        const labelBounds = await masterAggregateLabel.boundingBox();
        const slaveBounds = await slaveAggregate.boundingBox();
        assert.ok(labelBounds && slaveBounds);
        await page.mouse.move(
            labelBounds.x + labelBounds.width / 2,
            labelBounds.y + labelBounds.height / 2
        );
        await page.mouse.down();
        await page.mouse.move(
            slaveBounds.x + slaveBounds.width / 2,
            slaveBounds.y + slaveBounds.height / 2,
            { steps: 8 }
        );
        assert.equal(await page.locator('#canvas .x6-edge').count(), edgesBeforeLabelDrag);
        await page.mouse.up();
        assert.equal((await archDesignEditMessages(page)).length, editsBeforeLabelDrag);
        await page.waitForTimeout(350);
        assert.deepEqual(await capturedSaves(page), savesBeforeLabelDrag);

        const irq = page.locator(
            '.x6-node[data-cell-id="instance:u_master_free"] '
            + '.x6-port-body[port="instance:u_master_free:irq"]'
        );
        const irqPort = irq.locator('..');
        const irqLabel = irqPort.locator('.x6-port-label');
        const irqLabelText = irqLabel.locator('.veriflow-pin-label');
        const irqLabelHitArea = irqLabel.locator('.veriflow-pin-label-hit-area');
        const irqLabelWeightBefore = await irqLabelText.evaluate(element =>
            getComputedStyle(element).fontWeight
        );
        const irqLabelBackgroundBefore = await irqLabelHitArea.evaluate(element =>
            getComputedStyle(element).fill
        );
        const masterNode = page.locator(
            '.x6-node[data-cell-id="instance:u_master_free"]'
        );
        await masterNode.locator('rect').first().click({
            position: { x: 48, y: 24 },
        });
        await page.locator(
            '.x6-widget-selection-box[data-cell-id="instance:u_master_free"]'
        ).waitFor();
        const irqBounds = await irq.boundingBox();
        assert.ok(irqBounds);
        await page.mouse.click(
            irqBounds.x + irqBounds.width / 2,
            irqBounds.y + irqBounds.height / 2
        );
        await page.locator('#inspector[data-kind="pin"]').waitFor();
        await masterNode.locator('rect').first().click({
            position: { x: 48, y: 24 },
        });
        await page.locator(
            '.x6-widget-selection-box[data-cell-id="instance:u_master_free"]'
        ).waitFor();
        const irqLabelBounds = await irqLabel.boundingBox();
        assert.ok(irqLabelBounds);
        await page.mouse.click(
            irqLabelBounds.x + irqLabelBounds.width / 2,
            irqLabelBounds.y + irqLabelBounds.height / 2
        );
        await page.locator('#inspector[data-kind="pin"]').waitFor();
        assert.equal(await irq.evaluate(element =>
            element.classList.contains('veriflow-pin-selected')
        ), true);
        assert.equal(await irqLabel.evaluate(element =>
            element.classList.contains('veriflow-pin-selected')
        ), true);
        assert.equal(await irqLabelText.evaluate(element => {
            const clip = element.closest('svg.veriflow-pin-clip');
            const bounds = (element as SVGGraphicsElement).getBBox();
            const clipWidth = Number(clip?.getAttribute('width') ?? 0);
            return bounds.x >= -0.5 && bounds.x + bounds.width <= clipWidth + 0.5;
        }), true);
        assert.equal(
            await irqLabelText.evaluate(element => getComputedStyle(element).fontWeight),
            irqLabelWeightBefore
        );
        assert.notEqual(
            await irqLabelHitArea.evaluate(element => getComputedStyle(element).fill),
            irqLabelBackgroundBefore
        );
        assert.equal(await irqLabel.evaluate(element => [
            element,
            ...element.querySelectorAll('[magnet]'),
        ].some(candidate => candidate.getAttribute('magnet') === 'true')), false);
        assert.equal(await page.locator('#canvas .x6-widget-selection-box').count(), 0);
        assert.equal(await page.locator('#inspector-title').textContent(), 'u_master_free.irq');
        assert.deepEqual(await page.locator('#inspector-form output').evaluateAll(outputs =>
            Object.fromEntries(outputs.map(output => [
                output.previousElementSibling?.textContent ?? '',
                output.textContent ?? '',
            ]))
        ), {
            Instance: 'u_master_free',
            Port: 'irq',
            Direction: 'output',
            Width: '1 bit',
            Interface: 'None',
            Occupancy: 'Unconnected',
        });
        await page.locator('[data-inspector-action="expose-port"]').click();
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'promotePort'));
        assert.deepEqual(lastItem(await archDesignEditMessages(page)), {
            type: 'editArchDesign',
            revision: 'fixture:interfaces:inspect',
            edit: {
                type: 'promotePort',
                source: { kind: 'instance', instance: 'u_master_free', port: 'irq' },
                port: { name: 'irq', direction: 'output', width: 1 },
                connection: 'irq',
            },
        });

        await publishArchDesignInterfaceFixture(
            page,
            'fixture:interfaces:promotion-ack',
            false,
            false
        );
        await page.locator('#inspector[data-kind="pin"]').waitFor();
        assert.equal(await page.locator('#inspector-title').textContent(), 'u_master_free.irq');

        const aggregate = page.locator(
            '.x6-node[data-cell-id="instance:u_master_free"] '
            + `.x6-port-body[port="${fixture.interfaceIds.masterFree}"]`
        );
        const aggregateLabelHitTarget = aggregate.locator('..').locator('.x6-port-label');
        const aggregateLabelText = aggregateLabelHitTarget.locator('.veriflow-interface-label');
        const aggregateLabelHitArea = aggregateLabelHitTarget.locator(
            '.veriflow-pin-label-hit-area'
        );
        const labelStylesBefore = await aggregateLabelText.evaluate(element => ({
            fill: getComputedStyle(element).fill,
            fontWeight: getComputedStyle(element).fontWeight,
        }));
        const labelBackgroundBefore = await aggregateLabelHitArea.evaluate(element =>
            getComputedStyle(element).fill
        );
        await aggregateLabelHitTarget.click();
        await page.locator('#inspector[data-kind="interface"]').waitFor();
        assert.equal(
            (await aggregateLabelText.locator('tspan').first().textContent())
                ?.replace(/\u00a0/g, ' '),
            'M_FREE'
        );
        assert.equal(await aggregateLabelHitTarget.evaluate(element =>
            element.classList.contains('veriflow-pin-selected')
        ), true);
        const selectedColors = await page.evaluate(({ nodeId, pinId }) => {
            const node = document.querySelector(
                `.x6-node[data-cell-id="${nodeId}"]`
            )!;
            const port = node.querySelector(`.x6-port-body[port="${pinId}"]`)!;
            const label = port.parentElement!.querySelector('.veriflow-interface-label')!;
            const body = port.querySelector('[data-selector="portBody"]') ?? port;
            return {
                label: getComputedStyle(label).fill,
                circleStrokeWidth: getComputedStyle(body).strokeWidth,
            };
        }, {
            nodeId: 'instance:u_master_free',
            pinId: fixture.interfaceIds.masterFree,
        });
        const selectedLabelBackground = await aggregateLabelHitArea.evaluate(element =>
            getComputedStyle(element).fill
        );
        assert.notEqual(selectedColors.label, labelStylesBefore.fill);
        assert.notEqual(selectedLabelBackground, labelBackgroundBefore);
        assert.equal(await aggregateLabelText.evaluate(element => {
            const clip = element.closest('svg.veriflow-pin-clip');
            const bounds = (element as SVGGraphicsElement).getBBox();
            const clipWidth = Number(clip?.getAttribute('width') ?? 0);
            return bounds.x >= -0.5 && bounds.x + bounds.width <= clipWidth + 0.5;
        }), true);
        assert.equal(await aggregateLabelText.evaluate(element =>
            getComputedStyle(element).fontWeight
        ), labelStylesBefore.fontWeight);
        assert.equal(Number.parseFloat(selectedColors.circleStrokeWidth), 3);
        assert.equal(await page.locator('#inspector-title').textContent(), 'u_master_free.M_FREE');
        assert.equal(await page.locator('#interface-protocol').textContent(), 'Project Link');
        assert.equal(await page.locator('#interface-role').textContent(), 'master');
        assert.equal(await page.locator('#interface-missing').textContent(), 'tag');
        assert.equal(
            await page.locator('#interface-member-request').textContent(),
            'M_FREE_REQUEST · 32 bits'
        );
        assert.equal(
            await page.locator('[data-inspector-action="expose-interface"]').isEnabled(),
            true
        );
        await page.locator('[data-inspector-action="expose-interface"]').click();
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'promoteInterface'));
        assert.deepEqual(lastItem(await archDesignEditMessages(page))?.edit, {
            type: 'promoteInterface',
            source: {
                endpoint: {
                    kind: 'instance',
                    instance: 'u_master_free',
                    interface: 'M_FREE',
                },
                protocol: 'project.link',
                role: 'master',
                members: [{ member: 'request', port: 'M_FREE_REQUEST', width: 32 }, {
                    member: 'accept', port: 'M_FREE_ACCEPT', width: 1,
                }],
            },
            port: 'M_FREE',
            memberPrefix: 'M_FREE',
            connection: 'M_FREE',
        });
        await publishArchDesignInterfaceFixture(
            page,
            'fixture:interfaces:interface-promotion-ack',
            false,
            false
        );
        await page.locator('#inspector[data-kind="interface"]').waitFor();
        assert.equal(await page.locator('#inspector-title').textContent(), 'u_master_free.M_FREE');
        const beforeViewport = await page.evaluate(() => {
            const canvas = document.querySelector(
                '#canvas .x6-graph-svg-viewport'
            ) as SVGElement;
            return canvas.getAttribute('transform');
        });
        await page.locator('#interface-collapse').selectOption('expanded');
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'setPresentation'));
        const collapseEdit = lastItem(await archDesignEditMessages(page))?.edit;
        assert.equal(collapseEdit?.type, 'setPresentation');
        const collapsePresentation = collapseEdit?.presentation as {
            nodes?: Record<string, unknown>;
            collapsedInterfaces?: Record<string, boolean>;
            viewport?: unknown;
        } | undefined;
        assert.ok(collapsePresentation?.nodes?.['instance:u_master_free']);
        assert.equal(
            collapsePresentation?.collapsedInterfaces?.[fixture.interfaceIds.masterFree],
            false
        );
        assert.deepEqual(collapsePresentation?.viewport, { x: 24, y: 20, zoom: 0.85 });

        await publishArchDesignInterfaceFixture(
            page,
            'fixture:interfaces:expanded',
            true
        );
        await page.locator('#inspector[data-kind="interface"]').waitFor();
        assert.equal(await page.locator('#inspector-title').textContent(), 'u_master_free.M_FREE');
        assert.equal(await page.locator('#interface-collapse').inputValue(), 'expanded');
        assert.equal(
            await page.locator('#selection-status').textContent(),
            'interface: u_master_free.M_FREE'
        );
        assert.equal(await page.evaluate(() => {
            const canvas = document.querySelector(
                '#canvas .x6-graph-svg-viewport'
            ) as SVGElement;
            return canvas.getAttribute('transform');
        }), beforeViewport);

        const requestMember = page.locator(
            '.x6-node[data-cell-id="instance:u_master_free"] '
            + '.x6-port-body[port="instance:u_master_free:M_FREE_REQUEST"]'
        );
        await requestMember.click();
        await page.locator('#inspector[data-kind="pin"]').waitFor();
        assert.equal(
            await page.locator('#inspector-title').textContent(),
            'u_master_free.M_FREE_REQUEST'
        );
        assert.match(await page.locator('#pin-interface').textContent() ?? '', /Project Link/);
        assert.equal(
            await page.locator('[data-inspector-action="expose-port"]').isEnabled(),
            true
        );
        await page.locator('[data-inspector-action="expose-port"]').click();
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { source?: { port?: string } } }>;
        }).__veriflowMessages.some(message =>
            message.edit?.source?.port === 'M_FREE_REQUEST'
        ));
        assert.deepEqual(lastItem(await archDesignEditMessages(page))?.edit, {
            type: 'promotePort',
            source: {
                kind: 'instance',
                instance: 'u_master_free',
                port: 'M_FREE_REQUEST',
            },
            port: { name: 'M_FREE_REQUEST', direction: 'output', width: 32 },
            connection: 'M_FREE_REQUEST',
        });

        const refreshed = archDesignInterfaceFixture(true);
        refreshed.graph.nodes = refreshed.graph.nodes.map(item => item.id === 'instance:u_master_free'
            ? { ...item, pins: item.pins.filter(pin => (
                pin as { interface?: { id?: string } }
            ).interface?.id !== fixture.interfaceIds.masterFree) }
            : item);
        refreshed.inspector.interfaces = refreshed.inspector.interfaces.filter(item =>
            item.identity !== fixture.interfaceIds.masterFree
        );
        await page.evaluate(({ refreshed }) => {
            const revision = 'fixture:interfaces:removed';
            for (const data of [{
                type: 'initialize',
                fileUri: refreshed.graph.fileUri,
                modules: [{ key: refreshed.graph.moduleKey, name: refreshed.graph.moduleName }],
                selectedModuleKey: refreshed.graph.moduleKey,
                documentKind: 'arch-design',
                editable: true,
            }, {
                type: 'graph',
                revision,
                graph: refreshed.graph,
                layout: refreshed.layout,
                fitOnFirstRender: false,
            }, {
                type: 'archDesignState',
                status: 'editable',
                revision,
                design: refreshed.design,
                catalog: refreshed.catalog,
                validation: {
                    valid: true, diagnostics: [], warnings: [], effectiveDefaults: [],
                },
                inspector: refreshed.inspector,
            }]) {
                window.dispatchEvent(new MessageEvent('message', { data }));
            }
        }, { refreshed });
        await page.locator('#inspector[data-kind="design"]').waitFor();
        assert.equal(await page.locator('#selection-status').textContent(), 'No selection');
        assert.equal(await page.locator('#canvas .veriflow-pin-selected').count(), 0);
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design collapse edits retain the latest acknowledged layout presentation', {
    timeout: 40_000,
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
        await waitForSchematicRuntime(page);
        await captureWebviewMessages(page);
        const fixture = archDesignInterfaceFixture();
        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:layout-before-collapse');
        await page.locator('#zoom-reset-button').click();
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ type?: string }>;
        }).__veriflowMessages.some(message => message.type === 'saveLayout'));
        const latestLayout = lastItem(await capturedSaves(page))?.layout;
        assert.ok(latestLayout?.placement?.nodes?.['instance:u_slave_free']);
        assert.ok(latestLayout?.placement?.nodes?.['interface:port:m_free']);
        assert.ok(latestLayout.viewport);
        await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'archDesignLayoutSaved',
                revision: 'fixture:interfaces:layout-saved',
            },
        })));

        const aggregate = page.locator(
            '.x6-node[data-cell-id="instance:u_master_free"] '
            + `.x6-port-body[port="${fixture.interfaceIds.masterFree}"]`
        );
        await aggregate.click();
        await page.locator('#interface-collapse').selectOption('expanded');
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'setPresentation'));
        const presentation = lastItem(await archDesignEditMessages(page))?.edit?.presentation as {
            nodes?: Record<string, {
                column: number;
                order: number;
                offset?: number;
                userPositioned?: boolean;
            }>;
            viewport?: unknown;
            collapsedInterfaces?: Record<string, boolean>;
        } | undefined;
        const latestPlacement = latestLayout.placement?.nodes?.['instance:u_slave_free'];
        assert.ok(latestPlacement);
        assert.deepEqual(presentation?.nodes?.['instance:u_slave_free'], {
            column: latestPlacement.column,
            order: latestPlacement.order,
            ...(latestPlacement.yOffset === 0 ? {} : { offset: latestPlacement.yOffset }),
            ...(latestPlacement.fixed ? { userPositioned: true } : {}),
        });
        assert.ok(presentation?.nodes?.['interface:port:m_free']);
        assert.deepEqual(presentation?.viewport, latestLayout.viewport);
        assert.equal(presentation?.collapsedInterfaces?.[fixture.interfaceIds.masterFree], false);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design interface Inspector edits defaults, overrides, and top-level snapshots', {
    timeout: 40_000,
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
        await waitForSchematicRuntime(page);
        await captureWebviewMessages(page);
        const fixture = archDesignInterfaceFixture();
        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:forms');
        await page.waitForTimeout(100);
        assert.deepEqual(rendererErrors, []);
        const pin = (nodeId: string, pinId: string) => page.locator(
            `.x6-node[data-cell-id="${nodeId}"] .x6-port-body[port="${pinId}"]`
        );

        await page.locator('.x6-node[data-cell-id="port:clk"] rect').first().click();
        await page.locator('#inspector[data-kind="port"]').waitFor();
        assert.equal(await page.locator('#port-width').inputValue(), '1');
        await page.locator('#port-name').fill('clock');
        await page.locator('#port-name').press('Enter');
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'updatePort'));
        await page.locator('#inspector[data-kind="port"]').waitFor();
        const portUpdates = (await archDesignEditMessages(page)).filter(
            message => message.edit?.type === 'updatePort'
        );
        assert.equal(portUpdates.length, 1);
        assert.deepEqual(portUpdates[0]?.edit, {
            type: 'updatePort',
            name: 'clk',
            port: { name: 'clock', direction: 'input', width: 1 },
        });
        await publishArchDesignInterfaceFixture(
            page,
            'fixture:interfaces:port-ack',
            false,
            false
        );

        await pin('instance:u_master_connected', fixture.interfaceIds.masterConnected).click();
        await page.locator('#inspector[data-kind="interface"]').waitFor();
        assert.equal(await page.locator('#interface-peer').textContent(), 'u_slave_connected.S_LINK');
        assert.match(
            await page.locator('#interface-warnings').textContent() ?? '',
            /connects 32 bits to 16 bits/
        );
        assert.equal(
            await page.locator('[data-inspector-action="expose-interface"]').isDisabled(),
            true
        );
        assert.match(
            await page.locator('[data-inspector-action="expose-interface"]').getAttribute('title')
                ?? '',
            /connected by control/
        );
        await page.locator('#interface-default-tag').fill("4'hf");
        await page.locator('#interface-default-tag').press('Tab');
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'setInterfaceDefault'));
        assert.deepEqual(lastItem(await archDesignEditMessages(page))?.edit, {
            type: 'setInterfaceDefault',
            connection: 'control',
            member: 'tag',
            expression: "4'hf",
        });

        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:override', false, false);
        await pin('instance:u_master_free', fixture.interfaceIds.masterFree).click();
        await page.locator('#interface-protocol-override').selectOption('project.link');
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { protocol?: string } }>;
        }).__veriflowMessages.some(message =>
            message.edit?.protocol === 'project.link'
        ));
        assert.deepEqual(lastItem(await archDesignEditMessages(page))?.edit, {
            type: 'setInterfaceOverride',
            instance: 'u_master_free',
            interface: 'M_FREE',
            protocol: 'project.link',
        });
        await publishArchDesignInterfaceFixture(
            page,
            'fixture:interfaces:role-override',
            false,
            false
        );
        await page.locator('#interface-role-override').selectOption('slave');
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'setInterfaceOverride'));
        assert.deepEqual(lastItem(await archDesignEditMessages(page))?.edit, {
            type: 'setInterfaceOverride',
            instance: 'u_master_free',
            interface: 'M_FREE',
            role: 'slave',
        });

        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:resync', false, false);
        await page.locator(
            '.x6-node[data-cell-id="interface:port:m_link"] rect'
        ).first().click();
        await page.locator('#inspector[data-kind="interface"]').waitFor();
        assert.equal(await page.locator('#interface-top-level').textContent(), 'Yes');
        await page.locator('#interface-name').fill('ddr3');
        await page.locator('#interface-name').press('Enter');
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'renameInterfacePort'));
        await page.locator('#inspector[data-kind="interface"]').waitFor();
        const renameMessages = (await archDesignEditMessages(page)).filter(
            message => message.edit?.type === 'renameInterfacePort'
        );
        assert.equal(renameMessages.length, 1);
        assert.deepEqual(renameMessages[0]?.edit, {
            type: 'renameInterfacePort',
            name: 'm_link',
            nextName: 'ddr3',
            nextMemberPrefix: 'ddr3',
        });

        const renamedFixture = archDesignInterfaceFixture(false, {
            name: 'ddr3',
            memberPrefix: 'ddr3',
        });
        await publishArchDesignInterfaceFixture(
            page,
            'fixture:interfaces:rename-ack',
            false,
            false,
            renamedFixture
        );
        await pin('interface:port:ddr3', renamedFixture.interfaceIds.top).click();
        await page.locator('#inspector[data-kind="interface"]').waitFor();
        await page.locator('[data-inspector-action="resync-interface"]').click();
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'resyncInterfacePort'));
        assert.deepEqual(lastItem(await archDesignEditMessages(page))?.edit, {
            type: 'resyncInterfacePort',
            port: 'ddr3',
            source: {
                endpoint: {
                    kind: 'instance',
                    instance: 'u_boundary_master',
                    interface: 'M_BOUNDARY',
                },
                protocol: 'project.link',
                role: 'master',
                members: [{ member: 'request', port: 'M_BOUNDARY_REQUEST', width: 32 }, {
                    member: 'accept', port: 'M_BOUNDARY_ACCEPT', width: 1,
                }],
            },
        });
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design top-level Master acts as a Slave at the inner connection boundary', {
    timeout: 40_000,
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
        await waitForSchematicRuntime(page);
        await captureWebviewMessages(page);
        const fixture = archDesignInterfaceFixture();
        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:top-role');
        await page.locator('#connect-button').click();
        const master = page.locator(
            `.x6-node[data-cell-id="instance:u_master_free"] `
            + `.x6-port-body[port="${fixture.interfaceIds.masterFree}"]`
        );
        const topLevelMaster = page.locator(
            `.x6-node[data-cell-id="interface:port:m_free"] `
            + `.x6-port-body[port="${fixture.interfaceIds.topFree}"]`
        );
        assert.equal(await master.getAttribute('magnet'), 'true');
        assert.equal(await topLevelMaster.getAttribute('magnet'), 'true');
        await topLevelMaster.click();
        await master.click();
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{ edit?: { type?: string } }>;
        }).__veriflowMessages.some(message => message.edit?.type === 'connectInterface'));
        assert.deepEqual(lastItem(await archDesignEditMessages(page)), {
            type: 'editArchDesign',
            revision: 'fixture:interfaces:top-role',
            edit: {
                type: 'connectInterface',
                connection: {
                    name: 'M_FREE_to_m_free',
                    master: {
                        kind: 'instance', instance: 'u_master_free', interface: 'M_FREE',
                    },
                    slave: { kind: 'port', port: 'm_free' },
                },
            },
        });
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design rejects incompatible and occupied interface connection targets', {
    timeout: 40_000,
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
        await waitForSchematicRuntime(page);
        await captureWebviewMessages(page);
        const fixture = archDesignInterfaceFixture();
        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:reject');
        await page.locator('#connect-button').click();
        const pin = (nodeId: string, pinId: string) => page.locator(
            `.x6-node[data-cell-id="${nodeId}"] .x6-port-body[port="${pinId}"]`
        );
        const master = pin('instance:u_master_free', fixture.interfaceIds.masterFree);
        const slave = pin('instance:u_slave_free', fixture.interfaceIds.slaveFree);
        const otherProtocol = pin(
            'instance:u_slave_other',
            fixture.interfaceIds.slaveOtherProtocol
        );
        const memberOccupied = pin(
            'instance:u_slave_occupied',
            fixture.interfaceIds.slaveMemberOccupied
        );
        const scalar = pin('instance:u_master_free', 'instance:u_master_free:irq');
        assert.equal(await memberOccupied.getAttribute('magnet'), 'false');
        const editsBefore = (await archDesignEditMessages(page)).length;
        await scalar.click();
        await slave.click();
        assert.equal(
            await scalar.evaluate(element =>
                element.classList.contains('veriflow-connection-pending')
            ),
            true
        );
        await scalar.click();
        await master.click();
        await otherProtocol.click();
        assert.equal(
            await master.evaluate(element =>
                element.classList.contains('veriflow-connection-pending')
            ),
            true
        );
        await page.keyboard.press('Escape');
        assert.equal(
            await master.evaluate(element =>
                element.classList.contains('veriflow-connection-pending')
            ),
            false
        );
        assert.equal((await archDesignEditMessages(page)).length, editsBefore);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design rejects scalar connections to occupied expanded interface members', {
    timeout: 40_000,
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
        await waitForSchematicRuntime(page);
        await captureWebviewMessages(page);
        const fixture = archDesignExpandedConnectedInterfaceFixture();
        fixture.graph.nodes = fixture.graph.nodes.map(node => (
            node.id === 'instance:u_slave_free'
                ? {
                    ...node,
                    pins: [...node.pins, {
                        id: 'instance:u_slave_free:scalar_sink',
                        name: 'scalar_sink',
                        direction: 'load',
                        width: { kind: 'known', bits: 32 },
                        readOnly: false,
                    }],
                }
                : node
        ));
        await page.evaluate(({ fixture }) => {
            const revision = 'fixture:interfaces:expanded-occupied';
            for (const data of [{
                type: 'initialize',
                fileUri: fixture.graph.fileUri,
                modules: [{ key: fixture.graph.moduleKey, name: fixture.graph.moduleName }],
                selectedModuleKey: fixture.graph.moduleKey,
                documentKind: 'arch-design',
                editable: true,
            }, {
                type: 'graph',
                revision,
                graph: fixture.graph,
                layout: fixture.layout,
                fitOnFirstRender: false,
            }, {
                type: 'archDesignState',
                status: 'editable',
                revision,
                design: fixture.design,
                catalog: fixture.catalog,
                validation: {
                    valid: true, diagnostics: [], warnings: [], effectiveDefaults: [],
                },
                inspector: fixture.inspector,
            }]) {
                window.dispatchEvent(new MessageEvent('message', { data }));
            }
        }, { fixture });
        await page.locator('#connect-button').click();
        const pin = (nodeId: string, pinId: string) => page.locator(
            `.x6-node[data-cell-id="${nodeId}"] .x6-port-body[port="${pinId}"]`
        );
        const freeRequest = pin(
            'instance:u_master_free',
            'instance:u_master_free:M_FREE_REQUEST'
        );
        const scalarSink = pin(
            'instance:u_slave_free',
            'instance:u_slave_free:scalar_sink'
        );
        const occupiedMembers = [
            pin('instance:u_master_connected', 'instance:u_master_connected:M_LINK_REQUEST'),
            pin('instance:u_master_connected', 'instance:u_master_connected:M_LINK_ACCEPT'),
            pin('instance:u_slave_connected', 'instance:u_slave_connected:S_LINK_REQUEST'),
            pin('instance:u_slave_connected', 'instance:u_slave_connected:S_LINK_ACCEPT'),
        ];
        assert.equal(await freeRequest.getAttribute('magnet'), 'true');
        assert.equal(await scalarSink.getAttribute('magnet'), 'true');
        for (const member of occupiedMembers) {
            assert.equal(await member.getAttribute('magnet'), 'false');
        }
        const editsBefore = (await archDesignEditMessages(page)).length;
        await freeRequest.click();
        await occupiedMembers[2].dispatchEvent('click');
        assert.equal(
            await freeRequest.evaluate(element =>
                element.classList.contains('veriflow-connection-pending')
            ),
            true
        );
        await page.keyboard.press('Escape');
        assert.equal((await archDesignEditMessages(page)).length, editsBefore);
        await page.locator('#connect-button').click();
        await page.locator('#connect-button').click();
        await scalarSink.click();
        await freeRequest.click();
        assert.deepEqual(lastItem(await archDesignEditMessages(page))?.edit, {
            type: 'connect',
            source: {
                kind: 'instance',
                instance: 'u_master_free',
                port: 'M_FREE_REQUEST',
            },
            target: {
                kind: 'instance',
                instance: 'u_slave_free',
                port: 'scalar_sink',
            },
        });
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design interfaces render distinct routes and only connect Master to Slave', {
    timeout: 40_000,
}, async () => {
    rmSync(interfaceScreenshotRoot, { recursive: true, force: true });
    mkdirSync(interfaceScreenshotRoot, { recursive: true });
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
        await waitForSchematicRuntime(page);
        await captureWebviewMessages(page);
        const fixture = archDesignInterfaceFixture();
        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:connect');
        await page.waitForTimeout(100);
        assert.deepEqual(rendererErrors, []);
        await page.locator('#connect-button').click();
        const pin = (nodeId: string, pinId: string) => page.locator(
            `.x6-node[data-cell-id="${nodeId}"] .x6-port-body[port="${pinId}"]`
        );
        const master = pin('instance:u_master_free', fixture.interfaceIds.masterFree);
        const slave = pin('instance:u_slave_free', fixture.interfaceIds.slaveFree);
        const memberOccupied = pin(
            'instance:u_slave_occupied',
            fixture.interfaceIds.slaveMemberOccupied
        );
        const unknown = pin('instance:u_unknown', fixture.interfaceIds.unknown);
        assert.equal(await master.getAttribute('magnet'), 'true');
        assert.equal(await slave.getAttribute('magnet'), 'true');
        assert.equal(await memberOccupied.getAttribute('magnet'), 'false');
        assert.equal(await unknown.getAttribute('magnet'), 'false');
        await slave.click();
        await master.click();
        await page.waitForFunction(() => (window as unknown as {
            __veriflowMessages: Array<{
                revision?: string;
                edit?: { connection?: { slave?: { interface?: string } } };
            }>;
        }).__veriflowMessages.some(message =>
            message.revision === 'fixture:interfaces:connect'
            && message.edit?.connection?.slave?.interface === 'S_FREE'
        ));
        assert.deepEqual(lastItem(await archDesignEditMessages(page)), {
            type: 'editArchDesign',
            revision: 'fixture:interfaces:connect',
            edit: {
                type: 'connectInterface',
                connection: {
                    name: 'M_FREE_to_S_FREE',
                    master: {
                        kind: 'instance', instance: 'u_master_free', interface: 'M_FREE',
                    },
                    slave: {
                        kind: 'instance', instance: 'u_slave_free', interface: 'S_FREE',
                    },
                },
            },
        });

        await publishArchDesignInterfaceFixture(page, 'fixture:interfaces:visual');
        if (await page.locator('#connect-button').getAttribute('aria-pressed') !== 'true') {
            await page.locator('#connect-button').click();
        }
        const editsBeforeUnknownDrag = (await archDesignEditMessages(page)).length;
        await master.click();
        await unknown.click({ force: true });
        await page.keyboard.press('Escape');
        assert.equal((await archDesignEditMessages(page)).length, editsBeforeUnknownDrag);
        const route = page.locator(
            '#canvas .x6-edge[data-cell-id^="network:interface:control:segment:"] '
            + '> path:nth-child(2)'
        ).first();
        assert.equal(Number(await route.getAttribute('stroke-width')), 4);
        assert.ok(await page.locator('#canvas .veriflow-interface-pin').count() >= 7);
        assert.equal(await page.locator('#canvas .veriflow-interface-pin').evaluateAll(
            pins => pins.every(pin => pin.matches('.x6-port-body[port]'))
        ), true);
        const interfaceColor = await route.evaluate(element => getComputedStyle(element).stroke);
        const topNode = page.locator(
            '#canvas .x6-node[data-cell-id="interface:port:m_link"]'
        );
        assert.equal(
            await topNode.locator('.veriflow-boundary-directional').count(),
            1
        );
        assert.equal(await page.locator(
            '#canvas .x6-node[data-cell-id="interface:port:m_link"] '
            + '.veriflow-interface-tag, '
            + '#canvas .x6-node[data-cell-id="interface:port:m_link"] '
            + '.veriflow-interface-tag-text'
        ).count(), 0);
        assert.equal(
            await topNode.locator('.veriflow-interface-accent').evaluate(element =>
                getComputedStyle(element).fill
            ),
            interfaceColor
        );
        const masterAggregateLabel = page.locator(
            '#canvas .x6-node[data-cell-id="instance:u_master_free"] '
            + '.veriflow-interface-label'
        );
        const slaveAggregateLabel = page.locator(
            '#canvas .x6-node[data-cell-id="instance:u_slave_free"] '
            + '.veriflow-interface-label'
        );
        assert.equal(
            (await masterAggregateLabel.locator('tspan').first().textContent())
                ?.replace(/\u00a0/g, ' '),
            'M_FREE'
        );
        assert.equal(
            await masterAggregateLabel.evaluate(element => getComputedStyle(element).fill),
            interfaceColor
        );
        assert.equal(
            await slaveAggregateLabel.evaluate(element => getComputedStyle(element).fill),
            interfaceColor
        );
        await route.click({ force: true });
        await page.locator('#inspector[data-kind="network"]').waitFor();
        assert.equal(await page.locator('#interface-network-protocol').textContent(), 'Project Link');
        assert.equal(
            await page.locator('#interface-network-member-request').textContent(),
            'M_LINK_REQUEST (32 bits) -> S_LINK_REQUEST (32 bits)'
        );
        assert.equal(
            await page.locator('#interface-network-member-accept').textContent(),
            'S_LINK_ACCEPT (1 bit) -> M_LINK_ACCEPT (1 bit)'
        );
        await page.locator('#fit-button').click();
        await pin(
            'instance:u_master_connected',
            fixture.interfaceIds.masterConnected
        ).click();
        await page.locator('#inspector[data-kind="interface"]').waitFor();

        const checkViewport = async (name: 'interface-desktop' | 'interface-narrow') => {
            const layout = await page.evaluate(() => {
                const inspector = document.querySelector<HTMLElement>('#inspector')!;
                const actions = [...document.querySelectorAll<HTMLElement>(
                    '#inspector-form .inspector-action'
                )];
                const interfacePins = [...document.querySelectorAll<SVGGraphicsElement>(
                    '#canvas .veriflow-interface-pin'
                )];
                const geometryIssues = interfacePins.flatMap(pin => {
                    const pinBounds = pin.getBoundingClientRect();
                    const group = pin.parentElement;
                    const node = pin.closest<SVGGraphicsElement>('.x6-node');
                    const label = group?.querySelector<SVGGraphicsElement>('text');
                    if (!node || !label) return [{ reason: 'missing geometry' }];
                    const nodeBounds = node.getBoundingClientRect();
                    const labelBounds = label.getBoundingClientRect();
                    if (labelBounds.width === 0 || labelBounds.height === 0) return [];
                    const withinNode = labelBounds.left >= nodeBounds.left - 0.5
                        && labelBounds.right <= nodeBounds.right + 0.5
                        && labelBounds.top >= nodeBounds.top - 0.5
                        && labelBounds.bottom <= nodeBounds.bottom + 0.5;
                    const separated = labelBounds.right <= pinBounds.left + 0.5
                        || labelBounds.left >= pinBounds.right - 0.5;
                    return withinNode && separated ? [] : [{
                        reason: !withinNode ? 'outside node' : 'overlaps pin',
                        port: pin.getAttribute('port'),
                        node: node.getAttribute('data-cell-id'),
                        pinBounds: { ...pinBounds.toJSON() },
                        labelBounds: { ...labelBounds.toJSON() },
                        nodeBounds: { ...nodeBounds.toJSON() },
                    }];
                });
                return {
                    overflow: document.documentElement.scrollWidth
                        > document.documentElement.clientWidth,
                    fieldOverflow: [...document.querySelectorAll<HTMLElement>(
                        '#inspector-form .inspector-field, #inspector-form .inspector-action'
                    )].some(item => item.scrollWidth > item.clientWidth),
                    actionOutsideInspector: actions.some(action =>
                        action.getBoundingClientRect().right
                            > inspector.getBoundingClientRect().right + 0.5
                    ),
                    actionCount: actions.length,
                    interfaceGeometryIssues: geometryIssues,
                };
            });
            assert.deepEqual(layout, {
                overflow: false,
                fieldOverflow: false,
                actionOutsideInspector: false,
                actionCount: 1,
                interfaceGeometryIssues: [],
            });
            const pixels = await actualCanvasPixelStats(page);
            assert.ok(pixels.nonBackgroundPixels > 1_000, JSON.stringify(pixels));
            assert.ok(pixels.coloredPixels > 50, JSON.stringify(pixels));
            await page.screenshot({
                path: path.join(interfaceScreenshotRoot, `${name}.png`),
                fullPage: true,
            });
        };
        await checkViewport('interface-desktop');
        await electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].setSize(440, 640);
        });
        await page.waitForFunction(() => window.innerWidth <= 440 && window.innerHeight <= 640);
        await checkViewport('interface-narrow');
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

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
        await waitForSchematicRuntime(page);

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
        await waitForSchematicRuntime(page);

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
        await waitForSchematicRuntime(page);

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
        await waitForSchematicRuntime(page);
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
        await waitForSchematicRuntime(page);
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

test('Arch Design selection stays local and layout acknowledgement preserves cells', {
    timeout: 30_000,
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
        await waitForSchematicRuntime(page);
        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
            window.addEventListener('veriflow:webview-message', event => {
                state.__veriflowMessages.push((event as CustomEvent).detail);
            });
        });

        await publishArchDesignFixture(page, 'fixture:interaction:1');
        const sourceNode = page.locator(
            '.x6-node[data-cell-id="instance:u_source"]'
        );
        await sourceNode.waitFor();
        await sourceNode.locator('rect').first().click();
        await page.locator('#selection-status').getByText(
            'instance: u_source',
            { exact: true }
        ).waitFor();
        await page.locator('#inspector-title').getByText(
            'u_source',
            { exact: true }
        ).waitFor();
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 0);

        const networkPath = page.locator(
            '.x6-edge[data-cell-id^="network:payload:segment:"] > path:nth-child(2)'
        ).first();
        const sourceBeforeDrag = await sourceNode.boundingBox();
        const routeBeforeDrag = await networkPath.getAttribute('d');
        assert.ok(sourceBeforeDrag && routeBeforeDrag);
        await dragElement(page, sourceNode.locator('rect').first(), 0, 96);
        await page.waitForFunction(() => {
            const state = window as unknown as { __veriflowMessages: Array<{
                type?: string;
            }> };
            return state.__veriflowMessages.filter(
                message => message.type === 'saveLayout'
            ).length === 1;
        });
        const sourceAfterDrag = await sourceNode.boundingBox();
        const routeAfterDrag = await networkPath.getAttribute('d');
        assert.ok(sourceAfterDrag && routeAfterDrag);
        assert.ok(sourceAfterDrag.y > sourceBeforeDrag.y + 40);
        assert.notEqual(routeAfterDrag, routeBeforeDrag);
        assert.equal(
            await page.locator('#selection-status').textContent(),
            'instance: u_source'
        );
        assert.equal((await capturedSaves(page)).length, 1);
        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
        });

        await networkPath.click({ force: true });
        await page.locator('#selection-status').getByText(
            'network: payload',
            { exact: true }
        ).waitFor();
        await page.locator('#inspector-title').getByText(
            'payload',
            { exact: true }
        ).waitFor();
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 0);

        await sourceNode.evaluate(element => {
            element.setAttribute('data-interaction-marker', 'preserved');
        });
        await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'archDesignLayoutSaved',
                revision: 'fixture:interaction:2',
            } }));
        });
        assert.equal(
            await page.locator(
                '.x6-node[data-cell-id="instance:u_source"]'
            ).getAttribute('data-interaction-marker'),
            'preserved'
        );
        assert.equal(
            await page.locator('#selection-status').textContent(),
            'network: payload'
        );
        assert.equal(await page.locator('#inspector-title').textContent(), 'payload');

        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
        });
        await page.locator('#fit-button').click();
        await page.waitForFunction(() => {
            const state = window as unknown as { __veriflowMessages: Array<{
                type?: string;
                revision?: string;
            }> };
            return state.__veriflowMessages.some(message =>
                message.type === 'saveLayout'
                && message.revision === 'fixture:interaction:2'
            );
        });
        await page.locator('#zoom-reset-button').click();
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 1);
        await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'archDesignLayoutSaved',
                revision: 'fixture:interaction:3',
            } }));
        });
        await page.waitForFunction(() => {
            const state = window as unknown as { __veriflowMessages: Array<{
                type?: string;
                revision?: string;
            }> };
            const saves = state.__veriflowMessages.filter(
                message => message.type === 'saveLayout'
            );
            return saves.length === 2
                && saves[1]?.revision === 'fixture:interaction:3';
        });
        await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'archDesignLayoutSaved',
                revision: 'fixture:interaction:4',
            } }));
        });
        await sourceNode.locator('rect').first().click();
        const sourceBeforeRelayout = await sourceNode.boundingBox();
        assert.ok(sourceBeforeRelayout);
        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
        });
        await page.locator('#relayout-button').click();
        const sourceAfterRelayout = await sourceNode.boundingBox();
        assert.ok(sourceAfterRelayout);
        assert.ok(Math.abs(sourceAfterRelayout.y - sourceBeforeRelayout.y) > 20);
        assert.equal(
            await page.locator('#selection-status').textContent(),
            'instance: u_source'
        );
        await page.waitForFunction(() => {
            const messages = (window as unknown as {
                __veriflowMessages: Array<{ type?: string; revision?: string }>;
            }).__veriflowMessages;
            return messages.some(message =>
                message.type === 'saveLayout'
                && message.revision === 'fixture:interaction:4'
            );
        });
        assert.equal(await page.evaluate(() => (
            (window as unknown as {
                __veriflowMessages: Array<{ type?: string }>;
            }).__veriflowMessages.some(message => message.type === 'relayoutAll')
        )), false);
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design serializes layout saves with semantic edits', {
    timeout: 30_000,
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
        await waitForSchematicRuntime(page);
        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
            window.addEventListener('veriflow:webview-message', event => {
                state.__veriflowMessages.push((event as CustomEvent).detail);
            });
        });
        await publishArchDesignFixture(page, 'fixture:serialized:1');
        await page.locator('.x6-node[data-cell-id="instance:u_source"]').waitFor();

        await page.locator('#fit-button').click();
        await page.waitForFunction(() => {
            const messages = (window as unknown as {
                __veriflowMessages: Array<{ type?: string }>;
            }).__veriflowMessages;
            return messages.filter(message => message.type === 'saveLayout').length === 1;
        });
        await page.locator('#add-port-button').click();
        await page.locator('#port-name-input').fill('valid');
        await page.locator('#add-port-form button[type="submit"]').click();
        await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => (
            (window as unknown as {
                __veriflowMessages: Array<{ type?: string }>;
            }).__veriflowMessages.filter(message => message.type === 'editArchDesign').length
        )), 0);
        assert.equal(await page.locator('#add-port-button').isDisabled(), true);

        await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', { data: {
                type: 'archDesignLayoutSaved',
                revision: 'fixture:serialized:2',
            } }));
        });
        await page.waitForFunction(() => {
            const messages = (window as unknown as {
                __veriflowMessages: Array<{ type?: string; revision?: string }>;
            }).__veriflowMessages;
            return messages.some(message =>
                message.type === 'editArchDesign'
                && message.revision === 'fixture:serialized:2'
            );
        });
        assert.equal(await page.locator('#add-port-button').isDisabled(), true);

        await page.locator('#fit-button').click();
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 1);

        const nextFixture = archDesignInteractionFixture();
        await page.evaluate(({ fixture }) => {
            for (const data of [{
                type: 'graph',
                revision: 'fixture:serialized:3',
                graph: fixture.graph,
                layout: fixture.layout,
                fitOnFirstRender: false,
            }, {
                type: 'archDesignState',
                status: 'editable',
                revision: 'fixture:serialized:3',
                design: fixture.design,
                catalog: fixture.catalog,
                validation: { valid: true, diagnostics: [], warnings: [], effectiveDefaults: [] },
            }]) {
                window.dispatchEvent(new MessageEvent('message', { data }));
            }
        }, { fixture: nextFixture });
        await page.waitForFunction(() => {
            const saves = (window as unknown as {
                __veriflowMessages: Array<{ type?: string; revision?: string }>;
            }).__veriflowMessages.filter(message => message.type === 'saveLayout');
            return saves.length === 2 && saves[1]?.revision === 'fixture:serialized:3';
        });
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design pagehide forwards the latest queued layout', {
    timeout: 30_000,
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
        await waitForSchematicRuntime(page);
        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
            window.addEventListener('veriflow:webview-message', event => {
                state.__veriflowMessages.push((event as CustomEvent).detail);
            });
        });
        await publishArchDesignFixture(page, 'fixture:pagehide:1');
        await page.locator('.x6-node[data-cell-id="instance:u_source"]').waitFor();

        await page.locator('#fit-button').click();
        await page.waitForFunction(() => {
            const messages = (window as unknown as {
                __veriflowMessages: Array<{ type?: string }>;
            }).__veriflowMessages;
            return messages.filter(message => message.type === 'saveLayout').length === 1;
        });
        await page.locator('#zoom-reset-button').click();
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 1);

        await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await page.waitForFunction(() => {
            const messages = (window as unknown as {
                __veriflowMessages: Array<{ type?: string }>;
            }).__veriflowMessages;
            return messages.filter(message => message.type === 'saveLayout').length === 2;
        });
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('Arch Design first render fits once without persisting an automatic viewport', {
    timeout: 30_000,
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
        await waitForSchematicRuntime(page);
        await page.evaluate(() => {
            const state = window as unknown as { __veriflowMessages: unknown[] };
            state.__veriflowMessages = [];
            window.addEventListener('veriflow:webview-message', event => {
                state.__veriflowMessages.push((event as CustomEvent).detail);
            });
        });

        const emptyFixture = archDesignInteractionFixture('fit_top');
        emptyFixture.graph.nodes = [];
        emptyFixture.graph.networks = [];
        emptyFixture.design.instances = [];
        emptyFixture.design.connections = [];
        Reflect.deleteProperty(emptyFixture.layout.placement.nodes, 'instance:u_source');
        Reflect.deleteProperty(emptyFixture.layout.placement.nodes, 'instance:u_sink');
        await publishArchDesignFixture(
            page,
            'fixture:fit:empty',
            emptyFixture,
            { fitOnFirstRender: true }
        );
        await page.locator('#canvas-state-message').getByText(
            'No schematic objects',
            { exact: true }
        ).waitFor();
        const fixture = archDesignInteractionFixture('fit_top');
        await publishArchDesignFixture(
            page,
            'fixture:fit:1',
            fixture,
            { fitOnFirstRender: true }
        );
        await page.locator(
            '#canvas .x6-node[data-cell-id^="instance:"]'
        ).nth(1).waitFor();
        const centered = await page.evaluate(() => {
            const canvas = document.querySelector<HTMLElement>('#canvas')!.getBoundingClientRect();
            const nodes = [...document.querySelectorAll<SVGGElement>(
                '#canvas .x6-node[data-cell-id^="instance:"]'
            )].map(element => element.getBoundingClientRect());
            const left = Math.min(...nodes.map(bounds => bounds.left));
            const right = Math.max(...nodes.map(bounds => bounds.right));
            const top = Math.min(...nodes.map(bounds => bounds.top));
            const bottom = Math.max(...nodes.map(bounds => bounds.bottom));
            return {
                canvasCenter: { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 },
                contentCenter: { x: (left + right) / 2, y: (top + bottom) / 2 },
                canvas: {
                    left: canvas.left,
                    top: canvas.top,
                    width: canvas.width,
                    height: canvas.height,
                },
                transform: document.querySelector<SVGGElement>(
                    '#canvas .x6-graph-svg-viewport'
                )?.getAttribute('transform'),
            };
        });
        assert.ok(
            Math.abs(centered.contentCenter.x - centered.canvasCenter.x) < 4,
            JSON.stringify(centered)
        );
        assert.ok(
            Math.abs(centered.contentCenter.y - centered.canvasCenter.y) < 4,
            JSON.stringify(centered)
        );
        await page.waitForTimeout(400);
        assert.equal((await capturedSaves(page)).length, 0);

        const fittedSourceBounds = await page.locator(
            '.x6-node[data-cell-id="instance:u_source"]'
        ).boundingBox();
        assert.ok(fittedSourceBounds);
        fixture.layout.placement.nodes['instance:u_sink'] = {
            column: 4,
            order: 0,
            yOffset: 0,
            fixed: false,
        };
        await publishArchDesignFixture(
            page,
            'fixture:fit:repeated',
            fixture,
            { fitOnFirstRender: true }
        );
        const repeatedSourceBounds = await page.locator(
            '.x6-node[data-cell-id="instance:u_source"]'
        ).boundingBox();
        assert.ok(repeatedSourceBounds);
        assert.ok(Math.abs(repeatedSourceBounds.x - fittedSourceBounds.x) < 2);
        assert.ok(Math.abs(repeatedSourceBounds.y - fittedSourceBounds.y) < 2);
        const savedFixture = archDesignInteractionFixture('saved_view_top');
        await publishArchDesignFixture(
            page,
            'fixture:fit:baseline',
            savedFixture,
            { fitOnFirstRender: false }
        );
        const baselineSourceBounds = await page.locator(
            '.x6-node[data-cell-id="instance:u_source"]'
        ).boundingBox();
        assert.ok(baselineSourceBounds);
        savedFixture.layout.viewport = { x: 84, y: 68, zoom: 1 };
        await publishArchDesignFixture(
            page,
            'fixture:fit:2',
            savedFixture,
            { fitOnFirstRender: false }
        );
        const sourceBounds = await page.locator(
            '.x6-node[data-cell-id="instance:u_source"]'
        ).boundingBox();
        assert.ok(sourceBounds);
        assert.ok(Math.abs(sourceBounds.x - baselineSourceBounds.x - 84) < 2);
        assert.ok(Math.abs(sourceBounds.y - baselineSourceBounds.y - 68) < 2);
        assert.equal((await capturedSaves(page)).length, 0);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('schematic runtime paints responsive geometry and authors Arch Design connections', {
    timeout: 90_000,
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
        await waitForSchematicRuntime(page);
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
        assert.equal(await page.locator(
            '#canvas .x6-node[data-cell-id="port:visual-input-a"] '
            + '.veriflow-boundary-directional'
        ).count(), 1);
        assert.equal(await page.locator(
            '#canvas .x6-node[data-cell-id="port:visual-output"] '
            + '.veriflow-boundary-directional'
        ).count(), 1);
        const inoutNode = page.locator(
            '#canvas .x6-node[data-cell-id="port:visual-inout"]'
        );
        assert.equal(
            await inoutNode.locator('.veriflow-boundary-directional').count(),
            1
        );
        const inoutPinCenters = await inoutNode.locator('.x6-port-body[port]')
            .evaluateAll(elements => elements.map(element => {
                const bounds = element.getBoundingClientRect();
                return {
                    port: element.getAttribute('port'),
                    x: Math.round((bounds.left + bounds.width / 2) * 100) / 100,
                    y: Math.round((bounds.top + bounds.height / 2) * 100) / 100,
                };
            }));
        assert.equal(inoutPinCenters.length, 3);
        assert.equal(new Set(inoutPinCenters.map(pin => pin.y)).size, 3);
        const inoutPinCenter = (name: 'o' | 't' | 'i') =>
            inoutPinCenters.find(pin =>
                pin.port === `port:visual-inout:shared_io_${name}`
            )!;
        assert.equal(inoutPinCenter('o').x, inoutPinCenter('t').x);
        assert.ok(inoutPinCenter('i').x > inoutPinCenter('o').x);
        const inoutMarkers = {
            o: inoutNode.locator(
                'circle.x6-port-body.veriflow-inout-pin-o'
                + '[port="port:visual-inout:shared_io_o"]'
            ),
            t: inoutNode.locator(
                '.x6-port-body[port="port:visual-inout:shared_io_t"] '
                + 'circle.veriflow-inout-pin-t'
            ),
            i: inoutNode.locator(
                'circle.x6-port-body.veriflow-inout-pin-i'
                + '[port="port:visual-inout:shared_io_i"]'
            ),
        };
        assert.equal(
            await inoutMarkers.o.locator('title').textContent(),
            'Output drive (O)'
        );
        assert.equal(
            await inoutMarkers.t.locator('title').textContent(),
            'Tri-state enable (T)'
        );
        assert.equal(
            await inoutMarkers.i.locator('title').textContent(),
            'Input sense (I)'
        );
        assert.equal(await inoutNode.locator(
            '.x6-port-body[port="port:visual-inout:shared_io_t"] '
            + 'circle.veriflow-inout-t-ring'
        ).count(), 1);
        assert.equal(await page.locator(
            '#canvas .x6-node[data-cell-id="instance:visual-wide"] '
            + '.x6-port-body[port="instance:visual-wide:spare_input"] '
            + 'title'
        ).count(), 0);
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
            assert.equal(geometry.nodeCount, 14);
            assert.ok(geometry.edgeCount > fixture.graph.networks.length);
            assert.equal(geometry.labelCount, 0);
            assert.equal(geometry.pinCount, 29);
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
                'port:visual-inout': 'shared_io',
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
        await exerciseArchDesignConnections(page);
        assert.deepEqual(rendererErrors, []);
    } finally {
        await electronApp.close();
        rmSync(fixtureRoot, { recursive: true, force: true });
        rmSync(userDataDir, { recursive: true, force: true });
    }
});
