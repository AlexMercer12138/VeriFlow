import type { SchematicNodeSize } from '../nodeGeometry';
import type { Point, Rectangle } from './geometry';
import {
    MAX_ROUTING_TRACKS,
    createRoutingTrackPool,
    type RoutingTrackPool,
    type RoutingTrackPoolController,
} from './tracks';

export const ROUTING_GRID_DEFAULTS = Object.freeze({
    gridStep: 2,
    pinEscape: 12,
    safetyMargin: 4,
    trackPitch: 12,
    minimumChannelWidth: 32,
    minimumRowGap: 32,
    minimumOuterMargin: 16,
});

export const MAX_ROUTING_COLUMNS = 100_000;

export type RoutingGridMetrics = Readonly<{
    gridStep: number;
    pinEscape: number;
    safetyMargin: number;
    trackPitch: number;
    minimumChannelWidth: number;
    minimumRowGap: number;
    minimumOuterMargin: number;
}>;

export type RoutingGridCreateOptions = Partial<RoutingGridMetrics> & Readonly<{
    columnCount?: number;
}>;

export type RoutingGridPinInput = Readonly<{
    id: string;
    x: number;
    y: number;
}>;

export type RoutingGridNodeInput = Readonly<{
    id: string;
    column: number;
    order: number;
    yOffset: number;
    size: Readonly<SchematicNodeSize>;
    pinAnchors?: readonly RoutingGridPinInput[];
}>;

export type RoutingGridColumn = Readonly<{
    index: number;
    width: number;
    nodeIds: readonly string[];
}>;

export type RoutingGridChannel = Readonly<{
    index: number;
    columns: readonly [number, number];
    tracks: RoutingTrackPool;
}>;

export type RoutingGridRowGap = Readonly<{
    index: number;
    tracks: RoutingTrackPool;
}>;

export type RoutingGrid = Readonly<{
    metrics: RoutingGridMetrics;
    columns: readonly RoutingGridColumn[];
    channels: readonly RoutingGridChannel[];
    rowGaps: readonly RoutingGridRowGap[];
    outer: Readonly<{
        top: RoutingTrackPool;
        bottom: RoutingTrackPool;
    }>;
}>;

export type ColumnSpan = readonly [number, number];

export type InternalCorridorCandidate = Readonly<{
    kind: 'internal';
    rowGap: number;
    span: ColumnSpan;
}>;

export type OuterCorridorCandidate = Readonly<{
    kind: 'outer-top' | 'outer-bottom';
    lane: number;
    span: ColumnSpan;
}>;

export type CorridorCandidate =
    | InternalCorridorCandidate
    | OuterCorridorCandidate;

export type ChannelTrackHandle = Readonly<{
    kind: 'channel';
    channel: number;
    track: number;
}>;

export type InternalCorridorTrackHandle = Readonly<{
    kind: 'internal';
    rowGap: number;
    track: number;
    span: ColumnSpan;
}>;

export type OuterCorridorTrackHandle = Readonly<{
    kind: 'outer-top' | 'outer-bottom';
    lane: number;
    span: ColumnSpan;
}>;

export type CorridorTrackHandle =
    | InternalCorridorTrackHandle
    | OuterCorridorTrackHandle;

export type RealizedRoutingPin = Readonly<{
    id: string;
    point: Point;
}>;

export type RealizedRoutingNode = Readonly<{
    id: string;
    column: number;
    row: number;
    bounds: Rectangle;
    pinAnchors: readonly RealizedRoutingPin[];
}>;

export type RealizedRoutingColumn = Readonly<{
    index: number;
    x: number;
    width: number;
}>;

export type RealizedRoutingChannel = Readonly<{
    index: number;
    x: number;
    width: number;
    trackX: readonly number[];
}>;

export type RealizedRoutingRowGap = Readonly<{
    index: number;
    y: number;
    height: number;
    trackY: readonly number[];
}>;

export type RealizedRoutingOuterLane = Readonly<{
    y: number;
    height: number;
    trackY: readonly number[];
}>;

export type RealizedRoutingGrid = Readonly<{
    metrics: RoutingGridMetrics;
    width: number;
    height: number;
    columns: readonly RealizedRoutingColumn[];
    channels: readonly RealizedRoutingChannel[];
    rowGaps: readonly RealizedRoutingRowGap[];
    outer: Readonly<{
        top: RealizedRoutingOuterLane;
        bottom: RealizedRoutingOuterLane;
    }>;
    nodes: readonly RealizedRoutingNode[];
}>;

