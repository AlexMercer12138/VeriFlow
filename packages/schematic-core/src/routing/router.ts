import {
    allocateChannelTrack,
    allocateCorridorTrack,
    createRoutingGrid,
    planCorridors,
    realizeRoutingGrid,
    type CorridorTrackHandle,
    type CorridorCandidate,
    type OuterCorridorTrackHandle,
    type RealizedRoutingGrid,
    type RealizedRoutingNode,
    type RoutingGridCreateOptions,
    type RoutingGridNodeInput,
} from './grid';
import {
    horizontal,
    segmentIntersectsRectangleInterior,
    simplifySegments,
    vertical,
    type RouteSegment,
} from './geometry';
import {
    HorizontalReservationIndex,
    VerticalReservationIndex,
} from './occupancy';
import { MAX_ROUTING_TRACKS } from './tracks';

export type RoutingTerminalRole = 'driver' | 'load' | 'bidirectional';

export type RoutingTerminalRequest = Readonly<{
    nodeId: string;
    pinId: string;
    role: RoutingTerminalRole;
}>;

export type RoutingNetworkRequest = Readonly<{
    id: string;
    terminals: readonly RoutingTerminalRequest[];
}>;

export type RoutedRouteSegment = Readonly<
    Extract<RouteSegment, { orientation: 'horizontal' }>
> | Readonly<Extract<RouteSegment, { orientation: 'vertical' }>>;

export type RoutedNetworkPath = Readonly<{
    from: RoutingTerminalRequest;
    to: RoutingTerminalRequest;
    segments: readonly RoutedRouteSegment[];
}>;

export type RoutedNetwork = Readonly<{
    id: string;
    feedback: boolean;
    paths: readonly RoutedNetworkPath[];
    segments: readonly RoutedRouteSegment[];
}>;

export type RoutedSchematic = Readonly<{
    grid: RealizedRoutingGrid;
    networks: readonly RoutedNetwork[];
}>;

type PlannedPathBase = Readonly<{
    networkId: string;
    from: RoutingTerminalRequest;
    to: RoutingTerminalRequest;
}>;

type DirectPathPlan = PlannedPathBase & Readonly<{
    kind: 'direct';
}>;

type AdjacentPathPlan = PlannedPathBase & Readonly<{
    kind: 'adjacent';
    channel: number;
    track: number;
}>;

type CorridorPathPlan = PlannedPathBase & Readonly<{
    kind: 'corridor';
    sourceChannel: number;
    sourceTrack: number;
    targetChannel: number;
    targetTrack: number;
    corridor: CorridorTrackHandle;
}>;

type EndpointEscapePlan = Readonly<{
    kind: 'channel';
    channel: number;
    track: number;
}> | Readonly<{
    kind: 'exterior-left' | 'exterior-right';
    track: number;
}>;

type FeedbackPathPlan = PlannedPathBase & Readonly<{
    kind: 'feedback';
    sourceEscape: EndpointEscapePlan;
    targetEscape: EndpointEscapePlan;
    corridor: OuterCorridorTrackHandle;
}>;

type PlannedPath = DirectPathPlan
    | AdjacentPathPlan
    | CorridorPathPlan
    | FeedbackPathPlan;

type NodeLocation = Readonly<{
    node: RoutingGridNodeInput;
    row: number;
}>;

type NetworkTrackReuse = {
    channels: Map<number, number>;
    corridors: Map<string, CorridorTrackHandle>;
    terminalEscapes: Map<string, EndpointEscapePlan>;
};

type ExteriorTrackState = {
    left: number;
    right: number;
};

type OrderedNetworkContext = Readonly<{
    network: RoutingNetworkRequest;
    terminals: readonly RoutingTerminalRequest[];
    root?: RoutingTerminalRequest;
    remaining: readonly RoutingTerminalRequest[];
    feedback: boolean;
}>;

type AdjacentDescriptor = Readonly<{
    key: string;
    networkId: string;
    channel: number;
    leftRow: number;
    rightRow: number;
}>;

type ForcedCorridorTracks = Readonly<{
    sourceTrack: number;
    targetTrack: number;
}>;

function snapshotArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new RangeError(`${label} must be an array`);
    }
    const length = value.length;
    return Array.from({ length }, (_, index) => value[index]);
}

