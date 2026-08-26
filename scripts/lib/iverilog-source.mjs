import { execFileSync } from 'node:child_process';
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_TEXT = /\b(?:example|placeholder|todo)\b/i;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

function isRepeatedPlaceholder(revision) {
    for (const width of [1, 2, 4, 5, 8, 10, 20]) {
        if (revision === revision.slice(0, width).repeat(40 / width)) return true;
    }
    return false;
}

function requireRegularFile(filepath, label) {
    const stats = lstatSync(filepath);
    if (stats.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link: ${filepath}`);
    }
    if (!stats.isFile()) {
        throw new Error(`${label} must be a regular file: ${filepath}`);
    }
}

function normalizeRepository(repository) {
    const value = typeof repository === 'string' ? repository : repository?.url;
    if (typeof value !== 'string') return undefined;
    return value.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '');
}

function validateRepository(value) {
    if (PLACEHOLDER_TEXT.test(value)) {
        throw new Error('Icarus source repository must not be a placeholder');
    }
    let repository;
    try {
        repository = new URL(value);
    } catch {
        throw new Error('Icarus source repository must be a valid HTTPS URL');
    }
    if (
        repository.protocol !== 'https:'
        || repository.username !== ''
        || repository.password !== ''
        || repository.search !== ''
        || repository.hash !== ''
    ) {
        throw new Error('Icarus source repository must be a credential-free HTTPS URL');
    }
    return repository.href.replace(/\/$/, '').replace(/\.git$/, '');
}

export function parseIverilogSource(source) {
    const repositoryMatches = [...source.matchAll(/^- Repository:\s*(\S+)\s*$/gm)];
    if (repositoryMatches.length !== 1) {
        throw new Error('Icarus SOURCE.md must contain exactly one repository');
    }
    const revisionMatches = [...source.matchAll(/^- Git revision:\s*`([^`]+)`\s*$/gm)];
    if (revisionMatches.length !== 1) {
        throw new Error('Icarus SOURCE.md must contain exactly one Git revision');
    }
    const repository = validateRepository(repositoryMatches[0][1]);
    const revision = revisionMatches[0][1];
    if (
        !REVISION_PATTERN.test(revision)
        || isRepeatedPlaceholder(revision)
        || PLACEHOLDER_TEXT.test(revision)
    ) {
        throw new Error('Icarus source revision must be an exact non-placeholder 40-character lowercase hex revision');
    }
    return { repository, revision };
}

export function readIverilogSource({ packageRoot, expectedName, expectedVersion }) {
    if (!path.isAbsolute(packageRoot) || path.normalize(packageRoot) !== packageRoot) {
        throw new Error('Icarus package root must be an absolute normalized path without traversal');
    }
    const rootStats = lstatSync(packageRoot);
    if (rootStats.isSymbolicLink()) {
        throw new Error(`Icarus package root must not be a symbolic link: ${packageRoot}`);
    }
    if (!rootStats.isDirectory()) {
        throw new Error(`Icarus package root must be a directory: ${packageRoot}`);
    }
    const manifestFile = path.join(packageRoot, 'package.json');
    const distRoot = path.join(packageRoot, 'dist');
    const distStats = lstatSync(distRoot);
    if (distStats.isSymbolicLink()) {
        throw new Error(`Icarus package dist directory must not be a symbolic link: ${distRoot}`);
    }
    if (!distStats.isDirectory()) {
        throw new Error(`Icarus package dist path must be a directory: ${distRoot}`);
    }
    const sourceFile = path.join(distRoot, 'SOURCE.md');
    requireRegularFile(manifestFile, 'Icarus package manifest');
    requireRegularFile(sourceFile, 'Icarus source metadata');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (manifest.name !== expectedName) {
        throw new Error(`Icarus package name mismatch: expected ${expectedName}, received ${manifest.name}`);
    }
    if (manifest.version !== expectedVersion) {
        throw new Error(`Icarus package version mismatch: expected ${expectedVersion}, received ${manifest.version}`);
    }
    const source = parseIverilogSource(readFileSync(sourceFile, 'utf8'));
    if (normalizeRepository(manifest.repository) !== source.repository) {
        throw new Error('Icarus SOURCE.md repository does not match package metadata repository');
    }
    return {
        packageRoot,
        packageName: manifest.name,
        packageVersion: manifest.version,
        ...source,
        sourceFile,
    };
}

function run(command, args, options = {}) {
    try {
        return execFileSync(command, args, {
            cwd: options.cwd,
            env: options.environment,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stdout = error.stdout?.toString() ?? '';
        const stderr = error.stderr?.toString() ?? '';
        throw new Error(`${command} failed\n${stdout}${stderr}`);
    }
}

function removeGitMetadata(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filepath = path.join(directory, entry.name);
        if (entry.name === '.git') {
            rmSync(filepath, { recursive: true, force: true });
        } else if (entry.isDirectory()) {
            removeGitMetadata(filepath);
        }
    }
}

export function createIverilogSourceArchive({
    packageRoot,
    expectedName,
    expectedVersion,
    destination,
    environment = process.env,
}) {
    const provenance = readIverilogSource({
        packageRoot,
        expectedName,
        expectedVersion,
    });
    const destinationRoot = path.resolve(destination);
    mkdirSync(destinationRoot, { recursive: true });
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'iverilog-source-archive-'));
    const archiveName = `iverilog-wasm-source-${provenance.revision}`;
    const checkoutRoot = path.join(temporaryRoot, archiveName);
    const archivePath = path.join(destinationRoot, `${archiveName}.tar.gz`);
    const publicationRoot = mkdtempSync(path.join(destinationRoot, '.iverilog-source-publish-'));
    const stagedArchivePath = path.join(publicationRoot, path.basename(archivePath));
    try {
        run('git', [
            '-c', 'remote.origin.tagOpt=--no-tags',
            'clone', '--no-tags', '--no-checkout',
            provenance.repository, checkoutRoot,
        ], { environment });
        run('git', [
            '-c', 'remote.origin.tagOpt=--no-tags',
            'fetch', '--no-tags', 'origin', provenance.revision,
        ], { cwd: checkoutRoot, environment });
        const objectType = run('git', ['cat-file', '-t', provenance.revision], {
            cwd: checkoutRoot,
            environment,
        }).trim();
        if (objectType !== 'commit') {
            throw new Error(`Icarus source revision object type must be commit, received ${objectType}`);
        }
        run('git', ['checkout', '--detach', provenance.revision], {
            cwd: checkoutRoot,
            environment,
        });
        const checkedOutRevision = run('git', ['rev-parse', 'HEAD'], {
            cwd: checkoutRoot,
            environment,
        }).trim();
        if (checkedOutRevision !== provenance.revision) {
            throw new Error(`Icarus source checkout revision mismatch: expected ${provenance.revision}, received ${checkedOutRevision}`);
        }
        run('git', [
            'submodule', 'update', '--init', '--recursive', '--no-recommend-shallow',
        ], { cwd: checkoutRoot, environment });
        removeGitMetadata(checkoutRoot);
        run('tar', [
            '--sort=name',
            '--mtime=@0',
            '--owner=0',
            '--group=0',
            '--numeric-owner',
            '-czf', stagedArchivePath,
            '-C', temporaryRoot,
            archiveName,
        ], {
            environment,
        });
        renameSync(stagedArchivePath, archivePath);
        return archivePath;
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
        rmSync(publicationRoot, { recursive: true, force: true });
    }
}

