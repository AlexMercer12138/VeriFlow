import assert from 'node:assert/strict';
import test from 'node:test';

import * as publicApi from '../src';
import {
    FourStateVector,
    SimulatorTsError,
    classifyEdge,
    type LogicBit,
} from '../src';
import { FourStateScratch } from '../src/fourStateVector';

const STATES = ['0', '1', 'x', 'z'] as const satisfies readonly LogicBit[];

test('keeps mutable scratch helpers out of the public package entrypoint', () => {
    assert.equal('FourStateScratch' in publicApi, false);
});

test('parses and preserves every four-state bit without exposing mutation', () => {
    for (const state of STATES) {
        const value = FourStateVector.fromBits(state.toUpperCase());
        assert.equal(value.width, 1);
        assert.equal(value.signed, false);
        assert.equal(value.bit(0), state);
        assert.equal(value.toBits(), state);
        assert.equal(Object.isFrozen(value), true);
    }

    assert.throws(
        () => FourStateVector.fromBits(''),
        (error: unknown) => diagnostic(error, 'SIM_TS_INVALID_VALUE'),
    );
    assert.throws(
        () => FourStateVector.fromBits('10q1'),
        (error: unknown) => diagnostic(error, 'SIM_TS_INVALID_VALUE'),
    );
});

test('does not let runtime callers transfer mutable plane ownership', () => {
    const values = new Uint32Array([0, 1]);
    const unknowns = new Uint32Array([0, 0]);
    const runtimeFactory = FourStateVector.fromPlanes as unknown as (
        width: number,
        signed: boolean,
        valuePlanes: Uint32Array,
        unknownPlanes: Uint32Array,
        takeOwnership: boolean,
    ) => FourStateVector;
    const value = runtimeFactory(33, false, values, unknowns, true);

    values[1] = 0;
    unknowns[1] = 1;

    assert.equal(value.toBits(), `1${'0'.repeat(32)}`);
});

test('does not expose mutable plane storage on JavaScript instances', () => {
    const value = FourStateVector.fromBits(`1${'0'.repeat(32)}`);

    assert.equal('values' in value, false);
    assert.equal('unknowns' in value, false);
});

test('rejects direct JavaScript construction without the private factory token', () => {
    const RuntimeVector = FourStateVector as unknown as new (
        width: number,
        signed: boolean,
        values: Uint32Array,
        unknowns: Uint32Array,
    ) => FourStateVector;

    assert.throws(
        () => new RuntimeVector(
            33,
            false,
            new Uint32Array([0, 1]),
            new Uint32Array(2),
        ),
        (error: unknown) => diagnostic(error, 'SIM_TS_INVALID_VALUE'),
    );
});

test('matches exhaustive one-bit bitwise and equality truth tables', () => {
    for (const leftBit of STATES) {
        const left = FourStateVector.fromBits(leftBit);
        assert.equal(left.not().toBits(), referenceNot(leftBit));

        for (const rightBit of STATES) {
            const right = FourStateVector.fromBits(rightBit);
            assert.equal(left.and(right).toBits(), referenceAnd(leftBit, rightBit));
            assert.equal(left.or(right).toBits(), referenceOr(leftBit, rightBit));
            assert.equal(left.xor(right).toBits(), referenceXor(leftBit, rightBit));
            assert.equal(left.logicalEqual(right), referenceLogicalEqual(leftBit, rightBit));
            assert.equal(left.caseEqual(right), leftBit === rightBit ? '1' : '0');
        }
    }
});

test('matches exhaustive two-bit logical equality with known mismatches', () => {
    const values = STATES.flatMap(high => STATES.map(low => `${high}${low}`));
    for (const leftBits of values) {
        for (const rightBits of values) {
            assert.equal(
                FourStateVector.fromBits(leftBits).logicalEqual(
                    FourStateVector.fromBits(rightBits),
                ),
                referenceVectorLogicalEqual(leftBits, rightBits),
                `${leftBits} == ${rightBits}`,
            );
        }
    }
});

