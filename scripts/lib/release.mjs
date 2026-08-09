import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveNpmInvocation } from './npm-command.mjs';

const dependencyGroups = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
];

export class ReleaseError extends Error {}

function readJson(filepath) {
    try {
        return JSON.parse(readFileSync(filepath, 'utf8'));
    } catch (error) {
        throw new ReleaseError(`could not read JSON from ${filepath}: ${error.message}`);
    }
}

function writeJson(filepath, value) {
    writeFileSync(filepath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function packageFiles(root) {
    const files = [path.join(root, 'package.json')];
    const packagesRoot = path.join(root, 'packages');
    if (existsSync(packagesRoot)) {
        for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
            const manifest = path.join(packagesRoot, entry.name, 'package.json');
            if (entry.isDirectory() && existsSync(manifest)) {
                files.push(manifest);
            }
        }
    }
    files.push(path.join(root, 'veriflow-vscode', 'package.json'));
    return files.sort((left, right) => left.localeCompare(right));
}

export function parseVersion(version) {
    if (typeof version !== 'string') {
        throw new ReleaseError(`version must use MAJOR.MINOR.PATCH, got: ${String(version)}`);
    }
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
    if (!match) {
        throw new ReleaseError(`version must use MAJOR.MINOR.PATCH, got: ${JSON.stringify(version)}`);
    }
    return match.slice(1).map(Number);
}

export function nextPatchVersion(current) {
    const [major, minor, patchVersion] = parseVersion(current);
    return `${major}.${minor}.${patchVersion + 1}`;
}

export function ensureVersionsMatch(root) {
    const versions = packageFiles(root).map(filepath => {
        const manifest = readJson(filepath);
        if (typeof manifest.version !== 'string') {
            throw new ReleaseError(`could not read version from ${filepath}`);
        }
        return {
            name: path.relative(root, filepath).split(path.sep).join('/'),
            version: manifest.version,
        };
    });
    const unique = new Set(versions.map(entry => entry.version));
    if (unique.size !== 1) {
        const details = versions.map(entry => `  ${entry.name}: ${entry.version}`).join('\n');
        throw new ReleaseError(`version mismatch:\n${details}`);
    }
    return versions[0].version;
}

export function ensureChangelogHasVersion(root, version) {
    const changelogPath = path.join(root, 'veriflow-vscode', 'CHANGELOG.md');
    if (!existsSync(changelogPath)) {
        throw new ReleaseError(`missing VS Code changelog: ${changelogPath}`);
    }
    const changelog = readFileSync(changelogPath, 'utf8');
    const heading = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\](?:\\s+-\\s+.*)?\\s*$`, 'm');
    if (!heading.test(changelog)) {
        throw new ReleaseError(`missing changelog heading for version ${version} in ${changelogPath}`);
    }
}

function prepareContractUpdate(root, currentVersion, newVersion) {
    const filepath = path.join(root, 'tests', 'cli_contract', 'cases.json');
    const contract = readJson(filepath);
    if (!Array.isArray(contract.cases)) {
        throw new ReleaseError(`CLI contract has no cases array: ${filepath}`);
    }
    const versionCases = new Map(contract.cases
        .filter(entry => entry?.id === 'version' || entry?.id === 'version_short')
        .map(entry => [entry.id, entry]));
    for (const caseId of ['version', 'version_short']) {
        const contractCase = versionCases.get(caseId);
        if (!contractCase) {
            throw new ReleaseError(`CLI contract is missing ${caseId}: ${filepath}`);
        }
        const expectedCurrent = `VeriFlow ${currentVersion}\n`;
        if (contractCase.expected?.stdout !== expectedCurrent) {
            throw new ReleaseError(`CLI contract ${caseId} does not contain ${JSON.stringify(expectedCurrent)}`);
        }
        contractCase.expected.stdout = `VeriFlow ${newVersion}\n`;
    }
    return { filepath, contract };
}

export function updateVersionFiles(root, targetVersion) {
    const currentVersion = ensureVersionsMatch(root);
    const newVersion = targetVersion ?? nextPatchVersion(currentVersion);
    parseVersion(newVersion);

    const manifests = packageFiles(root).map(filepath => ({
        filepath,
        manifest: readJson(filepath),
    }));
    const contractUpdate = prepareContractUpdate(root, currentVersion, newVersion);

    for (const { manifest } of manifests) {
        manifest.version = newVersion;
        for (const group of dependencyGroups) {
            const dependencies = manifest[group];
            if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
                continue;
            }
            for (const dependency of Object.keys(dependencies)) {
                if (dependency.startsWith('@veriflow/')) {
                    dependencies[dependency] = newVersion;
                }
            }
        }
    }

    for (const { filepath, manifest } of manifests) {
        writeJson(filepath, manifest);
    }
    writeJson(contractUpdate.filepath, contractUpdate.contract);
    return { currentVersion, newVersion };
}

function setTargetVersion(current, candidate) {
    if (candidate === undefined) {
        return current;
    }
    parseVersion(candidate);
    if (current !== undefined && current !== candidate) {
        throw new ReleaseError(`conflicting target versions: ${current} and ${candidate}`);
    }
    return candidate;
}

export function parseArguments(argv) {
    const selected = new Set();
    let targetVersion;
    let all = false;
    let showHelp = false;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '-h' || argument === '--help') {
            showHelp = true;
            continue;
        }
        if (argument === '-c' || argument === '--check') {
            selected.add('check');
            continue;
        }
        if (argument === '-p' || argument === '--package') {
            selected.add('package');
            continue;
        }

        let action;
        let inlineVersion;
        if (argument === '-u' || argument === '--update') {
            action = 'update';
        } else if (argument.startsWith('--update=')) {
            action = 'update';
            inlineVersion = argument.slice('--update='.length);
        } else if (argument.startsWith('-u') && argument.length > 2) {
            action = 'update';
            inlineVersion = argument.slice(2);
        } else if (argument === '-a' || argument === '--all') {
            action = 'all';
        } else if (argument.startsWith('--all=')) {
            action = 'all';
            inlineVersion = argument.slice('--all='.length);
        } else if (argument.startsWith('-a') && argument.length > 2) {
            action = 'all';
            inlineVersion = argument.slice(2);
        } else {
            throw new ReleaseError(`unknown argument: ${argument}`);
        }

        let candidate = inlineVersion;
        if (candidate === undefined && argv[index + 1] && !argv[index + 1].startsWith('-')) {
            candidate = argv[index + 1];
            index += 1;
        }
        targetVersion = setTargetVersion(targetVersion, candidate);
        if (action === 'all') {
            all = true;
        } else {
            selected.add(action);
        }
    }

    const orderedActions = all
        ? ['update', 'check', 'package']
        : ['update', 'check', 'package'].filter(action => selected.has(action));
    return { actions: orderedActions, targetVersion, showHelp };
}

export const releaseUsage = `Usage: node scripts/run-release.mjs [options]\n\nOptions:\n  -c, --check             Run Node product release checks\n  -u, --update [VERSION]  Update versions; defaults to next patch\n  -p, --package           Build npm tarballs and the VSIX\n  -a, --all [VERSION]     Run update, check, then package\n  -h, --help              Show this help\n`;

export function resolveReleaseNpmInvocation(args, options = {}) {
    const nodeExecutable = options.nodeExecutable ?? process.execPath;
    const npmExecutable = options.npmExecutable ?? process.env.npm_execpath;
    if (npmExecutable) {
        return resolveNpmInvocation(args, { nodeExecutable, npmExecutable });
    }

    const platform = options.platform ?? process.platform;
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const nodeDirectory = pathApi.dirname(nodeExecutable);
    const candidates = platform === 'win32'
        ? [pathApi.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
        : [
            pathApi.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
            pathApi.resolve(nodeDirectory, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
        ];
    const fileExists = options.fileExists ?? existsSync;
    const discovered = candidates.find(candidate => fileExists(candidate));
    if (discovered) {
        return resolveNpmInvocation(args, {
            nodeExecutable,
            npmExecutable: discovered,
        });
    }
    if (platform !== 'win32') {
        return { executable: 'npm', args };
    }
    throw new ReleaseError('could not locate npm-cli.js; run this command through npm');
}

function defaultRunCommand(command, args, cwd) {
    let executable = command;
    let invocationArgs = args;
    if (command === 'npm') {
        const invocation = resolveReleaseNpmInvocation(args);
        executable = invocation.executable;
        invocationArgs = invocation.args;
    }
    const completed = spawnSync(executable, invocationArgs, {
        cwd,
        env: {
            ...process.env,
            GIT_PAGER: process.env.GIT_PAGER ?? 'cat',
            PAGER: process.env.PAGER ?? 'cat',
        },
        shell: false,
        stdio: 'inherit',
    });
    if (completed.error) {
        throw new ReleaseError(`could not run ${command}: ${completed.error.message}`);
    }
    if (completed.status !== 0) {
        throw new ReleaseError(`command failed (${completed.status}): ${command} ${args.join(' ')}`);
    }
}

export function runRelease(argv, options = {}) {
    const root = options.root ?? process.cwd();
    const log = options.log ?? (message => console.log(`[release] ${message}`));
    const runCommand = options.runCommand ?? defaultRunCommand;
    const parsed = parseArguments(argv);

    if (parsed.showHelp) {
        (options.print ?? console.log)(releaseUsage.trimEnd());
        return 0;
    }
    if (parsed.actions.length === 0) {
        (options.print ?? console.log)(releaseUsage.trimEnd());
        return 1;
    }

    const run = (command, args) => {
        log(`run: ${command} ${args.join(' ')}`);
        runCommand(command, args, root);
    };

    for (const action of parsed.actions) {
        if (action === 'update') {
            const result = updateVersionFiles(root, parsed.targetVersion);
            log(`update version: ${result.currentVersion} -> ${result.newVersion}`);
            run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
            continue;
        }

        const version = ensureVersionsMatch(root);
        log(`version: ${version}`);
        if (action === 'check') {
            ensureChangelogHasVersion(root, version);
            log(`changelog heading found: ${version}`);
            for (const [command, ...args] of [
                ['npm', 'run', 'typecheck:shared'],
                ['npm', 'run', 'test:shared'],
                ['npm', 'test', '--workspace', '@veriflow/cli'],
                ['npm', 'test', '--workspace', '@veriflow/waveform-desktop'],
                ['npm', 'test', '--workspace', 'veriflow-vscode'],
                ['npm', 'run', 'test:release'],
                ['npm', 'run', 'verify:generated'],
                ['git', '--no-pager', 'diff', '--check'],
                ['git', '--no-pager', 'status', '--short', '--branch'],
            ]) {
                run(command, args);
            }
        } else if (action === 'package') {
            run('npm', ['run', 'pack:node']);
            run('npm', ['run', 'package', '--workspace', 'veriflow-vscode']);
        }
    }
    log('done');
    return 0;
}
