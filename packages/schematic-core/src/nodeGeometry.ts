import type { GraphNode, GraphPin, PinSide } from './model';
import { pinKey, type PinKey } from './pins';

export type TextMeasurementStyle = Readonly<{
    fontSize: number;
    fontWeight: 400 | 600;
}>;

export type TextMeasurer = (
    text: string,
    style: TextMeasurementStyle
) => number;

export type Point = {
    x: number;
    y: number;
};

export type ClipBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type MeasuredLabel = {
    fullText: string;
    visibleText: string;
    truncated: boolean;
    clipBounds: ClipBounds;
};

export type ResolvedPin = {
    source: GraphPin;
    side: PinSide;
    anchor: Point;
    fullLabel: string;
    visibleLabel: string;
    truncated: boolean;
    clipBounds: ClipBounds;
};

export type MeasuredNode = {
    source: GraphNode;
    width: number;
    height: number;
    title: MeasuredLabel;
    subtitle?: MeasuredLabel;
    pins: ResolvedPin[];
    leftLabelWidth: number;
    rightLabelWidth: number;
    centerWidth: number;
};

export type SchematicNodeSize = {
    width: number;
    height: number;
};

export const SCHEMATIC_NODE_LAYOUT = {
    gridSize: 2,
    minimumWidth: 160,
    maximumWidth: 320,
    minimumHeight: 72,
    portWidth: 96,
    portHeight: 40,
    headerAreaHeight: 40,
    pinRowHeight: 20,
    verticalPadding: 12,
    horizontalPadding: 12,
    pinLabelInset: 10,
    minimumCenterGap: 24,
    labelHeight: 14,
    titleCenterY: 17,
    subtitleCenterY: 33,
} as const;

export const SCHEMATIC_TEXT_STYLES = {
    title: { fontSize: 12, fontWeight: 600 },
    subtitle: { fontSize: 10, fontWeight: 400 },
    pin: { fontSize: 10, fontWeight: 400 },
} as const satisfies Record<string, TextMeasurementStyle>;

const LAYOUT_CHARACTER_WIDTH = 7;

function measuredWidth(
    measure: TextMeasurer,
    text: string,
    style: TextMeasurementStyle
): number {
    const width = measure(text, style);
    return Number.isFinite(width) ? Math.max(0, width) : 0;
}

function fitText(
    text: string,
    maximumWidth: number,
    measure: TextMeasurer,
    style: TextMeasurementStyle
): { visibleText: string; truncated: boolean } {
    const available = Number.isFinite(maximumWidth) ? Math.max(0, maximumWidth) : 0;
    if (measuredWidth(measure, text, style) <= available) {
        return { visibleText: text, truncated: false };
    }
    const ellipsis = '...';
    if (measuredWidth(measure, ellipsis, style) > available) {
        return { visibleText: '', truncated: true };
    }
    let lower = 0;
    let upper = text.length;
    while (lower < upper) {
        const candidate = Math.ceil((lower + upper) / 2);
        if (measuredWidth(measure, `${text.slice(0, candidate)}${ellipsis}`, style)
            <= available) {
            lower = candidate;
        } else {
            upper = candidate - 1;
        }
    }
    return { visibleText: `${text.slice(0, lower)}${ellipsis}`, truncated: true };
}

function sideFor(
    node: GraphNode,
    pin: GraphPin,
    sideMap: ReadonlyMap<PinKey, PinSide>
): PinSide {
    return sideMap.get(pinKey(node.id, pin.id))
        ?? (pin.direction === 'driver' ? 'right' : 'left');
}

function allocateLabelWidths(
    leftNatural: number,
    rightNatural: number,
    available: number
): { left: number; right: number } {
    if (leftNatural + rightNatural <= available) {
        return { left: leftNatural, right: rightNatural };
    }
    if (leftNatural === 0) return { left: 0, right: available };
    if (rightNatural === 0) return { left: available, right: 0 };

    let left = Math.min(leftNatural, available / 2);
    let right = Math.min(rightNatural, available - left);
    let remaining = available - left - right;
    const leftGrowth = Math.min(leftNatural - left, remaining);
    left += leftGrowth;
    remaining -= leftGrowth;
    right += Math.min(rightNatural - right, remaining);
    return { left, right };
}