test('merges every one-bit branch pair for known and unknown conditions', () => {
    for (const condition of STATES) {
        for (const trueBit of STATES) {
            for (const falseBit of STATES) {
                const merged = FourStateVector.conditionalMerge(
                    condition,
                    FourStateVector.fromBits(trueBit),
                    FourStateVector.fromBits(falseBit),
                );
                const expected = condition === '0'
                    ? falseBit
                    : condition === '1'
                        ? trueBit
                        : trueBit === falseBit ? trueBit : 'x';
                assert.equal(
                    merged.toBits(),
                    expected,
                    `${condition} ? ${trueBit} : ${falseBit}`,
                );
            }
        }
    }
});

test('matches exhaustive two-bit reduction truth tables', () => {
    for (const high of STATES) {
        for (const low of STATES) {
            const bits = `${high}${low}`;
            const value = FourStateVector.fromBits(bits);
            assert.equal(value.reduceAnd(), referenceReduceAnd(bits));
            assert.equal(value.reduceOr(), referenceReduceOr(bits));
            assert.equal(value.reduceXor(), referenceReduceXor(bits));
        }
    }
});

test('classifies every scalar transition using Verilog edge rules', () => {
    for (const previous of STATES) {
        for (const next of STATES) {
            let expected: 'none' | 'posedge' | 'negedge' = 'none';
            if ((previous === '0' && next !== '0')
                || ((previous === 'x' || previous === 'z') && next === '1')) {
                expected = 'posedge';
            } else if ((previous === '1' && next !== '1')
                || ((previous === 'x' || previous === 'z') && next === '0')) {
                expected = 'negedge';
            }
            assert.equal(classifyEdge(previous, next), expected, `${previous}->${next}`);
        }
    }
});

test('resizes with Verilog signed extension and least-significant truncation', () => {
    assert.equal(
        FourStateVector.fromBits('1', { signed: true }).resize(4).toBits(),
        '1111',
    );
    assert.equal(
        FourStateVector.fromBits('x', { signed: true }).resize(4).toBits(),
        'xxxx',
    );
    assert.equal(
        FourStateVector.fromBits('z', { signed: true }).resize(4).toBits(),
        'zzzz',
    );
    assert.equal(FourStateVector.fromBits('1').resize(4).toBits(), '0001');
    assert.equal(FourStateVector.fromBits('10110').resize(3).toBits(), '110');
    assert.equal(FourStateVector.fromBits('101', { signed: true }).resize(5).signed, true);

    assert.throws(
        () => FourStateVector.fromBits('1').resize(0),
        (error: unknown) => diagnostic(error, 'SIM_TS_INVALID_WIDTH'),
    );
});

test('uses common-width signedness for bitwise and equality operands', () => {
    const signedOne = FourStateVector.fromBits('1', { signed: true });
    const signedThree = FourStateVector.fromBits('0011', { signed: true });
    const unsignedThree = FourStateVector.fromBits('0011');

    assert.equal(signedOne.and(signedThree).toBits(), '0011');
    assert.equal(signedOne.and(signedThree).signed, true);
    assert.equal(signedOne.and(unsignedThree).toBits(), '0001');
    assert.equal(signedOne.and(unsignedThree).signed, false);
    assert.equal(signedOne.logicalEqual(FourStateVector.fromBits('1111', { signed: true })), '1');
    assert.equal(signedOne.caseEqual(FourStateVector.fromBits('1111', { signed: true })), '1');
    assert.equal(signedOne.logicalEqual(FourStateVector.fromBits('1111')), '0');
});

