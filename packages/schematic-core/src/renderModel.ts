import type {
    GraphInterfaceNetwork,
    GraphInterfacePin,
    GraphNodeKind,
    PinDirection,
    PinSide,
} from './model';
import type { TextMeasurementStyle } from './nodeGeometry';
import type { Point, Rectangle, RouteSegment } from './routing/geometry';
import type { Direction } from './routing/junctions';

export type LayoutColumn = Readonly<{
    index: number;
    x: number;
    width: number;
    nodeIds: readonly string[];
}>;

export type RenderedTextLabel = Readonly<{
    fullText: string;
    visibleText: string;
    truncated: boolean;
    bounds: Readonly<Rectangle>;
}>;

export type RenderedPinGeometry = Readonly<{
    id: string;
    name: string;
    direction: PinDirection;
    side: PinSide;
    anchor: Readonly<Point>;
    fullLabel: string;
    visibleLabel: string;
    truncated: boolean;
    clipBounds: Readonly<Rectangle>;
    interface?: Readonly<GraphInterfacePin>;
}>;

export type RenderedNodeGeometry = Readonly<{
    id: string;
    kind: GraphNodeKind;
    label: string;
    subtitle?: string;
    column: number;
    row: number;
    bounds: Readonly<Rectangle>;
    title: RenderedTextLabel;
    renderedSubtitle?: RenderedTextLabel;
    pins: readonly RenderedPinGeometry[];
}>;

export type NetworkTerminalGeometry = Readonly<{
    nodeId: string;
    pinId: string;
    role: PinDirection;
    point: Readonly<Point>;
}>;

export type NetworkRouteLabel = Readonly<{
    text: string;
    bounds: Readonly<Rectangle>;
}>;

export type NetworkRoute = Readonly<{
    id: string;
    name: string;
    displayName: string;
    selectionDescription: string;
    feedback: boolean;
    renderWidth?: number;
    interface?: Readonly<GraphInterfaceNetwork>;
    terminals: readonly NetworkTerminalGeometry[];
    segments: readonly Readonly<RouteSegment>[];
    /** @deprecated Network names are shown in the Inspector, not on canvas. */
    label?: NetworkRouteLabel;
}>;

export type RenderedJunction = Readonly<{
    networkId: string;
    point: Readonly<Point>;
    directions: ReadonlySet<Direction>;
}>;

export type SchematicRenderModel = Readonly<{
    columns: readonly LayoutColumn[];
    nodes: ReadonlyMap<string, RenderedNodeGeometry>;
    networks: readonly NetworkRoute[];
    junctions: readonly RenderedJunction[];
    bounds: Readonly<Rectangle>;
}>;

export type SerializedSchematicRenderModel = Readonly<{
    columns: readonly LayoutColumn[];
    nodes: readonly RenderedNodeGeometry[];
    networks: readonly NetworkRoute[];
    junctions: readonly Readonly<{
        networkId: string;
        point: Readonly<Point>;
        directions: readonly Direction[];
    }>[];
    bounds: Readonly<Rectangle>;
}>;

export const SCHEMATIC_NETWORK_LABEL_STYLE = Object.freeze({
    fontSize: 10,
    fontWeight: 400,
} as const satisfies TextMeasurementStyle);

export const SCHEMATIC_NETWORK_LABEL_LAYOUT = Object.freeze({
    height: 14,
    endpointPadding: 4,
    wireGap: 3,
    junctionRadius: 3,
});

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
    readonly #values: Map<K, V>;

    constructor(entries: readonly (readonly [K, V])[]) {
        this.#values = new Map(entries);
        Object.freeze(this);
    }

    get size(): number {
        return this.#values.size;
    }

    entries(): MapIterator<[K, V]> {
        return this.#values.entries();
    }

    forEach(
        callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
        thisArg?: unknown
    ): void {
        for (const [key, value] of this.#values) {
            callbackfn.call(thisArg, value, key, this);
        }
    }

    get(key: K): V | undefined {
        return this.#values.get(key);
    }

    has(key: K): boolean {
        return this.#values.has(key);
    }

    keys(): MapIterator<K> {
        return this.#values.keys();
    }

    values(): MapIterator<V> {
        return this.#values.values();
    }

    [Symbol.iterator](): MapIterator<[K, V]> {
        return this.#values[Symbol.iterator]();
    }

    get [Symbol.toStringTag](): string {
        return 'ReadonlyMap';
    }
}

class ReadonlySetView<T> implements ReadonlySet<T> {
    readonly #values: Set<T>;

    constructor(values: readonly T[]) {
        this.#values = new Set(values);
        Object.freeze(this);
    }

    get size(): number {
        return this.#values.size;
    }

    entries(): SetIterator<[T, T]> {
        return this.#values.entries();
    }

    forEach(
        callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
        thisArg?: unknown
    ): void {
        for (const value of this.#values) {
            callbackfn.call(thisArg, value, value, this);
        }
    }

    has(value: T): boolean {
        return this.#values.has(value);
    }

    keys(): SetIterator<T> {
        return this.#values.keys();
    }

    values(): SetIterator<T> {
        return this.#values.values();
    }

    [Symbol.iterator](): SetIterator<T> {
        return this.#values[Symbol.iterator]();
    }

    get [Symbol.toStringTag](): string {
        return 'ReadonlySet';
    }
}

export function readonlyMap<K, V>(
    entries: readonly (readonly [K, V])[]
): ReadonlyMap<K, V> {
    return new ReadonlyMapView(entries);
}

export function readonlySet<T>(values: readonly T[]): ReadonlySet<T> {
    return new ReadonlySetView(values);
}

export function serializeSchematicRenderModel(
    model: SchematicRenderModel
): SerializedSchematicRenderModel {
    return Object.freeze({
        columns: Object.freeze([...model.columns]),
        nodes: Object.freeze([...model.nodes.values()]),
        networks: Object.freeze([...model.networks]),
        junctions: Object.freeze(model.junctions.map(junction => Object.freeze({
            networkId: junction.networkId,
            point: junction.point,
            directions: Object.freeze([...junction.directions]),
        }))),
        bounds: model.bounds,
    });
}
