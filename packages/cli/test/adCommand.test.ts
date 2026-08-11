import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArchDesignRtlMarker } from '@veriflow/schematic-core/arch-design';

import { type CliEnvironment, runCli } from '../src/main';

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

function archDesign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 1,
        module: 'soc_top',
        ports: [],
        instances: [{ name: 'u_leaf', module: 'leaf' }],
        connections: [],
        interfaceConnections: [],
        defaults: {},
        export: {},
        presentation: {},
        ...overrides,
    };
}

function writeFixture(cwd: string, relativePath: string, content: string): void {
    const filepath = path.join(cwd, relativePath);
    mkdirSync(path.dirname(filepath), { recursive: true });
    writeFileSync(filepath, content, 'utf8');
}

function writeDesign(
    cwd: string,
    design: Record<string, unknown> = archDesign()
): void {
    writeFixture(cwd, 'design/soc.ad', `${JSON.stringify(design, null, 2)}\n`);
}

async function invoke(
    argv: string[],
    cwd: string,
    homeDir = path.join(cwd, 'home')
): Promise<RunResult> {
    let stdout = '';
    let stderr = '';
    const environment: CliEnvironment = {
        cwd,
        homeDir,
        stdout: text => { stdout += text; },
        stderr: text => { stderr += text; },
    };
    return {
        exitCode: await runCli(argv, environment),
        stdout,
        stderr,
    };
}

async function withTemporaryDirectory(
    run: (directory: string) => Promise<void>
): Promise<void> {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-ad-'));
    try {
        await run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('validates a standalone Arch Design against HDL beside the design', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.sv', 'module leaf; endmodule\n');

        const result = await invoke(['ad', 'validate', 'design/soc.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'Arch Design: OK\n',
            stderr: '',
        });
    });
});

test('uses source, global, and comma-separated libraries for standalone validation', async () => {
    await withTemporaryDirectory(async cwd => {
        const homeDir = path.join(cwd, 'home');
        writeDesign(cwd, archDesign({
            instances: [
                { name: 'u_source', module: 'source_leaf' },
                { name: 'u_global', module: 'global_leaf' },
                { name: 'u_extra', module: 'extra_leaf' },
            ],
        }));
        writeFixture(cwd, 'design/source_leaf.sv', 'module source_leaf; endmodule\n');
        writeFixture(cwd, 'global-lib/global_leaf.sv', 'module global_leaf; endmodule\n');
        writeFixture(cwd, 'extra-lib/extra_leaf.sv', 'module extra_leaf; endmodule\n');
        writeFixture(cwd, 'not-a-directory', 'ignored\n');
        writeFixture(
            homeDir,
            '.veriflow_config.json',
            `${JSON.stringify({ lib_dirs: ['global-lib'] })}\n`
        );

        const result = await invoke([
            'ad',
            'validate',
            'design/soc.ad',
            '-L',
            'extra-lib,missing-lib,not-a-directory,extra-lib',
        ], cwd, homeDir);

        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'Arch Design: OK\n',
            stderr: '',
        });
    });
});

test('resolves project and library catalogs without mutating the project', async () => {
    await withTemporaryDirectory(async cwd => {
        const homeDir = path.join(cwd, 'home');
        writeDesign(cwd, archDesign({
            instances: [
                { name: 'u_root', module: 'root_leaf' },
                { name: 'u_project', module: 'project_leaf' },
                { name: 'u_global', module: 'global_leaf' },
                { name: 'u_extra', module: 'extra_leaf' },
            ],
        }));
        writeFixture(cwd, 'project-root/root_leaf.sv', 'module root_leaf; endmodule\n');
        writeFixture(cwd, 'project-library/project_leaf.sv', 'module project_leaf; endmodule\n');
        writeFixture(cwd, 'global-library/global_leaf.sv', 'module global_leaf; endmodule\n');
        writeFixture(cwd, 'extra-a/extra_leaf.sv', 'module extra_leaf; endmodule\n');
        writeFixture(
            homeDir,
            '.veriflow_config.json',
            `${JSON.stringify({ lib_dirs: ['global-library', 'missing-global-library'] })}\n`
        );
        const projectSource = `{
  "project_name": "catalog-fixture",
  "project_root": "project-root",
  "lib_dirs": ["project-library", "missing-project-library"],
  "fixture_metadata": { "preserve": true }
}\n`;
        writeFixture(cwd, 'project.json', projectSource);
        const originalProject = readFileSync(path.join(cwd, 'project.json'), 'utf8');

        const result = await invoke([
            'ad',
            'validate',
            'design/soc.ad',
            '--project',
            'project.json',
            '--lib',
            'extra-a,extra-b',
        ], cwd, homeDir);

        assert.equal(readFileSync(path.join(cwd, 'project.json'), 'utf8'), originalProject);
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'Arch Design: OK\n',
            stderr: '',
        });
    });
});