function snapshotRoutingNodes(
    input: readonly RoutingGridNodeInput[]
): readonly RoutingGridNodeInput[] {
    return Object.freeze(snapshotArray(input, 'routing nodes').map(
        (value, nodeIndex) => {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                throw new RangeError(`routing node ${nodeIndex} must be an object`);
            }
            const record = value as Record<string, unknown>;
            const id = record.id;
            const column = record.column;
            const order = record.order;
            const yOffset = record.yOffset;
            const sizeValue = record.size;
            const pinsValue = record.pinAnchors;
            if (typeof sizeValue !== 'object' || sizeValue === null
                || Array.isArray(sizeValue)) {
                throw new RangeError(`routing node ${nodeIndex} size must be an object`);
            }
            const size = sizeValue as Record<string, unknown>;
            const width = size.width;
            const height = size.height;
            const pins = pinsValue === undefined
                ? []
                : snapshotArray(pinsValue, `routing node ${nodeIndex} pinAnchors`);
            const pinAnchors = pins.map((pinValue, pinIndex) => {
                if (typeof pinValue !== 'object' || pinValue === null
                    || Array.isArray(pinValue)) {
                    throw new RangeError(
                        `routing node ${nodeIndex} pin ${pinIndex} must be an object`
                    );
                }
                const pin = pinValue as Record<string, unknown>;
                const pinId = pin.id;
                const x = pin.x;
                const y = pin.y;
                return Object.freeze({
                    id: pinId as string,
                    x: x as number,
                    y: y as number,
                });
            });
            return Object.freeze({
                id: id as string,
                column: column as number,
                order: order as number,
                yOffset: yOffset as number,
                size: Object.freeze({
                    width: width as number,
                    height: height as number,
                }),
                pinAnchors: Object.freeze(pinAnchors),
            });
        }
    ));
}

function snapshotRoutingNetworks(
    input: readonly RoutingNetworkRequest[]
): readonly RoutingNetworkRequest[] {
    const seenIds = new Set<string>();
    const result = snapshotArray(input, 'routing networks').map(
        (value, networkIndex) => {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                throw new RangeError(`routing network ${networkIndex} must be an object`);
            }
            const record = value as Record<string, unknown>;
            const id = record.id;
            const terminalsValue = record.terminals;
            if (typeof id !== 'string' || seenIds.has(id)) {
                throw new RangeError('routing network IDs must be unique strings');
            }
            seenIds.add(id);
            const terminals = snapshotArray(
                terminalsValue,
                `routing network ${id} terminals`
            ).map((terminalValue, terminalIndex) => {
                if (typeof terminalValue !== 'object' || terminalValue === null
                    || Array.isArray(terminalValue)) {
                    throw new RangeError(
                        `routing network ${id} terminal ${terminalIndex} must be an object`
                    );
                }
                const terminal = terminalValue as Record<string, unknown>;
                const nodeId = terminal.nodeId;
                const pinId = terminal.pinId;
                const role = terminal.role;
                if (typeof nodeId !== 'string' || typeof pinId !== 'string'
                    || (role !== 'driver' && role !== 'load'
                        && role !== 'bidirectional')) {
                    throw new RangeError(`invalid terminal in routing network ${id}`);
                }
                return Object.freeze({ nodeId, pinId, role });
            });
            return Object.freeze({ id, terminals: Object.freeze(terminals) });
        }
    );
    result.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return Object.freeze(result);
}

function validateNetworkTerminals(
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    networks: readonly RoutingNetworkRequest[]
): void {
    for (const network of networks) {
        const seenTerminals = new Set<string>();
        for (const terminal of network.terminals) {
            const node = nodes.get(terminal.nodeId);
            if (!node) {
                throw new RangeError(
                    `unknown routing node ${terminal.nodeId} in network ${network.id}`
                );
            }
            const pin = node.pinAnchors?.find(candidate =>
                candidate.id === terminal.pinId
            );
            if (!pin) {
                throw new RangeError(
                    `unknown routing pin ${terminal.nodeId}:${terminal.pinId}`
                );
            }
            if (pin.x !== 0 && pin.x !== node.size.width) {
                throw new RangeError(
                    `routing terminal ${terminal.nodeId}:${terminal.pinId} must be a side pin`
                );
            }
            const key = `${terminal.nodeId}\0${terminal.pinId}`;
            if (seenTerminals.has(key)) {
                throw new RangeError(`duplicate terminal in routing network ${network.id}`);
            }
            seenTerminals.add(key);
        }
    }
}

function nodeLocations(
    nodes: readonly RoutingGridNodeInput[]
): ReadonlyMap<string, NodeLocation> {
    const byColumn = new Map<number, Array<{
        node: RoutingGridNodeInput;
        inputIndex: number;
    }>>();
    nodes.forEach((node, inputIndex) => {
        const entries = byColumn.get(node.column) ?? [];
        entries.push({ node, inputIndex });
        byColumn.set(node.column, entries);
    });
    const locations = new Map<string, NodeLocation>();
    for (const entries of byColumn.values()) {
        entries.sort((left, right) =>
            left.node.order - right.node.order
            || left.inputIndex - right.inputIndex
            || left.node.id.localeCompare(right.node.id)
        );
        entries.forEach(({ node }, row) => locations.set(node.id, { node, row }));
    }
    return locations;
}