test('selects LSB-indexed ranges and concatenates MSB-first parts', () => {
    const value = FourStateVector.fromBits('10xz01', { signed: true });
    assert.deepEqual(
        Array.from({ length: value.width }, (_, index) => value.bit(index)),
        ['1', '0', 'z', 'x', '0', '1'],
    );
    assert.equal(value.slice(4, 2).toBits(), '0xz');
    assert.equal(value.slice(4, 2).signed, false);
    assert.equal(value.slice(3, 3).toBits(), 'x');
    assert.equal(FourStateVector.concat([
        FourStateVector.fromBits('10', { signed: true }),
        FourStateVector.fromBits('xz'),
        FourStateVector.fromBits('1'),
    ]).toBits(), '10xz1');
    assert.equal(FourStateVector.concat([value]).signed, false);

    for (const range of [[2, 3], [6, 0], [1, -1]] as const) {
        assert.throws(
            () => value.slice(range[0], range[1]),
            (error: unknown) => diagnostic(error, 'SIM_TS_INVALID_RANGE'),
        );
    }
    assert.throws(
        () => FourStateVector.concat([]),
        (error: unknown) => diagnostic(error, 'SIM_TS_INVALID_VALUE'),
    );
});

test('applies operations across 32-bit, multi-limb, and 1024-bit boundaries', () => {
    for (const width of [32, 33, 65, 1024]) {
        const leftBits = patternedBits(width, '01xz');
        const rightBits = patternedBits(width, '1100zx');
        const left = FourStateVector.fromBits(leftBits);
        const right = FourStateVector.fromBits(rightBits);

        assert.equal(left.not().toBits(), mapBits(leftBits, referenceNot));
        assert.equal(left.and(right).toBits(), zipBits(leftBits, rightBits, referenceAnd));
        assert.equal(left.or(right).toBits(), zipBits(leftBits, rightBits, referenceOr));
        assert.equal(left.xor(right).toBits(), zipBits(leftBits, rightBits, referenceXor));
        assert.equal(left.bit(width - 1), leftBits[0]);
        assert.equal(left.bit(0), leftBits[leftBits.length - 1]);
    }

    const signedWide = FourStateVector.fromBits(`z${'10xz'.repeat(16)}`, { signed: true });
    assert.equal(signedWide.width, 65);
    assert.equal(signedWide.resize(97).toBits(), `${'z'.repeat(32)}${signedWide.toBits()}`);
    assert.equal(
        FourStateVector.concat([signedWide, signedWide]).toBits(),
        `${signedWide.toBits()}${signedWide.toBits()}`,
    );
});

test('preserves scalar sign-bit masks and handles reductions and slices at limb edges', () => {
    const scalarSignBit = FourStateVector.fromPlanes(32, false, 0x8000_0000, 0);
    assert.equal(scalarSignBit.valueWord(0), 0x8000_0000);
    assert.equal(scalarSignBit.toBits(), `1${'0'.repeat(31)}`);

    for (const width of [31, 32, 33, 64, 65, 1024]) {
        const bits = patternedBits(width, '10100');
        const value = FourStateVector.fromBits(bits);
        assert.equal(value.reduceAnd(), referenceReduceAnd(bits), `reduceAnd width ${width}`);
        assert.equal(value.reduceOr(), referenceReduceOr(bits), `reduceOr width ${width}`);
        assert.equal(value.reduceXor(), referenceReduceXor(bits), `reduceXor width ${width}`);
    }

    const sourceBits = patternedBits(97, '10xz011');
    const source = FourStateVector.fromBits(sourceBits);
    for (const [msb, lsb] of [[63, 31], [70, 29], [95, 32], [64, 1]] as const) {
        assert.equal(
            source.slice(msb, lsb).toBits(),
            sourceBits.slice(source.width - msb - 1, source.width - lsb),
            `slice [${msb}:${lsb}]`,
        );
    }
});

