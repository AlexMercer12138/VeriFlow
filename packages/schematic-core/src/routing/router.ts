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
    assertGridCoordinate,
    horizontal,
    segmentIntersectsRectangleInterior,
    simplifySegments,
    vertical,
    type Point,
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

export type RouteAttachment = Readonly<{
    kind: 'terminal';
    point: Readonly<Point>;
    terminal: RoutingTerminalRequest;
    nodeId: string;
    pinId: string;
    role: RoutingTerminalRole;
}> | Readonly<{
    kind: 'tree';
    point: Readonly<Point>;
    nodeId?: undefined;
    pinId?: undefined;
    role?: undefined;
}>;

export type RoutedNetworkPath = Readonly<{
    from: RouteAttachment;
    to: RoutingTerminalRequest;
    segments: readonly RoutedRouteSegment[];
}>;

type MaterializedTerminalPath = Readonly<{
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
    track: ChannelLegHandle;
}>;

type ShortcutPathPlan = PlannedPathBase & Readonly<{
    kind: 'shortcut';
    channel: number;
    track: ChannelLegHandle;
}>;

type CorridorPathPlan = PlannedPathBase & Readonly<{
    kind: 'corridor';
    sourceChannel: number;
    sourceTrack: ChannelLegHandle;
    targetChannel: number;
    targetTrack: ChannelLegHandle;
    corridor: CorridorTrackHandle;
}>;

type EndpointEscapePlan = Readonly<{
    kind: 'channel';
    channel: number;
    track: ChannelLegHandle;
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
    | ShortcutPathPlan
    | CorridorPathPlan
    | FeedbackPathPlan;

type NodeLocation = Readonly<{
    node: RoutingGridNodeInput;
    row: number;
}>;

type NetworkTrackReuse = {
    channels: Map<number, ChannelLegHandle>;
    corridors: Map<string, CorridorTrackHandle>;
    terminalEscapes: Map<string, EndpointEscapePlan>;
};

type ExteriorTrackState = {
    left: number;
    right: number;
};

type PreferredEndpointEscapes = Readonly<{
    escapes: ReadonlyMap<string, EndpointEscapePlan>;
    exteriorTracks: ExteriorTrackState;
}>;

type PreferredChannelLegs = ReadonlyMap<string, ChannelLegHandle>;

type OrderedNetworkContext = Readonly<{
    network: RoutingNetworkRequest;
    terminals: readonly RoutingTerminalRequest[];
    root?: RoutingTerminalRequest;
    remaining: readonly RoutingTerminalRequest[];
    feedback: boolean;
}>;

type PendingTreeTerminal = {
    to: RoutingTerminalRequest;
    from: RoutingTerminalRequest;
    cost: number;
};

type AdjacentDescriptor = Readonly<{
    key: string;
    networkId: string;
    leftY: number;
    rightY: number;
}>;

type ChannelLegRole = 'source' | 'target' | 'shared'
    | 'feedback-source' | 'feedback-target';

type ChannelLegAttachment = Readonly<{
    attachmentSide: 0 | 1;
    escapeDirection: -1 | 1;
    anchorX: number;
    anchorY: number;
    row: number;
    role: ChannelLegRole;
    nodeId: string;
    pinId: string;
    terminalIdentity: string;
    peerIdentity: string;
}>;

type ChannelLegIntent = Readonly<{
    key: string;
    networkId: string;
    channel: number;
    attachments: readonly ChannelLegAttachment[];
}>;

type ChannelLegHandle = Readonly<{
    kind: 'channel-leg';
    key: string;
    channel: number;
    reuseKey?: string;
    intent: ChannelLegIntent;
}>;

type ActiveChannelLeg = Readonly<{
    key: string;
    networkId: string;
    channel: number;
    attachments: readonly ChannelLegAttachment[];
}>;

type ChannelTrackAssignment = Readonly<{
    resolve: (handle: ChannelLegHandle) => number;
}>;

type OrdinaryCorridorDemand = Readonly<{
    networkId: string;
    candidate: CorridorCandidate;
    terminals: readonly RoutingTerminalRequest[];
}>;

type ChannelAllocationAction = Readonly<{
    kind: 'channel';
    channel: number;
    track: number;
    leg: ChannelLegIntent;
}>;

type CorridorAllocationAction = Readonly<{
    kind: 'internal' | 'outer-top' | 'outer-bottom';
    rowGap?: number;
    lane?: number;
    track?: number;
    span: readonly [number, number];
}>;

type AllocationAction = ChannelAllocationAction | CorridorAllocationAction;

type RoutingAllocationBranch = Readonly<{
    allocator: RoutingAllocationJournal;
    baseActionCount: number;
}>;

type EvaluatedRouteCandidate = Readonly<{
    pendingIndex: number;
    variantIndex: number;
    plan: PlannedPath;
    actions: readonly AllocationAction[];
    reuse: NetworkTrackReuse;
    exteriorTracks: ExteriorTrackState;
    realized: RealizedRoutingGrid;
    routedNetworks: readonly RoutedNetwork[];
    path: RoutedNetworkPath;
    addedCost: number;
    trunkReuse: number;
    preflightBase: CandidatePreflightBase;
}>;

type RouteValidationState = Readonly<{
    grid: RealizedRoutingGrid;
    nodesByColumn: ReadonlyMap<number, readonly RealizedRoutingNode[]>;
    horizontalTrackYs: ReadonlySet<number>;
    verticalTrackXs: ReadonlySet<number>;
    horizontalReservations: HorizontalReservationIndex;
    verticalReservations: VerticalReservationIndex;
}>;

type CandidatePreflightBase = Readonly<{
    realized: RealizedRoutingGrid;
    routedNetworks: readonly RoutedNetwork[];
    validation: RouteValidationState;
    wireLength: number;
    allocationSignature: string;
}>;

type RoutingDiagnostics = Readonly<{
    realizedDemandSignatures: number;
    committedRouteMaterializations: number;
    incrementalCandidateMaterializations: number;
    committedChannelLegIntents: number;
}>;

type RoutingDiagnosticsCounter = {
    realizedDemandSignatures: number;
    committedRouteMaterializations: number;
    incrementalCandidateMaterializations: number;
    committedChannelLegIntents: number;
};

type RoutingDiagnosticsObserver = (value: RoutingDiagnostics) => void;

function incrementRoutingDiagnostic(
    diagnostics: RoutingDiagnosticsCounter | undefined,
    key: keyof RoutingDiagnosticsCounter
): void {
    if (diagnostics) diagnostics[key] += 1;
}

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

function snapshotRoutingOptions(
    value: RoutingGridCreateOptions
): RoutingGridCreateOptions {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RangeError('routing grid options must be an object');
    }
    const record = value as Record<string, unknown>;
    return Object.freeze({
        gridStep: record.gridStep as number | undefined,
        pinEscape: record.pinEscape as number | undefined,
        safetyMargin: record.safetyMargin as number | undefined,
        trackPitch: record.trackPitch as number | undefined,
        minimumChannelWidth: record.minimumChannelWidth as number | undefined,
        minimumRowGap: record.minimumRowGap as number | undefined,
        minimumOuterMargin: record.minimumOuterMargin as number | undefined,
        columnCount: record.columnCount as number | undefined,
    });
}

function channelLegRoleRank(role: ChannelLegRole): number {
    switch (role) {
        case 'source': return 0;
        case 'shared': return 1;
        case 'target': return 2;
        case 'feedback-source': return 3;
        case 'feedback-target': return 4;
    }
}

function compareChannelLegAttachments(
    left: ChannelLegAttachment,
    right: ChannelLegAttachment
): number {
    return left.attachmentSide - right.attachmentSide
        || right.escapeDirection - left.escapeDirection
        || left.anchorY - right.anchorY
        || left.anchorX - right.anchorX
        || left.row - right.row
        || channelLegRoleRank(left.role) - channelLegRoleRank(right.role)
        || left.terminalIdentity.localeCompare(right.terminalIdentity)
        || left.peerIdentity.localeCompare(right.peerIdentity);
}

function compareActiveChannelLegs(
    left: ActiveChannelLeg,
    right: ActiveChannelLeg
): number {
    const count = Math.min(left.attachments.length, right.attachments.length);
    for (let index = 0; index < count; index += 1) {
        const order = compareChannelLegAttachments(
            left.attachments[index],
            right.attachments[index]
        );
        if (order !== 0) return order;
    }
    return left.attachments.length - right.attachments.length
        || left.networkId.localeCompare(right.networkId)
        || left.key.localeCompare(right.key);
}

function structuredKey(parts: readonly unknown[]): string {
    return JSON.stringify(parts);
}

function channelLegAttachmentKey(attachment: ChannelLegAttachment): string {
    return structuredKey([
        attachment.attachmentSide,
        attachment.escapeDirection,
        attachment.anchorX,
        attachment.anchorY,
        attachment.row,
        attachment.role,
        attachment.terminalIdentity,
        attachment.peerIdentity,
    ]);
}

function physicalChannelLegKey(handle: ChannelLegHandle): string {
    return handle.reuseKey ?? handle.key;
}

class RoutingAllocationJournal {
    private writableGrid?: ReturnType<typeof createRoutingGrid>;
    private readonly actions: AllocationAction[];
    private readonly channelLegs: Map<string, ChannelLegIntent>;

    constructor(
        private readonly nodes: readonly RoutingGridNodeInput[],
        private readonly options: RoutingGridCreateOptions,
        actions: readonly AllocationAction[] = [],
        private sharedGrid?: ReturnType<typeof createRoutingGrid>,
        channelLegs: ReadonlyMap<string, ChannelLegIntent> = new Map()
    ) {
        this.actions = [...actions];
        this.channelLegs = new Map(channelLegs);
        if (!sharedGrid) this.writableGrid = createRoutingGrid(nodes, options);
    }

    get grid(): ReturnType<typeof createRoutingGrid> {
        return this.writableGrid ?? this.sharedGrid!;
    }

    channelLeg(intent: ChannelLegIntent): ChannelLegHandle {
        const existing = this.channelLegs.get(intent.key);
        if (existing) {
            if (existing.channel !== intent.channel) {
                throw new Error(`channel leg ${intent.key} changed channel`);
            }
            return Object.freeze({
                kind: 'channel-leg',
                key: existing.key,
                channel: existing.channel,
                intent,
            });
        }
        const handle = allocateChannelTrack(
            this.ensureWritableGrid(),
            intent.channel
        );
        this.actions.push(Object.freeze({
            kind: 'channel',
            channel: handle.channel,
            track: handle.track,
            leg: intent,
        }));
        this.channelLegs.set(intent.key, intent);
        return Object.freeze({
            kind: 'channel-leg',
            key: intent.key,
            channel: intent.channel,
            intent,
        });
    }

