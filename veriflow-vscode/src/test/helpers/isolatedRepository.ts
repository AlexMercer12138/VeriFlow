import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type PathSnapshot = Readonly<{
    target: string;
    entries: readonly string[];
}>;

export type IsolatedRepository = Readonly<{
    temporaryRoot: string;
    repositoryRoot: string;
    dispose(): void;
}>;

function isInside(parent: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative !== ''
        && !path.isAbsolute(relative)
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`);
}

function hashFile(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshotEntries(target: string): string[] {
    if (!fs.existsSync(target)) return ['<missing>'];
    const entries: string[] = [];
    const visit = (candidate: string): void => {
        const details = fs.lstatSync(candidate);
        const relative = path.relative(target, candidate) || '.';
        if (details.isSymbolicLink()) {
            entries.push([
                relative,
                'symlink',
                details.mtimeMs,
                fs.readlinkSync(candidate),
            ].join('|'));
            return;
        }
        if (details.isDirectory()) {
            entries.push([relative, 'directory', details.mtimeMs].join('|'));
            for (const child of fs.readdirSync(candidate).sort()) {
                visit(path.join(candidate, child));
            }
            return;
        }
        entries.push([
            relative,
            'file',
            details.size,
            details.mtimeMs,
            hashFile(candidate),
        ].join('|'));
    };
    visit(target);
    return entries;
}

export function snapshotRepositoryPaths(targets: readonly string[]): PathSnapshot[] {
    return targets.map(target => ({
        target: path.resolve(target),
        entries: snapshotEntries(path.resolve(target)),
    }));
}

export function assertRepositoryPathsUnchanged(snapshots: readonly PathSnapshot[]): void {
    for (const snapshot of snapshots) {
        assert.deepStrictEqual(
            snapshotEntries(snapshot.target),
            snapshot.entries,
            `${snapshot.target} changed while an isolated build test was running`
        );
    }
}

function shouldCopy(repositoryRoot: string, source: string): boolean {
    const relative = path.relative(repositoryRoot, source);
    if (!relative) return true;
    const segments = relative.split(path.sep);
    if (segments.some(segment => ['.git', '.artifacts', 'node_modules'].includes(segment))) {
        return false;
    }
    if (segments[0] === 'web-dist') {
        return false;
    }
    if (segments.some(segment => ['dist', 'dist-test', 'out'].includes(segment))) {
        return false;
    }
    return !(segments[0] === 'veriflow-vscode'
        && segments[1] === 'media'
        && ['schematic', 'waveform'].includes(segments[2] ?? ''));
}

function linkDirectory(source: string, destination: string): void {
    fs.symlinkSync(
        path.resolve(source),
        destination,
        process.platform === 'win32' ? 'junction' : 'dir'
    );
}

type WorkspacePackage = Readonly<{
    name: string;
    root: string;
}>;

function workspacePackages(fixtureRoot: string): WorkspacePackage[] {
    const packageRoots = [
        ...fs.readdirSync(path.join(fixtureRoot, 'packages'), { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => path.join(fixtureRoot, 'packages', entry.name)),
        path.join(fixtureRoot, 'veriflow-vscode'),
    ];
    return packageRoots.flatMap(packageRoot => {
        const manifestPath = path.join(packageRoot, 'package.json');
        if (!fs.existsSync(manifestPath)) return [];
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            name?: string;
        };
        return manifest.name ? [{ name: manifest.name, root: packageRoot }] : [];
    });
}

function linkExternalDependencies(
    installedRoot: string,
    fixtureNodeModules: string,
    workspaceNames: ReadonlySet<string>,
    scope?: string
): void {
    if (!fs.existsSync(installedRoot)) return;
    fs.mkdirSync(fixtureNodeModules, { recursive: true });
    for (const entry of fs.readdirSync(installedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = path.join(installedRoot, entry.name);
        const destination = path.join(fixtureNodeModules, entry.name);
        if (!scope && entry.name.startsWith('@')) {
            linkExternalDependencies(
                source,
                destination,
                workspaceNames,
                entry.name
            );
            continue;
        }
        const packageName = scope ? `${scope}/${entry.name}` : entry.name;
        if (workspaceNames.has(packageName)) continue;
        linkDirectory(source, destination);
    }
}

function linkInstalledDependencies(repositoryRoot: string, fixtureRoot: string): string[] {
    const installedRoot = path.join(repositoryRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    const workspaces = workspacePackages(fixtureRoot);
    const workspaceNames = new Set(workspaces.map(workspace => workspace.name));
    linkExternalDependencies(installedRoot, fixtureNodeModules, workspaceNames);
    linkExternalDependencies(
        path.join(repositoryRoot, 'veriflow-vscode', 'node_modules'),
        path.join(fixtureRoot, 'veriflow-vscode', 'node_modules'),
        workspaceNames
    );

    const fixtureScope = path.join(fixtureNodeModules, '@veriflow');
    fs.mkdirSync(fixtureScope, { recursive: true });
    const workspaceLinks: string[] = [];
    for (const workspace of workspaces) {
        if (!workspace.name.startsWith('@veriflow/')) continue;
        const workspaceLink = path.join(
            fixtureScope,
            workspace.name.slice('@veriflow/'.length)
        );
        linkDirectory(workspace.root, workspaceLink);
        workspaceLinks.push(workspaceLink);
    }
    const extensionLink = path.join(fixtureNodeModules, 'veriflow');
    linkDirectory(path.join(fixtureRoot, 'veriflow-vscode'), extensionLink);
    workspaceLinks.push(extensionLink);
    return workspaceLinks;
}

export function createIsolatedRepository(
    repositoryRoot: string,
    prefix: string
): IsolatedRepository {
    assert.match(prefix, /^[a-z0-9-]+$/);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const fixtureRoot = path.join(temporaryRoot, 'repository');
    try {
        fs.cpSync(repositoryRoot, fixtureRoot, {
            recursive: true,
            filter: source => shouldCopy(repositoryRoot, source),
        });
        assert.strictEqual(
            fs.existsSync(path.join(fixtureRoot, 'veriflow-vscode', 'node_modules')),
            false,
            'isolated repository copied nested node_modules'
        );
        const workspaceLinks = linkInstalledDependencies(repositoryRoot, fixtureRoot);
        for (const workspaceLink of workspaceLinks) {
            const linked = fs.realpathSync(workspaceLink);
            assert.ok(
                isInside(fixtureRoot, linked),
                `${workspaceLink} escaped the isolated repository: ${linked}`
            );
        }
    } catch (error) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        throw error;
    }
    return {
        temporaryRoot,
        repositoryRoot: fixtureRoot,
        dispose(): void {
            assert.ok(isInside(os.tmpdir(), temporaryRoot));
            assert.ok(path.basename(temporaryRoot).startsWith(`${prefix}-`));
            fs.rmSync(temporaryRoot, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 50,
            });
        },
    };
}