type NormalizedPin = Readonly<{
    id: string;
    x: number;
    y: number;
}>;

type NormalizedNode = Readonly<{
    id: string;
    inputIndex: number;
    column: number;
    order: number;
    row: number;
    yOffset: number;
    width: number;
    height: number;
    pinAnchors: readonly NormalizedPin[];
}>;

type GridState = {
    metrics: RoutingGridMetrics;
    nodes: NormalizedNode[];
    rowHeights: number[];
    blockedColumnsByRowGap: number[][];
    channelPools: RoutingTrackPoolController[];
    rowGapPools: RoutingTrackPoolController[];
    topPool: RoutingTrackPoolController;
    bottomPool: RoutingTrackPoolController;
    realized?: RealizedRoutingGrid;
};

const gridStates = new WeakMap<RoutingGrid, GridState>();

function safeAdd(left: number, right: number, label: string): number {
    const result = left + right;
    if (!Number.isSafeInteger(result)) {
        throw new RangeError(`${label} exceeds the finite integer routing grid`);
    }
    return result;
}

function safeMultiply(left: number, right: number, label: string): number {
    const result = left * right;
    if (!Number.isSafeInteger(result)) {
        throw new RangeError(`${label} exceeds the finite integer routing grid`);
    }
    return result;
}

function assertSafeNonNegativeInteger(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer`);
    }
}

function assertGridMetric(value: number, gridStep: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0 || value % gridStep !== 0) {
        throw new RangeError(`${label} must be a non-negative grid-aligned integer`);
    }
}

function alignUp(value: number, step: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0
        || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`${label} must be a positive finite safe value`);
    }
    const aligned = Math.ceil(value / step) * step;
    if (!Number.isSafeInteger(aligned)) {
        throw new RangeError(`${label} exceeds the finite integer routing grid`);
    }
    return aligned;
}

function alignNearest(value: number, step: number, label: string): number {
    if (!Number.isFinite(value)
        || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError(`${label} must be a finite safe value`);
    }
    const aligned = Math.round(value / step) * step;
    if (!Number.isSafeInteger(aligned)) {
        throw new RangeError(`${label} exceeds the finite integer routing grid`);
    }
    return Object.is(aligned, -0) ? 0 : aligned;
}

function resolvedMetrics(options: RoutingGridCreateOptions): RoutingGridMetrics {
    const metrics = Object.freeze({
        gridStep: options.gridStep ?? ROUTING_GRID_DEFAULTS.gridStep,
        pinEscape: options.pinEscape ?? ROUTING_GRID_DEFAULTS.pinEscape,
        safetyMargin: options.safetyMargin ?? ROUTING_GRID_DEFAULTS.safetyMargin,
        trackPitch: options.trackPitch ?? ROUTING_GRID_DEFAULTS.trackPitch,
        minimumChannelWidth: options.minimumChannelWidth
            ?? ROUTING_GRID_DEFAULTS.minimumChannelWidth,
        minimumRowGap: options.minimumRowGap
            ?? ROUTING_GRID_DEFAULTS.minimumRowGap,
        minimumOuterMargin: options.minimumOuterMargin
            ?? ROUTING_GRID_DEFAULTS.minimumOuterMargin,
    });
    if (!Number.isSafeInteger(metrics.gridStep) || metrics.gridStep <= 0) {
        throw new RangeError('gridStep must be a positive safe integer');
    }
    for (const [label, value] of Object.entries(metrics)) {
        if (label === 'gridStep') continue;
        assertGridMetric(value, metrics.gridStep, label);
    }
    if (metrics.trackPitch <= 0) {
        throw new RangeError('trackPitch must be positive');
    }
    if ((metrics.trackPitch / 2) % metrics.gridStep !== 0) {
        throw new RangeError('half the trackPitch must remain grid aligned');
    }
    const maximumTrackDemand = safeMultiply(
        MAX_ROUTING_TRACKS,
        metrics.trackPitch,
        'maximum routing track demand'
    );
    safeAdd(
        metrics.minimumChannelWidth,
        maximumTrackDemand,
        'maximum routing channel width'
    );
    safeAdd(
        metrics.minimumRowGap,
        maximumTrackDemand,
        'maximum routing row gap height'
    );
    safeAdd(
        metrics.minimumOuterMargin,
        maximumTrackDemand,
        'maximum outer routing margin'
    );
    const inflation = safeAdd(
        metrics.pinEscape,
        metrics.safetyMargin,
        'module inflation'
    );
    const doubleInflation = safeMultiply(inflation, 2, 'module inflation');
    if (metrics.minimumChannelWidth < doubleInflation
        || metrics.minimumRowGap < doubleInflation
        || metrics.minimumOuterMargin < inflation) {
        throw new RangeError(
            'routing minimum gaps must contain pin escape and safety margins'
        );
    }
    return metrics;
}

function upperBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle] <= target) low = middle + 1;
        else high = middle;
    }
    return low;
}

function lowerBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle] < target) low = middle + 1;
        else high = middle;
    }
    return low;
}

function normalizedColumnCount(
    options: RoutingGridCreateOptions,
    requiredCount: number
): number {
    const count = options.columnCount ?? requiredCount;
    assertSafeNonNegativeInteger(count, 'columnCount');
    if (count > MAX_ROUTING_COLUMNS) {
        throw new RangeError(`columnCount must not exceed ${MAX_ROUTING_COLUMNS}`);
    }
    if (count < requiredCount) {
        throw new RangeError('columnCount does not contain every routing node');
    }
    return count;
}

function normalizeNode(
    input: RoutingGridNodeInput,
    inputIndex: number,
    metrics: RoutingGridMetrics,
    seenNodeIds: Set<string>
): Omit<NormalizedNode, 'row'> {
    if (typeof input.id !== 'string' || seenNodeIds.has(input.id)) {
        throw new RangeError('routing node IDs must be unique strings');
    }
    seenNodeIds.add(input.id);
    assertSafeNonNegativeInteger(input.column, `node ${input.id} column`);
    if (input.column >= MAX_ROUTING_COLUMNS) {
        throw new RangeError(`node ${input.id} column exceeds the routing grid`);
    }
    assertSafeNonNegativeInteger(input.order, `node ${input.id} order`);
    const width = alignUp(input.size.width, metrics.gridStep, `node ${input.id} width`);
    const height = alignUp(input.size.height, metrics.gridStep, `node ${input.id} height`);
    const yOffset = alignNearest(
        input.yOffset,
        metrics.gridStep,
        `node ${input.id} yOffset`
    );
    const seenPinIds = new Set<string>();
    const pinAnchors = (input.pinAnchors ?? []).map(pin => {
        if (typeof pin.id !== 'string' || seenPinIds.has(pin.id)) {
            throw new RangeError(`node ${input.id} pin IDs must be unique strings`);
        }
        seenPinIds.add(pin.id);
        if (!Number.isFinite(pin.x) || Math.abs(pin.x) > Number.MAX_SAFE_INTEGER
            || !Number.isFinite(pin.y)
            || Math.abs(pin.y) > Number.MAX_SAFE_INTEGER
            || pin.x < 0 || pin.x > input.size.width
            || pin.y < 0 || pin.y > input.size.height) {
            throw new RangeError(`node ${input.id} pin anchor lies outside its bounds`);
        }
        return Object.freeze({
            id: pin.id,
            x: pin.x === input.size.width
                ? width
                : alignNearest(pin.x, metrics.gridStep, `pin ${pin.id} x`),
            y: pin.y === input.size.height
                ? height
                : alignNearest(pin.y, metrics.gridStep, `pin ${pin.id} y`),
        });
    });
    return {
        id: input.id,
        inputIndex,
        column: input.column,
        order: input.order,
        yOffset,
        width,
        height,
        pinAnchors: Object.freeze(pinAnchors),
    };
}

function rowTops(
    rowHeights: readonly number[],
    gapHeights: readonly number[]
): number[] {
    const tops: number[] = [];
    let cursor = 0;
    rowHeights.forEach((height, row) => {
        tops.push(cursor);
        cursor = safeAdd(cursor, height, 'routing row position');
        if (row < gapHeights.length) {
            cursor = safeAdd(cursor, gapHeights[row], 'routing row position');
        }
    });
    return tops;
}

function relativeNodeTops(
    nodes: readonly NormalizedNode[],
    tops: readonly number[],
    gridStep: number
): Map<string, number> {
    const byColumn = new Map<number, NormalizedNode[]>();
    for (const node of nodes) {
        const entries = byColumn.get(node.column) ?? [];
        entries.push(node);
        byColumn.set(node.column, entries);
    }
    const result = new Map<string, number>();
    for (const entries of byColumn.values()) {
        entries.sort((left, right) => left.row - right.row);
        let previousBottom = 0;
        entries.forEach((node, index) => {
            const desired = safeAdd(
                tops[node.row],
                node.yOffset,
                `node ${node.id} vertical position`
            );
            const minimum = index === 0
                ? 0
                : safeAdd(previousBottom, gridStep, 'node separation');
            const top = Math.max(0, desired, minimum);
            result.set(node.id, top);
            previousBottom = safeAdd(top, node.height, `node ${node.id} bounds`);
        });
    }
    return result;
}

function corridorBlockers(
    nodes: readonly NormalizedNode[],
    nodeTops: ReadonlyMap<string, number>,
    boundaries: readonly number[],
    columnCount: number,
    inflation: number
): number[][] {
    const blocked = Array.from({ length: boundaries.length }, () => new Set<number>());
    for (const node of nodes) {
        const top = nodeTops.get(node.id)!;
        const inflatedTop = top - inflation;
        const inflatedBottom = safeAdd(
            safeAdd(top, node.height, `node ${node.id} bounds`),
            inflation,
            `node ${node.id} inflated bounds`
        );
        const firstGapAboveNode = upperBound(boundaries, inflatedTop);
        const afterLastGapAboveNode = Math.min(node.row, boundaries.length);
        for (let gap = firstGapAboveNode;
            gap < afterLastGapAboveNode;
            gap += 1) {
            blocked[gap].add(node.column);
        }
        const firstGapBelowNode = Math.min(node.row, boundaries.length);
        const afterLastGapBelowNode = lowerBound(boundaries, inflatedBottom);
        for (let gap = firstGapBelowNode;
            gap < afterLastGapBelowNode;
            gap += 1) {
            blocked[gap].add(node.column);
        }
    }
    return blocked.map(columns => [...columns]
        .filter(column => column < columnCount)
        .sort((left, right) => left - right));
}

function stateFor(grid: RoutingGrid): GridState {
    const state = gridStates.get(grid);
    if (!state) throw new TypeError('unknown routing grid');
    return state;
}

function immutableSpan(startColumn: number, endColumn: number): ColumnSpan {
    return Object.freeze([startColumn, endColumn]) as ColumnSpan;
}

export function createRoutingGrid(
    inputNodes: readonly RoutingGridNodeInput[],
    options: RoutingGridCreateOptions = {}
): RoutingGrid {
    const metrics = resolvedMetrics(options);
    const seenNodeIds = new Set<string>();
    const provisional = inputNodes.map((node, index) =>
        normalizeNode(node, index, metrics, seenNodeIds)
    );
    const requiredColumnCount = provisional.reduce(
        (maximum, node) => Math.max(maximum, node.column + 1),
        0
    );
    const columnCount = normalizedColumnCount(options, requiredColumnCount);
    const nodesByColumn = Array.from(
        { length: columnCount },
        () => [] as Array<Omit<NormalizedNode, 'row'>>
    );
    for (const node of provisional) nodesByColumn[node.column].push(node);

    const nodes: NormalizedNode[] = [];
    const columns: RoutingGridColumn[] = [];
    nodesByColumn.forEach((columnNodes, column) => {
        columnNodes.sort((left, right) =>
            left.order - right.order
            || left.inputIndex - right.inputIndex
            || left.id.localeCompare(right.id)
        );
        const normalized = columnNodes.map((node, row) =>
            Object.freeze({ ...node, row })
        );
        nodes.push(...normalized);
        columns.push(Object.freeze({
            index: column,
            width: normalized.reduce(
                (maximum, node) => Math.max(maximum, node.width),
                0
            ),
            nodeIds: Object.freeze(normalized.map(node => node.id)),
        }));
    });
    nodes.sort((left, right) => left.inputIndex - right.inputIndex);

    const rowCount = nodes.reduce(
        (maximum, node) => Math.max(maximum, node.row + 1),
        0
    );
    const rowHeights = new Array<number>(rowCount).fill(0);
    for (const node of nodes) {
        rowHeights[node.row] = Math.max(rowHeights[node.row], node.height);
    }
    const baseGapHeights = Array.from(
        { length: Math.max(0, rowCount - 1) },
        () => metrics.minimumRowGap
    );
    const baseRowTops = rowTops(rowHeights, baseGapHeights);
    const inflation = safeAdd(
        metrics.pinEscape,
        metrics.safetyMargin,
        'module inflation'
    );
    const boundaries = baseGapHeights.map((_, rowGap) =>
        safeAdd(
            safeAdd(baseRowTops[rowGap], rowHeights[rowGap], 'row gap boundary'),
            inflation,
            'row gap boundary'
        )
    );
    const baseNodeTops = relativeNodeTops(nodes, baseRowTops, metrics.gridStep);
    const blockedColumnsByRowGap = corridorBlockers(
        nodes,
        baseNodeTops,
        boundaries,
        columnCount,
        inflation
    );

    const channelPools = Array.from(
        { length: Math.max(0, columnCount - 1) },
        (_, channel) => createRoutingTrackPool(`channel:${channel}`, 'vertical')
    );
    const rowGapPools = baseGapHeights.map((_, rowGap) =>
        createRoutingTrackPool(`row-gap:${rowGap}`, 'horizontal')
    );
    const topPool = createRoutingTrackPool('outer-top', 'horizontal');
    const bottomPool = createRoutingTrackPool('outer-bottom', 'horizontal');
    const channels = channelPools.map((controller, index) => Object.freeze({
        index,
        columns: Object.freeze([index, index + 1]) as readonly [number, number],
        tracks: controller.pool,
    }));
    const rowGaps = rowGapPools.map((controller, index) => Object.freeze({
        index,
        tracks: controller.pool,
    }));
    const grid: RoutingGrid = Object.freeze({
        metrics,
        columns: Object.freeze(columns),
        channels: Object.freeze(channels),
        rowGaps: Object.freeze(rowGaps),
        outer: Object.freeze({
            top: topPool.pool,
            bottom: bottomPool.pool,
        }),
    });
    gridStates.set(grid, {
        metrics,
        nodes,
        rowHeights,
        blockedColumnsByRowGap,
        channelPools,
        rowGapPools,
        topPool,
        bottomPool,
    });
    return grid;
}

function validateSpan(
    grid: RoutingGrid,
    startColumn: number,
    endColumn: number
): void {
    assertSafeNonNegativeInteger(startColumn, 'corridor start column');
    assertSafeNonNegativeInteger(endColumn, 'corridor end column');
    if (startColumn > endColumn || endColumn >= grid.columns.length) {
        throw new RangeError('corridor span must be an ordered range of grid columns');
    }
}

function gapIsClear(
    blockedColumns: readonly number[],
    startColumn: number,
    endColumn: number
): boolean {
    const candidate = lowerBound(blockedColumns, startColumn);
    return candidate >= blockedColumns.length
        || blockedColumns[candidate] > endColumn;
}

export function planCorridors(
    grid: RoutingGrid,
    startColumn: number,
    endColumn: number,
    preferredRowGap?: number
): CorridorCandidate[] {
    const state = stateFor(grid);
    validateSpan(grid, startColumn, endColumn);
    const rowGapCount = grid.rowGaps.length;
    const preferred = preferredRowGap ?? Math.max(
        0,
        Math.floor((rowGapCount - 1) / 2)
    );
    if (preferredRowGap !== undefined) {
        assertSafeNonNegativeInteger(preferredRowGap, 'preferred row gap');
        if (rowGapCount === 0 || preferredRowGap >= rowGapCount) {
            throw new RangeError('preferred row gap is outside the routing grid');
        }
    }
    const span = immutableSpan(startColumn, endColumn);
    const result: CorridorCandidate[] = state.blockedColumnsByRowGap
        .map((blockedColumns, rowGap) => ({ blockedColumns, rowGap }))
        .filter(({ blockedColumns }) =>
            gapIsClear(blockedColumns, startColumn, endColumn)
        )
        .sort((left, right) =>
            Math.abs(left.rowGap - preferred) - Math.abs(right.rowGap - preferred)
            || left.rowGap - right.rowGap
        )
        .map(({ rowGap }) => Object.freeze({
            kind: 'internal' as const,
            rowGap,
            span,
        }));

    const outerCandidates: OuterCorridorCandidate[] = [
        Object.freeze({
            kind: 'outer-top' as const,
            lane: state.topPool.pool.trackCount,
            span,
        }),
        Object.freeze({
            kind: 'outer-bottom' as const,
            lane: state.bottomPool.pool.trackCount,
            span,
        }),
    ];
    if (rowGapCount > 0) {
        const topDistance = preferred + 1;
        const bottomDistance = rowGapCount - preferred;
        if (bottomDistance < topDistance) outerCandidates.reverse();
    }
    result.push(...outerCandidates);
    return result;
}

export function allocateChannelTrack(
    grid: RoutingGrid,
    channel: number,
    track?: number
): ChannelTrackHandle {
    const state = stateFor(grid);
    assertSafeNonNegativeInteger(channel, 'routing channel');
    if (channel >= state.channelPools.length) {
        throw new RangeError('routing channel is outside the grid');
    }
    return Object.freeze({
        kind: 'channel',
        channel,
        track: state.channelPools[channel].request(track),
    });
}

function validateCandidate(grid: RoutingGrid, candidate: CorridorCandidate): void {
    validateSpan(grid, candidate.span[0], candidate.span[1]);
    if (candidate.kind === 'internal') {
        assertSafeNonNegativeInteger(candidate.rowGap, 'corridor row gap');
        if (candidate.rowGap >= grid.rowGaps.length) {
            throw new RangeError('corridor row gap is outside the grid');
        }
        return;
    }
    assertSafeNonNegativeInteger(candidate.lane, 'outer corridor lane');
}

export function allocateCorridorTrack(
    grid: RoutingGrid,
    candidate: InternalCorridorCandidate,
    track?: number
): InternalCorridorTrackHandle;
export function allocateCorridorTrack(
    grid: RoutingGrid,
    candidate: OuterCorridorCandidate
): OuterCorridorTrackHandle;
export function allocateCorridorTrack(
    grid: RoutingGrid,
    candidate: CorridorCandidate,
    track?: number
): CorridorTrackHandle;
export function allocateCorridorTrack(
    grid: RoutingGrid,
    candidate: CorridorCandidate,
    track?: number
): CorridorTrackHandle {
    const state = stateFor(grid);
    validateCandidate(grid, candidate);
    const span = immutableSpan(candidate.span[0], candidate.span[1]);
    if (candidate.kind === 'internal') {
        return Object.freeze({
            kind: candidate.kind,
            rowGap: candidate.rowGap,
            track: state.rowGapPools[candidate.rowGap].request(track),
            span,
        });
    }
    const controller = candidate.kind === 'outer-top'
        ? state.topPool
        : state.bottomPool;
    const lane = controller.request(candidate.lane);
    return Object.freeze({ kind: candidate.kind, lane, span });
}

function demandedSize(
    minimum: number,
    trackCount: number,
    pitch: number,
    label: string
): number {
    return safeAdd(
        minimum,
        safeMultiply(trackCount, pitch, label),
        label
    );
}

function trackCoordinates(
    start: number,
    trackCount: number,
    metrics: RoutingGridMetrics
): number[] {
    const inflation = safeAdd(
        metrics.pinEscape,
        metrics.safetyMargin,
        'track inset'
    );
    const halfPitch = metrics.trackPitch / 2;
    return Array.from({ length: trackCount }, (_, track) => safeAdd(
        safeAdd(start, inflation, 'track coordinate'),
        safeAdd(
            halfPitch,
            safeMultiply(track, metrics.trackPitch, 'track coordinate'),
            'track coordinate'
        ),
        'track coordinate'
    ));
}

function freezeRectangle(rectangle: Rectangle): Rectangle {
    return Object.freeze(rectangle);
}

export function realizeRoutingGrid(grid: RoutingGrid): RealizedRoutingGrid {
    const state = stateFor(grid);
    if (state.realized) return state.realized;
    const { metrics } = state;

    const channelWidths = state.channelPools.map(controller => demandedSize(
        metrics.minimumChannelWidth,
        controller.pool.trackCount,
        metrics.trackPitch,
        'routing channel width'
    ));
    const columns: RealizedRoutingColumn[] = [];
    const channels: RealizedRoutingChannel[] = [];
    let xCursor = 0;
    grid.columns.forEach((column, index) => {
        columns.push(Object.freeze({ index, x: xCursor, width: column.width }));
        xCursor = safeAdd(xCursor, column.width, 'routing grid width');
        if (index >= channelWidths.length) return;
        const width = channelWidths[index];
        channels.push(Object.freeze({
            index,
            x: xCursor,
            width,
            trackX: Object.freeze(trackCoordinates(
                xCursor,
                state.channelPools[index].pool.trackCount,
                metrics
            )),
        }));
        xCursor = safeAdd(xCursor, width, 'routing grid width');
    });

    const gapHeights = state.rowGapPools.map(controller => demandedSize(
        metrics.minimumRowGap,
        controller.pool.trackCount,
        metrics.trackPitch,
        'routing row gap height'
    ));
    const tops = rowTops(state.rowHeights, gapHeights);
    const relativeTops = relativeNodeTops(state.nodes, tops, metrics.gridStep);
    const topHeight = demandedSize(
        metrics.minimumOuterMargin,
        state.topPool.pool.trackCount,
        metrics.trackPitch,
        'top routing margin'
    );
    const bottomHeight = demandedSize(
        metrics.minimumOuterMargin,
        state.bottomPool.pool.trackCount,
        metrics.trackPitch,
        'bottom routing margin'
    );
    let contentHeight = state.rowHeights.length === 0
        ? 0
        : safeAdd(
            tops[tops.length - 1],
            state.rowHeights[state.rowHeights.length - 1],
            'routing content height'
        );
    for (const node of state.nodes) {
        contentHeight = Math.max(
            contentHeight,
            safeAdd(relativeTops.get(node.id)!, node.height, 'routing content height')
        );
    }

    const rowGaps = state.rowGapPools.map((controller, rowGap) => {
        const y = safeAdd(
            safeAdd(topHeight, tops[rowGap], 'routing row gap position'),
            state.rowHeights[rowGap],
            'routing row gap position'
        );
        return Object.freeze({
            index: rowGap,
            y,
            height: gapHeights[rowGap],
            trackY: Object.freeze(trackCoordinates(
                y,
                controller.pool.trackCount,
                metrics
            )),
        });
    });
    const nodes = state.nodes.map(node => {
        const column = columns[node.column];
        const centeredOffset = Math.floor(
            (column.width - node.width) / (2 * metrics.gridStep)
        ) * metrics.gridStep;
        const x = safeAdd(
            column.x,
            centeredOffset,
            `node ${node.id} horizontal position`
        );
        const y = safeAdd(
            topHeight,
            relativeTops.get(node.id)!,
            `node ${node.id} vertical position`
        );
        const bounds = freezeRectangle({
            x,
            y,
            width: node.width,
            height: node.height,
        });
        const pinAnchors = node.pinAnchors.map(pin => Object.freeze({
            id: pin.id,
            point: Object.freeze({
                x: safeAdd(x, pin.x, `pin ${pin.id} x`),
                y: safeAdd(y, pin.y, `pin ${pin.id} y`),
            }),
        }));
        return Object.freeze({
            id: node.id,
            column: node.column,
            row: node.row,
            bounds,
            pinAnchors: Object.freeze(pinAnchors),
        });
    });

    const bottomY = safeAdd(topHeight, contentHeight, 'bottom routing margin');
    const halfPitch = metrics.trackPitch / 2;
    const inflation = safeAdd(
        metrics.pinEscape,
        metrics.safetyMargin,
        'outer track inset'
    );
    const topTrackY = Array.from(
        { length: state.topPool.pool.trackCount },
        (_, track) => topHeight
            - inflation
            - halfPitch
            - track * metrics.trackPitch
    );
    const bottomTrackY = trackCoordinates(
        bottomY,
        state.bottomPool.pool.trackCount,
        metrics
    );
    const height = safeAdd(
        bottomY,
        bottomHeight,
        'routing grid height'
    );
    const realized: RealizedRoutingGrid = Object.freeze({
        metrics,
        width: xCursor,
        height,
        columns: Object.freeze(columns),
        channels: Object.freeze(channels),
        rowGaps: Object.freeze(rowGaps),
        outer: Object.freeze({
            top: Object.freeze({
                y: 0,
                height: topHeight,
                trackY: Object.freeze(topTrackY),
            }),
            bottom: Object.freeze({
                y: bottomY,
                height: bottomHeight,
                trackY: Object.freeze(bottomTrackY),
            }),
        }),
        nodes: Object.freeze(nodes),
    });

    state.channelPools.forEach(pool => pool.seal());
    state.rowGapPools.forEach(pool => pool.seal());
    state.topPool.seal();
    state.bottomPool.seal();
    state.realized = realized;
    return realized;
}
