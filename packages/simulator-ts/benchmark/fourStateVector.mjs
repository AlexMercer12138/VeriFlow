#!/usr/bin/env node

import { createRequire } from 'node:module';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { FourStateVector } = require('../dist/index.js');
const { FourStateScratch } = require('../dist/fourStateVector.js');

const CHECKSUM_SEED = 0x811c_9dc5;
const CHECKSUM_PRIME = 0x0100_0193;
const VALIDATION_SEQUENCE_LENGTH = 4;

const configuration = parseArguments(process.argv.slice(2));
const andTable = createPackedAndTable();
const scalarSources = [
    FourStateVector.fromBits('1'),
    FourStateVector.fromBits('z'),
];
const vector32Sources = [
    FourStateVector.fromBits('01xz'.repeat(8)),
    FourStateVector.fromBits('1100'.repeat(8)),
];
const vector1024Sources = [
    FourStateVector.fromBits('01xz'.repeat(256)),
    FourStateVector.fromBits('1100'.repeat(256)),
];

const results = [];
addAssignmentBenchmarks(results, 'scalar-assignment', 1, scalarSources, configuration.iterations);
addAssignmentBenchmarks(results, 'vector32-assignment', 32, vector32Sources, configuration.iterations);
addBitwiseBenchmarks(results, vector32Sources, configuration.iterations, andTable);
addEqualityBenchmarks(results, vector32Sources, configuration.iterations);
addWideCopyBenchmarks(results, vector1024Sources, configuration.wideIterations);