function compareTerminals(
    locations: ReadonlyMap<string, NodeLocation>,
    left: RoutingTerminalRequest,
    right: RoutingTerminalRequest
): number {
    const leftLocation = locations.get(left.nodeId)!;
    const rightLocation = locations.get(right.nodeId)!;
    return leftLocation.node.column - rightLocation.node.column
        || leftLocation.row - rightLocation.row
        || left.nodeId.localeCompare(right.nodeId)
        || left.pinId.localeCompare(right.pinId);
}

function terminalDistance(
    locations: ReadonlyMap<string, NodeLocation>,
    root: RoutingTerminalRequest,
    terminal: RoutingTerminalRequest
): number {
    const rootLocation = locations.get(root.nodeId)!;
    const terminalLocation = locations.get(terminal.nodeId)!;
    return Math.abs(rootLocation.node.column - terminalLocation.node.column)
        + Math.abs(rootLocation.row - terminalLocation.row);
}

function orderedNetworkContexts(
    networks: readonly RoutingNetworkRequest[],
    locations: ReadonlyMap<string, NodeLocation>
): readonly OrderedNetworkContext[] {
    return networks.map(network => {
        const terminals = [...network.terminals].sort((left, right) =>
            compareTerminals(locations, left, right)
        );
        const root = terminals[0];
        const remaining = root === undefined
            ? []
            : terminals.slice(1).sort((left, right) =>
                terminalDistance(locations, root, left)
                    - terminalDistance(locations, root, right)
                || compareTerminals(locations, left, right)
            );
        return Object.freeze({
            network,
            terminals: Object.freeze(terminals),
            root,
            remaining: Object.freeze(remaining),
            feedback: isFeedbackNetwork(locations, terminals),
        });
    });
}

function connectionKey(
    networkId: string,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest
): string {
    return `${networkId}\0${from.nodeId}\0${from.pinId}\0${to.nodeId}\0${to.pinId}`;
}

function forcedAdjacentCorridorTracks(
    grid: ReturnType<typeof createRoutingGrid>,
    contexts: readonly OrderedNetworkContext[],
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>
): ReadonlyMap<string, ForcedCorridorTracks> {
    const byChannel = new Map<number, AdjacentDescriptor[]>();
    for (const context of contexts) {
        if (context.feedback || !context.root
            || needsOuterEscape(grid, nodes, context.terminals)) continue;
        for (const to of context.remaining) {
            const fromNode = nodes.get(context.root.nodeId)!;
            const toNode = nodes.get(to.nodeId)!;
            if (Math.abs(fromNode.column - toNode.column) !== 1) continue;
            const sourceChannel = sideChannel(fromNode, context.root.pinId);
            const targetChannel = sideChannel(toNode, to.pinId);
            if (sourceChannel !== targetChannel) continue;
            const fromPin = fromNode.pinAnchors!.find(
                pin => pin.id === context.root!.pinId
            )!;
            const toPin = toNode.pinAnchors!.find(pin => pin.id === to.pinId)!;
            const fromLocation = locations.get(context.root.nodeId)!;
            const toLocation = locations.get(to.nodeId)!;
            const aligned = fromLocation.row === toLocation.row
                && fromNode.yOffset + fromPin.y === toNode.yOffset + toPin.y;
            if (aligned) continue;
            const descriptor: AdjacentDescriptor = Object.freeze({
                key: connectionKey(context.network.id, context.root, to),
                networkId: context.network.id,
                channel: sourceChannel,
                leftRow: fromNode.column < toNode.column
                    ? fromLocation.row
                    : toLocation.row,
                rightRow: fromNode.column < toNode.column
                    ? toLocation.row
                    : fromLocation.row,
            });
            const descriptors = byChannel.get(sourceChannel) ?? [];
            descriptors.push(descriptor);
            byChannel.set(sourceChannel, descriptors);
        }
    }

    const result = new Map<string, ForcedCorridorTracks>();
    for (const [channel, descriptors] of byChannel) {
        if (new Set(descriptors.map(descriptor => descriptor.networkId)).size < 2) {
            continue;
        }
        descriptors.sort((left, right) =>
            left.leftRow - right.leftRow
            || left.rightRow - right.rightRow
            || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
        );
        const hasConflict = descriptors.some((descriptor, index) => index > 0
            && (descriptor.leftRow <= descriptors[index - 1].leftRow
                || descriptor.rightRow <= descriptors[index - 1].rightRow)
        );
        if (!hasConflict) continue;
        const count = descriptors.length;
        descriptors.forEach((descriptor, index) => {
            const sourceTrack = index;
            const targetTrack = count + index;
            allocateChannelTrack(grid, channel, sourceTrack);
            allocateChannelTrack(grid, channel, targetTrack);
            result.set(descriptor.key, Object.freeze({
                sourceTrack,
                targetTrack,
            }));
        });
    }
    return result;
}

