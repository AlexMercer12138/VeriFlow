import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
