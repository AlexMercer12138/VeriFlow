import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseRegressionList } from './read-iverilog-regress.mjs';

test('parses active cases and ignores commented entries and inline comments', () => {
    const manifest = parseRegressionList(`
# disabled normal ivltests
active normal ivltests # inline comment
compile_error CE ivltests
runtime_error RE contrib
compile_only CO ivltests
`);

    assert.equal(manifest.activeCount, 4);
    assert.equal(manifest.eligibleCount, 4);
    assert.deepEqual(
        manifest.cases.map(({ name, type, sourceDirectory }) => ({
            name,
            type,
            sourceDirectory,
        })),
        [
            { name: 'active', type: 'normal', sourceDirectory: 'ivltests' },
            { name: 'compile_error', type: 'CE', sourceDirectory: 'ivltests' },
            { name: 'runtime_error', type: 'RE', sourceDirectory: 'contrib' },
            { name: 'compile_only', type: 'CO', sourceDirectory: 'ivltests' },
        ],
    );
});

test('joins continuations and separates compiler options from plusargs', () => {
    const manifest = parseRegressionList(`
with_args normal,-gspecify,+first=1,\\
  -Ttyp,+second ivltests
`);

    assert.deepEqual(manifest.cases[0].compilerOptions, ['-gspecify', '-Ttyp']);
    assert.deepEqual(manifest.cases[0].plusargs, ['+first=1', '+second']);
});

test('parses gold files, source directories, and top modules', () => {
    const manifest = parseRegressionList(`
gold_case normal contrib gold=gold_case.gold
top_case normal ivltests test
top_gold normal ivltests shellho gold=shellho.gold
`);

    assert.deepEqual(manifest.cases[0].comparison, {
        kind: 'gold',
        path: 'gold/gold_case.gold',
    });
    assert.equal(manifest.cases[1].topModule, 'test');
    assert.equal(manifest.cases[2].topModule, 'shellho');
    assert.deepEqual(manifest.cases[2].comparison, {
        kind: 'gold',
        path: 'gold/shellho.gold',
    });
});

test('excludes every explicit non-Verilog-2005 generation with its reason', () => {
    const manifest = parseRegressionList(`
default normal ivltests
explicit_2005 normal,-g2005 ivltests
sv normal,-g2005-sv ivltests
legacy normal,-g2001 ivltests
old CE,-g1995 ivltests
noconfig normal,-g2001-noconfig ivltests
short_1995 normal,-g1 ivltests
short_2001 normal,-g2 ivltests
`);

    assert.equal(manifest.activeCount, 8);
    assert.equal(manifest.eligibleCount, 2);
    assert.deepEqual(
        manifest.exclusions.map(({ name, reason }) => ({ name, reason })),
        [
            { name: 'sv', reason: 'explicit non-Verilog-2005 generation: -g2005-sv' },
            { name: 'legacy', reason: 'explicit non-Verilog-2005 generation: -g2001' },
            { name: 'old', reason: 'explicit non-Verilog-2005 generation: -g1995' },
            {
                name: 'noconfig',
                reason: 'explicit non-Verilog-2005 generation: -g2001-noconfig',
            },
            {
                name: 'short_1995',
                reason: 'explicit non-Verilog-2005 generation: -g1',
            },
            {
                name: 'short_2001',
                reason: 'explicit non-Verilog-2005 generation: -g2',
            },
        ],
    );
});

test('manifest contains source references but never copied HDL source', () => {
    const manifest = parseRegressionList('sample normal ivltests\n');

    assert.equal(manifest.cases[0].source, 'ivltests/sample.v');
    assert.equal('sourceText' in manifest.cases[0], false);
    assert.equal(JSON.stringify(manifest).includes('module sample'), false);
});

test('assigns deterministic case IDs after detecting duplicate names', () => {
    const manifest = parseRegressionList(`
unique normal ivltests
duplicate normal ivltests
duplicate normal,-g2005-sv ivltests
`);

    assert.equal(manifest.activeCount, 3);
    assert.equal(manifest.eligibleCount, 2);
    assert.deepEqual(
        manifest.cases.map(({ name, caseId }) => ({ name, caseId })),
        [
            { name: 'unique', caseId: 'unique' },
            { name: 'duplicate', caseId: 'duplicate#1' },
            { name: 'duplicate', caseId: 'duplicate#2' },
        ],
    );
    assert.deepEqual(manifest.exclusions, [{
        name: 'duplicate',
        caseId: 'duplicate#2',
        reason: 'explicit non-Verilog-2005 generation: -g2005-sv',
        generation: '-g2005-sv',
    }]);
});

test('pinned corpus retains both occurrences of each duplicate case name', {
    skip: process.env.IVERILOG_ROOT === undefined
        ? 'set IVERILOG_ROOT to a checkout containing the pinned commit'
        : false,
}, async () => {
    const revision = JSON.parse(await readFile(
        new URL('../../tools/simulation/iverilog-revision.json', import.meta.url),
        'utf8',
    ));
    const sourceText = execFileSync(
        'git',
        ['show', `${revision.revision}:ivtest/regress-vlg.list`],
        { cwd: process.env.IVERILOG_ROOT, encoding: 'utf8' },
    );
    const manifest = parseRegressionList(sourceText);

    assert.equal(manifest.activeCount, 1766);
    assert.equal(manifest.eligibleCount, 1758);
    assert.equal(manifest.exclusions.length, 8);
    assert.deepEqual(
        manifest.exclusions
            .filter(exclusion => ['scope2b', 'pr1077'].includes(exclusion.name))
            .map(({ name, generation, reason }) => ({ name, generation, reason })),
        [
            {
                name: 'pr1077',
                generation: '-g2',
                reason: 'explicit non-Verilog-2005 generation: -g2',
            },
            {
                name: 'scope2b',
                generation: '-g1',
                reason: 'explicit non-Verilog-2005 generation: -g1',
            },
        ],
    );
    assert.equal(new Set(manifest.cases.map(testCase => testCase.caseId)).size, 1766);
    assert.deepEqual(
        manifest.cases
            .filter(testCase => ['pr2792897', 'pr2849783'].includes(testCase.name))
            .map(({ name, caseId }) => ({ name, caseId })),
        [
            { name: 'pr2792897', caseId: 'pr2792897#1' },
            { name: 'pr2792897', caseId: 'pr2792897#2' },
            { name: 'pr2849783', caseId: 'pr2849783#1' },
            { name: 'pr2849783', caseId: 'pr2849783#2' },
        ],
    );
});