function parseOptions(args, command) {
    const known = new Set(['--package-root', '--expected-version', '--destination']);
    const allowed = command === 'archive'
        ? known
        : new Set(['--package-root', '--expected-version']);
    const options = new Map();
    for (let index = 1; index < args.length; index += 2) {
        const name = args[index];
        if (!known.has(name)) throw new Error(`Unknown option: ${name}`);
        if (!allowed.has(name)) throw new Error(`Option ${name} is not valid for ${command}`);
        if (options.has(name)) throw new Error(`Duplicate option: ${name}`);
        const value = args[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for option: ${name}`);
        }
        options.set(name, value);
    }
    for (const name of allowed) {
        if (!options.has(name)) throw new Error(`Missing required option: ${name}`);
    }
    return options;
}

export function runIverilogSourceCli(args) {
    const command = args[0];
    if (command !== 'validate' && command !== 'archive') {
        throw new Error('Usage: iverilog-source.mjs <validate|archive> --package-root PATH --expected-version VERSION [--destination PATH]');
    }
    const options = parseOptions(args, command);
    const packageRoot = path.resolve(options.get('--package-root'));
    const expectedVersion = options.get('--expected-version');
    if (command === 'validate') {
        return readIverilogSource({
            packageRoot,
            expectedName: '@veriflow/iverilog-wasm',
            expectedVersion,
        });
    }
    return createIverilogSourceArchive({
        packageRoot,
        expectedName: '@veriflow/iverilog-wasm',
        expectedVersion,
        destination: options.get('--destination'),
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        const result = runIverilogSourceCli(process.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
