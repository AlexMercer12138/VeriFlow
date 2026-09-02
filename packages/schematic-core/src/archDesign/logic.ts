import type { WidthValue } from '@veriflow/hdl-core/model';

import type { ArchDesignLogic, ArchDesignWidth } from './model';

export type ArchDesignLogicPin = Readonly<{
    name: string;
    role: 'driver' | 'load';
    width: WidthValue;
}>;

export function archDesignWidthValue(width: ArchDesignWidth): WidthValue {
    return Object.freeze(typeof width === 'number'
        ? { kind: 'known', bits: width }
        : { kind: 'symbolic', expression: width.expression });
}

function pin(
    name: string,
    role: ArchDesignLogicPin['role'],
    width: WidthValue
): ArchDesignLogicPin {
    return Object.freeze({ name, role, width });
}

function concatWidth(widths: readonly ArchDesignWidth[]): WidthValue {
    if (widths.every((width): width is number => typeof width === 'number')) {
        return Object.freeze({
            kind: 'known',
            bits: widths.reduce((sum, width) => sum + width, 0),
        });
    }
    return Object.freeze({
        kind: 'symbolic',
        expression: widths.map(width => typeof width === 'number'
            ? String(width)
            : `(${width.expression})`).join(' + '),
    });
}

function replicatedWidth(width: ArchDesignWidth, count: number): WidthValue {
    return Object.freeze(typeof width === 'number'
        ? { kind: 'known', bits: width * count }
        : { kind: 'symbolic', expression: `${count} * (${width.expression})` });
}

export function archDesignLogicPins(logic: ArchDesignLogic): readonly ArchDesignLogicPin[] {
    if (logic.operation === 'constant') {
        return Object.freeze([pin('out', 'driver', archDesignWidthValue(logic.width))]);
    }
    if (logic.operation === 'not') {
        const width = archDesignWidthValue(logic.width);
        return Object.freeze([pin('in', 'load', width), pin('out', 'driver', width)]);
    }
    if (
        logic.operation === 'and'
        || logic.operation === 'or'
        || logic.operation === 'xor'
        || logic.operation === 'nand'
        || logic.operation === 'nor'
        || logic.operation === 'xnor'
    ) {
        const width = archDesignWidthValue(logic.width);
        return Object.freeze([
            ...Array.from({ length: logic.inputCount }, (_, index) =>
                pin(`in${index}`, 'load', width)),
            pin('out', 'driver', width),
        ]);
    }
    if (logic.operation === 'mux') {
        const width = archDesignWidthValue(logic.width);
        return Object.freeze([
            pin('in0', 'load', width),
            pin('in1', 'load', width),
            pin('select', 'load', Object.freeze({ kind: 'known', bits: 1 })),
            pin('out', 'driver', width),
        ]);
    }
    if (logic.operation === 'concat') {
        return Object.freeze([
            ...logic.inputWidths.map((width, index) =>
                pin(`in${index}`, 'load', archDesignWidthValue(width))),
            pin('out', 'driver', concatWidth(logic.inputWidths)),
        ]);
    }
    if (logic.operation === 'slice') {
        return Object.freeze([
            pin('in', 'load', archDesignWidthValue(logic.inputWidth)),
            pin('out', 'driver', Object.freeze({
                kind: 'known', bits: logic.msb - logic.lsb + 1,
            })),
        ]);
    }
    if (logic.operation === 'replicate') {
        return Object.freeze([
            pin('in', 'load', archDesignWidthValue(logic.inputWidth)),
            pin('out', 'driver', replicatedWidth(logic.inputWidth, logic.count)),
        ]);
    }
    if (logic.operation === 'zero-extend' || logic.operation === 'sign-extend') {
        return Object.freeze([
            pin('in', 'load', archDesignWidthValue(logic.inputWidth)),
            pin('out', 'driver', archDesignWidthValue(logic.outputWidth)),
        ]);
    }
    if ('inputWidth' in logic) {
        return Object.freeze([
            pin('in', 'load', archDesignWidthValue(logic.inputWidth)),
            pin('out', 'driver', Object.freeze({ kind: 'known', bits: 1 })),
        ]);
    }
    return Object.freeze([]);
}
