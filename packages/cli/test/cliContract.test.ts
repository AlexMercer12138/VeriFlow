import assert from 'node:assert/strict';
import {
    chmodSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CommandExecutor, ProcessExecution } from '@veriflow/flow-core/simulation';
import type { WaveViewerLauncher } from '../src/commands/wave';
import { CliEnvironment, runCli } from '../src/main';

type JsonObject = Record<string, unknown>;

type ContractFile = {
    path: string;
    fixture?: string;
    content?: string;
    json?: unknown;
    mode?: string;
};

type ContractCase = {
    id: string;
    argv: string[];
    cwd: string;
    initial_files: ContractFile[];
    process_results?: Array<{
        exit_code: number;
        stdout: string;
        stderr: string;
        elapsed: number;
    }>;
    observe_json: string[];
    expected: JsonObject;
};

const repositoryRoot = path.resolve(__dirname, '../../../..');
const fixtureRoot = path.join(repositoryRoot, 'tests', 'cli_contract', 'fixtures');
const contract = JSON.parse(readFileSync(
    path.join(repositoryRoot, 'tests', 'cli_contract', 'cases.json'),
    'utf8'
)) as { cases: ContractCase[] };

const configurationCases = contract.cases.filter(contractCase => {
    const command = contractCase.argv[0];
    return contractCase.argv.length === 0
        || command === 'project'
        || command === 'lib'
        || command === 'top'
        || command === 'analyze'
        || command === 'sim'
        || command === 'wave'
        || ['-h', '--help', '-v', '--version'].includes(command)
        || contractCase.id.startsWith('help_')
        || contractCase.id === 'unknown_command';
});

function replaceTokens(value: unknown, tokens: Record<string, string>): unknown {
    if (typeof value === 'string') {
        let result = value;
        for (const [token, replacement] of Object.entries(tokens)) {
            result = result.split(token).join(replacement);
        }
        return result;
    }
    if (Array.isArray(value)) return value.map(item => replaceTokens(item, tokens));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(
            ([key, item]) => [key, replaceTokens(item, tokens)]
        ));
    }
    return value;
}

function writeInitialFiles(
    caseRoot: string,
    files: ContractFile[],
    tokens: Record<string, string>
): void {
    for (const entry of files) {
        const destination = path.join(caseRoot, entry.path);
        mkdirSync(path.dirname(destination), { recursive: true });
        if (entry.fixture) {
            copyFileSync(path.join(fixtureRoot, entry.fixture), destination);
        } else if (entry.json !== undefined) {
            writeFileSync(
                destination,
                JSON.stringify(replaceTokens(entry.json, tokens), null, 2),
                'utf8'
            );
        } else {
            writeFileSync(
                destination,
                replaceTokens(entry.content ?? '', tokens) as string,
                'utf8'
            );
        }
        if (entry.mode && process.platform !== 'win32') {
            chmodSync(destination, Number.parseInt(entry.mode, 8));
        }
    }
}

function observedJson(caseRoot: string, paths: string[]): JsonObject {
    return Object.fromEntries(paths.map(relative => {
        const filepath = path.join(caseRoot, relative);
        try {
            return [relative, JSON.parse(readFileSync(filepath, 'utf8'))];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [relative, null];
            throw error;
        }
    }));
}

function observedText(caseRoot: string, paths: string[]): JsonObject {
    return Object.fromEntries(paths.map(relative => {
        const filepath = path.join(caseRoot, relative);
        try {
            return [relative, readFileSync(filepath, 'utf8')];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [relative, null];
            throw error;
        }
    }));
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTokenizedPathTails(value: string, token: string): string {
    const pattern = new RegExp(`${escapeRegExp(token)}(/[^"'\\s:,)\\]}]*)`, 'g');
    return value.replace(pattern, (_match, tail: string) => (
        token + tail.replace(/\\\\/g, '/').replace(/\\/g, '/')
    ));
}

function normalize(value: unknown, replacements: Array<[string, string]>): unknown {
    if (typeof value === 'string') {
        let result = value;
        for (const [source, replacement] of replacements) {
            const encodedReplacement = JSON.stringify(replacement).slice(1, -1);
            const variants = [
                source,
                source.replace(/\\/g, '/'),
                source.replace(/\//g, '\\'),
            ];
            for (const variant of new Set(variants)) {
                const encodedVariant = JSON.stringify(variant).slice(1, -1);
                const forms: Array<[string, string, string[]]> = [
                    [encodedVariant, encodedReplacement, ['/', '\\\\']],
                    [variant, replacement, ['/', '\\']],
                ];
                for (const [candidate, normalized, separators] of forms) {
                    for (const separator of separators) {
                        result = result
                            .split(candidate + separator)
                            .join(`${normalized}/`);
                    }
                    const boundary = new RegExp(
                        `${escapeRegExp(candidate)}(?=$|[\\s"',)\\]}])`,
                        'g'
                    );
                    result = result.replace(boundary, normalized);
                }
            }
            result = normalizeTokenizedPathTails(result, replacement);
            result = normalizeTokenizedPathTails(result, encodedReplacement);
        }
        return result;
    }
    if (Array.isArray(value)) return value.map(item => normalize(item, replacements));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(
            ([key, item]) => [key, normalize(item, replacements)]
        ));
    }
    return value;
}

