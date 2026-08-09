import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fitSchematicNode,
    measureSchematicNode,
    measureSchematicNodeSize,
    SCHEMATIC_NODE_LAYOUT,
    type TextMeasurementStyle,
    type TextMeasurer,
} from '../src/nodeGeometry';
import type { GraphNode, GraphPin, PinSide } from '../src/model';
import { pinKey, type PinKey } from '../src/pins';

const measureWidth = (text: string): number => text.length * 7;
const measure: TextMeasurer = text => measureWidth(text);

function pin(nodeId: string, name: string): GraphPin {
    return {
        id: `${nodeId}:${name}`,
        name,
        direction: 'bidirectional',
        width: { kind: 'known', bits: 1 },
        readOnly: false,
    };
}

function instance(
    id: string,
    names: string[],
    label = 'instance',
    subtitle = 'module'
): GraphNode {
    return {
        id,
        kind: 'instance',
        label,
        subtitle,
        pins: names.map(name => pin(id, name)),
        readOnly: false,
    };
}

function sides(
    node: GraphNode,
    values: PinSide[]
): ReadonlyMap<PinKey, PinSide> {
    return new Map(node.pins.map((candidate, index) => [
        pinKey(node.id, candidate.id),
        values[index],
    ]));
}

test('sizes height from header and the larger side pin count', () => {
    const node = instance('instance:dense', ['a', 'b', 'c', 'y', 'z']);
    const measured = measureSchematicNode(
        node,
        sides(node, ['left', 'left', 'left', 'right', 'right']),
        measure
    );

    assert.equal(
        measured.height,
        SCHEMATIC_NODE_LAYOUT.headerAreaHeight
            + 3 * SCHEMATIC_NODE_LAYOUT.pinRowHeight
            + SCHEMATIC_NODE_LAYOUT.verticalPadding
    );
});

test('measures the title with its rendered bold font weight', () => {
    const node = instance('instance:bold', [], 'bold title width', undefined);
    const styles: TextMeasurementStyle[] = [];
    const styleAwareMeasure: TextMeasurer = (text, style) => {
        styles.push(style);
        return text.length * (style.fontWeight === 600 ? 9 : 5);
    };
    const measured = measureSchematicNode(node, new Map(), styleAwareMeasure);

    assert.equal(
        measured.width,
        node.label.length * 9
            + 2 * SCHEMATIC_NODE_LAYOUT.horizontalPadding
    );
    assert.ok(styles.some(style => style.fontWeight === 600));
});

test('fits real font widths inside the deterministic layout size', () => {
    const node = instance('instance:wide-font', [], 'W'.repeat(25), undefined);
    const sideMap = new Map<PinKey, PinSide>();
    const layoutSize = measureSchematicNodeSize(node, sideMap);
    const fitted = fitSchematicNode(
        node,
        sideMap,
        layoutSize,
        (text: string) => text.length * 12
    );

    assert.deepEqual(layoutSize, { width: 199, height: 72 });
    assert.deepEqual(
        { width: fitted.width, height: fitted.height },
        layoutSize
    );
    assert.equal(fitted.title.truncated, true);
    assert.ok(
        fitted.title.visibleText.length * 12 <= fitted.title.clipBounds.width
    );
});

test('accounts for headings and both pin-label columns in node width', () => {
    const node = instance(
        'instance:wide',
        ['left_label', 'right_label'],
        'wide instance heading',
        'wide module subtitle'
    );
    const measured = measureSchematicNode(
        node,
        sides(node, ['left', 'right']),
        measure
    );

    assert.ok(
        measured.width >= measureWidth(node.label)
            + 2 * SCHEMATIC_NODE_LAYOUT.horizontalPadding
    );
    assert.ok(
        measured.width >= measureWidth(node.subtitle!)
            + 2 * SCHEMATIC_NODE_LAYOUT.horizontalPadding
    );
    assert.ok(
        measured.width >= measured.leftLabelWidth
            + measured.centerWidth
            + measured.rightLabelWidth
            + 2 * SCHEMATIC_NODE_LAYOUT.pinLabelInset
    );
    assert.ok(measured.centerWidth >= SCHEMATIC_NODE_LAYOUT.minimumCenterGap);
});

test('anchors pins only on vertical sides in declaration order and on grid rows', () => {
    const node = instance('instance:ordered', [
        'right_first',
        'left_first',
        'right_second',
        'left_second',
    ]);
    const measured = measureSchematicNode(
        node,
        sides(node, ['right', 'left', 'right', 'left']),
        measure
    );

    assert.deepEqual(
        measured.pins.filter(candidate => candidate.side === 'left')
            .map(candidate => candidate.source.name),
        ['left_first', 'left_second']
    );
    assert.deepEqual(
        measured.pins.filter(candidate => candidate.side === 'right')
            .map(candidate => candidate.source.name),
        ['right_first', 'right_second']
    );
    for (const candidate of measured.pins) {
        assert.ok(candidate.anchor.x === 0 || candidate.anchor.x === measured.width);
        assert.equal(candidate.anchor.y % SCHEMATIC_NODE_LAYOUT.gridSize, 0);
        assert.ok(candidate.anchor.y >= 0 && candidate.anchor.y <= measured.height);
    }
});

test('ellipsizes measured labels at maximum width and keeps clips inside the node', () => {
    const long = 'a_very_long_signal_name_that_cannot_fit_inside_the_module';
    const node = instance(
        'instance:limited',
        [`left_${long}`, `right_${long}`],
        `title_${long}`,
        `subtitle_${long}`
    );
    const measured = measureSchematicNode(
        node,
        sides(node, ['left', 'right']),
        measure
    );

    assert.equal(measured.width, SCHEMATIC_NODE_LAYOUT.maximumWidth);
    assert.equal(measured.title.truncated, true);
    assert.match(measured.title.visibleText, /\.\.\.$/);
    for (const label of [measured.title, measured.subtitle!]) {
        const clip = label.clipBounds;
        assert.ok(Number.isFinite(clip.x) && Number.isFinite(clip.width));
        assert.ok(clip.x >= 0 && clip.width >= 0);
        assert.ok(clip.x + clip.width <= measured.width);
        assert.ok(clip.y >= 0 && clip.y + clip.height <= measured.height);
        assert.ok(measureWidth(label.visibleText) <= clip.width);
    }
    for (const candidate of measured.pins) {
        const clip = candidate.clipBounds;
        assert.ok(clip.x >= 0 && clip.x + clip.width <= measured.width);
        assert.ok(clip.y >= 0 && clip.y + clip.height <= measured.height);
        assert.ok(measureWidth(candidate.visibleLabel) <= clip.width);
        assert.equal(candidate.truncated, true);
        assert.ok(candidate.visibleLabel.endsWith('...'));
    }
});

test('keeps boundary port nodes compact with a centered side anchor', () => {
    const id = 'port:data';
    const node: GraphNode = {
        id,
        kind: 'port',
        label: 'data',
        pins: [pin(id, 'data')],
        readOnly: false,
    };
    const measured = measureSchematicNode(node, sides(node, ['right']), measure);

    assert.deepEqual(
        { width: measured.width, height: measured.height },
        {
            width: SCHEMATIC_NODE_LAYOUT.portWidth,
            height: SCHEMATIC_NODE_LAYOUT.portHeight,
        }
    );
    assert.deepEqual(measured.pins[0].anchor, {
        x: measured.width,
        y: measured.height / 2,
    });
    assert.strictEqual(measured.pins[0].source, node.pins[0]);
    assert.equal(measured.pins[0].fullLabel, 'data');
});
