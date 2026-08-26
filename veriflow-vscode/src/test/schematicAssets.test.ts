import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { build, type BuildOptions } from 'esbuild';
import { rename as renameFile } from 'fs/promises';

type PackageNotice = {
    name: string;
    version: string;
    license: string;
    licenseText: string;
    provenanceText?: string;
};

type RuntimePackage = {
    packageRoot: string;
    mode: number;
    directories: Array<{ relativePath: string; mode: number }>;
    files: Array<{ relativePath: string; source: string; mode: number }>;
    notice: PackageNotice;
};

type BuildSupport = {
    collectBundledPackageLicenses(
        metafile: { inputs: Record<string, unknown> },
        sourceRoot: string
    ): Promise<PackageNotice[]>;
    formatThirdPartyNotices(
        parserPackages: PackageNotice[],
        frontendPackages: PackageNotice[]
    ): string;
    collectRuntimePackage(
        packageRoot: string,
        expectations: {
            name: string;
            version: string;
            license: string;
            nodeEngine: string;
            entry: string;
            declaredFiles: string[];
            requiredFiles: string[];
            nonemptyFiles: string[];
            provenanceFile: string;
        }
    ): Promise<RuntimePackage>;
    copyRuntimePackage(
        runtimePackage: RuntimePackage,
        destination: string,
        fileSystem?: {
            mkdtemp?(prefix: string): Promise<string>;
            rename?(source: string, destination: string): Promise<void>;
            remove?(
                target: string,
                options: { recursive: boolean; force: boolean }
            ): Promise<void>;
        }
    ): Promise<void>;
};

type BrowserBuildConfig = {
    browserBuildOptions(): BuildOptions;
};

const extensionRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const schematicSourceRoot = path.join(
    repositoryRoot,
    'packages',
    'schematic-webview',
    'src'
);
const webDistRoot = path.join(repositoryRoot, 'web-dist', 'schematic');
const loadEsmModule = new Function(
    'specifier',
    'return import(specifier);'
) as <T>(specifier: string) => Promise<T>;

function sha256(value: Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

function ignored(patterns: string, relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    let result = false;
    for (const line of patterns.split(/\r?\n/)) {
        const rawPattern = line.trim();
        if (!rawPattern || rawPattern.startsWith('#')) continue;
        const negated = rawPattern.startsWith('!');
        const pattern = negated ? rawPattern.slice(1) : rawPattern;
        let matches = false;
        if (pattern === 'webview/**') {
            matches = normalized.startsWith('webview/');
        } else if (pattern === 'media/waveform/**') {
            matches = normalized.startsWith('media/waveform/');
        } else if (pattern === 'media/schematic/**') {
            matches = normalized.startsWith('media/schematic/');
        } else if (pattern === '**/*.ts') {
            matches = normalized.endsWith('.ts');
        } else if (pattern === '**/*.map') {
            matches = normalized.endsWith('.map');
        } else {
            matches = pattern === normalized;
        }
        if (matches) result = !negated;
    }
    return result;
}

function typeScriptFiles(root: string): string[] {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) return typeScriptFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    });
}