test('excludes the design source directory from project-mode catalogs', async () => {
    await withTemporaryDirectory(async cwd => {
        writeFixture(
            cwd,
            'design/source-only.ad',
            `${JSON.stringify(archDesign({
                instances: [{ name: 'u_source', module: 'source_only_leaf' }],
            }), null, 2)}\n`
        );
        writeFixture(
            cwd,
            'design/source_only_leaf.sv',
            'module source_only_leaf; endmodule\n'
        );
        writeFixture(cwd, 'project-root/root_leaf.sv', 'module root_leaf; endmodule\n');
        writeFixture(cwd, 'project.json', `${JSON.stringify({
            project_name: 'source-exclusion',
            project_root: 'project-root',
            lib_dirs: [],
        })}\n`);

        const result = await invoke([
            'ad', 'validate', 'design/source-only.ad', '--project', 'project.json',
        ], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'design/source-only.ad:$.instances[0].module [AD_MODULE_UNRESOLVED] '
                + 'No module definition is named source_only_leaf\n',
        });
    });
});

test('reports a missing project before scanning module catalogs', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.sv', 'module leaf; endmodule\n');

        const result = await invoke([
            'ad', 'validate', 'design/soc.ad', '--project', 'missing/project.json',
        ], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'Error: Project file not found: missing/project.json\n',
        });
    });
});

test('deduplicates repeated and overlapping project catalog roots', async () => {
    await withTemporaryDirectory(async cwd => {
        const homeDir = path.join(cwd, 'home');
        writeDesign(cwd);
        writeFixture(cwd, 'hdl/nested/leaf.sv', 'module leaf; endmodule\n');
        writeFixture(cwd, 'project.json', `${JSON.stringify({
            project_name: 'overlapping-roots',
            project_root: 'hdl',
            lib_dirs: ['hdl', 'hdl/nested'],
        })}\n`);
        writeFixture(
            homeDir,
            '.veriflow_config.json',
            `${JSON.stringify({ lib_dirs: ['hdl/nested', 'hdl'] })}\n`
        );

        const result = await invoke([
            'ad',
            'validate',
            'design/soc.ad',
            '--project',
            'project.json',
            '-L',
            'hdl,hdl/nested,missing-library',
        ], cwd, homeDir);

        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'Arch Design: OK\n',
            stderr: '',
        });
    });
});

test('reports a missing standalone Arch Design through the CLI error boundary', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'validate', 'design/missing.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'Error: Arch Design file not found: design/missing.ad\n',
        });
    });
});

test('reports invalid Arch Design JSON without scanning HDL', async () => {
    await withTemporaryDirectory(async cwd => {
        writeFixture(cwd, 'design/soc.ad', '{\n');
        writeFixture(cwd, 'design/broken.sv', 'this is not HDL\n');

        const result = await invoke(['ad', 'validate', 'design/soc.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'design/soc.ad:$ [AD_JSON_SYNTAX] Arch Design is not valid JSON\n',
        });
    });
});

test('uses an absolute diagnostic path for a design outside the working directory', async () => {
    await withTemporaryDirectory(async directory => {
        const cwd = path.join(directory, 'workspace');
        const designPath = path.join(directory, 'outside', 'soc.ad');
        mkdirSync(cwd, { recursive: true });
        writeFixture(directory, 'outside/soc.ad', '{\n');

        const result = await invoke(['ad', 'validate', designPath], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: `${designPath.replace(/\\/g, '/')}:$ [AD_JSON_SYNTAX] `
                + 'Arch Design is not valid JSON\n',
        });
    });
});