function measuredLabel(
    fullText: string,
    clipBounds: ClipBounds,
    measure: TextMeasurer,
    style: TextMeasurementStyle
): MeasuredLabel {
    const fitted = fitText(fullText, clipBounds.width, measure, style);
    return { fullText, ...fitted, clipBounds };
}

function calculateSchematicNode(
    node: GraphNode,
    sideMap: ReadonlyMap<PinKey, PinSide>,
    measure: TextMeasurer,
    fixedSize?: Readonly<SchematicNodeSize>
): MeasuredNode {
    const sidePins = node.pins.map(source => ({
        source,
        side: sideFor(node, source, sideMap),
    }));
    const leftPins = sidePins.filter(pin => pin.side === 'left');
    const rightPins = sidePins.filter(pin => pin.side === 'right');
    const isPort = node.kind === 'port';
    const leftNatural = isPort ? 0 : Math.max(
        0,
        ...leftPins.map(pin => measuredWidth(
            measure,
            pin.source.name,
            SCHEMATIC_TEXT_STYLES.pin
        ))
    );
    const rightNatural = isPort ? 0 : Math.max(
        0,
        ...rightPins.map(pin => measuredWidth(
            measure,
            pin.source.name,
            SCHEMATIC_TEXT_STYLES.pin
        ))
    );
    const headingWidth = Math.max(
        measuredWidth(measure, node.label, SCHEMATIC_TEXT_STYLES.title),
        measuredWidth(
            measure,
            node.subtitle ?? '',
            SCHEMATIC_TEXT_STYLES.subtitle
        )
    ) + 2 * SCHEMATIC_NODE_LAYOUT.horizontalPadding;
    const pinWidth = leftNatural
        + rightNatural
        + SCHEMATIC_NODE_LAYOUT.minimumCenterGap
        + 2 * SCHEMATIC_NODE_LAYOUT.pinLabelInset;
    const naturalWidth = isPort
        ? SCHEMATIC_NODE_LAYOUT.portWidth
        : Math.min(
            SCHEMATIC_NODE_LAYOUT.maximumWidth,
            Math.max(SCHEMATIC_NODE_LAYOUT.minimumWidth, headingWidth, pinWidth)
        );
    const sideRows = Math.max(leftPins.length, rightPins.length);
    const naturalHeight = isPort
        ? Math.max(
            SCHEMATIC_NODE_LAYOUT.portHeight,
            sideRows * SCHEMATIC_NODE_LAYOUT.pinRowHeight
                + SCHEMATIC_NODE_LAYOUT.verticalPadding
        )
        : Math.max(
            SCHEMATIC_NODE_LAYOUT.minimumHeight,
            SCHEMATIC_NODE_LAYOUT.headerAreaHeight
                + sideRows * SCHEMATIC_NODE_LAYOUT.pinRowHeight
                + SCHEMATIC_NODE_LAYOUT.verticalPadding
        );
    const width = fixedSize?.width ?? naturalWidth;
    const height = fixedSize?.height ?? naturalHeight;
    const availableForPins = Math.max(
        0,
        width
            - 2 * SCHEMATIC_NODE_LAYOUT.pinLabelInset
            - SCHEMATIC_NODE_LAYOUT.minimumCenterGap
    );
    const labelWidths = isPort
        ? { left: 0, right: 0 }
        : allocateLabelWidths(leftNatural, rightNatural, availableForPins);
    const centerWidth = Math.max(
        SCHEMATIC_NODE_LAYOUT.minimumCenterGap,
        width
            - 2 * SCHEMATIC_NODE_LAYOUT.pinLabelInset
            - labelWidths.left
            - labelWidths.right
    );
    const titleBounds: ClipBounds = {
        x: SCHEMATIC_NODE_LAYOUT.horizontalPadding,
        y: (isPort ? height / 2 : SCHEMATIC_NODE_LAYOUT.titleCenterY)
            - SCHEMATIC_NODE_LAYOUT.labelHeight / 2,
        width: Math.max(0, width - 2 * SCHEMATIC_NODE_LAYOUT.horizontalPadding),
        height: SCHEMATIC_NODE_LAYOUT.labelHeight,
    };
    const subtitleBounds: ClipBounds = {
        ...titleBounds,
        y: SCHEMATIC_NODE_LAYOUT.subtitleCenterY
            - SCHEMATIC_NODE_LAYOUT.labelHeight / 2,
    };
    const sideIndexes: Record<PinSide, number> = { left: 0, right: 0 };
    const sideCounts: Record<PinSide, number> = {
        left: leftPins.length,
        right: rightPins.length,
    };
    const pins: ResolvedPin[] = sidePins.map(({ source, side }) => {
        const row = sideIndexes[side]++;
        const anchor = isPort
            ? {
                x: side === 'left' ? 0 : width,
                y: (height
                    - sideCounts[side] * SCHEMATIC_NODE_LAYOUT.pinRowHeight) / 2
                    + row * SCHEMATIC_NODE_LAYOUT.pinRowHeight
                    + SCHEMATIC_NODE_LAYOUT.pinRowHeight / 2,
            }
            : {
                x: side === 'left' ? 0 : width,
                y: SCHEMATIC_NODE_LAYOUT.headerAreaHeight
                    + row * SCHEMATIC_NODE_LAYOUT.pinRowHeight
                    + SCHEMATIC_NODE_LAYOUT.pinRowHeight / 2,
            };
        const labelWidth = side === 'left' ? labelWidths.left : labelWidths.right;
        const clipBounds: ClipBounds = {
            x: side === 'left'
                ? SCHEMATIC_NODE_LAYOUT.pinLabelInset
                : width - SCHEMATIC_NODE_LAYOUT.pinLabelInset - labelWidth,
            y: Math.max(0, anchor.y - SCHEMATIC_NODE_LAYOUT.labelHeight / 2),
            width: labelWidth,
            height: Math.min(SCHEMATIC_NODE_LAYOUT.labelHeight, height),
        };
        const fitted = isPort
            ? { visibleText: '', truncated: false }
            : fitText(
                source.name,
                clipBounds.width,
                measure,
                SCHEMATIC_TEXT_STYLES.pin
            );
        return {
            source,
            side,
            anchor,
            fullLabel: source.name,
            visibleLabel: fitted.visibleText,
            truncated: fitted.truncated,
            clipBounds,
        };
    });

    return {
        source: node,
        width,
        height,
        title: measuredLabel(
            node.label,
            titleBounds,
            measure,
            SCHEMATIC_TEXT_STYLES.title
        ),
        subtitle: node.subtitle === undefined
            ? undefined
            : measuredLabel(
                node.subtitle,
                subtitleBounds,
                measure,
                SCHEMATIC_TEXT_STYLES.subtitle
            ),
        pins,
        leftLabelWidth: labelWidths.left,
        rightLabelWidth: labelWidths.right,
        centerWidth,
    };
}

export function measureSchematicNode(
    node: GraphNode,
    sideMap: ReadonlyMap<PinKey, PinSide>,
    measure: TextMeasurer
): MeasuredNode {
    return calculateSchematicNode(node, sideMap, measure);
}

export function measureSchematicNodeSize(
    node: GraphNode,
    sideMap: ReadonlyMap<PinKey, PinSide>
): SchematicNodeSize {
    // Layout must be reproducible in Node and browsers; real fonts only affect fitting.
    const measured = measureSchematicNode(
        node,
        sideMap,
        text => text.length * LAYOUT_CHARACTER_WIDTH
    );
    return { width: measured.width, height: measured.height };
}

export function fitSchematicNode(
    node: GraphNode,
    sideMap: ReadonlyMap<PinKey, PinSide>,
    size: Readonly<SchematicNodeSize>,
    measure: TextMeasurer
): MeasuredNode {
    return calculateSchematicNode(node, sideMap, measure, size);
}
