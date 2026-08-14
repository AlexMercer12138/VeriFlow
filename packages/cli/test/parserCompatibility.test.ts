import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CliEnvironment, runCli } from '../src/main';

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

async function invoke(argv: string[], cwd: string): Promise<RunResult> {
    let stdout = '';
    let stderr = '';
    const environment: CliEnvironment = {
        cwd,
        homeDir: path.join(cwd, 'home'),
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
    const directory = mkdtempSync(path.join(os.tmpdir(), 'veriflow-cli-parser-'));
    try {
        await run(directory);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('accepts a long option value joined with equals', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '--name=equals'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'Project created: equals.json\n');
        assert.equal(result.stderr, '');
        assert.equal(existsSync(path.join(cwd, 'equals.json')), true);
    });
});

test('accepts a value attached to a short option', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '-nattached'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'Project created: attached.json\n');
        assert.equal(result.stderr, '');
        assert.equal(existsSync(path.join(cwd, 'attached.json')), true);
    });
});

test('accepts an unambiguous long option abbreviation', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '--nam', 'abbreviated'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, 'Project created: abbreviated.json\n');
        assert.equal(result.stderr, '');
        assert.equal(existsSync(path.join(cwd, 'abbreviated.json')), true);
    });
});

test('rejects an option-like separated value', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['project', 'new', '-n', '-dash'], cwd);

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow project new [-h] -n NAME [-r ROOT] [-t TOP] [-L LIB] [-s SIM]
                            [-w WAVE] [--output OUTPUT]
veriflow project new: error: argument -n/--name: expected one argument
`);
        assert.equal(existsSync(path.join(cwd, '-dash.json')), false);
    });
});

test('shows Arch Design parent help', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', '--help'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, `usage: veriflow ad [-h] ACTION ...

positional arguments:
  ACTION
    new       create an Arch Design
    validate  validate an Arch Design
    export    export an Arch Design to RTL

options:
  -h, --help  show this help message and exit
`);
        assert.equal(result.stderr, '');
    });
});

test('shows Arch Design creation options in leaf help', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'new', '--help'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, `usage: veriflow ad new [-h] [-o OUTPUT] MODULE

positional arguments:
  MODULE                generated top module name

options:
  -h, --help            show this help message and exit
  -o, --output OUTPUT   output Arch Design file
`);
        assert.equal(result.stderr, '');
    });
});

test('requires a module for Arch Design creation', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'new'], cwd);

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow ad new [-h] [-o OUTPUT] MODULE
veriflow ad new: error: the following arguments are required: MODULE
`);
    });
});

test('accepts Arch Design creation output aliases', async () => {
    await withTemporaryDirectory(async cwd => {
        const short = await invoke(['ad', 'new', 'short_top', '-odesign/short'], cwd);
        const long = await invoke([
            'ad', 'new', '--output=design/long.AD', 'long_top',
        ], cwd);

        assert.equal(short.exitCode, 0);
        assert.equal(long.exitCode, 0);
        assert.equal(existsSync(path.join(cwd, 'design/short.ad')), true);
        assert.equal(existsSync(path.join(cwd, 'design/long.AD')), true);
    });
});

test('requires a design for Arch Design validation', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'validate'], cwd);

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow ad validate [-h] [-p PROJECT] [-L LIB] DESIGN
veriflow ad validate: error: the following arguments are required: DESIGN
`);
    });
});

test('rejects an unsupported Arch Design export language', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(
            ['ad', 'export', 'soc.ad', '--language', 'vhdl'],
            cwd
        );

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow ad export [-h] [-p PROJECT] [-L LIB] [-o OUTPUT]
                          [--language {verilog,systemverilog}] DESIGN
veriflow ad export: error: argument --language: invalid choice: 'vhdl' (choose from verilog, systemverilog)
`);
    });
});

test('requires a design for Arch Design export after parsing options', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'export', '--language', 'verilog'], cwd);

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow ad export [-h] [-p PROJECT] [-L LIB] [-o OUTPUT]
                          [--language {verilog,systemverilog}] DESIGN
veriflow ad export: error: the following arguments are required: DESIGN
`);
    });
});

test('shows only Arch Design validation options in leaf help', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'validate', '--help'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, `usage: veriflow ad validate [-h] [-p PROJECT] [-L LIB] DESIGN

positional arguments:
  DESIGN                Arch Design file

options:
  -h, --help            show this help message and exit
  -p, --project PROJECT
                        project JSON file
  -L, --lib LIB         additional library directory
`);
        assert.equal(result.stderr, '');
    });
});

test('shows only Arch Design export options in leaf help', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'export', '--help'], cwd);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, `usage: veriflow ad export [-h] [-p PROJECT] [-L LIB] [-o OUTPUT]
                          [--language {verilog,systemverilog}] DESIGN

positional arguments:
  DESIGN                Arch Design file

options:
  -h, --help            show this help message and exit
  -p, --project PROJECT
                        project JSON file
  -L, --lib LIB         additional library directory
  -o, --output OUTPUT   output RTL file
  --language {verilog,systemverilog}
                        output language
`);
        assert.equal(result.stderr, '');
    });
});

const missingArchDesignError = 'Error: Arch Design file not found: soc.ad\n';

for (const { name, argv } of [
    {
        name: 'before the design positional',
        argv: [
            'ad', 'export',
            '--project', 'project.json',
            '--lib', 'libs',
            '--output', 'soc.v',
            '--language', 'verilog',
            'soc.ad',
        ],
    },
    {
        name: 'after the design positional',
        argv: [
            'ad', 'export', 'soc.ad',
            '--project', 'project.json',
            '--lib', 'libs',
            '--output', 'soc.sv',
            '--language', 'systemverilog',
        ],
    },
]) {
    test(`accepts Arch Design export options ${name}`, async () => {
        await withTemporaryDirectory(async cwd => {
            const result = await invoke(argv, cwd);

            assert.equal(result.exitCode, 1);
            assert.equal(result.stdout, '');
            assert.equal(result.stderr, missingArchDesignError);
        });
    });
}

test('accepts Arch Design export short aliases and attached values', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(
            ['ad', 'export', '-p', 'project.json', '-Llibs', '-o', 'soc.v', 'soc.ad'],
            cwd
        );

        assert.equal(result.exitCode, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, missingArchDesignError);
    });
});

test('rejects an ambiguous Arch Design export long option', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'export', 'soc.ad', '--l', 'libs'], cwd);

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow ad export [-h] [-p PROJECT] [-L LIB] [-o OUTPUT]
                          [--language {verilog,systemverilog}] DESIGN
veriflow ad export: error: ambiguous option: --l could match --lib, --language
`);
    });
});

test('rejects an extra Arch Design export positional', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(['ad', 'export', 'soc.ad', 'extra.ad'], cwd);

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow ad export [-h] [-p PROJECT] [-L LIB] [-o OUTPUT]
                          [--language {verilog,systemverilog}] DESIGN
veriflow ad export: error: unrecognized arguments: extra.ad
`);
    });
});

test('rejects an export-only option during Arch Design validation', async () => {
    await withTemporaryDirectory(async cwd => {
        const result = await invoke(
            ['ad', 'validate', 'soc.ad', '--output', 'soc.v'],
            cwd
        );

        assert.equal(result.exitCode, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `usage: veriflow ad validate [-h] [-p PROJECT] [-L LIB] DESIGN
veriflow ad validate: error: unrecognized arguments: --output
`);
    });
});