test('reports unsupported Arch Design schemas as a CLI diagnostic', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd, archDesign({ schemaVersion: 2 }));

        const result = await invoke(['ad', 'validate', 'design/soc.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'design/soc.ad:$.schemaVersion [AD_SCHEMA_UNSUPPORTED] '
                + 'Arch Design schema version 2 is not supported\n',
        });
    });
});

test('reports an unresolved instance module', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);

        const result = await invoke(['ad', 'validate', 'design/soc.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'design/soc.ad:$.instances[0].module [AD_MODULE_UNRESOLVED] '
                + 'No module definition is named leaf\n',
        });
    });
});

test('reports duplicate module definitions as ambiguous', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.sv', 'module leaf; endmodule\n');
        writeFixture(cwd, 'design/duplicate/leaf.sv', 'module leaf; endmodule\n');

        const result = await invoke(['ad', 'validate', 'design/soc.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'design/soc.ad:$.instances[0].module [AD_MODULE_AMBIGUOUS] '
                + 'More than one module definition is named leaf\n',
        });
    });
});

test('reports semantic instance-port errors from the shared resolver', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd, archDesign({
            connections: [{
                name: 'missing_port',
                endpoints: [{ kind: 'instance', instance: 'u_leaf', port: 'missing' }],
            }],
        }));
        writeFixture(cwd, 'design/leaf.sv', 'module leaf(output logic data); endmodule\n');

        const result = await invoke(['ad', 'validate', 'design/soc.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'design/soc.ad:$.connections[0].endpoints[0].port [AD_ENDPOINT_UNKNOWN] '
                + 'Module leaf has no port named missing\n',
        });
    });
});

test('exports Verilog beside the Arch Design by default', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');
        const designPath = path.join(cwd, 'design/soc.ad');
        const originalDesign = readFileSync(designPath, 'utf8');

        const result = await invoke(['ad', 'export', 'design/soc.ad'], cwd);

        const outputPath = path.join(cwd, 'design/soc.v');
        const rtl = readFileSync(outputPath, 'utf8');
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'RTL exported: design/soc.v\n',
            stderr: '',
        });
        assert.equal(parseArchDesignRtlMarker(rtl)?.language, 'verilog');
        assert.equal(readFileSync(designPath, 'utf8'), originalDesign);
    });
});

test('resolves design export.output relative to the Arch Design directory', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd, archDesign({ export: { output: 'rtl/by-design.v' } }));
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');

        const result = await invoke(['ad', 'export', 'design/soc.ad'], cwd);

        const outputPath = path.join(cwd, 'design/rtl/by-design.v');
        const rtl = readFileSync(outputPath, 'utf8');
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'RTL exported: design/rtl/by-design.v\n',
            stderr: '',
        });
        assert.equal(parseArchDesignRtlMarker(rtl)?.language, 'verilog');
        assert.ok(rtl.includes('// vik-veriflow:source "../soc.ad"'));
        assert.equal(existsSync(path.join(cwd, 'design/soc.v')), false);
    });
});

test('resolves CLI output relative to cwd and prefers it over design output', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd, archDesign({ export: { output: 'ignored/by-design.v' } }));
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');

        const result = await invoke([
            'ad', 'export', 'design/soc.ad', '--output', 'generated/by-cli.v',
        ], cwd);

        const outputPath = path.join(cwd, 'generated/by-cli.v');
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'RTL exported: generated/by-cli.v\n',
            stderr: '',
        });
        assert.notEqual(parseArchDesignRtlMarker(readFileSync(outputPath, 'utf8')), undefined);
        assert.equal(existsSync(path.join(cwd, 'design/ignored/by-design.v')), false);
    });
});

