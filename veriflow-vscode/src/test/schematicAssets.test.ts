import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { build } from 'esbuild';

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

const extensionRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(extensionRoot, '..');
const mediaRoot = path.join(extensionRoot, 'media', 'schematic');
const loadEsmModule = new Function(
    'specifier',
    'return import(specifier);'
) as (specifier: string) => Promise<BuildSupport>;

function ignored(patterns: string, relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    return patterns.split(/\r?\n/).some(line => {
        const pattern = line.trim();
        if (!pattern || pattern.startsWith('#')) return false;
        if (pattern === 'webview/**') return normalized.startsWith('webview/');
        if (pattern === 'media/schematic/**') return normalized.startsWith('media/schematic/');
        if (pattern === '**/*.map') return normalized.endsWith('.map');
        return pattern === normalized;
    });
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
    const support = await loadEsmModule(pathToFileURL(
        path.join(extensionRoot, 'scripts', 'build-support.mjs')
    ).href);
    await testLicenseFailure(support);
    testNoticeFormatting(support);

    for (const relative of [
        'media/schematic/index.js',
        'media/schematic/styles.css',
        'media/schematic/index.html',
    ]) {
        assert.ok(
            fs.statSync(path.join(extensionRoot, relative)).size > 100,
            `${relative} is missing`
        );
    }
    assert.ok(fs.statSync(path.join(mediaRoot, 'index.js')).size > 50_000);
    assert.ok(!fs.existsSync(path.join(mediaRoot, 'index.js.map')));
    assert.deepStrictEqual(fs.readdirSync(mediaRoot).sort(), [
        'index.html',
        'index.js',
        'styles.css',
    ]);
    for (const sourceName of ['index.ts', 'styles.ts', 'index.html.ts']) {
        assert.ok(!fs.existsSync(path.join(mediaRoot, sourceName)));
    }

    const vscodeIgnore = fs.readFileSync(
        path.join(extensionRoot, '.vscodeignore'),
        'utf8'
    );
    assert.ok(ignored(vscodeIgnore, 'webview/schematic/index.ts'));
    assert.ok(!ignored(vscodeIgnore, 'media/schematic/index.js'));
    const gitignore = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8');
    assert.match(gitignore.replace(/\\/g, '/'), /veriflow-vscode\/media\/schematic\//);
    const manifest = JSON.parse(
        fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(manifest.dependencies['@antv/x6'], '3.1.7');
    assert.strictEqual(manifest.dependencies['@dagrejs/dagre'], '3.1.0');
    assert.strictEqual(manifest.dependencies.lucide, '1.28.0');

    const html = fs.readFileSync(path.join(mediaRoot, 'index.html'), 'utf8');
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

    const css = fs.readFileSync(path.join(mediaRoot, 'styles.css'), 'utf8');
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
    assert.doesNotMatch(
        css,
        /\.x6-widget-minimap\s+\.x6-graph\s*{[^}]*\b(?:width|height):\s*100%\s*!important/s,
        'the minimap graph must retain X6 runtime pixel dimensions'
    );

    const webviewSource = fs.readFileSync(
        path.join(extensionRoot, 'webview', 'schematic', 'index.ts'),
        'utf8'
    );
    assert.match(webviewSource, /schematicNodeSize\(model\)/);
    assert.doesNotMatch(webviewSource, /function nodeDimensions\(/);
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
        'graph.clearCells()',
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

    const notices = fs.readFileSync(
        path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'),
        'utf8'
    );
    assert.ok(notices.includes('@antv/x6 3.1.7'));
    assert.ok(notices.includes('@dagrejs/dagre 3.1.0'));
    assert.ok(notices.includes('lucide 1.28.0'));

    const bundle = await build({
        entryPoints: [path.join(extensionRoot, 'webview', 'schematic', 'index.ts')],
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
        extensionRoot
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