    channelAssignment(
        handles: readonly ChannelLegHandle[],
        geometry: RealizedRoutingGrid
    ): ChannelTrackAssignment {
        const geometryNodes = new Map(
            geometry.nodes.map(node => [node.id, node])
        );
        const mutable = new Map<string, {
            key: string;
            networkId: string;
            channel: number;
            attachments: Map<string, ChannelLegAttachment>;
        }>();
        for (const handle of handles) {
            const key = physicalChannelLegKey(handle);
            const allocated = this.channelLegs.get(key);
            if (!allocated || allocated.channel !== handle.channel) {
                throw new Error(`unknown channel leg ${key}`);
            }
            const existing = mutable.get(key);
            if (existing && existing.networkId !== handle.intent.networkId) {
                throw new RangeError(
                    `channel leg ${key} cannot be shared by different networks`
                );
            }
            const active = existing ?? {
                key,
                networkId: handle.intent.networkId,
                channel: handle.channel,
                attachments: new Map<string, ChannelLegAttachment>(),
            };
            for (const attachment of handle.intent.attachments) {
                const node = geometryNodes.get(attachment.nodeId)!;
                const anchor = node.pinAnchors.find(candidate =>
                    candidate.id === attachment.pinId
                )!.point;
                const realized = Object.freeze({
                    ...attachment,
                    anchorX: anchor.x,
                    anchorY: anchor.y,
                });
                active.attachments.set(
                    channelLegAttachmentKey(realized),
                    realized
                );
            }
            mutable.set(key, active);
        }

        const byChannel = new Map<number, ActiveChannelLeg[]>();
        for (const active of mutable.values()) {
            const leg = Object.freeze({
                key: active.key,
                networkId: active.networkId,
                channel: active.channel,
                attachments: Object.freeze(
                    [...active.attachments.values()].sort(
                        compareChannelLegAttachments
                    )
                ),
            });
            const channel = byChannel.get(leg.channel) ?? [];
            channel.push(leg);
            byChannel.set(leg.channel, channel);
        }

        const tracks = new Map<string, number>();
        for (const [channelIndex, legs] of byChannel) {
            if (legs.length === 1) {
                tracks.set(legs[0].key, 0);
                continue;
            }
            const byKey = new Map(legs.map(leg => [leg.key, leg]));
            const outgoing = new Map(legs.map(leg => [leg.key, new Set<string>()]));
            const indegree = new Map(legs.map(leg => [leg.key, 0]));
            const attachmentsByY = new Map<number, {
                left: Set<string>;
                right: Set<string>;
            }>();
            for (const leg of legs) {
                for (const attachment of leg.attachments) {
                    const entries = attachmentsByY.get(attachment.anchorY) ?? {
                        left: new Set<string>(),
                        right: new Set<string>(),
                    };
                    entries[attachment.escapeDirection > 0 ? 'left' : 'right']
                        .add(leg.key);
                    attachmentsByY.set(attachment.anchorY, entries);
                }
            }
            for (const entries of attachmentsByY.values()) {
                for (const leftKey of entries.left) {
                    for (const rightKey of entries.right) {
                        if (leftKey === rightKey) continue;
                        const left = byKey.get(leftKey)!;
                        const right = byKey.get(rightKey)!;
                        if (left.networkId === right.networkId) continue;
                        const edges = outgoing.get(leftKey)!;
                        if (edges.has(rightKey)) continue;
                        edges.add(rightKey);
                        indegree.set(rightKey, indegree.get(rightKey)! + 1);
                    }
                }
            }

            const ready = legs.filter(leg => indegree.get(leg.key) === 0)
                .sort(compareActiveChannelLegs);
            const ordered: ActiveChannelLeg[] = [];
            while (ready.length > 0) {
                const leg = ready.shift()!;
                ordered.push(leg);
                for (const nextKey of outgoing.get(leg.key)!) {
                    const nextIndegree = indegree.get(nextKey)! - 1;
                    indegree.set(nextKey, nextIndegree);
                    if (nextIndegree === 0) {
                        ready.push(byKey.get(nextKey)!);
                        ready.sort(compareActiveChannelLegs);
                    }
                }
            }
            if (ordered.length !== legs.length) {
                throw new RangeError(
                    `infeasible shared channel topology in channel ${channelIndex}`
                );
            }
            ordered.forEach((leg, track) => {
                tracks.set(leg.key, track);
            });
        }
        return Object.freeze({
            resolve: (handle: ChannelLegHandle): number => {
                const key = physicalChannelLegKey(handle);
                const track = tracks.get(key);
                if (track === undefined) {
                    throw new Error(`inactive channel leg ${key}`);
                }
                return track;
            },
        });
    }

    actionCount(): number {
        return this.actions.length;
    }

    compactChannelLegs(
        usedPhysicalKeys: ReadonlySet<string>
    ): RoutingAllocationJournal {
        const missing = new Set(usedPhysicalKeys);
        const nextTrackByChannel = new Map<number, number>();
        const actions: AllocationAction[] = [];
        const channelLegs = new Map<string, ChannelLegIntent>();
        for (const action of this.actions) {
            if (action.kind !== 'channel') {
                actions.push(action);
                continue;
            }
            if (!usedPhysicalKeys.has(action.leg.key)) continue;
            missing.delete(action.leg.key);
            const track = nextTrackByChannel.get(action.channel) ?? 0;
            nextTrackByChannel.set(action.channel, track + 1);
            const compacted = Object.freeze({ ...action, track });
            actions.push(compacted);
            channelLegs.set(compacted.leg.key, compacted.leg);
        }
        if (missing.size > 0) {
            throw new Error('planned route refers to an unknown channel leg');
        }
        return new RoutingAllocationJournal(
            this.nodes,
            this.options,
            actions,
            undefined,
            channelLegs
        );
    }

    corridor(
        candidate: Extract<CorridorCandidate, { kind: 'internal' }>,
        track?: number
    ): Extract<CorridorTrackHandle, { kind: 'internal' }>;
    corridor(
        candidate: Extract<
            CorridorCandidate,
            { kind: 'outer-top' | 'outer-bottom' }
        >
    ): OuterCorridorTrackHandle;
    corridor(
        candidate: CorridorCandidate,
        track?: number
    ): CorridorTrackHandle;
    corridor(
        candidate: CorridorCandidate,
        track?: number
    ): CorridorTrackHandle {
        const grid = this.ensureWritableGrid();
        const handle = candidate.kind === 'internal'
            ? allocateCorridorTrack(grid, candidate, track)
            : allocateCorridorTrack(grid, candidate);
        this.actions.push(this.corridorAction(handle));
        return handle;
    }

    preview(additional: readonly AllocationAction[] = []): RealizedRoutingGrid {
        const scratch = createRoutingGrid(this.nodes, this.options);
        this.replay(scratch, [...this.actions, ...additional]);
        return realizeRoutingGrid(scratch);
    }

    realizeFinal(): RealizedRoutingGrid {
        const finalGrid = createRoutingGrid(this.nodes, this.options);
        this.replay(finalGrid, this.actions);
        return realizeRoutingGrid(finalGrid);
    }

    realizeBranch(): RealizedRoutingGrid {
        return this.writableGrid
            ? realizeRoutingGrid(this.writableGrid)
            : this.preview();
    }

    fork(): RoutingAllocationBranch {
        const allocator = new RoutingAllocationJournal(
            this.nodes,
            this.options,
            this.actions,
            this.grid,
            this.channelLegs
        );
        return Object.freeze({
            allocator,
            baseActionCount: this.actions.length,
        });
    }

    actionsSince(baseActionCount: number): readonly AllocationAction[] {
        if (!Number.isSafeInteger(baseActionCount)
            || baseActionCount < 0
            || baseActionCount > this.actions.length) {
            throw new RangeError('invalid routing allocation branch');
        }
        return Object.freeze(this.actions.slice(baseActionCount));
    }

    commit(actions: readonly AllocationAction[]): void {
        for (const action of actions) {
            if (action.kind !== 'channel') continue;
            const existing = this.channelLegs.get(action.leg.key);
            if (existing && existing.channel !== action.leg.channel) {
                throw new Error(`channel leg ${action.leg.key} changed channel`);
            }
        }
        this.preview(actions);
        this.replay(this.ensureWritableGrid(), actions);
        this.actions.push(...actions);
        for (const action of actions) {
            if (action.kind === 'channel') {
                this.channelLegs.set(action.leg.key, action.leg);
            }
        }
    }

    private corridorAction(handle: CorridorTrackHandle): AllocationAction {
        if (handle.kind === 'internal') {
            return Object.freeze({
                kind: handle.kind,
                rowGap: handle.rowGap,
                track: handle.track,
                span: handle.span,
            });
        }
        return Object.freeze({
            kind: handle.kind,
            lane: handle.lane,
            span: handle.span,
        });
    }

    private ensureWritableGrid(): ReturnType<typeof createRoutingGrid> {
        if (this.writableGrid) return this.writableGrid;
        const grid = createRoutingGrid(this.nodes, this.options);
        this.replay(grid, this.actions);
        this.writableGrid = grid;
        this.sharedGrid = undefined;
        return grid;
    }

    private replay(
        grid: ReturnType<typeof createRoutingGrid>,
        actions: readonly AllocationAction[]
    ): void {
        for (const action of actions) {
            if (action.kind === 'channel') {
                allocateChannelTrack(grid, action.channel, action.track);
            } else if (action.kind === 'internal') {
                allocateCorridorTrack(grid, {
                    kind: action.kind,
                    rowGap: action.rowGap!,
                    span: action.span,
                }, action.track);
            } else {
                allocateCorridorTrack(grid, {
                    kind: action.kind,
                    lane: action.lane!,
                    span: action.span,
                });
            }
        }
    }
}