test('exports SystemVerilog to a sibling .sv file when requested', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.sv', 'module leaf; endmodule\n');

        const result = await invoke([
            'ad', 'export', 'design/soc.ad', '--language', 'systemverilog',
        ], cwd);

        const outputPath = path.join(cwd, 'design/soc.sv');
        const rtl = readFileSync(outputPath, 'utf8');
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'RTL exported: design/soc.sv\n',
            stderr: '',
        });
        assert.equal(parseArchDesignRtlMarker(rtl)?.language, 'systemverilog');
        assert.equal(existsSync(path.join(cwd, 'design/soc.v')), false);
    });
});

test('prefers CLI language over design export.language', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd, archDesign({
            export: { language: 'systemverilog', output: 'cli-language-wins.v' },
        }));
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');

        const result = await invoke([
            'ad', 'export', 'design/soc.ad', '--language', 'verilog',
        ], cwd);

        const outputPath = path.join(cwd, 'design/cli-language-wins.v');
        const rtl = readFileSync(outputPath, 'utf8');
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'RTL exported: design/cli-language-wins.v\n',
            stderr: '',
        });
        assert.equal(parseArchDesignRtlMarker(rtl)?.language, 'verilog');
    });
});

test('matches Verilog and SystemVerilog output extensions case-insensitively', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');
        const cases = [
            { language: 'verilog', output: 'generated/verilog.V' },
            { language: 'systemverilog', output: 'generated/systemverilog.SV' },
        ] as const;

        for (const item of cases) {
            const result = await invoke([
                'ad', 'export', 'design/soc.ad',
                '--language', item.language,
                '-o', item.output,
            ], cwd);
            const rtl = readFileSync(path.join(cwd, item.output), 'utf8');

            assert.deepEqual(result, {
                exitCode: 0,
                stdout: `RTL exported: ${item.output}\n`,
                stderr: '',
            });
            assert.equal(parseArchDesignRtlMarker(rtl)?.language, item.language);
        }
    });
});

test('rejects mismatched and missing extensions before creating output directories', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        const cases = [
            {
                output: 'mismatched/output.sv',
                stderr: 'Error: Output file extension must be .v for verilog: '
                    + 'mismatched/output.sv\n',
            },
            {
                output: 'missing-extension/output',
                stderr: 'Error: Output file extension must be .v for verilog: '
                    + 'missing-extension/output\n',
            },
        ];

        for (const item of cases) {
            const result = await invoke([
                'ad', 'export', 'design/soc.ad', '-o', item.output,
            ], cwd);

            assert.deepEqual(result, {
                exitCode: 1,
                stdout: '',
                stderr: item.stderr,
            });
            assert.equal(existsSync(path.dirname(path.join(cwd, item.output))), false);
        }
    });
});

test('preserves an existing generated target when export semantics are invalid', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');
        const first = await invoke(['ad', 'export', 'design/soc.ad'], cwd);
        assert.equal(first.exitCode, 0);
        const outputPath = path.join(cwd, 'design/soc.v');
        const original = readFileSync(outputPath, 'utf8');
        assert.notEqual(parseArchDesignRtlMarker(original), undefined);
        writeDesign(cwd, archDesign({
            instances: [{ name: 'u_missing', module: 'missing_leaf' }],
        }));

        const result = await invoke(['ad', 'export', 'design/soc.ad'], cwd);

        assert.deepEqual(result, {
            exitCode: 1,
            stdout: '',
            stderr: 'design/soc.ad:$.instances[0].module [AD_MODULE_UNRESOLVED] '
                + 'No module definition is named missing_leaf\n',
        });
        assert.equal(readFileSync(outputPath, 'utf8'), original);
    });
});

test('replaces a valid prior generated target', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');
        const outputPath = path.join(cwd, 'design/soc.v');
        const first = await invoke(['ad', 'export', 'design/soc.ad'], cwd);
        assert.equal(first.exitCode, 0);
        const original = readFileSync(outputPath, 'utf8');
        const originalMarker = parseArchDesignRtlMarker(original);
        assert.notEqual(originalMarker, undefined);
        writeDesign(cwd, archDesign({ module: 'updated_top' }));

        const result = await invoke(['ad', 'export', 'design/soc.ad'], cwd);

        const replacement = readFileSync(outputPath, 'utf8');
        const replacementMarker = parseArchDesignRtlMarker(replacement);
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: 'RTL exported: design/soc.v\n',
            stderr: '',
        });
        assert.notEqual(replacement, original);
        assert.notEqual(replacementMarker, undefined);
        assert.notEqual(replacementMarker?.fingerprint, originalMarker?.fingerprint);
        assert.ok(replacement.includes('module updated_top;'));
    });
});

