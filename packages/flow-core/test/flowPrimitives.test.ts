import assert from 'node:assert/strict';
import test from 'node:test';

import { LogParser } from '@veriflow/flow-core/logParser';
import { relativeDisplayPath } from '@veriflow/flow-core/pathStyle';
import { TemplateEngine } from '@veriflow/flow-core/templateEngine';
import {
    DependencyResult,
    formatDuplicateSummary,
    SimulatorConfig,
} from '@veriflow/flow-core/types';

test('log parser preserves current simulator diagnostic behavior', () => {
    const parser = new LogParser();
    const entries = parser.parse([
        'rtl/top.v:12: error: broken expression',
        'WARNING: inferred latch',
        'build completed',
        '',
    ].join('\n'));

    assert.deepEqual(entries, [
        {
            level: 'ERROR',
            message: 'broken expression',
            fileRef: 'rtl/top.v',
            lineNo: 12,
        },
        {
            level: 'WARNING',
            message: 'inferred latch',
            fileRef: undefined,
            lineNo: undefined,
        },
        { level: 'INFO', message: 'build completed' },
    ]);
    assert.equal(parser.hasErrors('tool error without a location'), true);
    assert.equal(parser.hasErrors('WARNING: caution'), false);
});

test('template engine preserves placeholders, quoting, and command names', () => {
    assert.equal(
        TemplateEngine.render('{known}:{known}:{unknown}', { known: 'value' }),
        'value:value:{unknown}'
    );
    assert.equal(
        TemplateEngine.renderCompile(
            'compile -o {output} {files} -top {top_module}',
            'top.out',
            ['rtl/child.v', 'rtl/top.v'],
            'top'
        ),
        'compile -o top.out "rtl/child.v" "rtl/top.v" -top top'
    );
    assert.equal(TemplateEngine.renderRun('run {output}', 'top.out'), 'run top.out');
    assert.equal(
        TemplateEngine.renderWave('viewer "{wave_file}"', 'waves/top.vcd'),
        'viewer "waves/top.vcd"'
    );
});

test('path display remains host neutral for POSIX, drive, and UNC paths', () => {
    assert.equal(
        relativeDisplayPath('/workspace/project', '/workspace/project/rtl/top.sv'),
        'rtl/top.sv'
    );
    assert.equal(
        relativeDisplayPath('D:\\work\\project', 'D:/work/project/rtl/top.sv'),
        'rtl/top.sv'
    );
    assert.equal(
        relativeDisplayPath(
            '\\\\server\\share\\project',
            '\\\\server\\share\\project\\rtl\\top.sv'
        ),
        'rtl/top.sv'
    );
    assert.equal(
        relativeDisplayPath('D:\\work\\project', 'E:\\shared\\alu.sv'),
        'E:/shared/alu.sv'
    );
    assert.equal(
        relativeDisplayPath('/workspace/project', '/workspace/shared/alu.sv'),
        '/workspace/shared/alu.sv'
    );
    assert.equal(
        relativeDisplayPath(
            '/workspace/project',
            '/workspace/shared/alu.sv',
            { allowOutsideRoot: true }
        ),
        '../shared/alu.sv'
    );
});

test('shared types and duplicate summary preserve their public shape', () => {
    const simulator: SimulatorConfig = {
        name: 'fake',
        compileCmd: 'compile',
        runCmd: 'run',
    };
    const dependency: DependencyResult = {
        topModule: 'top',
        topDefinitionKey: 'module:top',
        files: ['top.v'],
        missingModules: [],
        ambiguousModules: {},
        moduleMap: { top: 'top.v' },
        depGraph: { top: [] },
    };
    assert.equal(simulator.name, 'fake');
    assert.equal(dependency.topModule, 'top');

    assert.deepEqual(formatDuplicateSummary([
        {
            name: 'alu',
            definitions: [
                { uri: 'file:///b/alu.sv', declarationLine: 3 },
                { uri: 'file:///a/alu.sv', declarationLine: 1 },
            ],
        },
    ]), {
        outputLines: [
            '  alu: file:///a/alu.sv:1',
            '  alu: file:///b/alu.sv:3',
        ],
        statusText: '$(warning) VeriFlow: 1 duplicate module name',
        popupMessage: undefined,
    });
});