function channelTrack(
    grid: ReturnType<typeof createRoutingGrid>,
    reuse: NetworkTrackReuse,
    channel: number
): number {
    const existing = reuse.channels.get(channel);
    const track = allocateChannelTrack(grid, channel, existing).track;
    reuse.channels.set(channel, track);
    return track;
}

function endpointEscape(
    grid: ReturnType<typeof createRoutingGrid>,
    reuse: NetworkTrackReuse,
    exteriorTracks: ExteriorTrackState,
    node: RoutingGridNodeInput,
    terminal: RoutingTerminalRequest
): EndpointEscapePlan {
    const key = `${terminal.nodeId}\0${terminal.pinId}`;
    const existing = reuse.terminalEscapes.get(key);
    if (existing) return existing;
    const channel = sideChannel(node, terminal.pinId);
    let escape: EndpointEscapePlan;
    if (channel >= 0 && channel < grid.channels.length) {
        escape = Object.freeze({
            kind: 'channel',
            channel,
            track: allocateChannelTrack(grid, channel).track,
        });
    } else {
        const pin = node.pinAnchors!.find(
            candidate => candidate.id === terminal.pinId
        )!;
        const side = pin.x === 0 ? 'left' : 'right';
        const track = exteriorTracks[side];
        if (track >= MAX_ROUTING_TRACKS) {
            throw new RangeError(
                `exterior routing track must be below ${MAX_ROUTING_TRACKS}`
            );
        }
        exteriorTracks[side] = track + 1;
        escape = Object.freeze({
            kind: side === 'left' ? 'exterior-left' : 'exterior-right',
            track,
        });
    }
    reuse.terminalEscapes.set(key, escape);
    return escape;
}

function isFeedbackNetwork(
    locations: ReadonlyMap<string, NodeLocation>,
    terminals: readonly RoutingTerminalRequest[]
): boolean {
    let maximumDriverColumn = Number.NEGATIVE_INFINITY;
    let minimumLoadColumn = Number.POSITIVE_INFINITY;
    for (const terminal of terminals) {
        const column = locations.get(terminal.nodeId)!.node.column;
        if (terminal.role === 'driver') {
            maximumDriverColumn = Math.max(maximumDriverColumn, column);
        } else if (terminal.role === 'load') {
            minimumLoadColumn = Math.min(minimumLoadColumn, column);
        }
    }
    return minimumLoadColumn <= maximumDriverColumn;
}

function needsOuterEscape(
    grid: ReturnType<typeof createRoutingGrid>,
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    terminals: readonly RoutingTerminalRequest[]
): boolean {
    return terminals.some(terminal => {
        const node = nodes.get(terminal.nodeId)!;
        const channel = sideChannel(node, terminal.pinId);
        return channel < 0 || channel >= grid.channels.length;
    });
}

function chooseFeedbackCorridor(
    grid: ReturnType<typeof createRoutingGrid>,
    locations: ReadonlyMap<string, NodeLocation>,
    terminals: readonly RoutingTerminalRequest[],
    rowCount: number,
    preferTopOnTie: boolean
): Readonly<{
    corridor: OuterCorridorTrackHandle;
    nextTiePreference: boolean;
}> {
    const rows = terminals.map(terminal => locations.get(terminal.nodeId)!.row);
    const topAddedLength = rows.reduce(
        (sum, row) => safeAdd(sum, row + 1, 'feedback route length'),
        0
    );
    const bottomAddedLength = rows.reduce(
        (sum, row) => safeAdd(
            sum,
            rowCount - row,
            'feedback route length'
        ),
        0
    );
    const topScore = safeAdd(
        topAddedLength,
        grid.outer.top.trackCount,
        'feedback route score'
    );
    const bottomScore = safeAdd(
        bottomAddedLength,
        grid.outer.bottom.trackCount,
        'feedback route score'
    );
    const tie = topScore === bottomScore;
    const useTop = topScore < bottomScore || (tie && preferTopOnTie);
    let startColumn = Number.MAX_SAFE_INTEGER;
    let endColumn = 0;
    for (const terminal of terminals) {
        const column = locations.get(terminal.nodeId)!.node.column;
        startColumn = Math.min(startColumn, column);
        endColumn = Math.max(endColumn, column);
    }
    const span = Object.freeze([
        startColumn,
        endColumn,
    ]) as readonly [number, number];
    const kind = useTop ? 'outer-top' : 'outer-bottom';
    const lane = useTop
        ? grid.outer.top.trackCount
        : grid.outer.bottom.trackCount;
    const corridor = allocateCorridorTrack(grid, { kind, lane, span });
    return Object.freeze({
        corridor,
        nextTiePreference: tie ? !preferTopOnTie : preferTopOnTie,
    });
}