test('reuses fixed-width scratch storage without mutating prior snapshots', () => {
    const left = FourStateVector.fromBits(patternedBits(65, '01xz'));
    const right = FourStateVector.fromBits(patternedBits(65, '1z00x'));
    const scratch = new FourStateScratch(65);

    assert.equal(scratch.assign(left), scratch);
    assert.equal(scratch.snapshot().toBits(), left.toBits());
    assert.equal(scratch.assignNot(left), scratch);
    const notSnapshot = scratch.snapshot();
    assert.equal(notSnapshot.toBits(), left.not().toBits());

    assert.equal(scratch.assignAnd(left, right), scratch);
    assert.equal(scratch.snapshot().toBits(), left.and(right).toBits());
    assert.equal(notSnapshot.toBits(), left.not().toBits());

    assert.equal(scratch.assignOr(left, right), scratch);
    assert.equal(scratch.snapshot().toBits(), left.or(right).toBits());
    assert.equal(scratch.assignXor(left, right), scratch);
    assert.equal(scratch.snapshot({ signed: true }).toBits(), left.xor(right).toBits());
    assert.equal(scratch.snapshot({ signed: true }).signed, true);

    assert.throws(
        () => scratch.assignNot(FourStateVector.fromBits('x')),
        (error: unknown) => diagnostic(error, 'SIM_TS_WIDTH_MISMATCH'),
    );

    for (const width of [1, 32]) {
        const source = FourStateVector.fromBits(patternedBits(width, '10xz'));
        const scalarScratch = new FourStateScratch(width);
        assert.equal(scalarScratch.assign(source), scalarScratch);
        assert.equal(scalarScratch.snapshot().toBits(), source.toBits());
    }
});

function diagnostic(error: unknown, code: SimulatorTsError['code']): boolean {
    return error instanceof SimulatorTsError && error.code === code;
}

function referenceNot(bit: LogicBit): LogicBit {
    if (bit === '0') return '1';
    if (bit === '1') return '0';
    return 'x';
}

function referenceAnd(left: LogicBit, right: LogicBit): LogicBit {
    if (left === '0' || right === '0') return '0';
    if (left === '1' && right === '1') return '1';
    return 'x';
}

function referenceOr(left: LogicBit, right: LogicBit): LogicBit {
    if (left === '1' || right === '1') return '1';
    if (left === '0' && right === '0') return '0';
    return 'x';
}

function referenceXor(left: LogicBit, right: LogicBit): LogicBit {
    if ((left === 'x' || left === 'z') || (right === 'x' || right === 'z')) {
        return 'x';
    }
    return left === right ? '0' : '1';
}

function referenceLogicalEqual(left: LogicBit, right: LogicBit): LogicBit {
    if ((left === 'x' || left === 'z') || (right === 'x' || right === 'z')) {
        return 'x';
    }
    return left === right ? '1' : '0';
}

function referenceVectorLogicalEqual(left: string, right: string): LogicBit {
    let hasUnknown = false;
    for (let index = 0; index < left.length; index += 1) {
        const leftBit = left[index] as LogicBit;
        const rightBit = right[index] as LogicBit;
        const leftUnknown = leftBit === 'x' || leftBit === 'z';
        const rightUnknown = rightBit === 'x' || rightBit === 'z';
        if (!leftUnknown && !rightUnknown && leftBit !== rightBit) return '0';
        hasUnknown ||= leftUnknown || rightUnknown;
    }
    return hasUnknown ? 'x' : '1';
}

function referenceReduceAnd(bits: string): LogicBit {
    if (bits.includes('0')) return '0';
    if (bits.includes('x') || bits.includes('z')) return 'x';
    return '1';
}

function referenceReduceOr(bits: string): LogicBit {
    if (bits.includes('1')) return '1';
    if (bits.includes('x') || bits.includes('z')) return 'x';
    return '0';
}

function referenceReduceXor(bits: string): LogicBit {
    if (bits.includes('x') || bits.includes('z')) return 'x';
    return Array.from(bits).filter(bit => bit === '1').length % 2 === 0 ? '0' : '1';
}

function patternedBits(width: number, pattern: string): string {
    return Array.from(
        { length: width },
        (_, index) => pattern[index % pattern.length],
    ).join('');
}

function mapBits(bits: string, operation: (bit: LogicBit) => LogicBit): string {
    return Array.from(bits, bit => operation(bit as LogicBit)).join('');
}

function zipBits(
    left: string,
    right: string,
    operation: (leftBit: LogicBit, rightBit: LogicBit) => LogicBit,
): string {
    return Array.from(
        left,
        (bit, index) => operation(bit as LogicBit, right[index] as LogicBit),
    ).join('');
}
