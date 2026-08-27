import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

test('four-state microbenchmark emits representation-only JSON without thresholds', () => {
    const packageRoot = path.resolve(__dirname, '../..');
    const stdout = execFileSync(process.execPath, [
        path.join(packageRoot, 'benchmark', 'fourStateVector.mjs'),
        '--iterations', '1000',
        '--wide-iterations', '100',
    ], {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 30_000,
    });
    const report = JSON.parse(stdout);

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'representation-comparison');
    assert.equal(report.configuration.iterations, 1_000);
    assert.equal(report.configuration.wideIterations, 100);
    assert.equal(report.thresholds, undefined);
    assert.deepEqual(report.validation, {
        preflight: 'passed',
        checksum: 'fnv1a32-four-state-lsb-first',
        sequenceLength: 4,
    });
    assert.doesNotMatch(stdout, /vvp|iverilog/i);
    const expectedChecksums: Record<string, number> = {
        'scalar-assignment': 3_901_539_589,
        'vector32-assignment': 3_890_037_745,
        'vector32-bitwise-and': 1_402_237_297,
        'vector32-case-equality': 4_234_786_711,
        'vector1024-copy': 1_981_420_529,
    };
    assert.deepEqual(
        new Set(report.results.map((result: { operation: string }) => result.operation)),
        new Set([
            'scalar-assignment',
            'vector32-assignment',
            'vector32-bitwise-and',
            'vector32-case-equality',
            'vector1024-copy',
        ]),
    );
    assert.equal(report.results.some(
        (result: { variant: string }) => result.variant === 'four-state-scratch',
    ), true);
    assert.equal(report.results.some(
        (result: { variant: string }) => result.variant === 'paired-mask',
    ), true);
    assert.equal(report.results.some(
        (result: { variant: string }) => result.variant === 'packed-symbol',
    ), true);
    assert.equal(report.results.some(
        (result: { variant: string }) => result.variant === 'split-limbs',
    ), true);
    assert.equal(report.results.some(
        (result: { variant: string }) => result.variant === 'interleaved-limbs',
    ), true);
    for (const result of report.results) {
        assert.equal(Number.isSafeInteger(result.iterations), true);
        assert.equal(Number.isFinite(result.totalMs), true);
        assert.equal(result.totalMs >= 0, true);
        assert.equal(Number.isFinite(result.nanosecondsPerOperation), true);
        assert.equal(result.nanosecondsPerOperation >= 0, true);
        assert.equal(result.validationIterations, 4);
        assert.equal(result.checksum, expectedChecksums[result.operation]);
    }
});