function corridorKey(candidate: CorridorCandidate): string {
    return candidate.kind === 'internal'
        ? `internal:${candidate.rowGap}`
        : candidate.kind;
}

function corridorTrack(
    grid: ReturnType<typeof createRoutingGrid>,
    reuse: NetworkTrackReuse,
    candidate: CorridorCandidate
): CorridorTrackHandle {
    const key = corridorKey(candidate);
    const existing = reuse.corridors.get(key);
    let handle: CorridorTrackHandle;
    if (candidate.kind === 'internal') {
        handle = allocateCorridorTrack(
            grid,
            candidate,
            existing?.kind === 'internal' ? existing.track : undefined
        );
    } else {
        const lane = existing?.kind === candidate.kind
            ? existing.lane
            : candidate.lane;
        handle = allocateCorridorTrack(grid, { ...candidate, lane });
    }
    reuse.corridors.set(key, handle);
    return handle;
}

function selectCorridorCandidate(
    grid: ReturnType<typeof createRoutingGrid>,
    locations: ReadonlyMap<string, NodeLocation>,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    rowCount: number
): CorridorCandidate {
    const fromLocation = locations.get(from.nodeId)!;
    const toLocation = locations.get(to.nodeId)!;
    const startColumn = Math.min(
        fromLocation.node.column,
        toLocation.node.column
    );
    const endColumn = Math.max(
        fromLocation.node.column,
        toLocation.node.column
    );
    const candidates = planCorridors(grid, startColumn, endColumn);
    const internals = candidates
        .filter((candidate): candidate is Extract<
            CorridorCandidate,
            { kind: 'internal' }
        > => candidate.kind === 'internal')
        .sort((left, right) => {
            const leftY = left.rowGap * 2 + 1;
            const rightY = right.rowGap * 2 + 1;
            const fromY = fromLocation.row * 2;
            const toY = toLocation.row * 2;
            const leftCost = Math.abs(fromY - leftY) + Math.abs(toY - leftY);
            const rightCost = Math.abs(fromY - rightY) + Math.abs(toY - rightY);
            return leftCost - rightCost || left.rowGap - right.rowGap;
        });
    if (internals.length > 0) return internals[0];

    const outerCost = (candidate: CorridorCandidate): number =>
        candidate.kind === 'outer-top'
            ? fromLocation.row + toLocation.row + 2
            : (rowCount - fromLocation.row) + (rowCount - toLocation.row);
    return candidates
        .filter(candidate => candidate.kind !== 'internal')
        .sort((left, right) =>
            outerCost(left) - outerCost(right)
            || (left.kind === 'outer-top' ? -1 : 1)
        )[0];
}

function collapsePathSegments(segments: readonly RouteSegment[]): RouteSegment[] {
    const result: RouteSegment[] = [];
    for (const segment of segments) {
        const zeroLength = segment.orientation === 'horizontal'
            ? segment.x1 === segment.x2
            : segment.y1 === segment.y2;
        if (zeroLength) continue;
        const previous = result[result.length - 1];
        if (previous?.orientation === 'horizontal'
            && segment.orientation === 'horizontal'
            && previous.networkId === segment.networkId
            && previous.y === segment.y
            && Math.max(previous.x1, segment.x1)
                <= Math.min(previous.x2, segment.x2)) {
            result[result.length - 1] = horizontal(
                segment.networkId,
                Math.min(previous.x1, segment.x1),
                Math.max(previous.x2, segment.x2),
                segment.y
            );
        } else if (previous?.orientation === 'vertical'
            && segment.orientation === 'vertical'
            && previous.networkId === segment.networkId
            && previous.x === segment.x
            && Math.max(previous.y1, segment.y1)
                <= Math.min(previous.y2, segment.y2)) {
            result[result.length - 1] = vertical(
                segment.networkId,
                segment.x,
                Math.min(previous.y1, segment.y1),
                Math.max(previous.y2, segment.y2)
            );
        } else {
            result.push(segment);
        }
    }
    return result;
}

function freezeSegments(
    segments: readonly RouteSegment[]
): readonly RoutedRouteSegment[] {
    return Object.freeze(segments.map(segment => Object.freeze({ ...segment })));
}

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