function validateNetworkTerminals(
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    networks: readonly RoutingNetworkRequest[]
): void {
    for (const network of networks) {
        const seenTerminals = new Map<string, Set<string>>();
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
            const nodePins = seenTerminals.get(terminal.nodeId)
                ?? new Set<string>();
            if (nodePins.has(terminal.pinId)) {
                throw new RangeError(`duplicate terminal in routing network ${network.id}`);
            }
            nodePins.add(terminal.pinId);
            seenTerminals.set(terminal.nodeId, nodePins);
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

function pointDistance(
    left: Readonly<Point>,
    right: Readonly<Point>
): number {
    return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
}

function pointToSegmentDistance(
    point: Readonly<Point>,
    segment: RoutedRouteSegment
): number {
    if (segment.orientation === 'horizontal') {
        const x = Math.max(segment.x1, Math.min(point.x, segment.x2));
        return Math.abs(point.x - x) + Math.abs(point.y - segment.y);
    }
    const y = Math.max(segment.y1, Math.min(point.y, segment.y2));
    return Math.abs(point.x - segment.x) + Math.abs(point.y - y);
}

function improvePendingTreeTerminals(
    locations: ReadonlyMap<string, NodeLocation>,
    pending: readonly PendingTreeTerminal[],
    added: RoutingTerminalRequest,
    addedSegments: readonly RoutedRouteSegment[],
    nodes: ReadonlyMap<string, RealizedRoutingNode>
): void {
    for (const candidate of pending) {
        const point = realizedNodePinPoint(nodes, candidate.to);
        const cost = addedSegments.reduce(
            (minimum, segment) => Math.min(
                minimum,
                pointToSegmentDistance(point, segment)
            ),
            Number.POSITIVE_INFINITY
        );
        if (cost < candidate.cost
            || (cost === candidate.cost
                && compareTerminals(locations, added, candidate.from) < 0)) {
            candidate.from = added;
            candidate.cost = cost;
        }
    }
}

function resetPendingTreeTerminals(
    locations: ReadonlyMap<string, NodeLocation>,
    pending: readonly PendingTreeTerminal[],
    root: RoutingTerminalRequest,
    paths: readonly RoutedNetworkPath[],
    nodes: ReadonlyMap<string, RealizedRoutingNode>
): void {
    const rootPoint = realizedNodePinPoint(nodes, root);
    for (const candidate of pending) {
        candidate.from = root;
        candidate.cost = pointDistance(
            rootPoint,
            realizedNodePinPoint(nodes, candidate.to)
        );
    }
    for (const path of paths) {
        improvePendingTreeTerminals(
            locations,
            pending,
            path.to,
            path.segments,
            nodes
        );
    }
}

function routingGeometryDemandSignature(
    grid: ReturnType<typeof createRoutingGrid>
): string {
    return [
        ...grid.channels.map(channel => channel.tracks.trackCount),
        -1,
        ...grid.rowGaps.map(gap => gap.tracks.trackCount),
        -1,
        grid.outer.top.trackCount,
        grid.outer.bottom.trackCount,
    ].join(',');
}

function routingDemandSignature(
    allocator: RoutingAllocationJournal,
    allocationSignature: string
): string {
    return structuredKey([
        routingGeometryDemandSignature(allocator.grid),
        allocationSignature,
    ]);
}

function orderedNetworkContexts(
    networks: readonly RoutingNetworkRequest[],
    locations: ReadonlyMap<string, NodeLocation>
): readonly OrderedNetworkContext[] {
    const contexts = networks.map(network => {
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
    contexts.sort((left, right) => {
        const count = Math.min(left.terminals.length, right.terminals.length);
        for (let index = 0; index < count; index += 1) {
            const order = compareTerminals(
                locations,
                left.terminals[index],
                right.terminals[index]
            );
            if (order !== 0) return order;
        }
        return left.terminals.length - right.terminals.length
            || left.network.id.localeCompare(right.network.id);
    });
    return contexts;
}

function connectionKey(
    networkId: string,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest
): string {
    return structuredKey([
        networkId,
        from.nodeId,
        from.pinId,
        to.nodeId,
        to.pinId,
    ]);
}

function forcedAdjacentConnections(
    contexts: readonly OrderedNetworkContext[],
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>,
    grid: ReturnType<typeof createRoutingGrid>,
    baseGeometry: RealizedRoutingGrid
): ReadonlySet<string> {
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
            const fromLocation = locations.get(context.root.nodeId)!;
            const toLocation = locations.get(to.nodeId)!;
            const fromPoint = realizedPinPoint(baseGeometry, context.root);
            const toPoint = realizedPinPoint(baseGeometry, to);
            const aligned = fromLocation.row === toLocation.row
                && fromPoint.y === toPoint.y;
            if (aligned) continue;
            const fromIsLeft = fromNode.column < toNode.column;
            const descriptor: AdjacentDescriptor = Object.freeze({
                key: connectionKey(context.network.id, context.root, to),
                networkId: context.network.id,
                leftY: fromIsLeft ? fromPoint.y : toPoint.y,
                rightY: fromIsLeft ? toPoint.y : fromPoint.y,
            });
            const descriptors = byChannel.get(sourceChannel) ?? [];
            descriptors.push(descriptor);
            byChannel.set(sourceChannel, descriptors);
        }
    }

    const result = new Set<string>();
    for (const descriptors of byChannel.values()) {
        if (new Set(descriptors.map(descriptor => descriptor.networkId)).size < 2) {
            continue;
        }
        descriptors.sort((left, right) =>
            left.leftY - right.leftY
            || left.rightY - right.rightY
            || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
        );
        const hasConflict = descriptors.some((descriptor, index) => index > 0
            && (descriptor.leftY <= descriptors[index - 1].leftY
                || descriptor.rightY <= descriptors[index - 1].rightY)
        );
        const endpointLevels = descriptors.flatMap(descriptor => [
            descriptor.leftY,
            descriptor.rightY,
        ]);
        const sharesEndpointLevel = new Set(endpointLevels).size < endpointLevels.length;
        if (!hasConflict || !sharesEndpointLevel) continue;
        for (const descriptor of descriptors) result.add(descriptor.key);
    }
    return result;
}

function realizedPinPoint(
    grid: RealizedRoutingGrid,
    terminal: RoutingTerminalRequest
): Readonly<{ x: number; y: number }> {
    return grid.nodes.find(node => node.id === terminal.nodeId)!
        .pinAnchors.find(pin => pin.id === terminal.pinId)!.point;
}

function realizedNodePinPoint(
    nodes: ReadonlyMap<string, RealizedRoutingNode>,
    terminal: RoutingTerminalRequest
): Readonly<Point> {
    return nodes.get(terminal.nodeId)!.pinAnchors
        .find(pin => pin.id === terminal.pinId)!.point;
}

function preferredCorridorKey(
    networkId: string,
    candidate: CorridorCandidate
): string {
    return structuredKey([networkId, corridorKey(candidate)]);
}

function preferredOrdinaryCorridorTracks(
    allocator: RoutingAllocationJournal,
    contexts: readonly OrderedNetworkContext[],
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>,
    rowCount: number,
    baseGeometry: RealizedRoutingGrid,
    forcedConnections: ReadonlySet<string>
): ReadonlyMap<string, CorridorTrackHandle> {
    const { grid } = allocator;
    const byPool = new Map<string, OrdinaryCorridorDemand[]>();
    for (const context of contexts) {
        if (context.feedback || !context.root
            || context.terminals.length !== 2
            || needsOuterEscape(grid, nodes, context.terminals)) continue;
        const from = context.root;
        const to = context.remaining[0];
        const fromNode = nodes.get(from.nodeId)!;
        const toNode = nodes.get(to.nodeId)!;
        const sourceChannel = sideChannel(fromNode, from.pinId);
        const targetChannel = sideChannel(toNode, to.pinId);
        if (Math.abs(fromNode.column - toNode.column) > 1) continue;
        if (Math.abs(fromNode.column - toNode.column) === 1
            && sourceChannel === targetChannel) {
            const aligned = locations.get(from.nodeId)!.row
                    === locations.get(to.nodeId)!.row
                && realizedPinPoint(baseGeometry, from).y
                    === realizedPinPoint(baseGeometry, to).y;
            if (aligned || !forcedConnections.has(
                connectionKey(context.network.id, from, to)
            )) continue;
        }
        const candidate = selectCorridorCandidate(
            grid,
            locations,
            from,
            to,
            rowCount
        );
        const pool = corridorKey(candidate);
        const demands = byPool.get(pool) ?? [];
        demands.push(Object.freeze({
            networkId: context.network.id,
            candidate,
            terminals: Object.freeze([from, to]),
        }));
        byPool.set(pool, demands);
    }

    const result = new Map<string, CorridorTrackHandle>();
    for (const demands of byPool.values()) {
        demands.sort((left, right) =>
            left.candidate.span[0] - right.candidate.span[0]
            || left.candidate.span[1] - right.candidate.span[1]
            || compareTerminals(locations, left.terminals[0], right.terminals[0])
            || compareTerminals(locations, left.terminals[1], right.terminals[1])
            || left.networkId.localeCompare(right.networkId)
        );
        const first = demands[0].candidate;
        const firstTrack = first.kind === 'internal'
            ? grid.rowGaps[first.rowGap].tracks.trackCount
            : grid.outer[first.kind === 'outer-top' ? 'top' : 'bottom'].trackCount;
        demands.forEach((demand, index) => {
            const track = firstTrack + index;
            const handle = demand.candidate.kind === 'internal'
                ? allocator.corridor(demand.candidate, track)
                : allocator.corridor({ ...demand.candidate, lane: track });
            result.set(
                preferredCorridorKey(demand.networkId, demand.candidate),
                handle
            );
        });
    }
    return result;
}

function endpointEscapeKey(
    networkId: string,
    terminal: RoutingTerminalRequest
): string {
    return structuredKey([networkId, terminal.nodeId, terminal.pinId]);
}

function terminalIdentity(terminal: RoutingTerminalRequest): string {
    return structuredKey([terminal.nodeId, terminal.pinId]);
}

function channelLegIntent(
    key: string,
    networkId: string,
    channel: number,
    terminal: RoutingTerminalRequest,
    peer: RoutingTerminalRequest,
    role: ChannelLegRole,
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>,
    geometry: RealizedRoutingGrid
): ChannelLegIntent {
    const attachment = (
        current: RoutingTerminalRequest,
        other: RoutingTerminalRequest,
        attachmentRole: ChannelLegRole
    ): ChannelLegAttachment => {
        const node = nodes.get(current.nodeId)!;
        const pin = node.pinAnchors!.find(
            candidate => candidate.id === current.pinId
        )!;
        const anchor = realizedPinPoint(geometry, current);
        return Object.freeze({
            attachmentSide: node.column === channel ? 0 : 1,
            escapeDirection: pin.x === 0 ? -1 : 1,
            anchorX: anchor.x,
            anchorY: anchor.y,
            row: locations.get(current.nodeId)!.row,
            role: attachmentRole,
            nodeId: current.nodeId,
            pinId: current.pinId,
            terminalIdentity: terminalIdentity(current),
            peerIdentity: terminalIdentity(other),
        });
    };
    const attachments = role === 'shared'
        ? [
            attachment(terminal, peer, 'source'),
            attachment(peer, terminal, 'target'),
        ]
        : [attachment(terminal, peer, role)];
    return Object.freeze({
        key,
        networkId,
        channel,
        attachments: Object.freeze(attachments),
    });
}

function ordinaryChannelLegKey(
    networkId: string,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    role: 'source' | 'target' | 'shared',
    variant: string
): string {
    return structuredKey([
        connectionKey(networkId, from, to),
        role,
        variant,
    ]);
}

function preferredChannelLegKey(
    networkId: string,
    terminal: RoutingTerminalRequest,
    role: ChannelLegRole,
    channel: number,
    peer?: RoutingTerminalRequest
): string {
    return structuredKey([
        networkId,
        terminalIdentity(terminal),
        role,
        channel,
        peer ? terminalIdentity(peer) : '',
    ]);
}

function aliasChannelLeg(
    intent: ChannelLegIntent,
    physical: ChannelLegHandle
): ChannelLegHandle {
    if (intent.channel !== physical.channel) {
        throw new Error('preferred channel leg changed channel');
    }
    return Object.freeze({
        kind: 'channel-leg',
        key: intent.key,
        channel: intent.channel,
        reuseKey: physical.reuseKey ?? physical.key,
        intent,
    });
}

function plannedChannelLeg(
    allocator: RoutingAllocationJournal,
    intent: ChannelLegIntent,
    preferred?: ChannelLegHandle
): ChannelLegHandle {
    return preferred
        ? aliasChannelLeg(intent, preferred)
        : allocator.channelLeg(intent);
}

function preallocatePreferredChannelLegs(
    allocator: RoutingAllocationJournal,
    contexts: readonly OrderedNetworkContext[],
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>,
    geometry: RealizedRoutingGrid,
    forcedConnections: ReadonlySet<string>
): PreferredChannelLegs {
    const preferred = new Map<string, ChannelLegHandle>();
    const allocate = (
        networkId: string,
        terminal: RoutingTerminalRequest,
        peer: RoutingTerminalRequest,
        role: ChannelLegRole,
        channel: number,
        reuse?: ChannelLegHandle
    ): ChannelLegHandle => {
        const preference = preferredChannelLegKey(
            networkId,
            terminal,
            role,
            channel,
            role === 'shared' ? peer : undefined
        );
        const existing = preferred.get(preference);
        if (existing) return existing;
        const intent = channelLegIntent(
            structuredKey(['preferred', preference]),
            networkId,
            channel,
            terminal,
            peer,
            role,
            nodes,
            locations,
            geometry
        );
        const handle = reuse ?? allocator.channelLeg(intent);
        preferred.set(preference, handle);
        return handle;
    };

    for (const context of contexts) {
        if (!context.root || context.remaining.length === 0) continue;
        if (context.feedback
            || needsOuterEscape(allocator.grid, nodes, context.terminals)) {
            const root = context.root;
            for (const terminal of context.terminals) {
                const channel = sideChannel(
                    nodes.get(terminal.nodeId)!,
                    terminal.pinId
                );
                if (channel < 0 || channel >= allocator.grid.channels.length) {
                    continue;
                }
                const isSource = terminal === root;
                const peer = isSource ? context.remaining[0] : root;
                allocate(
                    context.network.id,
                    terminal,
                    peer,
                    isSource ? 'feedback-source' : 'feedback-target',
                    channel
                );
            }
            continue;
        }

        const reuse = new Map<number, ChannelLegHandle>();
        const from = context.root;
        const fromNode = nodes.get(from.nodeId)!;
        for (const to of context.remaining) {
            const toNode = nodes.get(to.nodeId)!;
            const sourceChannel = sideChannel(fromNode, from.pinId);
            const targetChannel = sideChannel(toNode, to.pinId);
            const adjacentSharedChannel = Math.abs(
                fromNode.column - toNode.column
            ) === 1 && sourceChannel === targetChannel;
            const forced = adjacentSharedChannel && forcedConnections.has(
                connectionKey(context.network.id, from, to)
            );
            const aligned = adjacentSharedChannel
                && locations.get(from.nodeId)!.row
                    === locations.get(to.nodeId)!.row
                && realizedPinPoint(geometry, from).y
                    === realizedPinPoint(geometry, to).y;
            if (aligned && !forced) continue;
            if (adjacentSharedChannel && !forced) {
                const handle = allocate(
                    context.network.id,
                    from,
                    to,
                    'shared',
                    sourceChannel,
                    reuse.get(sourceChannel)
                );
                reuse.set(sourceChannel, handle);
                continue;
            }
            const source = allocate(
                context.network.id,
                from,
                to,
                'source',
                sourceChannel,
                reuse.get(sourceChannel)
            );
            reuse.set(sourceChannel, source);
            if (targetChannel === sourceChannel) {
                allocate(
                    context.network.id,
                    to,
                    from,
                    'target',
                    targetChannel
                );
            } else {
                const target = allocate(
                    context.network.id,
                    to,
                    from,
                    'target',
                    targetChannel,
                    reuse.get(targetChannel)
                );
                reuse.set(targetChannel, target);
            }
        }
    }
    return preferred;
}

function preferredOuterEndpointEscapes(
    grid: ReturnType<typeof createRoutingGrid>,
    contexts: readonly OrderedNetworkContext[],
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>
): PreferredEndpointEscapes {
    const exterior = {
        left: [] as Array<Readonly<{
            networkId: string;
            terminal: RoutingTerminalRequest;
        }>>,
        right: [] as Array<Readonly<{
            networkId: string;
            terminal: RoutingTerminalRequest;
        }>>,
    };
    for (const context of contexts) {
        if (!context.feedback
            && !needsOuterEscape(grid, nodes, context.terminals)) continue;
        for (const terminal of context.terminals) {
            const node = nodes.get(terminal.nodeId)!;
            const channel = sideChannel(node, terminal.pinId);
            const descriptor = Object.freeze({
                networkId: context.network.id,
                terminal,
            });
            if (channel >= 0 && channel < grid.channels.length) {
                continue;
            } else {
                const pin = node.pinAnchors!.find(
                    candidate => candidate.id === terminal.pinId
                )!;
                exterior[pin.x === 0 ? 'left' : 'right'].push(descriptor);
            }
        }
    }

    const escapes = new Map<string, EndpointEscapePlan>();
    for (const side of ['left', 'right'] as const) {
        exterior[side].sort((left, right) =>
            compareTerminals(locations, left.terminal, right.terminal)
            || left.networkId.localeCompare(right.networkId)
        );
        exterior[side].forEach((descriptor, track) => {
            escapes.set(
                endpointEscapeKey(descriptor.networkId, descriptor.terminal),
                Object.freeze({
                    kind: side === 'left' ? 'exterior-left' : 'exterior-right',
                    track,
                })
            );
        });
    }
    return Object.freeze({
        escapes,
        exteriorTracks: {
            left: exterior.left.length,
            right: exterior.right.length,
        },
    });
}

function channelTrack(
    allocator: RoutingAllocationJournal,
    reuse: NetworkTrackReuse,
    channel: number,
    intent: ChannelLegIntent,
    preferred?: ChannelLegHandle
): ChannelLegHandle {
    const existing = reuse.channels.get(channel);
    if (preferred) {
        if (existing === undefined) reuse.channels.set(channel, preferred);
        return aliasChannelLeg(intent, preferred);
    }
    if (existing !== undefined) {
        return aliasChannelLeg(intent, existing);
    }
    const physical = allocator.channelLeg(intent);
    reuse.channels.set(channel, physical);
    return physical;
}

function cloneNetworkTrackReuse(reuse: NetworkTrackReuse): NetworkTrackReuse {
    return {
        channels: new Map(reuse.channels),
        corridors: new Map(reuse.corridors),
        terminalEscapes: new Map(reuse.terminalEscapes),
    };
}

function endpointEscape(
    allocator: RoutingAllocationJournal,
    reuse: NetworkTrackReuse,
    exteriorTracks: ExteriorTrackState,
    preferredEscapes: ReadonlyMap<string, EndpointEscapePlan>,
    networkId: string,
    node: RoutingGridNodeInput,
    terminal: RoutingTerminalRequest,
    channelIntent: ChannelLegIntent,
    preferredChannelLeg?: ChannelLegHandle
): EndpointEscapePlan {
    const { grid } = allocator;
    const key = terminalIdentity(terminal);
    const existing = reuse.terminalEscapes.get(key);
    if (existing) return existing;
    const channel = sideChannel(node, terminal.pinId);
    let escape: EndpointEscapePlan;
    const preferred = preferredEscapes.get(
        endpointEscapeKey(networkId, terminal)
    );
    if (preferred) {
        escape = preferred;
    } else if (channel >= 0 && channel < grid.channels.length) {
        escape = Object.freeze({
            kind: 'channel',
            channel,
            track: plannedChannelLeg(
                allocator,
                channelIntent,
                preferredChannelLeg
            ),
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

function feedbackCorridorSpan(
    locations: ReadonlyMap<string, NodeLocation>,
    terminals: readonly RoutingTerminalRequest[]
): readonly [number, number] {
    let startColumn = Number.MAX_SAFE_INTEGER;
    let endColumn = 0;
    for (const terminal of terminals) {
        const column = locations.get(terminal.nodeId)!.node.column;
        startColumn = Math.min(startColumn, column);
        endColumn = Math.max(endColumn, column);
    }
    return Object.freeze([startColumn, endColumn]);
}

function rankedFeedbackCorridorKinds(
    grid: ReturnType<typeof createRoutingGrid>,
    preferTopOnTie: boolean
): readonly ['outer-top' | 'outer-bottom', 'outer-top' | 'outer-bottom'] {
    const topCount = grid.outer.top.trackCount;
    const bottomCount = grid.outer.bottom.trackCount;
    const topFirst = topCount < bottomCount
        || (topCount === bottomCount && preferTopOnTie);
    return topFirst
        ? Object.freeze(['outer-top', 'outer-bottom'])
        : Object.freeze(['outer-bottom', 'outer-top']);
}

function planFeedbackConnection(
    allocator: RoutingAllocationJournal,
    reuse: NetworkTrackReuse,
    exteriorTracks: ExteriorTrackState,
    preferredEscapes: ReadonlyMap<string, EndpointEscapePlan>,
    preferredChannelLegs: PreferredChannelLegs,
    networkId: string,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>,
    geometry: RealizedRoutingGrid,
    span: readonly [number, number],
    kind: 'outer-top' | 'outer-bottom'
): FeedbackPathPlan {
    const key = corridorKey({ kind, lane: 0, span });
    const existing = reuse.corridors.get(key);
    const corridor = existing?.kind === kind
        ? existing
        : allocator.corridor({
            kind,
            lane: kind === 'outer-top'
                ? allocator.grid.outer.top.trackCount
                : allocator.grid.outer.bottom.trackCount,
            span,
        });
    reuse.corridors.set(key, corridor);
    const connection = connectionKey(networkId, from, to);
    const sourceChannel = sideChannel(nodes.get(from.nodeId)!, from.pinId);
    const targetChannel = sideChannel(nodes.get(to.nodeId)!, to.pinId);
    return Object.freeze({
        kind: 'feedback',
        networkId,
        from,
        to,
        sourceEscape: endpointEscape(
            allocator,
            reuse,
            exteriorTracks,
            preferredEscapes,
            networkId,
            nodes.get(from.nodeId)!,
            from,
            channelLegIntent(
                structuredKey([connection, 'feedback-source']),
                networkId,
                sourceChannel,
                from,
                to,
                'feedback-source',
                nodes,
                locations,
                geometry
            ),
            preferredChannelLegs.get(preferredChannelLegKey(
                networkId,
                from,
                'feedback-source',
                sourceChannel
            ))
        ),
        targetEscape: endpointEscape(
            allocator,
            reuse,
            exteriorTracks,
            preferredEscapes,
            networkId,
            nodes.get(to.nodeId)!,
            to,
            channelLegIntent(
                structuredKey([connection, 'feedback-target']),
                networkId,
                targetChannel,
                to,
                from,
                'feedback-target',
                nodes,
                locations,
                geometry
            ),
            preferredChannelLegs.get(preferredChannelLegKey(
                networkId,
                to,
                'feedback-target',
                targetChannel
            ))
        ),
        corridor,
    });
}

function corridorKey(candidate: CorridorCandidate): string {
    return candidate.kind === 'internal'
        ? `internal:${candidate.rowGap}`
        : candidate.kind;
}

function corridorTrack(
    allocator: RoutingAllocationJournal,
    reuse: NetworkTrackReuse,
    networkId: string,
    candidate: CorridorCandidate,
    preferredTracks: ReadonlyMap<string, CorridorTrackHandle>
): CorridorTrackHandle {
    const key = corridorKey(candidate);
    const existing = reuse.corridors.get(key);
    if (existing) return existing;
    let handle: CorridorTrackHandle;
    const preferred = preferredTracks.get(
        preferredCorridorKey(networkId, candidate)
    );
    if (preferred) {
        handle = preferred;
    } else if (candidate.kind === 'internal') {
        handle = allocator.corridor(candidate);
    } else {
        handle = allocator.corridor(candidate);
    }
    reuse.corridors.set(key, handle);
    return handle;
}

function rankedCorridorCandidates(
    grid: ReturnType<typeof createRoutingGrid>,
    locations: ReadonlyMap<string, NodeLocation>,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    rowCount: number,
    reuse?: NetworkTrackReuse
): readonly CorridorCandidate[] {
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
            const leftReuses = reuse?.corridors.has(corridorKey(left)) ?? false;
            const rightReuses = reuse?.corridors.has(corridorKey(right)) ?? false;
            return leftCost - rightCost
                || Number(rightReuses) - Number(leftReuses)
                || left.rowGap - right.rowGap;
        });
    const outerCost = (candidate: CorridorCandidate): number =>
        candidate.kind === 'outer-top'
            ? fromLocation.row + toLocation.row + 2
            : (rowCount - fromLocation.row) + (rowCount - toLocation.row);
    const outers = candidates
        .filter(candidate => candidate.kind !== 'internal')
        .sort((left, right) =>
            outerCost(left) - outerCost(right)
            || Number(reuse?.corridors.has(corridorKey(right)) ?? false)
                - Number(reuse?.corridors.has(corridorKey(left)) ?? false)
            || (left.kind === 'outer-top' ? -1 : 1)
        );
    return Object.freeze([...internals, ...outers]);
}

function selectCorridorCandidate(
    grid: ReturnType<typeof createRoutingGrid>,
    locations: ReadonlyMap<string, NodeLocation>,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    rowCount: number,
    reuse?: NetworkTrackReuse
): CorridorCandidate {
    return rankedCorridorCandidates(
        grid,
        locations,
        from,
        to,
        rowCount,
        reuse
    )[0];
}

type ShortcutVariant = Readonly<{
    channel: number;
    fresh: boolean;
}>;

function shortcutVariants(
    enabled: boolean,
    reuse: NetworkTrackReuse,
    fromNode: RoutingGridNodeInput,
    toNode: RoutingGridNodeInput,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    geometry: RealizedRoutingGrid
): readonly ShortcutVariant[] {
    const startColumn = Math.min(fromNode.column, toNode.column);
    const endColumn = Math.max(fromNode.column, toNode.column);
    if (!enabled
        || endColumn - startColumn <= 1
        || realizedPinPoint(geometry, from).y
            === realizedPinPoint(geometry, to).y) {
        return Object.freeze([]);
    }
    const midpoint = (startColumn + endColumn) / 2;
    const channels = Array.from(
        { length: endColumn - startColumn },
        (_, index) => startColumn + index
    ).sort((left, right) =>
        Math.abs(left + 0.5 - midpoint) - Math.abs(right + 0.5 - midpoint)
        || left - right
    );
    return Object.freeze(channels.flatMap(channel => [
        Object.freeze({ channel, fresh: false }),
        ...(reuse.channels.has(channel)
            ? [Object.freeze({ channel, fresh: true })]
            : []),
    ]));
}

function ordinaryVariantUsesFreshTracks(
    allowShortcuts: boolean,
    reuse: NetworkTrackReuse,
    networkId: string,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>,
    geometry: RealizedRoutingGrid,
    forcedConnections: ReadonlySet<string>,
    variantIndex: number
): boolean {
    const fromNode = nodes.get(from.nodeId)!;
    const toNode = nodes.get(to.nodeId)!;
    const sourceChannel = sideChannel(fromNode, from.pinId);
    const targetChannel = sideChannel(toNode, to.pinId);
    const adjacentSharedChannel = Math.abs(
        fromNode.column - toNode.column
    ) === 1 && sourceChannel === targetChannel;
    const sharedChannel = adjacentSharedChannel
        || (sourceChannel === targetChannel
            && reuse.channels.has(sourceChannel));
    const forced = adjacentSharedChannel
        && forcedConnections.has(connectionKey(networkId, from, to));
    if (forced) return false;
    const aligned = realizedPinPoint(geometry, from).y
        === realizedPinPoint(geometry, to).y;
    const topologyOffset = sharedChannel
        ? aligned ? 1 : 2
        : allowShortcuts && aligned
            && Math.abs(fromNode.column - toNode.column) > 1 ? 1 : 0;
    if (variantIndex < topologyOffset) {
        return sharedChannel && !aligned && variantIndex === 1;
    }
    const shortcuts = shortcutVariants(
        allowShortcuts,
        reuse,
        fromNode,
        toNode,
        from,
        to,
        geometry
    );
    const shortcutIndex = variantIndex - topologyOffset;
    if (shortcutIndex < shortcuts.length) {
        return shortcuts[shortcutIndex].fresh;
    }
    return (shortcutIndex - shortcuts.length) % 2 === 1;
}

function planOrdinaryConnection(
    allocator: RoutingAllocationJournal,
    allowShortcuts: boolean,
    reuse: NetworkTrackReuse,
    networkId: string,
    from: RoutingTerminalRequest,
    to: RoutingTerminalRequest,
    nodes: ReadonlyMap<string, RoutingGridNodeInput>,
    locations: ReadonlyMap<string, NodeLocation>,
    rowCount: number,
    geometry: RealizedRoutingGrid,
    forcedConnections: ReadonlySet<string>,
    preferredChannelLegs: PreferredChannelLegs,
    preferredCorridorTracks: ReadonlyMap<string, CorridorTrackHandle>,
    variantIndex: number
): PlannedPath | undefined {
    const { grid } = allocator;
    const fromNode = nodes.get(from.nodeId)!;
    const toNode = nodes.get(to.nodeId)!;
    const sourceChannel = sideChannel(fromNode, from.pinId);
    const targetChannel = sideChannel(toNode, to.pinId);
    const adjacentSharedChannel = Math.abs(
        fromNode.column - toNode.column
    ) === 1 && sourceChannel === targetChannel;
    const reusableSharedChannel = sourceChannel === targetChannel
        && reuse.channels.has(sourceChannel);
    const sharedChannel = adjacentSharedChannel || reusableSharedChannel;
    const aligned = realizedPinPoint(geometry, from).y
        === realizedPinPoint(geometry, to).y;
    const forced = adjacentSharedChannel
        && forcedConnections.has(connectionKey(networkId, from, to));
    const intent = (
        terminal: RoutingTerminalRequest,
        peer: RoutingTerminalRequest,
        role: 'source' | 'target' | 'shared',
        channel: number,
        variant: string
    ): ChannelLegIntent => channelLegIntent(
        ordinaryChannelLegKey(networkId, from, to, role, variant),
        networkId,
        channel,
        terminal,
        peer,
        role,
        nodes,
        locations,
        geometry
    );
    const preferred = (
        terminal: RoutingTerminalRequest,
        peer: RoutingTerminalRequest,
        role: 'source' | 'target' | 'shared',
        channel: number
    ): ChannelLegHandle | undefined => preferredChannelLegs.get(
        preferredChannelLegKey(
            networkId,
            terminal,
            role,
            channel,
            role === 'shared' ? peer : undefined
        )
    );

    const crossColumnAligned = allowShortcuts && !sharedChannel
        && Math.abs(fromNode.column - toNode.column) > 1
        && aligned;
    if ((sharedChannel || crossColumnAligned)
        && aligned && variantIndex === 0 && !forced) {
        return Object.freeze({ kind: 'direct', networkId, from, to });
    }
    if (sharedChannel && !aligned && variantIndex < 2 && !forced) {
        const track = variantIndex === 0
            ? channelTrack(
                allocator,
                reuse,
                sourceChannel,
                intent(from, to, 'shared', sourceChannel, 'primary'),
                preferred(from, to, 'shared', sourceChannel)
                    ?? preferred(to, from, 'target', sourceChannel)
            )
            : allocator.channelLeg(intent(
                from,
                to,
                'shared',
                sourceChannel,
                `fresh:${variantIndex}`
            ));
        reuse.channels.set(sourceChannel, track);
        return Object.freeze({
            kind: 'adjacent',
            networkId,
            from,
            to,
            channel: sourceChannel,
            track,
        });
    }

    const topologyOffset = sharedChannel && !forced
        ? aligned ? 1 : 2
        : crossColumnAligned && !forced ? 1 : 0;
    const shortcuts = shortcutVariants(
        allowShortcuts,
        reuse,
        fromNode,
        toNode,
        from,
        to,
        geometry
    );
    const shortcutIndex = variantIndex - topologyOffset;
    if (shortcutIndex >= 0 && shortcutIndex < shortcuts.length) {
        const shortcut = shortcuts[shortcutIndex];
        const trackIntent = intent(
            from,
            to,
            'shared',
            shortcut.channel,
            shortcut.fresh ? `shortcut:fresh:${shortcut.channel}`
                : `shortcut:${shortcut.channel}`
        );
        const track = shortcut.fresh
            ? allocator.channelLeg(trackIntent)
            : channelTrack(
                allocator,
                reuse,
                shortcut.channel,
                trackIntent
            );
        reuse.channels.set(shortcut.channel, track);
        return Object.freeze({
            kind: 'shortcut',
            networkId,
            from,
            to,
            channel: shortcut.channel,
            track,
        });
    }

    const corridorVariant = shortcutIndex - shortcuts.length;
    if (corridorVariant < 0) return undefined;
    const freshTracks = !forced && corridorVariant % 2 === 1;
    const corridorIndex = forced
        ? corridorVariant
        : Math.floor(corridorVariant / 2);
    const candidate = rankedCorridorCandidates(
        grid,
        locations,
        from,
        to,
        rowCount,
        reuse
    )[corridorIndex];
    if (!candidate) return undefined;
    const trackVariant = freshTracks
        ? `fresh:${corridorIndex}`
        : forced ? 'forced' : 'primary';
    const allocateFreshTrack = (
        channel: number,
        terminal: RoutingTerminalRequest,
        peer: RoutingTerminalRequest,
        role: 'source' | 'target'
    ): ChannelLegHandle => {
        const track = allocator.channelLeg(intent(
            terminal,
            peer,
            role,
            channel,
            trackVariant
        ));
        reuse.channels.set(channel, track);
        return track;
    };
    const sourceTrack = freshTracks
        ? allocateFreshTrack(sourceChannel, from, to, 'source')
        : channelTrack(
            allocator,
            reuse,
            sourceChannel,
            intent(from, to, 'source', sourceChannel, trackVariant),
            preferred(from, to, 'source', sourceChannel)
        );
    const targetTrack = targetChannel === sourceChannel
        ? plannedChannelLeg(
            allocator,
            intent(to, from, 'target', targetChannel, trackVariant),
            freshTracks
                ? undefined
                : preferred(to, from, 'target', targetChannel)
        )
        : freshTracks
            ? allocateFreshTrack(targetChannel, to, from, 'target')
            : channelTrack(
                allocator,
                reuse,
                targetChannel,
                intent(to, from, 'target', targetChannel, trackVariant),
                preferred(to, from, 'target', targetChannel)
            );
    return Object.freeze({
        kind: 'corridor',
        networkId,
        from,
        to,
        sourceChannel,
        sourceTrack,
        targetChannel,
        targetTrack,
        corridor: corridorTrack(
            allocator,
            reuse,
            networkId,
            candidate,
            preferredCorridorTracks
        ),
    });
}

function freezeSegments(
    segments: readonly RouteSegment[]
): readonly RoutedRouteSegment[] {
    return Object.freeze(segments.map(segment => Object.freeze({ ...segment })));
}

function samePoint(left: Readonly<Point>, right: Readonly<Point>): boolean {
    return left.x === right.x && left.y === right.y;
}

function collinearPoints(
    first: Readonly<Point>,
    second: Readonly<Point>,
    third: Readonly<Point>
): boolean {
    return first.x === second.x && second.x === third.x
        || first.y === second.y && second.y === third.y;
}

/** @internal */
export function orderedPathSegments(
    networkId: string,
    input: readonly Readonly<Point>[]
): readonly RoutedRouteSegment[] {
    const points: Point[] = [];
    for (const value of input) {
        const point = { x: value.x, y: value.y };
        assertGridCoordinate(point.x, 'path point x');
        assertGridCoordinate(point.y, 'path point y');
        if (points.length > 0 && samePoint(points[points.length - 1], point)) {
            continue;
        }
        points.push(point);
        while (points.length >= 3) {
            const last = points.length - 1;
            if (!collinearPoints(
                points[last - 2],
                points[last - 1],
                points[last]
            )) break;
            points.splice(last - 1, 1);
            if (points.length >= 2 && samePoint(
                points[points.length - 2],
                points[points.length - 1]
            )) {
                points.pop();
            }
        }
    }

    const segments: RouteSegment[] = [];
    for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        if (start.y === end.y) {
            segments.push(horizontal(networkId, start.x, end.x, start.y));
        } else if (start.x === end.x) {
            segments.push(vertical(networkId, start.x, start.y, end.y));
        } else {
            throw new RangeError('routed path points must be orthogonal');
        }
    }
    return freezeSegments(segments);
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
    grid: RealizedRoutingGrid,
    resolveChannelTrack: (handle: ChannelLegHandle) => number
): number {
    if (escape.kind === 'channel') {
        return grid.channels[escape.channel].trackX[
            resolveChannelTrack(escape.track)
        ];
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
    nodeById: ReadonlyMap<string, RealizedRoutingNode>,
    resolveChannelTrack: (handle: ChannelLegHandle) => number
): MaterializedTerminalPath {
    const sourceNode = nodeById.get(plan.from.nodeId)!;
    const targetNode = nodeById.get(plan.to.nodeId)!;
    const source = sourceNode.pinAnchors.find(pin => pin.id === plan.from.pinId)!.point;
    const target = targetNode.pinAnchors.find(pin => pin.id === plan.to.pinId)!.point;
    if (plan.kind === 'feedback') {
        const sourceX = escapeX(plan.sourceEscape, grid, resolveChannelTrack);
        const targetX = escapeX(plan.targetEscape, grid, resolveChannelTrack);
        const outer = plan.corridor.kind === 'outer-top'
            ? grid.outer.top
            : grid.outer.bottom;
        const corridorY = outer.trackY[plan.corridor.lane];
        return Object.freeze({
            from: plan.from,
            to: plan.to,
            segments: orderedPathSegments(plan.networkId, [
                source,
                { x: sourceX, y: source.y },
                { x: sourceX, y: corridorY },
                { x: targetX, y: corridorY },
                { x: targetX, y: target.y },
                target,
            ]),
        });
    }
    if (plan.kind === 'direct') {
        return Object.freeze({
            from: plan.from,
            to: plan.to,
            segments: orderedPathSegments(plan.networkId, [source, target]),
        });
    }
    if (plan.kind === 'adjacent' || plan.kind === 'shortcut') {
        const channelX = grid.channels[plan.channel].trackX[
            resolveChannelTrack(plan.track)
        ];
        const segments = orderedPathSegments(plan.networkId, [
            source,
            { x: channelX, y: source.y },
            { x: channelX, y: target.y },
            target,
        ]);
        return Object.freeze({
            from: plan.from,
            to: plan.to,
            segments,
        });
    }
    const sourceX = grid.channels[plan.sourceChannel].trackX[
        resolveChannelTrack(plan.sourceTrack)
    ];
    const targetX = grid.channels[plan.targetChannel].trackX[
        resolveChannelTrack(plan.targetTrack)
    ];
    const corridorY = plan.corridor.kind === 'internal'
        ? grid.rowGaps[plan.corridor.rowGap].trackY[plan.corridor.track]
        : grid.outer[plan.corridor.kind === 'outer-top' ? 'top' : 'bottom']
            .trackY[plan.corridor.lane];
    const segments = orderedPathSegments(plan.networkId, [
        source,
        { x: sourceX, y: source.y },
        { x: sourceX, y: corridorY },
        { x: targetX, y: corridorY },
        { x: targetX, y: target.y },
        target,
    ]);
    return Object.freeze({
        from: plan.from,
        to: plan.to,
        segments,
    });
}

function segmentContainsPoint(
    segment: RoutedRouteSegment,
    point: Readonly<Point>
): boolean {
    return segment.orientation === 'horizontal'
        ? point.y === segment.y
            && point.x >= segment.x1 && point.x <= segment.x2
        : point.x === segment.x
            && point.y >= segment.y1 && point.y <= segment.y2;
}

function segmentLength(segment: RoutedRouteSegment): number {
    return segment.orientation === 'horizontal'
        ? segment.x2 - segment.x1
        : segment.y2 - segment.y1;
}

function traversalEnd(
    segment: RoutedRouteSegment,
    start: Readonly<Point>
): Readonly<Point> {
    if (!segmentContainsPoint(segment, start)) {
        throw new RangeError('routed path segments are not connected');
    }
    if (segment.orientation === 'horizontal') {
        if (start.x === segment.x1) {
            return Object.freeze({ x: segment.x2, y: segment.y });
        }
        if (start.x === segment.x2) {
            return Object.freeze({ x: segment.x1, y: segment.y });
        }
    } else {
        if (start.y === segment.y1) {
            return Object.freeze({ x: segment.x, y: segment.y2 });
        }
        if (start.y === segment.y2) {
            return Object.freeze({ x: segment.x, y: segment.y1 });
        }
    }
    throw new RangeError('routed path enters a segment through its interior');
}

function validateSegmentsTraversal(
    segments: readonly RoutedRouteSegment[],
    source: Readonly<Point>,
    target: Readonly<Point>
): void {
    let current = source;
    for (const segment of segments) {
        current = traversalEnd(segment, current);
    }
    if (!samePoint(current, target)) {
        throw new RangeError('routed path does not end at its terminal anchor');
    }
}

function farthestSegmentIntersection(
    pathSegment: RoutedRouteSegment,
    start: Readonly<Point>,
    end: Readonly<Point>,
    treeSegment: RoutedRouteSegment
): Readonly<Point> | undefined {
    if (pathSegment.orientation === 'horizontal'
        && treeSegment.orientation === 'horizontal') {
        if (pathSegment.y !== treeSegment.y) return undefined;
        const first = Math.max(pathSegment.x1, treeSegment.x1);
        const last = Math.min(pathSegment.x2, treeSegment.x2);
        if (first > last) return undefined;
        return Object.freeze({
            x: end.x >= start.x ? last : first,
            y: pathSegment.y,
        });
    }
    if (pathSegment.orientation === 'vertical'
        && treeSegment.orientation === 'vertical') {
        if (pathSegment.x !== treeSegment.x) return undefined;
        const first = Math.max(pathSegment.y1, treeSegment.y1);
        const last = Math.min(pathSegment.y2, treeSegment.y2);
        if (first > last) return undefined;
        return Object.freeze({
            x: pathSegment.x,
            y: end.y >= start.y ? last : first,
        });
    }
    const horizontalSegment = pathSegment.orientation === 'horizontal'
        ? pathSegment
        : treeSegment as Extract<RoutedRouteSegment, { orientation: 'horizontal' }>;
    const verticalSegment = pathSegment.orientation === 'vertical'
        ? pathSegment
        : treeSegment as Extract<RoutedRouteSegment, { orientation: 'vertical' }>;
    const point = Object.freeze({
        x: verticalSegment.x,
        y: horizontalSegment.y,
    });
    return segmentContainsPoint(pathSegment, point)
        && segmentContainsPoint(treeSegment, point)
        ? point
        : undefined;
}

function trimPathToTree(
    path: MaterializedTerminalPath,
    source: Readonly<Point>,
    tree: readonly RoutedRouteSegment[]
): Readonly<{
    point: Readonly<Point>;
    segments: readonly RoutedRouteSegment[];
}> {
    let current = source;
    let traversed = 0;
    let bestDistance = -1;
    let bestPoint: Readonly<Point> | undefined;
    for (const segment of path.segments) {
        const end = traversalEnd(segment, current);
        for (const treeSegment of tree) {
            const point = farthestSegmentIntersection(
                segment,
                current,
                end,
                treeSegment
            );
            if (!point) continue;
            const distance = traversed
                + Math.abs(point.x - current.x)
                + Math.abs(point.y - current.y);
            if (distance > bestDistance) {
                bestDistance = distance;
                bestPoint = point;
            }
        }
        traversed += segmentLength(segment);
        current = end;
    }
    if (!bestPoint || bestDistance < 0) {
        throw new RangeError(
            'incremental route does not touch the existing tree'
        );
    }

    const suffixPoints: Point[] = [{ ...bestPoint }];
    current = source;
    let skipped = 0;
    for (const segment of path.segments) {
        const end = traversalEnd(segment, current);
        const length = segmentLength(segment);
        if (skipped + length <= bestDistance) {
            skipped += length;
            current = end;
            continue;
        }
        suffixPoints.push({ ...end });
        skipped += length;
        current = end;
    }
    return Object.freeze({
        point: Object.freeze({ ...bestPoint }),
        segments: orderedPathSegments(
            path.segments[0].networkId,
            suffixPoints
        ),
    });
}

function incrementalizePaths(
    paths: readonly MaterializedTerminalPath[],
    nodes: ReadonlyMap<string, RealizedRoutingNode>
): readonly RoutedNetworkPath[] {
    let tree: readonly RoutedRouteSegment[] = [];
    return Object.freeze(paths.map((path, index) => {
        const source = nodes.get(path.from.nodeId)!.pinAnchors
            .find(pin => pin.id === path.from.pinId)!.point;
        let from: RouteAttachment;
        let segments: readonly RoutedRouteSegment[];
        if (index === 0) {
            from = Object.freeze({
                kind: 'terminal',
                point: Object.freeze({ ...source }),
                terminal: path.from,
                nodeId: path.from.nodeId,
                pinId: path.from.pinId,
                role: path.from.role,
            });
            segments = path.segments;
        } else {
            const trimmed = trimPathToTree(path, source, tree);
            from = Object.freeze({
                kind: 'tree',
                point: trimmed.point,
            });
            segments = trimmed.segments;
        }
        tree = freezeSegments(simplifySegments([...tree, ...segments]));
        return Object.freeze({
            from,
            to: path.to,
            segments,
        });
    }));
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

function createRouteValidationState(
    grid: RealizedRoutingGrid
): RouteValidationState {
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
    return {
        grid,
        nodesByColumn,
        horizontalTrackYs,
        verticalTrackXs,
        horizontalReservations: new HorizontalReservationIndex(),
        verticalReservations: new VerticalReservationIndex(),
    };
}

function geometryPreservesCommittedRoutes(
    previous: RealizedRoutingGrid,
    next: RealizedRoutingGrid
): boolean {
    if (previous.width !== next.width
        || previous.nodes.length !== next.nodes.length
        || previous.channels.length !== next.channels.length
        || previous.rowGaps.length !== next.rowGaps.length) return false;
    const samePrefix = (
        left: readonly number[],
        right: readonly number[]
    ): boolean => left.length <= right.length
        && left.every((coordinate, index) => coordinate === right[index]);
    for (let index = 0; index < previous.nodes.length; index += 1) {
        const left = previous.nodes[index];
        const right = next.nodes[index];
        if (left.id !== right.id
            || left.bounds.x !== right.bounds.x
            || left.bounds.y !== right.bounds.y
            || left.bounds.width !== right.bounds.width
            || left.bounds.height !== right.bounds.height
            || left.pinAnchors.length !== right.pinAnchors.length) return false;
        for (let pin = 0; pin < left.pinAnchors.length; pin += 1) {
            if (left.pinAnchors[pin].id !== right.pinAnchors[pin].id
                || left.pinAnchors[pin].point.x
                    !== right.pinAnchors[pin].point.x
                || left.pinAnchors[pin].point.y
                    !== right.pinAnchors[pin].point.y) return false;
        }
    }
    for (let index = 0; index < previous.channels.length; index += 1) {
        if (!samePrefix(
            previous.channels[index].trackX,
            next.channels[index].trackX
        )) return false;
    }
    for (let index = 0; index < previous.rowGaps.length; index += 1) {
        if (!samePrefix(
            previous.rowGaps[index].trackY,
            next.rowGaps[index].trackY
        )) return false;
    }
    return samePrefix(previous.outer.top.trackY, next.outer.top.trackY)
        && samePrefix(previous.outer.bottom.trackY, next.outer.bottom.trackY);
}

function validationStateForPreservedRoutes(
    grid: RealizedRoutingGrid,
    previous: RouteValidationState
): RouteValidationState {
    const geometry = createRouteValidationState(grid);
    return {
        ...geometry,
        horizontalReservations: previous.horizontalReservations,
        verticalReservations: previous.verticalReservations,
    };
}

function validateRouteSegments(
    state: RouteValidationState,
    networkId: string,
    segments: readonly RoutedRouteSegment[]
): void {
    for (const segment of segments) {
        const obstacle = obstacleForSegment(
            state.grid,
            state.nodesByColumn,
            state.horizontalTrackYs,
            state.verticalTrackXs,
            segment
        );
        if (obstacle) {
            throw new RangeError(
                `route for ${networkId} intersects module ${obstacle.id}`
            );
        }
        const conflict = segment.orientation === 'horizontal'
            ? state.horizontalReservations.hasConflict(
                `y:${segment.y}`,
                0,
                networkId,
                segment.x1,
                segment.x2
            )
            : state.verticalReservations.hasConflict(
                `x:${segment.x}`,
                0,
                networkId,
                segment.y1,
                segment.y2
            );
        if (conflict) {
            throw new RangeError(
                `routing reservation conflict for network ${networkId}`
            );
        }
    }
}

function reserveRouteSegments(
    state: RouteValidationState,
    networkId: string,
    segments: readonly RoutedRouteSegment[]
): void {
    for (const segment of segments) {
        const reserved = segment.orientation === 'horizontal'
            ? state.horizontalReservations.reserve(
                `y:${segment.y}`,
                0,
                networkId,
                segment.x1,
                segment.x2
            )
            : state.verticalReservations.reserve(
                `x:${segment.x}`,
                0,
                networkId,
                segment.y1,
                segment.y2
            );
        if (!reserved) {
            throw new Error('routing reservation changed after preflight');
        }
    }
}

function validationStateForRoutes(
    grid: RealizedRoutingGrid,
    networks: readonly RoutedNetwork[]
): RouteValidationState {
    const state = createRouteValidationState(grid);
    for (const network of networks) {
        validateRouteSegments(state, network.id, network.segments);
        reserveRouteSegments(state, network.id, network.segments);
    }
    return state;
}

function validateAndReserveRoutes(
    grid: RealizedRoutingGrid,
    networks: readonly RoutedNetwork[]
): void {
    validationStateForRoutes(grid, networks);
}

function materializeRoutedNetworks(
    networks: readonly RoutingNetworkRequest[],
    plans: readonly PlannedPath[],
    feedbackNetworkIds: ReadonlySet<string>,
    realized: RealizedRoutingGrid,
    resolveChannelTrack: (handle: ChannelLegHandle) => number
): readonly RoutedNetwork[] {
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
    for (const network of networks) {
        const terminalPaths = (plansByNetworkId.get(network.id) ?? [])
            .map(plan => materializePath(
                plan,
                realized,
                realizedNodesById,
                resolveChannelTrack
            ));
        const paths = incrementalizePaths(terminalPaths, realizedNodesById);
        networksById.set(network.id, Object.freeze({
            id: network.id,
            feedback: feedbackNetworkIds.has(network.id),
            paths,
            segments: freezeSegments(simplifySegments(
                paths.flatMap(path => path.segments)
            )),
        }));
    }
    return Object.freeze(networks.map(network => networksById.get(network.id)!));
}

function plannedChannelLegCount(plans: readonly PlannedPath[]): number {
    return plans.reduce((count, plan) => {
        if (plan.kind === 'adjacent' || plan.kind === 'shortcut') {
            return count + 1;
        }
        if (plan.kind === 'corridor') return count + 2;
        if (plan.kind === 'feedback') {
            return count
                + Number(plan.sourceEscape.kind === 'channel')
                + Number(plan.targetEscape.kind === 'channel');
        }
        return count;
    }, 0);
}

function usedPhysicalChannelLegKeys(
    plans: readonly PlannedPath[]
): ReadonlySet<string> {
    const result = new Set<string>();
    const add = (handle: ChannelLegHandle): void => {
        result.add(handle.reuseKey ?? handle.key);
    };
    for (const plan of plans) {
        if (plan.kind === 'adjacent' || plan.kind === 'shortcut') {
            add(plan.track);
        } else if (plan.kind === 'corridor') {
            add(plan.sourceTrack);
            add(plan.targetTrack);
        } else if (plan.kind === 'feedback') {
            if (plan.sourceEscape.kind === 'channel') {
                add(plan.sourceEscape.track);
            }
            if (plan.targetEscape.kind === 'channel') {
                add(plan.targetEscape.track);
            }
        }
    }
    return result;
}

function plannedChannelLegHandles(
    plans: readonly PlannedPath[]
): readonly ChannelLegHandle[] {
    const result: ChannelLegHandle[] = [];
    for (const plan of plans) {
        if (plan.kind === 'adjacent' || plan.kind === 'shortcut') {
            result.push(plan.track);
        } else if (plan.kind === 'corridor') {
            result.push(plan.sourceTrack, plan.targetTrack);
        } else if (plan.kind === 'feedback') {
            if (plan.sourceEscape.kind === 'channel') {
                result.push(plan.sourceEscape.track);
            }
            if (plan.targetEscape.kind === 'channel') {
                result.push(plan.targetEscape.track);
            }
        }
    }
    return Object.freeze(result);
}

function committedChannelMappingSignature(
    handles: readonly ChannelLegHandle[],
    assignment: ChannelTrackAssignment
): string {
    const physical = new Map<string, ChannelLegHandle>();
    for (const handle of handles) {
        physical.set(physicalChannelLegKey(handle), handle);
    }
    return structuredKey([...physical.values()].map(handle => [
        handle.channel,
        physicalChannelLegKey(handle),
        assignment.resolve(handle),
    ]));
}

function routedPathLength(path: RoutedNetworkPath): number {
    return path.segments.reduce((sum, segment) => safeAdd(
        sum,
        segment.orientation === 'horizontal'
            ? segment.x2 - segment.x1
            : segment.y2 - segment.y1,
        'incremental route length'
    ), 0);
}

function routedNetworksWireLength(
    networks: readonly RoutedNetwork[]
): number {
    return networks.reduce((total, network) => network.segments.reduce(
        (sum, segment) => safeAdd(
            sum,
            segmentLength(segment),
            'routed network wire length'
        ),
        total
    ), 0);
}

function preflightCandidateBranch(
    branch: RoutingAllocationBranch,
    networks: readonly RoutingNetworkRequest[],
    plans: readonly PlannedPath[],
    feedbackNetworkIds: ReadonlySet<string>,
    candidate: PlannedPath,
    basesByDemand: Map<string, CandidatePreflightBase>,
    realizedByDemand: Map<string, RealizedRoutingGrid>,
    committedBase: CandidatePreflightBase,
    diagnostics: RoutingDiagnosticsCounter | undefined
): Readonly<{
    actions: readonly AllocationAction[];
    path: RoutedNetworkPath;
    realized: RealizedRoutingGrid;
    routedNetworks: readonly RoutedNetwork[];
    fullPathLength: number;
    geometryAddedLength: number;
    base: CandidatePreflightBase;
    committedAllocationSignature: string;
}> {
    const geometryDemand = routingGeometryDemandSignature(branch.allocator.grid);
    let realized = realizedByDemand.get(geometryDemand);
    if (!realized) {
        realized = branch.allocator.realizeBranch();
        realizedByDemand.set(geometryDemand, realized);
        incrementRoutingDiagnostic(diagnostics, 'realizedDemandSignatures');
    }
    const committedHandles = plannedChannelLegHandles(plans);
    const activeHandles = Object.freeze([
        ...committedHandles,
        ...plannedChannelLegHandles([candidate]),
    ]);
    const assignment = branch.allocator.channelAssignment(
        activeHandles,
        realized
    );
    const allocationSignature = committedChannelMappingSignature(
        committedHandles,
        assignment
    );
    const committedAllocationSignature = committedChannelMappingSignature(
        activeHandles,
        assignment
    );
    const demand = structuredKey([geometryDemand, allocationSignature]);
    let base = basesByDemand.get(demand);
    if (!base) {
        if (geometryPreservesCommittedRoutes(
            committedBase.realized,
            realized
        ) && allocationSignature === committedBase.allocationSignature) {
            base = Object.freeze({
                realized,
                routedNetworks: committedBase.routedNetworks,
                validation: validationStateForPreservedRoutes(
                    realized,
                    committedBase.validation
                ),
                wireLength: committedBase.wireLength,
                allocationSignature,
            });
        } else {
            const routedNetworks = materializeRoutedNetworks(
                networks,
                plans,
                feedbackNetworkIds,
                realized,
                assignment.resolve
            );
            incrementRoutingDiagnostic(
                diagnostics,
                'committedRouteMaterializations'
            );
            base = Object.freeze({
                realized,
                routedNetworks,
                validation: validationStateForRoutes(realized, routedNetworks),
                wireLength: routedNetworksWireLength(routedNetworks),
                allocationSignature,
            });
        }
        basesByDemand.set(demand, base);
    }
    incrementRoutingDiagnostic(
        diagnostics,
        'incrementalCandidateMaterializations'
    );
    const realizedNodesById = new Map(
        base.realized.nodes.map(node => [node.id, node])
    );
    const fullPath = materializePath(
        candidate,
        base.realized,
        realizedNodesById,
        assignment.resolve
    );
    const existingNetwork = base.routedNetworks.find(
        network => network.id === candidate.networkId
    )!;
    const source = realizedNodePinPoint(realizedNodesById, candidate.from);
    const target = realizedNodePinPoint(realizedNodesById, candidate.to);
    validateSegmentsTraversal(fullPath.segments, source, target);
    let from: RouteAttachment;
    let segments: readonly RoutedRouteSegment[];
    if (existingNetwork.paths.length === 0) {
        from = Object.freeze({
            kind: 'terminal',
            point: Object.freeze({ ...source }),
            terminal: candidate.from,
            nodeId: candidate.from.nodeId,
            pinId: candidate.from.pinId,
            role: candidate.from.role,
        });
        segments = fullPath.segments;
    } else {
        const trimmed = trimPathToTree(
            fullPath,
            source,
            existingNetwork.segments
        );
        from = Object.freeze({ kind: 'tree', point: trimmed.point });
        segments = trimmed.segments;
    }
    const path: RoutedNetworkPath = Object.freeze({
        from,
        to: candidate.to,
        segments,
    });
    validateSegmentsTraversal(path.segments, path.from.point, target);
    validateRouteSegments(base.validation, candidate.networkId, segments);
    const updatedNetwork: RoutedNetwork = Object.freeze({
        id: existingNetwork.id,
        feedback: existingNetwork.feedback,
        paths: Object.freeze([...existingNetwork.paths, path]),
        segments: freezeSegments(simplifySegments([
            ...existingNetwork.segments,
            ...segments,
        ])),
    });
    const routedNetworks = Object.freeze(base.routedNetworks.map(network =>
        network.id === candidate.networkId ? updatedNetwork : network
    ));
    return Object.freeze({
        actions: branch.allocator.actionsSince(branch.baseActionCount),
        path,
        realized: base.realized,
        routedNetworks,
        fullPathLength: fullPath.segments.reduce(
            (sum, segment) => safeAdd(
                sum,
                segmentLength(segment),
                'candidate route length'
            ),
            0
        ),
        geometryAddedLength: base.wireLength - committedBase.wireLength,
        base,
        committedAllocationSignature,
    });
}

function compareCandidateSegments(
    left: readonly RoutedRouteSegment[],
    right: readonly RoutedRouteSegment[]
): number {
    const count = Math.min(left.length, right.length);
    for (let index = 0; index < count; index += 1) {
        const leftSegment = left[index];
        const rightSegment = right[index];
        const orientation = leftSegment.orientation.localeCompare(
            rightSegment.orientation
        );
        if (orientation !== 0) return orientation;
        const leftCoordinates = leftSegment.orientation === 'horizontal'
            ? [leftSegment.x1, leftSegment.x2, leftSegment.y]
            : [leftSegment.x, leftSegment.y1, leftSegment.y2];
        const rightCoordinates = rightSegment.orientation === 'horizontal'
            ? [rightSegment.x1, rightSegment.x2, rightSegment.y]
            : [rightSegment.x, rightSegment.y1, rightSegment.y2];
        for (let coordinate = 0; coordinate < 3; coordinate += 1) {
            const order = leftCoordinates[coordinate]
                - rightCoordinates[coordinate];
            if (order !== 0) return order;
        }
    }
    return left.length - right.length;
}

function compareEvaluatedCandidates(
    locations: ReadonlyMap<string, NodeLocation>,
    left: EvaluatedRouteCandidate,
    right: EvaluatedRouteCandidate
): number {
    const sameConnection = left.plan.from.nodeId === right.plan.from.nodeId
        && left.plan.from.pinId === right.plan.from.pinId
        && left.plan.to.nodeId === right.plan.to.nodeId
        && left.plan.to.pinId === right.plan.to.pinId;
    const geometryOrder = compareCandidateSegments(
        left.path.segments,
        right.path.segments
    );
    return left.addedCost - right.addedCost
        || left.actions.length - right.actions.length
        || right.trunkReuse - left.trunkReuse
        || (sameConnection ? left.variantIndex - right.variantIndex : 0)
        || left.path.from.point.x - right.path.from.point.x
        || left.path.from.point.y - right.path.from.point.y
        || geometryOrder
        || left.variantIndex - right.variantIndex
        || compareTerminals(locations, left.plan.to, right.plan.to)
        || compareTerminals(locations, left.plan.from, right.plan.from);
}

function routeNetworksInternal(
    nodes: readonly RoutingGridNodeInput[],
    networks: readonly RoutingNetworkRequest[],
    options: RoutingGridCreateOptions,
    observer?: RoutingDiagnosticsObserver
): RoutedSchematic {
    const diagnostics: RoutingDiagnosticsCounter | undefined = observer
        ? {
            realizedDemandSignatures: 0,
            committedRouteMaterializations: 0,
            incrementalCandidateMaterializations: 0,
            committedChannelLegIntents: 0,
        }
        : undefined;
    const nodeSnapshots = snapshotRoutingNodes(nodes);
    const networkSnapshots = snapshotRoutingNetworks(networks);
    const optionSnapshot = snapshotRoutingOptions(options);
    const allocator = new RoutingAllocationJournal(nodeSnapshots, optionSnapshot);
    const { grid } = allocator;
    const nodeById = new Map(nodeSnapshots.map(node => [node.id, node]));
    validateNetworkTerminals(nodeById, networkSnapshots);
    const locations = nodeLocations(nodeSnapshots);
    const rowCount = routingRowCount(locations);
    const contexts = orderedNetworkContexts(networkSnapshots, locations);
    const baseGeometry = allocator.preview();
    const forcedAdjacent = forcedAdjacentConnections(
        contexts,
        nodeById,
        locations,
        grid,
        baseGeometry
    );
    const preferredChannelLegs = preallocatePreferredChannelLegs(
        allocator,
        contexts,
        nodeById,
        locations,
        baseGeometry,
        forcedAdjacent
    );
    const preferredCorridorTracks = preferredOrdinaryCorridorTracks(
        allocator,
        contexts,
        nodeById,
        locations,
        rowCount,
        baseGeometry,
        forcedAdjacent
    );
    const preferredEndpointEscapes = preferredOuterEndpointEscapes(
        grid,
        contexts,
        nodeById,
        locations
    );
    const plans: PlannedPath[] = [];
    const feedbackNetworkIds = new Set<string>();
    const exteriorTracks: ExteriorTrackState = {
        ...preferredEndpointEscapes.exteriorTracks,
    };
    const initialRealized = allocator.preview();
    incrementRoutingDiagnostic(diagnostics, 'realizedDemandSignatures');
    const initialAssignment = allocator.channelAssignment([], initialRealized);
    const initialRoutedNetworks = materializeRoutedNetworks(
        networkSnapshots,
        plans,
        feedbackNetworkIds,
        initialRealized,
        initialAssignment.resolve
    );
    incrementRoutingDiagnostic(diagnostics, 'committedRouteMaterializations');
    const realizedByDemand = new Map<string, RealizedRoutingGrid>([[
        routingGeometryDemandSignature(allocator.grid),
        initialRealized,
    ]]);
    let committedBase: CandidatePreflightBase = Object.freeze({
        realized: initialRealized,
        routedNetworks: initialRoutedNetworks,
        validation: validationStateForRoutes(
            initialRealized,
            initialRoutedNetworks
        ),
        wireLength: routedNetworksWireLength(initialRoutedNetworks),
        allocationSignature: '',
    });
    let preferTopOnTie = true;
    for (const context of contexts) {
        const { network, terminals, root, feedback } = context;
        if (!root || context.remaining.length === 0) continue;
        let contextGeometry = committedBase.realized;
        let contextNodes = new Map(
            contextGeometry.nodes.map(node => [node.id, node])
        );
        const rootPoint = realizedNodePinPoint(contextNodes, root);
        const pending: PendingTreeTerminal[] = context.remaining.map(to => ({
            to,
            from: root,
            cost: pointDistance(
                rootPoint,
                realizedNodePinPoint(contextNodes, to)
            ),
        }));
        let reuse: NetworkTrackReuse = {
            channels: new Map(),
            corridors: new Map(),
            terminalEscapes: new Map(),
        };
        const outerOnly = needsOuterEscape(grid, nodeById, terminals);
        const useFeedbackRouting = feedback || outerOnly;
        if (feedback) feedbackNetworkIds.add(network.id);
        const feedbackSpan = useFeedbackRouting
            ? feedbackCorridorSpan(locations, terminals)
            : undefined;

        while (pending.length > 0) {
            const orderedPending = pending.map((candidate, index) => ({
                candidate,
                index,
            })).sort((left, right) =>
                left.candidate.cost - right.candidate.cost
                || compareTerminals(
                    locations,
                    left.candidate.to,
                    right.candidate.to
                )
                || compareTerminals(
                    locations,
                    left.candidate.from,
                    right.candidate.from
                )
            );
            let selected: EvaluatedRouteCandidate | undefined;
            let candidateFailure: RangeError | undefined;
            const basesByDemand = new Map<string, CandidatePreflightBase>([[
                routingDemandSignature(
                    allocator,
                    committedBase.allocationSignature
                ),
                committedBase,
            ]]);
            const hadFeedbackCorridor = reuse.corridors.has('outer-top')
                || reuse.corridors.has('outer-bottom');
            const topCount = grid.outer.top.trackCount;
            const bottomCount = grid.outer.bottom.trackCount;

            const consider = (
                pendingIndex: number,
                variantIndex: number,
                branch: RoutingAllocationBranch,
                candidateReuse: NetworkTrackReuse,
                candidateExteriorTracks: ExteriorTrackState,
                plan: PlannedPath
            ): EvaluatedRouteCandidate | undefined => {
                try {
                    const preflight = preflightCandidateBranch(
                        branch,
                        networkSnapshots,
                        plans,
                        feedbackNetworkIds,
                        plan,
                        basesByDemand,
                        realizedByDemand,
                        committedBase,
                        diagnostics
                    );
                    const pathLength = routedPathLength(preflight.path);
                    const addedCost = safeAdd(
                        pathLength,
                        preflight.geometryAddedLength,
                        'realized added route length'
                    );
                    const evaluated = Object.freeze({
                        pendingIndex,
                        variantIndex,
                        plan,
                        actions: preflight.actions,
                        reuse: candidateReuse,
                        exteriorTracks: candidateExteriorTracks,
                        realized: preflight.realized,
                        routedNetworks: preflight.routedNetworks,
                        path: preflight.path,
                        addedCost,
                        trunkReuse: preflight.fullPathLength - pathLength,
                        preflightBase: Object.freeze({
                            ...preflight.base,
                            allocationSignature:
                                preflight.committedAllocationSignature,
                        }),
                    });
                    if (!selected || compareEvaluatedCandidates(
                        locations,
                        evaluated,
                        selected
                    ) < 0) {
                        selected = evaluated;
                    }
                    return evaluated;
                } catch (error) {
                    if (error instanceof RangeError) {
                        candidateFailure ??= error;
                        return undefined;
                    }
                    throw error;
                }
            };

            for (const entry of orderedPending) {
                if (selected && entry.candidate.cost > selected.addedCost) {
                    break;
                }
                const { from, to } = entry.candidate;
                if (useFeedbackRouting) {
                    const existingKind = reuse.corridors.has('outer-top')
                        ? 'outer-top'
                        : reuse.corridors.has('outer-bottom')
                            ? 'outer-bottom'
                            : undefined;
                    const kinds: readonly (
                        'outer-top' | 'outer-bottom'
                    )[] = existingKind
                        ? Object.freeze([existingKind])
                        : rankedFeedbackCorridorKinds(grid, preferTopOnTie);
                    for (let variantIndex = 0;
                        variantIndex < kinds.length;
                        variantIndex += 1) {
                        const branch = allocator.fork();
                        const candidateReuse = cloneNetworkTrackReuse(reuse);
                        const candidateExteriorTracks = { ...exteriorTracks };
                        try {
                            const plan = planFeedbackConnection(
                                branch.allocator,
                                candidateReuse,
                                candidateExteriorTracks,
                                preferredEndpointEscapes.escapes,
                                preferredChannelLegs,
                                network.id,
                                from,
                                to,
                                nodeById,
                                locations,
                                contextGeometry,
                                feedbackSpan!,
                                kinds[variantIndex]
                            );
                            consider(
                                entry.index,
                                variantIndex,
                                branch,
                                candidateReuse,
                                candidateExteriorTracks,
                                plan
                            );
                        } catch (error) {
                            if (error instanceof RangeError) {
                                candidateFailure ??= error;
                                continue;
                            }
                            throw error;
                        }
                    }
                    continue;
                }

                let skipFreshVariant = false;
                const columnSpan = Math.abs(
                    nodeById.get(from.nodeId)!.column
                        - nodeById.get(to.nodeId)!.column
                );
                const maximumVariant = 2 * (rowCount + 3)
                    + 2 * columnSpan + 1;
                for (let variantIndex = 0;
                    variantIndex <= maximumVariant;
                    variantIndex += 1) {
                    const freshTracks = ordinaryVariantUsesFreshTracks(
                        terminals.length === 2,
                        reuse,
                        network.id,
                        from,
                        to,
                        nodeById,
                        locations,
                        contextGeometry,
                        forcedAdjacent,
                        variantIndex
                    );
                    if (freshTracks && skipFreshVariant) {
                        skipFreshVariant = false;
                        continue;
                    }
                    if (!freshTracks) skipFreshVariant = false;
                    const branch = allocator.fork();
                    const candidateReuse = cloneNetworkTrackReuse(reuse);
                    const candidateExteriorTracks = { ...exteriorTracks };
                    let plan: PlannedPath | undefined;
                    try {
                        plan = planOrdinaryConnection(
                            branch.allocator,
                            terminals.length === 2,
                            candidateReuse,
                            network.id,
                            from,
                            to,
                            nodeById,
                            locations,
                            rowCount,
                            contextGeometry,
                            forcedAdjacent,
                            preferredChannelLegs,
                            preferredCorridorTracks,
                            variantIndex
                        );
                    } catch (error) {
                        if (error instanceof RangeError) {
                            candidateFailure ??= error;
                            continue;
                        }
                        throw error;
                    }
                    if (!plan) break;
                    const evaluated = consider(
                        entry.index,
                        variantIndex,
                        branch,
                        candidateReuse,
                        candidateExteriorTracks,
                        plan
                    );
                    if (!freshTracks && evaluated) skipFreshVariant = true;
                    if (evaluated
                        && evaluated.addedCost === entry.candidate.cost) {
                        break;
                    }
                }
            }

            if (!selected) {
                throw candidateFailure ?? new RangeError(
                    `no valid routing candidate for network ${network.id}`
                );
            }
            allocator.commit(selected.actions);
            plans.push(selected.plan);
            reserveRouteSegments(
                selected.preflightBase.validation,
                selected.plan.networkId,
                selected.path.segments
            );
            committedBase = Object.freeze({
                realized: selected.realized,
                routedNetworks: selected.routedNetworks,
                validation: selected.preflightBase.validation,
                wireLength: safeAdd(
                    selected.preflightBase.wireLength,
                    routedPathLength(selected.path),
                    'committed route wire length'
                ),
                allocationSignature: selected.preflightBase.allocationSignature,
            });
            reuse = selected.reuse;
            exteriorTracks.left = selected.exteriorTracks.left;
            exteriorTracks.right = selected.exteriorTracks.right;
            if (useFeedbackRouting && !hadFeedbackCorridor
                && topCount === bottomCount) {
                preferTopOnTie = !preferTopOnTie;
            }
            pending.splice(selected.pendingIndex, 1);
            const geometryChanged = contextGeometry !== selected.realized;
            contextGeometry = selected.realized;
            contextNodes = new Map(
                contextGeometry.nodes.map(node => [node.id, node])
            );
            if (geometryChanged) {
                const routedNetwork = selected.routedNetworks.find(
                    candidate => candidate.id === network.id
                )!;
                resetPendingTreeTerminals(
                    locations,
                    pending,
                    root,
                    routedNetwork.paths,
                    contextNodes
                );
            } else {
                improvePendingTreeTerminals(
                    locations,
                    pending,
                    selected.plan.to,
                    selected.path.segments,
                    contextNodes
                );
            }
        }
    }

    const finalAllocator = allocator.compactChannelLegs(
        usedPhysicalChannelLegKeys(plans)
    );
    const realized = finalAllocator.realizeFinal();
    const finalAssignment = finalAllocator.channelAssignment(
        plannedChannelLegHandles(plans),
        realized
    );
    const routedNetworks = materializeRoutedNetworks(
        networkSnapshots,
        plans,
        feedbackNetworkIds,
        realized,
        finalAssignment.resolve
    );
    validateAndReserveRoutes(realized, routedNetworks);
    if (diagnostics) {
        diagnostics.committedChannelLegIntents = plannedChannelLegCount(plans);
        observer!(Object.freeze({ ...diagnostics }));
    }
    return Object.freeze({
        grid: realized,
        networks: routedNetworks,
    });
}

export function routeNetworks(
    nodes: readonly RoutingGridNodeInput[],
    networks: readonly RoutingNetworkRequest[],
    options: RoutingGridCreateOptions = {}
): RoutedSchematic {
    return routeNetworksInternal(nodes, networks, options);
}

/** @internal */
export function routeNetworksForTesting(
    nodes: readonly RoutingGridNodeInput[],
    networks: readonly RoutingNetworkRequest[],
    options: RoutingGridCreateOptions,
    observer?: RoutingDiagnosticsObserver
): RoutedSchematic {
    return routeNetworksInternal(nodes, networks, options, observer);
}

type RoutingTransactionProbeSnapshot = Readonly<{
    actionCount: number;
    channelTrackCounts: readonly number[];
    demand: string;
}>;

type RoutingTransactionProbeResult = Readonly<{
    rejected: boolean;
    before: RoutingTransactionProbeSnapshot;
    afterRejected: RoutingTransactionProbeSnapshot;
    afterCommitted: RoutingTransactionProbeSnapshot;
}>;

/** @internal */
export function probeRoutingAllocationTransactionForTesting(
    nodes: readonly RoutingGridNodeInput[],
    terminal: RoutingTerminalRequest,
    options: RoutingGridCreateOptions = {}
): RoutingTransactionProbeResult {
    const nodeSnapshots = snapshotRoutingNodes(nodes);
    const optionSnapshot = snapshotRoutingOptions(options);
    const nodeById = new Map(nodeSnapshots.map(node => [node.id, node]));
    const node = nodeById.get(terminal.nodeId);
    if (!node?.pinAnchors?.some(pin => pin.id === terminal.pinId)) {
        throw new RangeError('transaction probe terminal is not routable');
    }
    const channel = sideChannel(node, terminal.pinId);
    const allocator = new RoutingAllocationJournal(nodeSnapshots, optionSnapshot);
    if (channel < 0 || channel >= allocator.grid.channels.length) {
        throw new RangeError('transaction probe terminal needs an internal channel');
    }
    const locations = nodeLocations(nodeSnapshots);
    const geometry = allocator.preview();
    const intent = (
        key: string,
        networkId: string,
        role: ChannelLegRole
    ): ChannelLegIntent => channelLegIntent(
        key,
        networkId,
        channel,
        terminal,
        terminal,
        role,
        nodeById,
        locations,
        geometry
    );
    allocator.channelLeg(intent('probe:committed', 'probe:committed', 'source'));
    const snapshot = (): RoutingTransactionProbeSnapshot => Object.freeze({
        actionCount: allocator.actionCount(),
        channelTrackCounts: Object.freeze(allocator.grid.channels.map(
            candidate => candidate.tracks.trackCount
        )),
        demand: routingGeometryDemandSignature(allocator.grid),
    });
    const before = snapshot();
    const occupied = horizontal('probe:committed', 0, 20, -100);

    const rejectedBranch = allocator.fork();
    rejectedBranch.allocator.channelLeg(intent(
        'probe:rejected',
        'probe:rejected',
        'target'
    ));
    const rejectedGrid = rejectedBranch.allocator.realizeBranch();
    const rejectedState = createRouteValidationState(rejectedGrid);
    validateRouteSegments(rejectedState, 'probe:committed', [occupied]);
    reserveRouteSegments(rejectedState, 'probe:committed', [occupied]);
    let rejected = false;
    try {
        validateRouteSegments(rejectedState, 'probe:rejected', [
            horizontal('probe:rejected', 0, 20, -100),
        ]);
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        rejected = true;
    }
    const afterRejected = snapshot();

    const committedBranch = allocator.fork();
    committedBranch.allocator.channelLeg(intent(
        'probe:accepted',
        'probe:accepted',
        'target'
    ));
    const committedGrid = committedBranch.allocator.realizeBranch();
    const committedState = createRouteValidationState(committedGrid);
    validateRouteSegments(committedState, 'probe:committed', [occupied]);
    reserveRouteSegments(committedState, 'probe:committed', [occupied]);
    validateRouteSegments(committedState, 'probe:accepted', [
        horizontal('probe:accepted', 30, 50, -100),
    ]);
    allocator.commit(committedBranch.allocator.actionsSince(
        committedBranch.baseActionCount
    ));

    return Object.freeze({
        rejected,
        before,
        afterRejected,
        afterCommitted: snapshot(),
    });
}

type ChannelConstraintProbeSnapshot = Readonly<{
    actionCount: number;
    trackCount: number;
}>;

type ChannelConstraintProbeResult = Readonly<{
    chainTracks: readonly number[];
    cycleRejected: boolean;
    before: ChannelConstraintProbeSnapshot;
    afterRejected: ChannelConstraintProbeSnapshot;
    afterCommitted: ChannelConstraintProbeSnapshot;
}>;

/** @internal */
export function probeChannelConstraintAssignmentForTesting(
): ChannelConstraintProbeResult {
    const nodes = snapshotRoutingNodes([
        {
            id: 'left',
            column: 0,
            order: 0,
            yOffset: 0,
            size: { width: 100, height: 40 },
            pinAnchors: [10, 20, 30].map(y => ({
                id: `right-${y}`,
                x: 100,
                y,
            })),
        },
        {
            id: 'right',
            column: 1,
            order: 0,
            yOffset: 0,
            size: { width: 100, height: 40 },
            pinAnchors: [10, 20, 30].map(y => ({
                id: `left-${y}`,
                x: 0,
                y,
            })),
        },
    ]);
    const allocator = new RoutingAllocationJournal(nodes, {});
    const locations = nodeLocations(nodes);
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    const geometry = allocator.preview();
    const terminal = (
        side: 'left' | 'right',
        y: 10 | 20 | 30
    ): RoutingTerminalRequest => Object.freeze({
        nodeId: side,
        pinId: `${side === 'left' ? 'right' : 'left'}-${y}`,
        role: 'bidirectional',
    });
    const shared = (
        key: string,
        networkId: string,
        first: RoutingTerminalRequest,
        second: RoutingTerminalRequest
    ): ChannelLegIntent => channelLegIntent(
        key,
        networkId,
        0,
        first,
        second,
        'shared',
        nodesById,
        locations,
        geometry
    );
    const first = allocator.channelLeg(shared(
        'probe:a',
        'probe:a',
        terminal('left', 10),
        terminal('right', 30)
    ));
    const second = allocator.channelLeg(shared(
        'probe:b',
        'probe:b',
        terminal('right', 10),
        terminal('left', 20)
    ));
    const snapshot = (): ChannelConstraintProbeSnapshot => Object.freeze({
        actionCount: allocator.actionCount(),
        trackCount: allocator.grid.channels[0].tracks.trackCount,
    });
    const before = snapshot();

    const rejectedBranch = allocator.fork();
    const cycle = rejectedBranch.allocator.channelLeg(shared(
        'probe:c',
        'probe:c',
        terminal('right', 20),
        terminal('left', 30)
    ));
    let cycleRejected = false;
    try {
        rejectedBranch.allocator.channelAssignment(
            [first, second, cycle],
            rejectedBranch.allocator.realizeBranch()
        );
    } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        cycleRejected = true;
    }
    const afterRejected = snapshot();

    const committedBranch = allocator.fork();
    const accepted = committedBranch.allocator.channelLeg(channelLegIntent(
        'probe:d',
        'probe:d',
        0,
        terminal('right', 20),
        terminal('left', 20),
        'target',
        nodesById,
        locations,
        geometry
    ));
    const assignment = committedBranch.allocator.channelAssignment(
        [first, second, accepted],
        committedBranch.allocator.realizeBranch()
    );
    const chainTracks = Object.freeze(
        [first, second, accepted].map(assignment.resolve)
    );
    allocator.commit(committedBranch.allocator.actionsSince(
        committedBranch.baseActionCount
    ));

    return Object.freeze({
        chainTracks,
        cycleRejected,
        before,
        afterRejected,
        afterCommitted: snapshot(),
    });
}
