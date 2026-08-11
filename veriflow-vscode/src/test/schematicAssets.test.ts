import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { build, type BuildOptions } from 'esbuild';

type PackageNotice = {
    name: string;
    version: string;
    license: string;
    licenseText: string;
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
    assert.strictEqual(
        source.match(/\bgraph\.addEdge\(/g)?.length ?? 0,
        1,
        'the renderer must have exactly one graph.addEdge call'
    );
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

async function testSchematicAssets(): Promise<void> {
    const support = await loadEsmModule<BuildSupport>(pathToFileURL(
        path.join(extensionRoot, 'scripts', 'build-support.mjs')
    ).href);
    await testLicenseFailure(support);
    testNoticeFormatting(support);

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
        'id="canvas"',
        'id="status-strip"',
        'aria-label="Fit schematic"',
        'aria-label="Reset zoom to 100%"',
        'aria-label="Relayout schematic"',
        'aria-label="Search schematic"',
        'aria-label="Toggle minimap"',
        'aria-label="Previous search result"',
        'aria-label="Next search result"',
        'data-testid="schematic-shell"',
    ]) {
        assert.ok(html.includes(expected), `HTML is missing ${expected}`);
    }
    assert.doesNotMatch(html, /<svg\b/i);

    const css = fs.readFileSync(path.join(webDistRoot, 'index.css'), 'utf8');
    assert.match(css, /grid-template-rows:\s*36px\s+minmax\(0,\s*1fr\)\s+24px/);
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
    assert.match(
        webviewSource,
        /function scheduleLayoutSave\(\): void[^]*vscode\.setState\([^]*layoutSaveScheduler\.schedule\(/,
        'layout changes must reach webview state before the debounced host save'
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
        /window\.addEventListener\('pagehide',\s*flushLayoutSaves\)/
    );
    assert.match(
        webviewSource,
        /window\.addEventListener\('beforeunload',\s*flushLayoutSaves\)/
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