function makeTreeWritableForCleanup(root: string): void {
    let details: fs.Stats;
    try {
        details = fs.lstatSync(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) return;
    fs.chmodSync(root, details.mode | 0o700);
    for (const entry of fs.readdirSync(root)) {
        makeTreeWritableForCleanup(path.join(root, entry));
    }
}

function sourceSection(
    source: string,
    startMarker: string,
    endMarker: string,
    description: string
): string {
    const start = source.indexOf(startMarker);
    assert.notStrictEqual(start, -1, `${description} is missing ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notStrictEqual(end, -1, `${description} is missing ${endMarker}`);
    return source.slice(start, end);
}

function assertCanonicalSegmentRendering(source: string): void {
    const renderer = sourceSection(
        source,
        'function renderNetworks(',
        '\nconst selection =',
        'network renderer'
    );
    const segmentLoop = sourceSection(
        renderer,
        'networkRoute.segments.forEach((segment, index) => {',
        '\n    renderModel.junctions.forEach',
        'canonical segment loop'
    );
    assert.strictEqual(
        segmentLoop.match(/\bgraph\.addEdge\(/g)?.length ?? 0,
        1,
        'each canonical segment loop must contain exactly one graph.addEdge call'
    );
    assert.match(
        segmentLoop,
        /const \[source, target] = segmentEndpoints\(segment\);[^]*graph\.addEdge\(\{[^]*\n\s+source,\n\s+target,/,
        'canonical segments must render with point source and target endpoints'
    );
    assert.doesNotMatch(segmentLoop, /\bvertices:\s*|\brouter:\s*/);
    assert.doesNotMatch(segmentLoop, /\blabels:\s*/);
    assert.doesNotMatch(source, /function labelForSegment\(/);
}

function assertRendererCellContracts(source: string): void {
    const nodeRenderer = sourceSection(
        source,
        'function createRenderedNode(',
        '\nfunction segmentEndpoints(',
        'node renderer'
    );
    assert.match(nodeRenderer, /objectId: model\.id,[^]*objectType: 'node',[^]*node: model,/);
    assert.match(nodeRenderer, /zIndex: 2,/);

    const networkRenderer = sourceSection(
        source,
        'function renderNetworks(',
        '\nconst selection =',
        'network renderer'
    );
    const segmentLoop = sourceSection(
        networkRenderer,
        'networkRoute.segments.forEach((segment, index) => {',
        '\n    renderModel.junctions.forEach',
        'canonical segment loop'
    );
    assert.match(
        segmentLoop,
        /data: \{\s*objectId: network\.id,\s*objectType: 'network',\s*network,\s*networkRoute,\s*} satisfies CellData/
    );
    assert.match(segmentLoop, /zIndex: 0,/);

    const junctionLoop = networkRenderer.slice(networkRenderer.indexOf(
        'renderModel.junctions.forEach'
    ));
    assert.match(
        junctionLoop,
        /data: \{\s*objectId: network\.id,\s*objectType: 'network',\s*network,\s*networkRoute,\s*junction: true,\s*} satisfies CellData/
    );
    assert.doesNotMatch(junctionLoop, /interacting:/);
    assert.match(
        junctionLoop,
        /tabindex: 0,[^]*role: 'link',[^]*'aria-label': `network junction: \$\{network\.name\}`/
    );
    assert.doesNotMatch(junctionLoop, /aria-hidden: 'true'|pointerEvents: 'none'/);
    const selectionOptions = sourceSection(
        source,
        'const selection = new Selection({',
        '\n});\n\nconst graph =',
        'selection options'
    );
    assert.match(selectionOptions, /showEdgeSelectionBox: false,/);
    assert.match(
        selectionOptions,
        /filter: cell => cellData\(cell\)\?\.objectType === 'node'[^]*cellData\(cell\)\?\.junction !== true,/
    );
    assert.match(
        source,
        /nodeMovable: view => cellData\(view\.cell\)\?\.junction !== true,/
    );
}

function assertNetworkSelectionContracts(source: string): void {
    assert.doesNotMatch(source, /function expandNetworkSelection\(/);
    assert.match(source, /let selectedNetworkId: string \| undefined;/);
    assert.match(source, /function selectNetwork\(/);

    const styling = sourceSection(
        source,
        'function refreshNetworkSelectionStyles(',
        '\nfunction descriptionFor(',
        'network selection styling'
    );
    assert.match(styling, /const selected = data\.objectId === selectedNetworkId;/);
    assert.match(styling, /graph\.findViewByCell\(cell\)/);
    assert.match(styling, /veriflow-network-selected/);
    assert.match(styling, /veriflow-network-search-match/);

    const status = sourceSection(
        source,
        'function updateSelectionStatus(',
        '\nfunction navigationTargetForCell(',
        'selection status update'
    );
    assert.match(status, /selectedNetworkId/);
    assert.match(status, /const itemsByObjectId = new Map<string,/);
    assert.match(status, /summarizeSchematicSelection\(\[\.\.\.itemsByObjectId\.values\(\)]\)/);
    assert.match(source, /graph\.on\('edge:click'/);
    assert.match(source, /graph\.on\('node:click'/);
    assert.match(source, /graph\.on\('blank:click'/);
}

function assertAdapterSearchContract(source: string): void {
    assert.match(source, /network\?: SchematicNetwork;/, 'CellData must retain the raw network');
    const search = sourceSection(
        source,
        'function searchText(',
        '\nfunction collectSearchMatches(',
        'network search text'
    );
    assert.match(search, /data\.networkRoute\?\.displayName \?\? data\.network\?\.name/);
    assert.match(search, /data\.network\?\.adapterLabel \?\? ''/);
}

function assertNetworkNavigationContract(source: string): void {
    const target = sourceSection(
        source,
        'function navigationTargetForCell(',
        '\nfunction updateViewportFromGraph(',
        'cell navigation target'
    );
    assert.match(target, /return data\?\.node \?\? data\?\.network \?\? \{};/);
    assert.match(
        source,
        /graph\.on\('cell:dblclick', \(\{ cell }\) => \{\s*const command = navigationCommandForCell\(navigationTargetForCell\(cell\), false\);/
    );
}

async function testLicenseFailure(support: BuildSupport): Promise<void> {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-license-'));
    try {
        const packageRoot = path.join(fixtureRoot, 'node_modules', 'fixture-package');
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'package.json'),
            JSON.stringify({ name: 'fixture-package', version: '1.0.0', license: 'MIT' })
        );
        fs.writeFileSync(path.join(packageRoot, 'index.js'), 'export const value = 1;\n');

        await assert.rejects(
            () => support.collectBundledPackageLicenses({
                inputs: { 'node_modules/fixture-package/index.js': {} },
            }, fixtureRoot),
            /fixture-package@1\.0\.0.*license text|license text.*fixture-package@1\.0\.0/i
        );
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

function testNoticeFormatting(support: BuildSupport): void {
    const packageNotice = (
        name: string,
        version: string,
        licenseText: string
    ): PackageNotice => ({ name, version, license: 'MIT', licenseText });
    const notices = support.formatThirdPartyNotices([
        packageNotice('parser-two', '2.0.0', 'PARSER\r\nTWO\r\n'),
        packageNotice('parser-one', '1.0.0', 'PARSER ONE'),
    ], [
        packageNotice('zeta', '2.0.0', 'ZETA TWO'),
        packageNotice('alpha', '1.0.0', 'ALPHA'),
        packageNotice('zeta', '1.0.0', 'ZETA ONE'),
        packageNotice('alpha', '1.0.0', 'ALPHA'),
    ]);
    const headings = [...notices.matchAll(/^## (.+)$/gm)].map(match => match[1]);
    assert.deepStrictEqual(headings, [
        'parser-two 2.0.0',
        'parser-one 1.0.0',
        'alpha 1.0.0',
        'zeta 1.0.0',
        'zeta 2.0.0',
    ]);
    assert.strictEqual(notices.match(/## alpha 1\.0\.0/g)?.length, 1);
    assert.ok(!notices.includes('\r'), 'notices must use deterministic LF endings');
    assert.ok(notices.includes('PARSER\nTWO'));
    assert.ok(notices.includes('Declared license: MIT\n\nALPHA'));
    assert.ok(notices.endsWith('ZETA TWO\n'));
}

async function testRuntimePackageCollection(support: BuildSupport): Promise<void> {
    const packageRoot = path.join(
        repositoryRoot,
        'node_modules',
        '@veriflow',
        'iverilog-wasm'
    );
    const runtimePackage = await support.collectRuntimePackage(packageRoot, {
        name: '@veriflow/iverilog-wasm',
        version: '0.1.4',
        license: 'GPL-2.0-or-later',
        nodeEngine: '>=18.15.0',
        entry: 'dist/index.js',
        declaredFiles: ['dist', 'README.md', 'LICENSE'],
        requiredFiles: [
            'package.json',
            'LICENSE',
            'README.md',
            'dist/SOURCE.md',
            'dist/index.js',
            'dist/worker.js',
            'dist/runtime/ivl.mjs',
            'dist/runtime/ivl.wasm',
            'dist/runtime/ivlpp.mjs',
            'dist/runtime/ivlpp.wasm',
            'dist/runtime/vvp.mjs',
            'dist/runtime/vvp.wasm',
        ],
        nonemptyFiles: [
            'LICENSE',
            'dist/SOURCE.md',
            'dist/runtime/ivl.wasm',
            'dist/runtime/ivlpp.wasm',
            'dist/runtime/vvp.wasm',
        ],
        provenanceFile: 'dist/SOURCE.md',
    });
    const expectedFiles = [
        'package.json',
        ...fs.readdirSync(path.join(packageRoot, 'dist'), {
            recursive: true,
            withFileTypes: true,
        }).filter(entry => entry.isFile()).map(entry => path.relative(
            packageRoot,
            path.join(entry.parentPath, entry.name)
        ).replace(/\\/g, '/')),
        'README.md',
        'LICENSE',
    ].sort();
    assert.deepStrictEqual(
        runtimePackage.files.map(file => file.relativePath),
        expectedFiles
    );
    assert.strictEqual(runtimePackage.notice.name, '@veriflow/iverilog-wasm');
    assert.strictEqual(runtimePackage.notice.version, '0.1.4');
    assert.strictEqual(runtimePackage.notice.license, 'GPL-2.0-or-later');
    assert.match(runtimePackage.notice.licenseText, /GNU GENERAL PUBLIC LICENSE/);
    assert.match(runtimePackage.notice.provenanceText ?? '', /Corresponding Source/);

    const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-runtime-copy-'));
    try {
        await support.copyRuntimePackage(runtimePackage, destinationRoot);
        for (const file of runtimePackage.files) {
            const copied = path.join(destinationRoot, file.relativePath);
            assert.deepStrictEqual(fs.readFileSync(copied), fs.readFileSync(file.source));
            assert.strictEqual(fs.statSync(copied).mode & 0o777, file.mode);
        }
    } finally {
        fs.rmSync(destinationRoot, { recursive: true, force: true });
    }
}

async function testRuntimePackageSafety(support: BuildSupport): Promise<void> {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-runtime-safety-'));
    const expectations = {
        name: 'fixture-runtime',
        version: '1.0.0',
        license: 'MIT',
        nodeEngine: '>=18.15.0',
        entry: 'dist/index.js',
        declaredFiles: ['dist', 'LICENSE'],
        requiredFiles: ['package.json', 'LICENSE', 'dist/SOURCE.md', 'dist/index.js'],
        nonemptyFiles: ['LICENSE', 'dist/SOURCE.md'],
        provenanceFile: 'dist/SOURCE.md',
    };
    const writeFixture = (files: string[]): void => {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
        fs.mkdirSync(path.join(fixtureRoot, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
            name: expectations.name,
            version: expectations.version,
            license: expectations.license,
            engines: { node: expectations.nodeEngine },
            exports: { '.': { import: './dist/index.js' } },
            files,
        }));
        fs.writeFileSync(path.join(fixtureRoot, 'LICENSE'), 'fixture license\n');
        fs.writeFileSync(path.join(fixtureRoot, 'dist', 'SOURCE.md'), 'fixture source\n');
        fs.writeFileSync(path.join(fixtureRoot, 'dist', 'index.js'), 'export {};\n');
    };
    try {
        writeFixture(['dist', 'LICENSE']);
        fs.writeFileSync(path.join(fixtureRoot, 'undeclared.txt'), 'not declared\n');
        await assert.rejects(
            support.collectRuntimePackage(fixtureRoot, expectations),
            /undeclared/i
        );

        writeFixture(['dist', 'LICENSE']);
        fs.symlinkSync('../LICENSE', path.join(fixtureRoot, 'dist', 'linked-license'));
        await assert.rejects(
            support.collectRuntimePackage(fixtureRoot, expectations),
            /symbolic link/i
        );

        writeFixture(['../outside', 'dist', 'LICENSE']);
        await assert.rejects(
            support.collectRuntimePackage(fixtureRoot, {
                ...expectations,
                declaredFiles: ['../outside', 'dist', 'LICENSE'],
            }),
            /unsafe|traversal|relative/i
        );

        writeFixture(['dist', 'dist/index.js', 'LICENSE']);
        await assert.rejects(
            support.collectRuntimePackage(fixtureRoot, {
                ...expectations,
                declaredFiles: ['dist', 'dist/index.js', 'LICENSE'],
            }),
            /duplicate|collision/i
        );
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

async function testRuntimePackageRootMode(support: BuildSupport): Promise<void> {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-runtime-mode-'));
    const packageRoot = path.join(fixtureRoot, 'package');
    const destination = path.join(fixtureRoot, 'published');
    const expectedMode = 0o751;
    try {
        fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
        fs.chmodSync(packageRoot, expectedMode);
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
            name: 'fixture-runtime',
            version: '1.0.0',
            license: 'MIT',
            engines: { node: '>=18.15.0' },
            exports: { '.': { import: './dist/index.js' } },
            files: ['dist', 'LICENSE'],
        }));
        fs.writeFileSync(path.join(packageRoot, 'LICENSE'), 'fixture license\n');
        fs.writeFileSync(path.join(packageRoot, 'dist', 'SOURCE.md'), 'fixture source\n');
        fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export {};\n');
        const runtimePackage = await support.collectRuntimePackage(packageRoot, {
            name: 'fixture-runtime',
            version: '1.0.0',
            license: 'MIT',
            nodeEngine: '>=18.15.0',
            entry: 'dist/index.js',
            declaredFiles: ['dist', 'LICENSE'],
            requiredFiles: ['package.json', 'LICENSE', 'dist/SOURCE.md', 'dist/index.js'],
            nonemptyFiles: ['LICENSE', 'dist/SOURCE.md'],
            provenanceFile: 'dist/SOURCE.md',
        });

        assert.strictEqual(runtimePackage.mode, expectedMode);
        await support.copyRuntimePackage(runtimePackage, destination);
        assert.strictEqual(fs.statSync(destination).mode & 0o777, expectedMode);
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

async function testRuntimePackageDirectoryModes(support: BuildSupport): Promise<void> {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-runtime-dirs-'));
    const packageRoot = path.join(fixtureRoot, 'package');
    const destination = path.join(fixtureRoot, 'published');
    try {
        fs.mkdirSync(path.join(packageRoot, 'dist', 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
            name: 'fixture-runtime', version: '1.0.0', license: 'MIT',
            engines: { node: '>=18.15.0' },
            exports: { '.': { import: './dist/index.js' } },
            files: ['dist', 'LICENSE'],
        }));
        fs.writeFileSync(path.join(packageRoot, 'LICENSE'), 'fixture license\n');
        fs.writeFileSync(path.join(packageRoot, 'dist', 'SOURCE.md'), 'fixture source\n');
        fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export {};\n');
        fs.writeFileSync(path.join(packageRoot, 'dist', 'runtime', 'worker.js'), 'export {};\n');
        fs.chmodSync(packageRoot, 0o755);
        fs.chmodSync(path.join(packageRoot, 'dist'), 0o755);
        fs.chmodSync(path.join(packageRoot, 'dist', 'runtime'), 0o711);

        const previousUmask = process.umask(0o077);
        let runtimePackage: RuntimePackage;
        try {
            runtimePackage = await support.collectRuntimePackage(packageRoot, {
                name: 'fixture-runtime', version: '1.0.0', license: 'MIT',
                nodeEngine: '>=18.15.0', entry: 'dist/index.js',
                declaredFiles: ['dist', 'LICENSE'],
                requiredFiles: [
                    'package.json',
                    'LICENSE',
                    'dist/SOURCE.md',
                    'dist/index.js',
                    'dist/runtime/worker.js',
                ],
                nonemptyFiles: ['LICENSE', 'dist/SOURCE.md'],
                provenanceFile: 'dist/SOURCE.md',
            });
            await support.copyRuntimePackage(runtimePackage, destination);
        } finally {
            process.umask(previousUmask);
        }

        assert.deepStrictEqual(runtimePackage.directories, [
            { relativePath: 'dist', mode: 0o755 },
            { relativePath: 'dist/runtime', mode: 0o711 },
        ]);
        assert.strictEqual(fs.statSync(destination).mode & 0o777, 0o755);
        assert.strictEqual(fs.statSync(path.join(destination, 'dist')).mode & 0o777, 0o755);
        assert.strictEqual(
            fs.statSync(path.join(destination, 'dist', 'runtime')).mode & 0o777,
            0o711
        );
    } finally {
        makeTreeWritableForCleanup(fixtureRoot);
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

async function testRuntimePackageReplacement(support: BuildSupport): Promise<void> {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-runtime-replace-'));
    const packageRoot = path.join(fixtureRoot, 'package');
    const destination = path.join(fixtureRoot, 'published');
    try {
        fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
            name: 'fixture-runtime', version: '1.0.0', license: 'MIT',
            engines: { node: '>=18.15.0' },
            exports: { '.': { import: './dist/index.js' } },
            files: ['dist', 'LICENSE'],
        }));
        fs.writeFileSync(path.join(packageRoot, 'LICENSE'), 'fixture license\n');
        fs.writeFileSync(path.join(packageRoot, 'dist', 'SOURCE.md'), 'fixture source\n');
        fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), 'export {};\n');
        fs.chmodSync(path.join(packageRoot, 'dist'), 0o511);
        fs.chmodSync(packageRoot, 0o555);
        const runtimePackage = await support.collectRuntimePackage(packageRoot, {
            name: 'fixture-runtime', version: '1.0.0', license: 'MIT',
            nodeEngine: '>=18.15.0', entry: 'dist/index.js',
            declaredFiles: ['dist', 'LICENSE'],
            requiredFiles: ['package.json', 'LICENSE', 'dist/SOURCE.md', 'dist/index.js'],
            nonemptyFiles: ['LICENSE', 'dist/SOURCE.md'], provenanceFile: 'dist/SOURCE.md',
        });
        const ownedEntries = (): string[] => fs.readdirSync(fixtureRoot)
            .filter(entry => entry.startsWith('.runtime-package-'));

        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'old.txt'), 'trusted old content\n');
        await support.copyRuntimePackage(runtimePackage, destination);
        assert.strictEqual(fs.existsSync(path.join(destination, 'old.txt')), false);
        assert.strictEqual(fs.readFileSync(
            path.join(destination, 'dist', 'index.js'),
            'utf8'
        ), 'export {};\n');
        assert.strictEqual(fs.statSync(destination).mode & 0o777, 0o555);
        assert.deepStrictEqual(ownedEntries(), []);

        await support.copyRuntimePackage(runtimePackage, destination);
        assert.strictEqual(fs.statSync(destination).mode & 0o777, 0o555);
        assert.strictEqual(fs.readFileSync(
            path.join(destination, 'dist', 'index.js'),
            'utf8'
        ), 'export {};\n');
        assert.deepStrictEqual(ownedEntries(), []);

        fs.chmodSync(destination, 0o755);
        makeTreeWritableForCleanup(destination);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'old.txt'), 'trusted old content\n');
        fs.chmodSync(destination, 0o555);
        await assert.rejects(
            support.copyRuntimePackage(runtimePackage, destination, {
                async rename() {
                    throw new Error('injected backup rename failure');
                },
            }),
            /injected backup rename failure/
        );
        assert.strictEqual(fs.statSync(destination).mode & 0o777, 0o555);
        assert.strictEqual(
            fs.readFileSync(path.join(destination, 'old.txt'), 'utf8'),
            'trusted old content\n'
        );
        assert.deepStrictEqual(ownedEntries(), []);

        makeTreeWritableForCleanup(destination);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'old.txt'), 'backup temp failure content\n');
        fs.chmodSync(destination, 0o555);
        let mkdtempCalls = 0;
        await assert.rejects(
            support.copyRuntimePackage(runtimePackage, destination, {
                async mkdtemp(prefix) {
                    mkdtempCalls += 1;
                    if (mkdtempCalls === 2) {
                        throw new Error('injected backup temp failure');
                    }
                    return fs.promises.mkdtemp(prefix);
                },
            }),
            /injected backup temp failure/
        );
        assert.strictEqual(mkdtempCalls, 2);
        assert.strictEqual(fs.statSync(destination).mode & 0o777, 0o555);
        assert.strictEqual(
            fs.readFileSync(path.join(destination, 'old.txt'), 'utf8'),
            'backup temp failure content\n'
        );
        assert.deepStrictEqual(ownedEntries(), []);
        fs.writeFileSync(path.join(destination, 'old.txt'), 'trusted old content\n');

        let renameCalls = 0;
        await assert.rejects(
            support.copyRuntimePackage(runtimePackage, destination, {
                async rename(source, target) {
                    renameCalls += 1;
                    if (renameCalls === 2) throw new Error('injected publish rename failure');
                    await renameFile(source, target);
                },
            }),
            /injected publish rename failure/
        );
        assert.strictEqual(renameCalls, 3, 'failed publish must restore the backup');
        assert.strictEqual(fs.statSync(destination).mode & 0o777, 0o555);
        assert.strictEqual(
            fs.readFileSync(path.join(destination, 'old.txt'), 'utf8'),
            'trusted old content\n'
        );
        assert.deepStrictEqual(fs.readdirSync(destination), ['old.txt']);
        assert.deepStrictEqual(ownedEntries(), []);

        makeTreeWritableForCleanup(destination);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'old.txt'), 'cleanup retained content\n');
        fs.mkdirSync(path.join(destination, 'dist', 'runtime'), { recursive: true });
        fs.chmodSync(path.join(destination, 'dist'), 0o511);
        fs.chmodSync(path.join(destination, 'dist', 'runtime'), 0o501);
        fs.chmodSync(destination, 0o555);
        let cleanupRemoveCalls = 0;
        await assert.rejects(
            support.copyRuntimePackage(runtimePackage, destination, {
                async remove(target, options) {
                    cleanupRemoveCalls += 1;
                    if (target.includes('.runtime-package-backup-')) {
                        throw new Error('injected old backup cleanup failure');
                    }
                    await fs.promises.rm(target, options);
                },
            }),
            error => {
                const failure = error as Error & { errors: Error[] };
                assert.strictEqual(failure.name, 'AggregateError');
                assert.match(
                    failure.errors[0].message,
                    /runtime package backup.*injected old backup cleanup failure/i
                );
                return true;
            }
        );
        assert.strictEqual(cleanupRemoveCalls, 2);
        const retainedEntries = ownedEntries();
        assert.strictEqual(retainedEntries.length, 1);
        assert.match(retainedEntries[0], /^\.runtime-package-backup-/);
        const retainedBackup = retainedEntries[0];
        const retainedPrevious = path.join(fixtureRoot, retainedBackup, 'previous');
        assert.strictEqual(
            fs.statSync(retainedPrevious).mode & 0o777,
            0o555
        );
        assert.strictEqual(fs.statSync(path.join(retainedPrevious, 'dist')).mode & 0o777, 0o511);
        assert.strictEqual(
            fs.statSync(path.join(retainedPrevious, 'dist', 'runtime')).mode & 0o777,
            0o501
        );
        makeTreeWritableForCleanup(path.join(fixtureRoot, retainedBackup));
        fs.rmSync(path.join(fixtureRoot, retainedBackup), { recursive: true, force: true });
        makeTreeWritableForCleanup(destination);
        fs.rmSync(destination, { recursive: true, force: true });

        let absentRenameCalls = 0;
        await assert.rejects(
            support.copyRuntimePackage(runtimePackage, destination, {
                async rename() {
                    absentRenameCalls += 1;
                    throw new Error('injected absent publish failure');
                },
            }),
            /injected absent publish failure/
        );
        assert.strictEqual(absentRenameCalls, 1);
        assert.strictEqual(fs.existsSync(destination), false);
        assert.deepStrictEqual(ownedEntries(), []);

        const cleanupPublishError = new Error('injected cleanup-case publish failure');
        await assert.rejects(
            support.copyRuntimePackage(runtimePackage, destination, {
                async rename() {
                    throw cleanupPublishError;
                },
                async remove(target, options) {
                    await fs.promises.rm(path.join(target, 'dist'), options);
                    throw new Error('injected staging cleanup failure');
                },
            }),
            error => {
                const failure = error as Error & { cause?: unknown; errors: unknown[] };
                assert.strictEqual(failure.name, 'AggregateError');
                assert.strictEqual(failure.cause, cleanupPublishError);
                assert.strictEqual(failure.errors[0], cleanupPublishError);
                assert.match(
                    (failure.errors[1] as Error).message,
                    /staging runtime package.*injected staging cleanup failure/i
                );
                return true;
            }
        );
        assert.strictEqual(ownedEntries().length, 1);
        const retainedStaging = path.join(fixtureRoot, ownedEntries()[0]);
        assert.strictEqual(fs.statSync(retainedStaging).mode & 0o777, 0o555);
        assert.strictEqual(fs.existsSync(path.join(retainedStaging, 'dist')), false);
        makeTreeWritableForCleanup(retainedStaging);
        fs.rmSync(retainedStaging, {
            recursive: true,
            force: true,
        });

        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'old.txt'), 'only recoverable copy\n');
        fs.chmodSync(destination, 0o555);
        let restoreRenameCalls = 0;
        await assert.rejects(
            support.copyRuntimePackage(runtimePackage, destination, {
                async rename(source, target) {
                    restoreRenameCalls += 1;
                    if (restoreRenameCalls > 1) {
                        if (restoreRenameCalls === 2) {
                            fs.chmodSync(path.join(source, 'dist'), 0o555);
                        }
                        throw new Error(
                            restoreRenameCalls === 2
                                ? 'injected publish failure'
                                : 'injected restore failure'
                        );
                    }
                    await renameFile(source, target);
                },
            }),
            error => {
                const failure = error as Error & { errors?: Error[] };
                assert.strictEqual(failure.name, 'AggregateError');
                assert.match(failure.message, /restore.*\.runtime-package-backup-/i);
                assert.deepStrictEqual(
                    failure.errors?.map(item => item.message),
                    ['injected publish failure', 'injected restore failure']
                );
                return true;
            }
        );
        assert.strictEqual(fs.existsSync(destination), false);
        const recoveryEntries = ownedEntries();
        assert.strictEqual(recoveryEntries.length, 1);
        assert.match(recoveryEntries[0], /^\.runtime-package-backup-/);
        const recoverable = path.join(fixtureRoot, recoveryEntries[0], 'previous');
        assert.strictEqual(fs.statSync(recoverable).mode & 0o777, 0o555);
        assert.strictEqual(
            fs.readFileSync(path.join(recoverable, 'old.txt'), 'utf8'),
            'only recoverable copy\n'
        );
        assert.deepStrictEqual(fs.readdirSync(recoverable), ['old.txt']);
    } finally {
        makeTreeWritableForCleanup(fixtureRoot);
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
}

async function testSchematicAssets(): Promise<void> {
    const support = await loadEsmModule<BuildSupport>(pathToFileURL(
        path.join(extensionRoot, 'scripts', 'build-support.mjs')
    ).href);
    await testLicenseFailure(support);
    testNoticeFormatting(support);
    await testRuntimePackageCollection(support);
    await testRuntimePackageSafety(support);
    await testRuntimePackageRootMode(support);
    await testRuntimePackageDirectoryModes(support);
    await testRuntimePackageReplacement(support);

    for (const relative of [
        'index.js',
        'index.css',
        'index.html',
    ]) {
        assert.ok(
            fs.statSync(path.join(webDistRoot, relative)).size > 100,
            `${relative} is missing`
        );
    }
    assert.ok(fs.statSync(path.join(webDistRoot, 'index.js')).size > 50_000);
    assert.ok(!fs.existsSync(path.join(webDistRoot, 'index.js.map')));
    assert.deepStrictEqual(fs.readdirSync(webDistRoot).sort(), [
        'index.css',
        'index.html',
        'index.js',
    ]);
    for (const sourceName of ['index.ts', 'styles.ts', 'index.html.ts']) {
        assert.ok(!fs.existsSync(path.join(webDistRoot, sourceName)));
    }

    const vscodeIgnore = fs.readFileSync(
        path.join(extensionRoot, '.vscodeignore'),
        'utf8'
    );
    assert.ok(ignored(vscodeIgnore, 'webview/schematic/index.ts'));
    assert.doesNotMatch(vscodeIgnore, /^!media\/(?:waveform|schematic)\/\*\*$/m);
    const runtimeMediaPaths = [
        'media/waveform/index.html',
        'media/waveform/index.css',
        'media/waveform/index.js',
        'media/waveform/viewer-core.js',
        'media/waveform/viewer-transport.js',
        'media/schematic/index.html',
        'media/schematic/index.css',
        'media/schematic/index.js',
    ];
    for (const runtimeMediaPath of runtimeMediaPaths) {
        assert.ok(vscodeIgnore.includes(`!${runtimeMediaPath}`));
        assert.ok(!ignored(vscodeIgnore, runtimeMediaPath));
    }
    for (const excludedMediaPath of [
        'media/waveform/stray.ts',
        'media/waveform/index.js.map',
        'media/schematic/stray.ts',
        'media/schematic/index.js.map',
    ]) {
        assert.ok(ignored(vscodeIgnore, excludedMediaPath));
    }
    const gitignore = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8');
    assert.match(gitignore.replace(/\\/g, '/'), /veriflow-vscode\/media\/schematic\//);
    const manifest = JSON.parse(
        fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(manifest.dependencies['@antv/x6'], '3.1.7');
    assert.strictEqual(manifest.dependencies['@dagrejs/dagre'], undefined);
    assert.strictEqual(manifest.dependencies.lucide, '1.28.0');
    const webviewManifest = JSON.parse(fs.readFileSync(
        path.join(repositoryRoot, 'packages', 'schematic-webview', 'package.json'),
        'utf8'
    )) as { dependencies: Record<string, string> };
    assert.strictEqual(webviewManifest.dependencies['@dagrejs/dagre'], undefined);
    assert.doesNotMatch(
        fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
        /@dagrejs\/(?:dagre|graphlib)/
    );

    const html = fs.readFileSync(path.join(webDistRoot, 'index.html'), 'utf8');
    for (const expected of [
        'id="toolbar"',
        'id="module-selector"',
        'id="content-row"',
        'id="canvas"',
        'id="inspector"',
        'id="inspector-title"',
        'id="inspector-properties"',
        'id="inspector-toggle-button"',
        'id="status-strip"',
        'aria-label="Fit schematic"',
        'aria-label="Reset zoom to 100%"',
        'aria-label="Relayout schematic"',
        'aria-label="Search schematic"',
        'aria-label="Toggle minimap"',
        'aria-label="Properties"',
        'aria-controls="inspector"',
        'aria-expanded="true"',
        'aria-label="Previous search result"',
        'aria-label="Next search result"',
        'data-testid="schematic-shell"',
        'id="authoring-actions"',
        'id="add-instance-button"',
        'id="add-port-button"',
        'id="connect-button"',
        'id="export-button"',
        'id="delete-button"',
        'title="Add instance"',
        'title="Add port"',
        'title="Connect pins"',
        'title="Export RTL"',
        'title="Delete selection"',
        'id="add-instance-dialog"',
        'id="instance-name-input"',
        'id="instance-module-select"',
        'id="add-port-dialog"',
        'id="port-name-input"',
        'id="port-direction-select"',
        'id="port-width-input"',
        'id="inspector-form"',
    ]) {
        assert.ok(html.includes(expected), `HTML is missing ${expected}`);
    }
    assert.match(html, /id="authoring-actions"[^>]*\shidden(?:\s|>)/);
    assert.doesNotMatch(html, /<svg\b/i);

    const css = fs.readFileSync(path.join(webDistRoot, 'index.css'), 'utf8');
    assert.match(css, /grid-template-rows:\s*36px\s+minmax\(0,\s*1fr\)\s+24px/);
    assert.match(css, /#content-row\s*{[^}]*display:\s*flex/s);
    assert.match(css, /#inspector\s*{[^}]*flex:\s*0\s+0\s+280px/s);
    assert.match(css, /#inspector\[hidden\]\s*{[^}]*display:\s*none/s);
    assert.match(css, /#authoring-actions\[hidden\]\s*{[^}]*display:\s*none/s);
    assert.match(css, /\.inspector-field\s+(?:input|select)/);
    assert.match(css, /--vscode-editor-background/);
    assert.match(css, /--vscode-editor-foreground/);
    assert.match(css, /font-size:\s*12px/);
    assert.match(css, /letter-spacing:\s*0/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /\.x6-node:focus-visible/);
    assert.match(css, /\.x6-edge:focus-visible/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /forced-colors/);
    assert.doesNotMatch(css, /gradient\s*\(/i);
    const semanticColorTokens = [
        '--schematic-canvas',
        '--schematic-node-fill',
        '--schematic-node-border',
        '--schematic-text',
        '--schematic-muted-text',
        '--schematic-pin',
        '--schematic-wire',
        '--schematic-wire-selected',
        '--schematic-junction',
    ];
    for (const token of semanticColorTokens) {
        assert.ok(css.includes(`${token}:`), `CSS is missing ${token}`);
    }
    assert.match(css, /\.x6-edge\.veriflow-network-selected\s*>\s*path:nth-child\(2\)/);
    assert.match(css, /--schematic-interface-wire:/);
    assert.match(css, /\.veriflow-pin-label\.veriflow-pin-selected/);
    assert.match(css, /\.veriflow-pin-label-hit-area/);
    assert.doesNotMatch(css, /--schematic-interface-(?:master|slave|unknown):/);
    assert.doesNotMatch(
        css,
        /\.x6-widget-minimap\s+\.x6-graph\s*{[^}]*\b(?:width|height):\s*100%\s*!important/s,
        'the minimap graph must retain X6 runtime pixel dimensions'
    );

    const webviewSource = fs.readFileSync(
        path.join(schematicSourceRoot, 'index.ts'),
        'utf8'
    );
    assertCanonicalSegmentRendering(webviewSource);
    assertRendererCellContracts(webviewSource);
    assertNetworkSelectionContracts(webviewSource);
    assertAdapterSearchContract(webviewSource);
    assertNetworkNavigationContract(webviewSource);
    assert.match(webviewSource, /\bprojectSchematicInspector\(/);
    assert.match(webviewSource, /function renderInspector\(/);
    assert.match(webviewSource, /function renderCurrentInspector\(/);
    assert.match(webviewSource, /dom\.inspectorToggleButton\.addEventListener\('click'/);
    assert.match(webviewSource, /\bAddBox\b/);
    assert.match(webviewSource, /\bPanelTopOpen\b/);
    assert.match(webviewSource, /\bCable\b/);
    assert.match(webviewSource, /\bFileOutput\b/);
    assert.match(webviewSource, /\bTrash2\b/);
    assert.match(webviewSource, /function renderArchDesignInspector\(/);
    assert.match(webviewSource, /case 'archDesignState':/);
    assert.match(webviewSource, /type === 'archDesignState'/);
    assert.match(webviewSource, /\barchDesignEndpointForPin\(/);
    assert.ok(
        webviewSource.includes("type: 'connectInterface'"),
        'webview source is missing interface connection authoring'
    );
    assert.match(webviewSource, /const interfaceColor = 'var\(--schematic-interface-wire\)'/);
    assert.match(webviewSource, /class: 'veriflow-node-accent veriflow-interface-accent'/);
    assert.match(webviewSource, /class: 'veriflow-pin-label-hit-area'/);
    assert.match(webviewSource, /'veriflow-pin-label veriflow-interface-label'/);
    assert.match(webviewSource, /function portAtSelectionBoxPoint\(/);
    assert.doesNotMatch(webviewSource, /interfaceTag|interfaceTagText/);
    assert.doesNotMatch(
        webviewSource,
        /pin\.name} · \$\{pin\.interface\.protocolName}/
    );
    const webviewSupportSource = fs.readFileSync(
        path.join(extensionRoot, 'src', 'schematic', 'webviewSupport.ts'),
        'utf8'
    );
    for (const marker of [
        "type: 'promoteInterface'",
        "type: 'setInterfaceDefault'",
        "type: 'setInterfaceOverride'",
        "type: 'renameInterfacePort'",
        "id: 'interface-collapse'",
        "'interface-network-protocol'",
        "'interface-network-member'",
    ]) {
        assert.ok(
            webviewSupportSource.includes(marker),
            `webview support source is missing ${marker}`
        );
    }
    assert.match(webviewSource, /magnetConnectable:\s*false/);
    assert.doesNotMatch(webviewSource, /graph\.on\('edge:connected'/);
    assert.match(webviewSource, /graph\.on\('node:port:click'/);
    assert.match(webviewSource, /function normalizeConnectionTerminals\(/);
    const completedConnection = sourceSection(
        webviewSource,
        'function postConnection(',
        '\nfunction handleConnectionPinClick(',
        'Arch Design connection completion'
    );
    assert.match(
        completedConnection,
        /cancelPendingConnection\(\);[^]*postArchDesignEdit\(\{[^]*type:\s*'connect'/,
        'preview edge removal must precede the revision-bound edit'
    );
    const editPosting = sourceSection(
        webviewSource,
        'function postArchDesignEdit(',
        '\nfunction renderArchDesignInspector(',
        'Arch Design edit posting'
    );
    assert.match(
        editPosting,
        /queuedArchDesignCommand\s*=\s*{\s*type:\s*'edit',\s*edit\s*}[^]*function drainArchDesignWrites\(\)[^]*queuedArchDesignLayoutSave[^]*type:\s*'editArchDesign',[^]*revision:\s*currentRevision,[^]*edit:\s*command\.edit,/
    );
    assert.doesNotMatch(editPosting, /\.design\s*=|design\.[A-Za-z_$][\w$]*\s*=/);
    for (const token of semanticColorTokens.slice(1).filter(
        token => token !== '--schematic-wire-selected'
    )) {
        assert.ok(webviewSource.includes(`var(${token})`), `renderer is missing ${token}`);
    }
    const temporaryImportOwners = typeScriptFiles(
        path.join(repositoryRoot, 'packages')
    ).filter(filePath => fs.readFileSync(filePath, 'utf8').includes(
        '../../../veriflow-vscode/src/'
    )).map(filePath => path.relative(repositoryRoot, filePath).replace(/\\/g, '/'));
    assert.deepStrictEqual(temporaryImportOwners, [
        'packages/schematic-webview/src/index.ts',
    ]);
    assert.match(
        webviewSource,
        /import\s*{[^}]*\blayoutSchematic\b[^}]*}\s*from '@veriflow\/schematic-core';/s
    );
    assert.match(webviewSource, /layoutSchematic\(model,/);
    assert.match(webviewSource, /\bsnapNodesToPlacement\b/);
    assert.match(webviewSource, /layoutSchematic\(model,\s*layout\.placement,/);
    assert.match(webviewSource, /graph\.on\('node:moved'/);
    assert.match(webviewSource, /selection\.on\('box:mousedown'/);
    assert.match(webviewSource, /selection\.on\('box:mouseup'/);
    const movementFlush = sourceSection(
        webviewSource,
        'function flushPendingNodeMoves(',
        '\nfunction clearSchematicState(',
        'pending node movement flush'
    );
    assert.match(movementFlush, /snapNodesToPlacement\(/);
    assert.match(movementFlush, /renderSchematic\(/);
    assert.match(movementFlush, /scheduleLayoutSave\(\)/);
    assert.match(webviewSource, /queueMicrotask\(\(\) =>/);
    assert.doesNotMatch(webviewSource, /graph\.on\('node:change:position'/);
    assert.match(webviewSource, /renderModel\.networks/);
    assert.match(webviewSource, /networkRoute\.segments/);
    assert.match(webviewSource, /renderModel\.junctions/);
    assert.match(webviewSource, /graph\.addNode\(\{[^}]*shape:\s*'circle'/s);
    assert.doesNotMatch(webviewSource, /function expandNetworkSelection\(/);
    assert.match(
        webviewSource,
        /function refreshNetworkSelectionStyles\([^]*searchMatches\.map\(/
    );
    assert.match(
        webviewSource,
        /sourceMarker:\s*terminatesAtLoad\(networkRoute, source\)/
    );
    assert.match(
        webviewSource,
        /targetMarker:\s*terminatesAtLoad\(networkRoute, target\)/
    );
    assert.match(webviewSource, /SCHEMATIC_NODE_LAYOUT/);
    assert.ok(
        webviewSource.includes(
            'textMeasureContext.font = '
                + '`${style.fontWeight} ${style.fontSize}px ${fontFamily}`;'
        )
    );
    for (const clipClass of [
        'veriflow-title-clip',
        'veriflow-subtitle-clip',
        'veriflow-pin-clip',
    ]) {
        assert.ok(
            webviewSource.includes(clipClass),
            `schematic text is missing ${clipClass}`
        );
    }
    assert.match(webviewSource, /{ tagName: 'text', selector: 'text' }/);
    assert.match(webviewSource, /{ tagName: 'rect', selector: 'portLabelHitArea' }/);
    assert.match(webviewSource, /portLabelHitArea:\s*{[^}]*port: pin\.id,/s);
    assert.match(
        webviewSource,
        /function selectPin\(node: Cell, port: string \| null \| undefined\)/
    );
    assert.match(webviewSource, /portLabelHitArea:\s*{[^}]*pointerEvents: 'all',/s);
    assert.match(
        webviewSource,
        /document\.addEventListener\('mousedown', selectPinTarget, true\)/
    );
    assert.doesNotMatch(webviewSource, /selector: 'portLabel'/);
    assert.doesNotMatch(webviewSource, /tagName: 'clipPath'/);
    assert.doesNotMatch(webviewSource, /clipPath:/);
    assert.doesNotMatch(webviewSource, /nextClipPathId/);
    assert.doesNotMatch(webviewSource, /\bbottom:\s*{/);
    assert.doesNotMatch(webviewSource, /pin\.side\s*===\s*'bottom'/);
    assert.doesNotMatch(webviewSource, /function nodeDimensions\(/);
    assert.doesNotMatch(webviewSource, /\bnetworkPairs\b/);
    assert.doesNotMatch(webviewSource, /\btrunkX\b/);
    assert.doesNotMatch(webviewSource, /\bderiveFeedbackRoutes\b/);
    assert.doesNotMatch(webviewSource, /\bvertices:\s*/);
    assert.doesNotMatch(webviewSource, /\brouter:\s*/);
    assert.match(webviewSource, /new DebouncedLayoutSaveScheduler\(/);
    assert.doesNotMatch(webviewSource, /\bsaveTimer\b/);
    const localLayoutPersistence = sourceSection(
        webviewSource,
        'function persistCurrentLayoutState()',
        '\nfunction scheduleLayoutSave()',
        'local layout persistence'
    );
    assert.match(localLayoutPersistence, /vscode\.setState\(/);
    const scheduledLayoutPersistence = sourceSection(
        webviewSource,
        'function scheduleLayoutSave()',
        '\nfunction flushLayoutSaves()',
        'scheduled layout persistence'
    );
    assert.match(
        scheduledLayoutPersistence,
        /persistCurrentLayoutState\(\)[^]*layoutSaveScheduler\.schedule\(/,
        'layout changes must reach webview state before the debounced host save'
    );
    const selectionPersistence = sourceSection(
        webviewSource,
        'function updateSelectionStatus(',
        '\nfunction renderInspector(',
        'selection persistence'
    );
    assert.match(
        selectionPersistence,
        /if \(archDesignDocument\)\s*{\s*persistCurrentLayoutState\(\);\s*}\s*else\s*{\s*scheduleLayoutSave\(\);/,
        'Arch Design selection must remain local while HDL selection keeps host persistence'
    );
    assert.match(
        webviewSource,
        /function clearSchematicState\(\): void\s*{\s*layoutSaveScheduler\.flush\(\);\s*layoutSaveScheduler\.dispose\(\);/,
        'empty-state reset must flush pending host saves before disposal'
    );
    const emptyStateReset = sourceSection(
        webviewSource,
        'function clearSchematicState()',
        '\nfunction initialize(',
        'empty-state reset'
    );
    assert.match(emptyStateReset, /graph\.resetCells\(\[\]\)/);
    assert.doesNotMatch(emptyStateReset, /graph\.clearCells\(\)/);
    assert.match(
        webviewSource,
        /window\.addEventListener\('pagehide',\s*flushLayoutSavesForUnload\)/
    );
    assert.match(
        webviewSource,
        /window\.addEventListener\('beforeunload',\s*flushLayoutSavesForUnload\)/
    );
    assert.match(webviewSource, /function clearSchematicState\(\): void/);
    for (const resetOperation of [
        'graph.resetCells([])',
        'currentGraph = undefined',
        'currentLayout = undefined',
        'selection.clean()',
        "dom.searchInput.value = ''",
        'searchMatches = []',
        'minimapAvailable = false',
        'setGraphControls(false)',
    ]) {
        assert.ok(
            webviewSource.includes(resetOperation),
            `empty schematic reset is missing ${resetOperation}`
        );
    }
    assert.match(
        webviewSource,
        /if \(event\.modules\.length === 0\) \{\s*clearSchematicState\(\);/s
    );
    const accessibleRoots = webviewSource.match(
        /root:\s*{\s*tabindex:\s*0,\s*role:\s*'link',\s*'aria-label':\s*[^,]+,\s*'aria-keyshortcuts':\s*[^,}]+,?\s*}/g
    ) ?? [];
    assert.strictEqual(accessibleRoots.length, 2);
    assert.match(webviewSource, /dom\.canvas\.addEventListener\('keydown'/);
    assert.match(
        webviewSource,
        /navigationCommandForCell\(\s*navigationTargetForCell\(cell\),\s*event\.shiftKey\s*\)/
    );
    assert.doesNotMatch(webviewSource, /post\(\{\s*type:\s*'revealSource'/);
    assert.doesNotMatch(webviewSource, /post\(\{\s*type:\s*'openDefinition'/);

    const generatedBundle = fs.readFileSync(
        path.join(webDistRoot, 'index.js'),
        'utf8'
    );
    assert.match(generatedBundle, /function clearSchematicState\(\)/);
    for (const marker of [
        'connectInterface',
        'promoteInterface',
        'setInterfaceDefault',
        'setInterfaceOverride',
        'interface-collapse',
    ]) {
        assert.ok(
            generatedBundle.includes(marker),
            `generated schematic bundle is missing interface marker: ${marker}`
        );
    }
    const buildConfig = await loadEsmModule<BrowserBuildConfig>(pathToFileURL(
        path.join(repositoryRoot, 'scripts', 'lib', 'build-config.mjs')
    ).href);
    const rebuiltBundle = await build({
        ...buildConfig.browserBuildOptions(),
        absWorkingDir: repositoryRoot,
        entryPoints: [path.join(schematicSourceRoot, 'index.ts')],
        outfile: path.join(webDistRoot, 'index.js'),
        write: false,
        logLevel: 'silent',
    });
    assert.strictEqual(rebuiltBundle.outputFiles?.length, 1);
    const rebuiltBytes = rebuiltBundle.outputFiles![0].contents;
    const generatedBytes = fs.readFileSync(path.join(webDistRoot, 'index.js'));
    assert.strictEqual(sha256(rebuiltBytes), sha256(generatedBytes));
    assert.deepStrictEqual(Buffer.from(rebuiltBytes), generatedBytes);

    const notices = fs.readFileSync(
        path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'),
        'utf8'
    );
    assert.ok(notices.includes('@antv/x6 3.1.7'));
    assert.ok(!notices.includes('@dagrejs/dagre'));
    assert.ok(notices.includes('lucide 1.28.0'));
    assert.ok(notices.includes('## @veriflow/iverilog-wasm 0.1.4'));
    assert.ok(notices.includes('Declared license: GPL-2.0-or-later'));
    assert.ok(notices.includes('# Corresponding Source'));
    for (const relative of ['LICENSE', 'dist/SOURCE.md']) {
        const completeText = fs.readFileSync(
            path.join(repositoryRoot, 'node_modules', '@veriflow', 'iverilog-wasm', relative),
            'utf8'
        ).replace(/\r\n?/g, '\n');
        assert.ok(
            notices.includes(completeText),
            `notices must embed complete ${relative} text`
        );
    }

    const bundle = await build({
        absWorkingDir: repositoryRoot,
        entryPoints: [path.join(schematicSourceRoot, 'index.ts')],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: true,
        metafile: true,
        sourcemap: false,
        write: false,
        logLevel: 'silent',
    });
    const packages = await support.collectBundledPackageLicenses(
        bundle.metafile!,
        repositoryRoot
    );
    assert.ok(packages.length >= 3);
    for (const bundledPackage of packages) {
        const heading = `## ${bundledPackage.name} ${bundledPackage.version}`;
        assert.ok(notices.includes(heading), `notices are missing ${heading}`);
        const normalizedLicense = bundledPackage.licenseText
            .replace(/\r\n?/g, '\n')
            .trim();
        assert.ok(notices.includes(normalizedLicense));
    }
    const sortedIdentities = packages
        .map(item => `${item.name}@${item.version}`)
        .sort((left, right) => left.localeCompare(right));
    assert.deepStrictEqual(
        packages.map(item => `${item.name}@${item.version}`),
        sortedIdentities
    );
    assert.strictEqual(new Set(sortedIdentities).size, sortedIdentities.length);
}

testSchematicAssets()
    .then(() => console.log('schematic asset tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