function escapeX(
    escape: EndpointEscapePlan,
    grid: RealizedRoutingGrid
): number {
    if (escape.kind === 'channel') {
        return grid.channels[escape.channel].trackX[escape.track];
    }
    const offset = safeAdd(
        grid.metrics.pinEscape,
        safeMultiply(escape.track, grid.metrics.trackPitch, 'feedback escape'),
        'feedback escape'
    );
    return escape.kind === 'exterior-left'
        ? -offset
        : safeAdd(grid.width, offset, 'feedback escape');
}

function sideChannel(
    node: RoutingGridNodeInput,
    pinId: string
): number {
    const pin = node.pinAnchors?.find(candidate => candidate.id === pinId);
    if (!pin) throw new RangeError(`unknown routing pin ${node.id}:${pinId}`);
    return pin.x === 0 ? node.column - 1 : node.column;
}

function materializePath(
    plan: PlannedPath,
    grid: RealizedRoutingGrid,
    nodeById: ReadonlyMap<string, RealizedRoutingNode>
): RoutedNetworkPath {
    const sourceNode = nodeById.get(plan.from.nodeId)!;
    const targetNode = nodeById.get(plan.to.nodeId)!;
    const source = sourceNode.pinAnchors.find(pin => pin.id === plan.from.pinId)!.point;
    const target = targetNode.pinAnchors.find(pin => pin.id === plan.to.pinId)!.point;
    if (plan.kind === 'feedback') {
        const sourceX = escapeX(plan.sourceEscape, grid);
        const targetX = escapeX(plan.targetEscape, grid);
        const outer = plan.corridor.kind === 'outer-top'
            ? grid.outer.top
            : grid.outer.bottom;
        const corridorY = outer.trackY[plan.corridor.lane];
        return Object.freeze({
            from: plan.from,
            to: plan.to,
            segments: freezeSegments(collapsePathSegments([
                horizontal(plan.networkId, source.x, sourceX, source.y),
                vertical(plan.networkId, sourceX, source.y, corridorY),
                horizontal(plan.networkId, sourceX, targetX, corridorY),
                vertical(plan.networkId, targetX, corridorY, target.y),
                horizontal(plan.networkId, targetX, target.x, target.y),
            ])),
        });
    }
    if (plan.kind === 'direct') {
        return Object.freeze({
            from: plan.from,
            to: plan.to,
            segments: freezeSegments([
                horizontal(plan.networkId, source.x, target.x, source.y),
            ]),
        });
    }
    if (plan.kind === 'adjacent') {
        const channelX = grid.channels[plan.channel].trackX[plan.track];
        const segments = collapsePathSegments([
            horizontal(plan.networkId, source.x, channelX, source.y),
            vertical(plan.networkId, channelX, source.y, target.y),
            horizontal(plan.networkId, channelX, target.x, target.y),
        ]);
        return Object.freeze({
            from: plan.from,
            to: plan.to,
            segments: freezeSegments(segments),
        });
    }
    const sourceX = grid.channels[plan.sourceChannel].trackX[plan.sourceTrack];
    const targetX = grid.channels[plan.targetChannel].trackX[plan.targetTrack];
    const corridorY = plan.corridor.kind === 'internal'
        ? grid.rowGaps[plan.corridor.rowGap].trackY[plan.corridor.track]
        : grid.outer[plan.corridor.kind === 'outer-top' ? 'top' : 'bottom']
            .trackY[plan.corridor.lane];
    const segments = collapsePathSegments([
        horizontal(plan.networkId, source.x, sourceX, source.y),
        vertical(plan.networkId, sourceX, source.y, corridorY),
        horizontal(plan.networkId, sourceX, targetX, corridorY),
        vertical(plan.networkId, targetX, corridorY, target.y),
        horizontal(plan.networkId, targetX, target.x, target.y),
    ]);
    return Object.freeze({
        from: plan.from,
        to: plan.to,
        segments: freezeSegments(segments),
    });
}

function routingRowCount(
    locations: ReadonlyMap<string, NodeLocation>
): number {
    let rowCount = 1;
    for (const location of locations.values()) {
        rowCount = Math.max(rowCount, location.row + 1);
    }
    return rowCount;
}

