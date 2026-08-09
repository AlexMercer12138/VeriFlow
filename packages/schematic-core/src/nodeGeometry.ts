import type { GraphNode, GraphPin, PinSide } from './model';
import { pinKey, type PinKey } from './pins';

export type TextMeasurer = (text: string) => number;

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
} as const;

function measuredWidth(measure: TextMeasurer, text: string): number {
    const width = measure(text);
    return Number.isFinite(width) ? Math.max(0, width) : 0;
}

function fitText(
    text: string,
    maximumWidth: number,
    measure: TextMeasurer
): { visibleText: string; truncated: boolean } {
    const available = Number.isFinite(maximumWidth) ? Math.max(0, maximumWidth) : 0;
    if (measuredWidth(measure, text) <= available) {
        return { visibleText: text, truncated: false };
    }
    const ellipsis = '...';
    if (measuredWidth(measure, ellipsis) > available) {
        return { visibleText: '', truncated: true };
    }
    let lower = 0;
    let upper = text.length;
    while (lower < upper) {
        const candidate = Math.ceil((lower + upper) / 2);
        if (measuredWidth(measure, `${text.slice(0, candidate)}${ellipsis}`)
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
    measure: TextMeasurer
): MeasuredLabel {
    const fitted = fitText(fullText, clipBounds.width, measure);
    return { fullText, ...fitted, clipBounds };
}

export function measureSchematicNode(
    node: GraphNode,
    sideMap: ReadonlyMap<PinKey, PinSide>,
    measure: TextMeasurer
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
        ...leftPins.map(pin => measuredWidth(measure, pin.source.name))
    );
    const rightNatural = isPort ? 0 : Math.max(
        0,
        ...rightPins.map(pin => measuredWidth(measure, pin.source.name))
    );
    const headingWidth = Math.max(
        measuredWidth(measure, node.label),
        measuredWidth(measure, node.subtitle ?? '')
    ) + 2 * SCHEMATIC_NODE_LAYOUT.horizontalPadding;
    const pinWidth = leftNatural
        + rightNatural
        + SCHEMATIC_NODE_LAYOUT.minimumCenterGap
        + 2 * SCHEMATIC_NODE_LAYOUT.pinLabelInset;
    const width = isPort
        ? SCHEMATIC_NODE_LAYOUT.portWidth
        : Math.min(
            SCHEMATIC_NODE_LAYOUT.maximumWidth,
            Math.max(SCHEMATIC_NODE_LAYOUT.minimumWidth, headingWidth, pinWidth)
        );
    const sideRows = Math.max(leftPins.length, rightPins.length);
    const height = isPort
        ? SCHEMATIC_NODE_LAYOUT.portHeight
        : Math.max(
            SCHEMATIC_NODE_LAYOUT.minimumHeight,
            SCHEMATIC_NODE_LAYOUT.headerAreaHeight
                + sideRows * SCHEMATIC_NODE_LAYOUT.pinRowHeight
                + SCHEMATIC_NODE_LAYOUT.verticalPadding
        );
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
        y: 5,
        width: Math.max(0, width - 2 * SCHEMATIC_NODE_LAYOUT.horizontalPadding),
        height: SCHEMATIC_NODE_LAYOUT.labelHeight,
    };
    const subtitleBounds: ClipBounds = {
        ...titleBounds,
        y: 22,
    };
    const sideIndexes: Record<PinSide, number> = { left: 0, right: 0 };
    const pins: ResolvedPin[] = sidePins.map(({ source, side }) => {
        const row = sideIndexes[side]++;
        const anchor = isPort
            ? { x: side === 'left' ? 0 : width, y: height / 2 }
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
            : fitText(source.name, clipBounds.width, measure);
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
        title: measuredLabel(node.label, titleBounds, measure),
        subtitle: node.subtitle === undefined
            ? undefined
            : measuredLabel(node.subtitle, subtitleBounds, measure),
        pins,
        leftLabelWidth: labelWidths.left,
        rightLabelWidth: labelWidths.right,
        centerWidth,
    };
}