process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'representation-comparison',
    generatedAt: new Date().toISOString(),
    system: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
    },
    configuration,
    validation: {
        preflight: 'passed',
        checksum: 'fnv1a32-four-state-lsb-first',
        sequenceLength: VALIDATION_SEQUENCE_LENGTH,
    },
    results,
}, null, 2)}\n`);

function addAssignmentBenchmarks(results, operation, width, sources, iterations) {
    const expectedChecksums = validationSequence(
        index => vectorStateChecksum(sources[index & 1]),
    );
    const planes = sources.map(toPairPlanes);
    let targetValues = 0;
    let targetUnknowns = 0;
    results.push(measure({
        operation,
        width,
        variant: 'paired-mask',
        iterations,
        run(index) {
            const source = planes[index & 1];
            targetValues = source.values;
            targetUnknowns = source.unknowns;
        },
        observe: () => pairStateChecksum(width, targetValues, targetUnknowns),
        expectedChecksums,
    }));

    const packedSources = sources.map(source => packSymbols(source.toBits()));
    const packedTarget = new Uint8Array(packedSources[0].length);
    results.push(measure({
        operation,
        width,
        variant: 'packed-symbol',
        iterations,
        run(index) {
            packedTarget.set(packedSources[index & 1]);
        },
        observe: () => packedStateChecksum(width, packedTarget),
        expectedChecksums,
    }));

    const scratch = new FourStateScratch(width);
    results.push(measure({
        operation,
        width,
        variant: 'four-state-scratch',
        iterations,
        run(index) {
            scratch.assign(sources[index & 1]);
        },
        observe: () => vectorStateChecksum(scratch.snapshot()),
        expectedChecksums,
    }));
}

function addBitwiseBenchmarks(results, sources, iterations, lookup) {
    const operation = 'vector32-bitwise-and';
    const width = 32;
    const expectedChecksums = validationSequence(index => vectorStateChecksum(
        sources[index & 1].and(sources[(index + 1) & 1]),
    ));
    const planes = sources.map(toPairPlanes);
    let targetValues = 0;
    let targetUnknowns = 0;
    results.push(measure({
        operation,
        width,
        variant: 'paired-mask',
        iterations,
        run(index) {
            const left = planes[index & 1];
            const right = planes[(index + 1) & 1];
            const leftZero = (~left.unknowns) & (~left.values);
            const rightZero = (~right.unknowns) & (~right.values);
            const leftOne = (~left.unknowns) & left.values;
            const rightOne = (~right.unknowns) & right.values;
            const knownZero = leftZero | rightZero;
            const knownOne = leftOne & rightOne;
            targetValues = knownOne >>> 0;
            targetUnknowns = (~(knownZero | knownOne)) >>> 0;
        },
        observe: () => pairStateChecksum(width, targetValues, targetUnknowns),
        expectedChecksums,
    }));

    const packedSources = sources.map(source => packSymbols(source.toBits()));
    const packedTarget = new Uint8Array(packedSources[0].length);
    results.push(measure({
        operation,
        width,
        variant: 'packed-symbol',
        iterations,
        run(index) {
            const left = packedSources[index & 1];
            const right = packedSources[(index + 1) & 1];
            for (let byte = 0; byte < packedTarget.length; byte += 1) {
                packedTarget[byte] = lookup[left[byte] * 256 + right[byte]];
            }
        },
        observe: () => packedStateChecksum(width, packedTarget),
        expectedChecksums,
    }));

    const scratch = new FourStateScratch(width);
    results.push(measure({
        operation,
        width,
        variant: 'four-state-scratch',
        iterations,
        run(index) {
            scratch.assignAnd(sources[index & 1], sources[(index + 1) & 1]);
        },
        observe: () => vectorStateChecksum(scratch.snapshot()),
        expectedChecksums,
    }));
}

function addEqualityBenchmarks(results, sources, iterations) {
    const operation = 'vector32-case-equality';
    const width = 32;
    const expectedChecksums = validationSequence(index => (
        sources[index & 1].caseEqual(sources[(index >>> 1) & 1]) === '1' ? 1 : 0
    ));
    const planes = sources.map(toPairPlanes);
    let pairResult = 0;
    results.push(measure({
        operation,
        width,
        variant: 'paired-mask',
        iterations,
        run(index) {
            const left = planes[index & 1];
            const right = planes[(index >>> 1) & 1];
            pairResult = left.values === right.values
                && left.unknowns === right.unknowns ? 1 : 0;
        },
        observe: () => pairResult,
        expectedChecksums,
    }));

    const packedSources = sources.map(source => packSymbols(source.toBits()));
    let packedResult = 0;
    results.push(measure({
        operation,
        width,
        variant: 'packed-symbol',
        iterations,
        run(index) {
            const left = packedSources[index & 1];
            const right = packedSources[(index >>> 1) & 1];
            packedResult = equalBytes(left, right) ? 1 : 0;
        },
        observe: () => packedResult,
        expectedChecksums,
    }));

    let vectorResult = '0';
    results.push(measure({
        operation,
        width,
        variant: 'four-state-vector',
        iterations,
        run(index) {
            vectorResult = sources[index & 1].caseEqual(sources[(index >>> 1) & 1]);
        },
        observe: () => vectorResult === '1' ? 1 : 0,
        expectedChecksums,
    }));
}

function addWideCopyBenchmarks(results, sources, iterations) {
    const operation = 'vector1024-copy';
    const width = 1024;
    const expectedChecksums = validationSequence(
        index => vectorStateChecksum(sources[index & 1]),
    );
    const splitSources = sources.map(source => wideSplitPlanes(source.toBits()));
    const targetValues = new Uint32Array(32);
    const targetUnknowns = new Uint32Array(32);
    results.push(measure({
        operation,
        width,
        variant: 'split-limbs',
        iterations,
        run(index) {
            const source = splitSources[index & 1];
            targetValues.set(source.values);
            targetUnknowns.set(source.unknowns);
        },
        observe: () => splitStateChecksum(width, targetValues, targetUnknowns),
        expectedChecksums,
    }));

    const interleavedSources = splitSources.map(interleavePlanes);
    const interleavedTarget = new Uint32Array(64);
    results.push(measure({
        operation,
        width,
        variant: 'interleaved-limbs',
        iterations,
        run(index) {
            interleavedTarget.set(interleavedSources[index & 1]);
        },
        observe: () => interleavedStateChecksum(width, interleavedTarget),
        expectedChecksums,
    }));

    const scratch = new FourStateScratch(width);
    results.push(measure({
        operation,
        width,
        variant: 'four-state-scratch',
        iterations,
        run(index) {
            scratch.assign(sources[index & 1]);
        },
        observe: () => vectorStateChecksum(scratch.snapshot()),
        expectedChecksums,
    }));
}

function measure({
    operation,
    width,
    variant,
    iterations,
    run,
    observe,
    expectedChecksums,
}) {
    const checksum = runPreflight({
        operation,
        variant,
        run,
        observe,
        expectedChecksums,
    });
    const warmups = Math.min(iterations, 10_000);
    for (let index = 0; index < warmups; index += 1) run(index);
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) run(index);
    const totalMs = performance.now() - startedAt;
    return {
        operation,
        width,
        variant,
        iterations,
        totalMs,
        nanosecondsPerOperation: totalMs * 1_000_000 / iterations,
        validationIterations: expectedChecksums.length,
        checksum,
    };
}

function runPreflight({ operation, variant, run, observe, expectedChecksums }) {
    let checksum = CHECKSUM_SEED;
    for (let index = 0; index < expectedChecksums.length; index += 1) {
        run(index);
        const actual = observe();
        const expected = expectedChecksums[index];
        if (actual !== expected) {
            throw new Error(
                `${operation}/${variant} preflight failed at ${index}: `
                + `expected ${expected}, received ${actual}`,
            );
        }
        checksum = updateChecksum(checksum, actual);
    }
    return checksum;
}

function validationSequence(createValue) {
    return Array.from(
        { length: VALIDATION_SEQUENCE_LENGTH },
        (_, index) => createValue(index),
    );
}

function toPairPlanes(vector) {
    const bits = vector.toBits();
    let values = 0;
    let unknowns = 0;
    for (let index = 0; index < bits.length; index += 1) {
        const shift = bits.length - index - 1;
        const mask = (1 << shift) >>> 0;
        if (bits[index] === '1' || bits[index] === 'z') values |= mask;
        if (bits[index] === 'x' || bits[index] === 'z') unknowns |= mask;
    }
    return { values: values >>> 0, unknowns: unknowns >>> 0 };
}

function packSymbols(bits) {
    const packed = new Uint8Array(Math.ceil(bits.length / 4));
    for (let index = 0; index < bits.length; index += 1) {
        const code = '01xz'.indexOf(bits[bits.length - index - 1]);
        packed[Math.floor(index / 4)] |= code << ((index % 4) * 2);
    }
    return packed;
}

function createPackedAndTable() {
    const table = new Uint8Array(256 * 256);
    for (let left = 0; left < 256; left += 1) {
        for (let right = 0; right < 256; right += 1) {
            let output = 0;
            for (let shift = 0; shift < 8; shift += 2) {
                const leftBit = (left >>> shift) & 3;
                const rightBit = (right >>> shift) & 3;
                const result = leftBit === 0 || rightBit === 0
                    ? 0
                    : leftBit === 1 && rightBit === 1 ? 1 : 2;
                output |= result << shift;
            }
            table[left * 256 + right] = output;
        }
    }
    return table;
}

function wideSplitPlanes(bits) {
    const values = new Uint32Array(Math.ceil(bits.length / 32));
    const unknowns = new Uint32Array(values.length);
    for (let index = 0; index < bits.length; index += 1) {
        const state = bits[bits.length - index - 1];
        const word = Math.floor(index / 32);
        const mask = (1 << (index % 32)) >>> 0;
        if (state === '1' || state === 'z') values[word] |= mask;
        if (state === 'x' || state === 'z') unknowns[word] |= mask;
    }
    return { values, unknowns };
}

function interleavePlanes(split) {
    const interleaved = new Uint32Array(split.values.length * 2);
    for (let index = 0; index < split.values.length; index += 1) {
        interleaved[index * 2] = split.values[index];
        interleaved[index * 2 + 1] = split.unknowns[index];
    }
    return interleaved;
}

function equalBytes(left, right) {
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

function vectorStateChecksum(vector) {
    const bits = vector.toBits();
    return stateChecksum(bits.length, bitIndex => (
        '01xz'.indexOf(bits[bits.length - bitIndex - 1])
    ));
}

function pairStateChecksum(width, values, unknowns) {
    return stateChecksum(width, bitIndex => (
        (((unknowns >>> bitIndex) & 1) << 1)
        | ((values >>> bitIndex) & 1)
    ));
}

function packedStateChecksum(width, packed) {
    return stateChecksum(width, bitIndex => (
        (packed[Math.floor(bitIndex / 4)] >>> ((bitIndex % 4) * 2)) & 3
    ));
}

function splitStateChecksum(width, values, unknowns) {
    return stateChecksum(width, bitIndex => {
        const word = Math.floor(bitIndex / 32);
        const offset = bitIndex % 32;
        return (
            (((unknowns[word] >>> offset) & 1) << 1)
            | ((values[word] >>> offset) & 1)
        );
    });
}

function interleavedStateChecksum(width, interleaved) {
    return stateChecksum(width, bitIndex => {
        const word = Math.floor(bitIndex / 32);
        const offset = bitIndex % 32;
        return (
            (((interleaved[word * 2 + 1] >>> offset) & 1) << 1)
            | ((interleaved[word * 2] >>> offset) & 1)
        );
    });
}

function stateChecksum(width, stateAt) {
    let checksum = CHECKSUM_SEED;
    for (let bitIndex = 0; bitIndex < width; bitIndex += 1) {
        checksum = updateChecksum(checksum, stateAt(bitIndex));
    }
    return checksum;
}

function updateChecksum(checksum, value) {
    return Math.imul((checksum ^ value) >>> 0, CHECKSUM_PRIME) >>> 0;
}

function parseArguments(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 2) {
        const option = argv[index];
        const value = argv[index + 1];
        if (option !== '--iterations' && option !== '--wide-iterations') {
            throw new Error(`Unknown option: ${option}`);
        }
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${option}`);
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            throw new Error(`${option} must be a positive safe integer`);
        }
        values[option] = parsed;
    }
    return {
        iterations: values['--iterations'] ?? 1_000_000,
        wideIterations: values['--wide-iterations'] ?? 100_000,
    };
}