function obstacleForSegment(
    grid: RealizedRoutingGrid,
    nodesByColumn: ReadonlyMap<number, readonly RealizedRoutingNode[]>,
    horizontalTrackYs: ReadonlySet<number>,
    verticalTrackXs: ReadonlySet<number>,
    segment: RoutedRouteSegment
): RealizedRoutingNode | undefined {
    if (segment.orientation === 'vertical') {
        if (verticalTrackXs.has(segment.x)
            || segment.x <= 0 || segment.x >= grid.width) {
            return undefined;
        }
        const column = grid.columns.find(candidate =>
            segment.x > candidate.x
            && segment.x < candidate.x + candidate.width
        );
        return column === undefined
            ? undefined
            : nodesByColumn.get(column.index)?.find(node =>
                segmentIntersectsRectangleInterior(segment, node.bounds)
            );
    }
    if (horizontalTrackYs.has(segment.y)) return undefined;
    let low = 0;
    let high = grid.columns.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        const column = grid.columns[middle];
        if (column.x + column.width <= segment.x1) low = middle + 1;
        else high = middle;
    }
    for (let index = low; index < grid.columns.length; index += 1) {
        const column = grid.columns[index];
        if (column.x >= segment.x2) break;
        const obstacle = nodesByColumn.get(column.index)?.find(node =>
            segmentIntersectsRectangleInterior(segment, node.bounds)
        );
        if (obstacle) return obstacle;
    }
    return undefined;
}

function validateAndReserveRoutes(
    grid: RealizedRoutingGrid,
    networks: readonly RoutedNetwork[]
): void {
    const horizontalReservations = new HorizontalReservationIndex();
    const verticalReservations = new VerticalReservationIndex();
    const nodesByColumn = new Map<number, RealizedRoutingNode[]>();
    for (const node of grid.nodes) {
        const nodes = nodesByColumn.get(node.column) ?? [];
        nodes.push(node);
        nodesByColumn.set(node.column, nodes);
    }
    const horizontalTrackYs = new Set([
        ...grid.rowGaps.flatMap(gap => gap.trackY),
        ...grid.outer.top.trackY,
        ...grid.outer.bottom.trackY,
    ]);
    const verticalTrackXs = new Set(
        grid.channels.flatMap(channel => channel.trackX)
    );
    for (const network of networks) {
        for (const segment of network.segments) {
            const obstacle = obstacleForSegment(
                grid,
                nodesByColumn,
                horizontalTrackYs,
                verticalTrackXs,
                segment
            );
            if (obstacle) {
                throw new RangeError(
                    `route for ${network.id} intersects module ${obstacle.id}`
                );
            }
            const conflict = segment.orientation === 'horizontal'
                ? horizontalReservations.hasConflict(
                    `y:${segment.y}`,
                    0,
                    network.id,
                    segment.x1,
                    segment.x2
                )
                : verticalReservations.hasConflict(
                    `x:${segment.x}`,
                    0,
                    network.id,
                    segment.y1,
                    segment.y2
                );
            if (conflict) {
                throw new RangeError(
                    `routing reservation conflict for network ${network.id}`
                );
            }
        }
        for (const segment of network.segments) {
            const reserved = segment.orientation === 'horizontal'
                ? horizontalReservations.reserve(
                    `y:${segment.y}`,
                    0,
                    network.id,
                    segment.x1,
                    segment.x2
                )
                : verticalReservations.reserve(
                    `x:${segment.x}`,
                    0,
                    network.id,
                    segment.y1,
                    segment.y2
                );
            if (!reserved) {
                throw new Error('routing reservation changed after preflight');
            }
        }
    }
}

