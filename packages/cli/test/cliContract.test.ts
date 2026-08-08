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
        || ['-h', '--help', '-v', '--version'].includes(command)
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

function normalize(value: unknown, replacements: Array<[string, string]>): unknown {
    if (typeof value === 'string') {
        let result = value;
        for (const [source, token] of replacements) {
            const variants = [source, source.split(path.sep).join('/'), source.replace(/\//g, '\\')];
            for (const variant of new Set(variants)) {
                result = result.split(variant).join(token);
                const encoded = JSON.stringify(variant).slice(1, -1);
                result = result.split(encoded).join(token);
            }
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

assert.equal(configurationCases.length, 53);

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
            const environment: CliEnvironment = {
                cwd,
                homeDir,
                stdout: text => { stdout += text; },
                stderr: text => { stderr += text; },
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
                process_calls: [],
                popen_calls: [],
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