test('refuses handwritten, malformed-marker, and non-leading-marker targets', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');
        const outputPath = path.join(cwd, 'design/soc.v');
        const initial = await invoke(['ad', 'export', 'design/soc.ad'], cwd);
        assert.equal(initial.exitCode, 0);
        const generated = readFileSync(outputPath, 'utf8');
        assert.notEqual(parseArchDesignRtlMarker(generated), undefined);
        const fixtures = [
            'module handwritten;\nendmodule\n',
            generated.replace('schema=1', 'schema=invalid'),
            `\n${generated}`,
        ];
        assert.deepEqual(fixtures.map(parseArchDesignRtlMarker), [
            undefined, undefined, undefined,
        ]);

        for (const fixture of fixtures) {
            writeFileSync(outputPath, fixture, 'utf8');

            const result = await invoke(['ad', 'export', 'design/soc.ad'], cwd);

            assert.deepEqual(result, {
                exitCode: 1,
                stdout: '',
                stderr: `Error: Generated file conflict: ${outputPath}\n`,
            });
            assert.equal(readFileSync(outputPath, 'utf8'), fixture);
        }
    });
});

test('creates a missing explicit output parent after successful generation', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd);
        writeFixture(cwd, 'design/leaf.v', 'module leaf; endmodule\n');
        const output = 'generated/nested/soc.v';
        const outputDirectory = path.join(cwd, 'generated/nested');
        assert.equal(existsSync(outputDirectory), false);

        const result = await invoke([
            'ad', 'export', 'design/soc.ad', '--output', output,
        ], cwd);

        assert.deepEqual(result, {
            exitCode: 0,
            stdout: `RTL exported: ${output}\n`,
            stderr: '',
        });
        assert.notEqual(
            parseArchDesignRtlMarker(readFileSync(path.join(cwd, output), 'utf8')),
            undefined
        );
    });
});

test('exports scanned module ports with a portable source comment and named mappings', async () => {
    await withTemporaryDirectory(async cwd => {
        writeDesign(cwd, archDesign({
            ports: [
                { name: 'request', direction: 'input' },
                { name: 'response', direction: 'output' },
            ],
            connections: [{
                name: 'request',
                endpoints: [
                    { kind: 'port', port: 'request' },
                    { kind: 'instance', instance: 'u_leaf', port: 'data_i' },
                ],
            }, {
                name: 'response',
                endpoints: [
                    { kind: 'instance', instance: 'u_leaf', port: 'data_o' },
                    { kind: 'port', port: 'response' },
                ],
            }],
        }));
        writeFixture(cwd, 'design/leaf.v', [
            'module leaf(',
            '    input wire data_i,',
            '    output wire data_o',
            ');',
            'endmodule',
            '',
        ].join('\n'));
        const output = 'generated/rtl/soc.v';

        const result = await invoke([
            'ad', 'export', 'design/soc.ad', '-o', output,
        ], cwd);

        const rtl = readFileSync(path.join(cwd, output), 'utf8');
        assert.deepEqual(result, {
            exitCode: 0,
            stdout: `RTL exported: ${output}\n`,
            stderr: '',
        });
        assert.notEqual(parseArchDesignRtlMarker(rtl), undefined);
        assert.equal(rtl.startsWith('// vik-veriflow:generated arch-design '), true);
        assert.ok(rtl.includes('// vik-veriflow:source "../../design/soc.ad"'));
        assert.ok(rtl.includes([
            'leaf u_leaf (',
            '    .data_i(__vf_net_request),',
            '    .data_o(__vf_net_response)',
            ');',
        ].join('\n')));
    });
});