export function routeNetworks(
    nodes: readonly RoutingGridNodeInput[],
    networks: readonly RoutingNetworkRequest[],
    options: RoutingGridCreateOptions = {}
): RoutedSchematic {
    const nodeSnapshots = snapshotRoutingNodes(nodes);
    const networkSnapshots = snapshotRoutingNetworks(networks);
    const grid = createRoutingGrid(nodeSnapshots, options);
    const nodeById = new Map(nodeSnapshots.map(node => [node.id, node]));
    validateNetworkTerminals(nodeById, networkSnapshots);
    const locations = nodeLocations(nodeSnapshots);
    const rowCount = routingRowCount(locations);
    const contexts = orderedNetworkContexts(networkSnapshots, locations);
    const forcedCorridorTracks = forcedAdjacentCorridorTracks(
        grid,
        contexts,
        nodeById,
        locations
    );
    const plans: PlannedPath[] = [];
    const feedbackNetworkIds = new Set<string>();
    const exteriorTracks: ExteriorTrackState = { left: 0, right: 0 };
    let preferTopOnTie = true;
    for (const context of contexts) {
        const { network, terminals, root, remaining, feedback } = context;
        if (!root || remaining.length === 0) continue;
        const reuse: NetworkTrackReuse = {
            channels: new Map(),
            corridors: new Map(),
            terminalEscapes: new Map(),
        };
        const outerOnly = needsOuterEscape(
            grid,
            nodeById,
            terminals
        );
        if (feedback || outerOnly) {
            if (feedback) feedbackNetworkIds.add(network.id);
            const selection = chooseFeedbackCorridor(
                grid,
                locations,
                terminals,
                rowCount,
                preferTopOnTie
            );
            preferTopOnTie = selection.nextTiePreference;
            for (const to of remaining) {
                const fromNode = nodeById.get(root.nodeId)!;
                const toNode = nodeById.get(to.nodeId)!;
                plans.push({
                    kind: 'feedback',
                    networkId: network.id,
                    from: root,
                    to,
                    sourceEscape: endpointEscape(
                        grid,
                        reuse,
                        exteriorTracks,
                        fromNode,
                        root
                    ),
                    targetEscape: endpointEscape(
                        grid,
                        reuse,
                        exteriorTracks,
                        toNode,
                        to
                    ),
                    corridor: selection.corridor,
                });
            }
            continue;
        }
        for (const to of remaining) {
            const from = root;
            const fromNode = nodeById.get(from.nodeId);
            const toNode = nodeById.get(to.nodeId);
            if (!fromNode || !toNode) {
                throw new RangeError(`unknown routing node in network ${network.id}`);
            }
            const sourceChannel = sideChannel(fromNode, from.pinId);
            const targetChannel = sideChannel(toNode, to.pinId);
            const fromPin = fromNode.pinAnchors!.find(pin => pin.id === from.pinId)!;
            const toPin = toNode.pinAnchors!.find(pin => pin.id === to.pinId)!;
            if (Math.abs(fromNode.column - toNode.column) === 1
                && sourceChannel === targetChannel) {
                const aligned = locations.get(from.nodeId)!.row
                        === locations.get(to.nodeId)!.row
                    && fromNode.yOffset + fromPin.y
                        === toNode.yOffset + toPin.y;
                if (aligned) {
                    plans.push({
                        kind: 'direct',
                        networkId: network.id,
                        from,
                        to,
                    });
                } else {
                    const forced = forcedCorridorTracks.get(
                        connectionKey(network.id, from, to)
                    );
                    if (forced) {
                        const candidate = selectCorridorCandidate(
                            grid,
                            locations,
                            from,
                            to,
                            rowCount
                        );
                        plans.push({
                            kind: 'corridor',
                            networkId: network.id,
                            from,
                            to,
                            sourceChannel,
                            sourceTrack: forced.sourceTrack,
                            targetChannel,
                            targetTrack: forced.targetTrack,
                            corridor: corridorTrack(grid, reuse, candidate),
                        });
                    } else {
                        plans.push({
                            kind: 'adjacent',
                            networkId: network.id,
                            from,
                            to,
                            channel: sourceChannel,
                            track: channelTrack(grid, reuse, sourceChannel),
                        });
                    }
                }
                continue;
            }
            const candidate = selectCorridorCandidate(
                grid,
                locations,
                from,
                to,
                rowCount
            );
            const sourceTrack = channelTrack(grid, reuse, sourceChannel);
            const targetTrack = targetChannel === sourceChannel
                ? allocateChannelTrack(grid, targetChannel).track
                : channelTrack(grid, reuse, targetChannel);
            plans.push({
                kind: 'corridor',
                networkId: network.id,
                from,
                to,
                sourceChannel,
                sourceTrack,
                targetChannel,
                targetTrack,
                corridor: corridorTrack(grid, reuse, candidate),
            });
        }
    }

    const realized = realizeRoutingGrid(grid);
    const realizedNodesById = new Map(
        realized.nodes.map(node => [node.id, node])
    );
    const plansByNetworkId = new Map<string, PlannedPath[]>();
    for (const plan of plans) {
        const networkPlans = plansByNetworkId.get(plan.networkId) ?? [];
        networkPlans.push(plan);
        plansByNetworkId.set(plan.networkId, networkPlans);
    }
    const networksById = new Map<string, RoutedNetwork>();
    for (const network of networkSnapshots) {
        const paths = (plansByNetworkId.get(network.id) ?? [])
            .map(plan => materializePath(plan, realized, realizedNodesById));
        networksById.set(network.id, Object.freeze({
            id: network.id,
            feedback: feedbackNetworkIds.has(network.id),
            paths: Object.freeze(paths),
            segments: freezeSegments(simplifySegments(
                paths.flatMap(path => path.segments)
            )),
        }));
    }
    const routedNetworks = Object.freeze(
        networkSnapshots.map(network => networksById.get(network.id)!)
    );
    validateAndReserveRoutes(realized, routedNetworks);
    return Object.freeze({
        grid: realized,
        networks: routedNetworks,
    });
}