test('contract normalization handles Windows separators without replacing lookalikes', () => {
    const value = {
        stdout: 'Root: C:\\contract\\workspace\\libs\\project\n',
        observedText: '"lib_dirs": ["C:\\\\contract\\\\workspace\\\\libs\\\\project"]',
        metadata: String.raw`pattern=\d+\w; source=rtl\top.v`,
        lookalike: String.raw`C:\contract\workspace-old`,
        diagnostic: (
            'C:\\contract\\workspace\\libs\\project: '
            + String.raw`escaped=\signal regex=\d+\w`
        ),
    };

    assert.deepEqual(normalize(value, [[String.raw`C:\contract\workspace`, '<CWD>']]), {
        stdout: 'Root: <CWD>/libs/project\n',
        observedText: '"lib_dirs": ["<CWD>/libs/project"]',
        metadata: String.raw`pattern=\d+\w; source=rtl\top.v`,
        lookalike: String.raw`C:\contract\workspace-old`,
        diagnostic: String.raw`<CWD>/libs/project: escaped=\signal regex=\d+\w`,
    });
});

test('project new persists builtin simulation defaults', async () => {
    const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-node-cli-project-new-'));
    const cwd = path.join(caseRoot, 'workspace');
    const homeDir = path.join(caseRoot, 'home');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    try {
        let stdout = '';
        let stderr = '';
        const exitCode = await runCli(
            ['project', 'new', '--name', 'builtin-demo'],
            {
                cwd,
                homeDir,
                stdout: text => { stdout += text; },
                stderr: text => { stderr += text; },
            }
        );
        const project = JSON.parse(readFileSync(
            path.join(cwd, 'builtin-demo.json'),
            'utf8'
        ));

        assert.equal(exitCode, 0);
        assert.equal(stdout, 'Project created: builtin-demo.json\n');
        assert.equal(stderr, '');
        assert.equal(project.simulator, 'builtin');
        assert.deepEqual(project.defines, {});
        assert.deepEqual(project.simulation_files, []);
        assert.deepEqual(project.simulators.iverilog, {
            compile_cmd: 'iverilog -o "{output}" {files}',
            run_cmd: 'vvp "{output}"',
        });
        assert.deepEqual(project.simulators['native-iverilog'], {
            compile_cmd: (
                'iverilog -g2005 -o "{output}" '
                + '{defines} {include_dirs} {files}'
            ),
            run_cmd: 'vvp "{output}"',
        });
    } finally {
        rmSync(caseRoot, { recursive: true, force: true });
    }
});

assert.equal(configurationCases.length, 78);

for (const contractCase of configurationCases) {
    test(contractCase.id, async () => {
        const caseRoot = mkdtempSync(path.join(os.tmpdir(), 'veriflow-node-cli-'));
        const cwd = path.join(caseRoot, contractCase.cwd || 'workspace');
        const homeDir = path.join(caseRoot, 'home');
        mkdirSync(cwd, { recursive: true });
        mkdirSync(homeDir, { recursive: true });
        const tokens = {
            '<CASE_ROOT>': caseRoot,
            '<CWD>': cwd,
            '<HOME>': homeDir,
        };
        try {
            writeInitialFiles(caseRoot, contractCase.initial_files ?? [], tokens);
            let stdout = '';
            let stderr = '';
            const processCalls: Array<{
                cmd: string;
                cwd: string;
                timeout: number;
            }> = [];
            const processResults = [...(contractCase.process_results ?? [])];
            const popenCalls: Array<{
                cmd: string;
                shell: boolean;
                kwargs: Record<string, unknown>;
            }> = [];
            const commandExecutor: CommandExecutor = {
                execute(command, processCwd, timeoutSeconds): Promise<ProcessExecution> {
                    processCalls.push({
                        cmd: command,
                        cwd: processCwd,
                        timeout: timeoutSeconds,
                    });
                    const result = processResults.shift();
                    if (!result) {
                        throw new Error(`Unexpected process call: ${command}`);
                    }
                    return Promise.resolve({
                        exitCode: result.exit_code,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        elapsedTime: result.elapsed,
                    });
                },
            };
            const waveViewerLauncher: WaveViewerLauncher = {
                openBuiltin(): Promise<void> {
                    popenCalls.push({ cmd: '', shell: true, kwargs: {} });
                    return Promise.resolve();
                },
                openExternal(command): Promise<void> {
                    popenCalls.push({ cmd: command, shell: true, kwargs: {} });
                    return Promise.resolve();
                },
            };
            const environment: CliEnvironment = {
                cwd,
                homeDir,
                stdout: text => { stdout += text; },
                stderr: text => { stderr += text; },
                commandExecutor,
                waveViewerLauncher,
            };
            const exitCode = await runCli(
                replaceTokens(contractCase.argv, tokens) as string[],
                environment
            );
            const actual = normalize({
                exit_code: exitCode,
                stdout,
                stderr,
                observed_json: observedJson(caseRoot, contractCase.observe_json ?? []),
                observed_text: observedText(caseRoot, contractCase.observe_json ?? []),
                process_calls: processCalls,
                popen_calls: popenCalls,
            }, [
                [cwd, '<CWD>'],
                [homeDir, '<HOME>'],
                [caseRoot, '<CASE_ROOT>'],
            ]);
            assert.deepEqual(actual, contractCase.expected);
        } finally {
            rmSync(caseRoot, { recursive: true, force: true });
        }
    });
}
