import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { build } from 'esbuild';

interface SimulationResult {
    success: boolean;
    stdout: string;
    artifacts: Map<string, Uint8Array>;
}

interface IverilogApi {
    simulate(request: {
        files: Array<{ path: string; data: string }>;
        sources: string[];
        top: string;
        generation: '2005';
        artifacts?: string[];
    }): Promise<SimulationResult>;
}

interface AdapterModule {
    loadIverilog(): Promise<IverilogApi>;
    createExtensionIverilogLoader(extensionRoot: URL): {
        load(specifier?: string | URL): Promise<IverilogApi>;
    };
}

const packageRoot = path.resolve(__dirname, '../..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const adapterPath = path.join(packageRoot, 'dist', 'index.js');
const upstreamRoot = path.join(
    repositoryRoot,
    'node_modules',
    '@veriflow',
    'iverilog-wasm',
);
const upstreamEntry = path.join(upstreamRoot, 'dist', 'index.js');

function requireAdapter(filename = adapterPath): AdapterModule {
    return require(filename) as AdapterModule;
}

async function assertVerilog2005Pass(api: IverilogApi): Promise<void> {
    const result = await api.simulate({
        files: [{
            path: 'smoke.v',
            data: [
                'module smoke;',
                '  reg clock;',
                '  initial clock = 0;',
                '  always #1 clock = ~clock;',
                '  initial begin',
                '    $dumpfile("smoke.vcd");',
                '    $dumpvars(0, smoke);',
                '    #4 $display("PASS");',
                '    $finish;',
                '  end',
                'endmodule',
                '',
            ].join('\n'),
        }],
        sources: ['smoke.v'],
        top: 'smoke',
        generation: '2005',
        artifacts: ['smoke.vcd'],
    });

    assert.equal(result.success, true, JSON.stringify(result));
    assert.match(result.stdout, /(^|\n)PASS\n/);
    assert.ok((result.artifacts.get('smoke.vcd')?.byteLength ?? 0) > 0);
}

test('compiled CommonJS adapter loads ESM-only Icarus with native import', async () => {
    const adapter = requireAdapter();

    assert.equal(typeof adapter.loadIverilog, 'function');
    await assertVerilog2005Pass(await adapter.loadIverilog());
});

test('extension loader accepts only modules inside its bound file root', async () => {
    const adapter = requireAdapter();
    const loader = adapter.createExtensionIverilogLoader(
        pathToFileURL(`${upstreamRoot}${path.sep}`),
    );

    const fileApi = await loader.load(pathToFileURL(upstreamEntry));
    assert.equal(typeof fileApi.simulate, 'function');
    await assertVerilog2005Pass(fileApi);
    await assert.rejects(
        loader.load('https://example.com/iverilog.js'),
        /must be @veriflow\/iverilog-wasm or a file: URL/,
    );
    await assert.rejects(
        loader.load('other-package'),
        /must be @veriflow\/iverilog-wasm or a file: URL/,
    );
    await assert.rejects(
        loader.load(pathToFileURL(path.join(repositoryRoot, 'package.json'))),
        /outside the trusted extension root/,
    );
    await assert.rejects(
        loader.load(new URL('../package.json', pathToFileURL(`${upstreamRoot}${path.sep}`))),
        /outside the trusted extension root/,
    );
    await assert.rejects(
        loader.load(new URL(`${pathToFileURL(upstreamEntry).href}?version=1`)),
        /must not contain a query or fragment/,
    );
    await assert.rejects(
        loader.load(new URL(`${pathToFileURL(upstreamEntry).href}#entry`)),
        /must not contain a query or fragment/,
    );
    await assert.rejects(
        loader.load(new URL(
            `%2e%2e/package.json`,
            pathToFileURL(`${upstreamRoot}${path.sep}`),
        )),
        /outside the trusted extension root/,
    );
});

test('extension loader rejects a trusted-root link that resolves outside', async t => {
    const fixtureRoot = await mkdtemp(
        path.join(packageRoot, 'dist-test', 'outside-link-'),
    );
    const trustedRoot = path.join(fixtureRoot, 'trusted');
    const outsideRoot = path.join(fixtureRoot, 'outside');
    const linkedRoot = path.join(trustedRoot, 'linked');

    try {
        await Promise.all([
            mkdir(trustedRoot),
            mkdir(outsideRoot),
        ]);
        await writeFile(
            path.join(outsideRoot, 'runtime.mjs'),
            'export const loadedFrom = import.meta.url;\n',
        );
        if (!await createDirectoryLink(outsideRoot, linkedRoot, t)) return;

        const loader = requireAdapter().createExtensionIverilogLoader(
            pathToFileURL(`${trustedRoot}${path.sep}`),
        );
        await assert.rejects(
            loader.load(pathToFileURL(path.join(linkedRoot, 'runtime.mjs'))),
            /outside the trusted extension root/,
        );
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

test('extension loader imports the canonical path behind a trusted-root link', async t => {
    const fixtureRoot = await mkdtemp(
        path.join(packageRoot, 'dist-test', 'inside-link-'),
    );
    const trustedRoot = path.join(fixtureRoot, 'trusted');
    const canonicalRoot = path.join(trustedRoot, 'canonical');
    const linkedRoot = path.join(trustedRoot, 'linked');
    const canonicalEntry = path.join(canonicalRoot, 'runtime.mjs');

    try {
        await mkdir(canonicalRoot, { recursive: true });
        await writeFile(
            canonicalEntry,
            'export const loadedFrom = import.meta.url;\n',
        );
        if (!await createDirectoryLink(canonicalRoot, linkedRoot, t)) return;

        const script = [
            `const { pathToFileURL } = require('node:url');`,
            `const adapter = require(${JSON.stringify(adapterPath)});`,
            `const loader = adapter.createExtensionIverilogLoader(pathToFileURL(${JSON.stringify(`${trustedRoot}${path.sep}`)}));`,
            `loader.load(pathToFileURL(${JSON.stringify(path.join(linkedRoot, 'runtime.mjs'))}))`,
            `  .then(api => {`,
            `    const expected = pathToFileURL(${JSON.stringify(canonicalEntry)}).href;`,
            `    if (api.loadedFrom !== expected) {`,
            `      throw new Error(JSON.stringify({ expected, actual: api.loadedFrom }));`,
            `    }`,
            `  })`,
            `  .catch(error => { console.error(error); process.exitCode = 1; });`,
        ].join('\n');
        const result = spawnSync(process.execPath, [
            '--preserve-symlinks',
            '-e',
            script,
        ], { encoding: 'utf8' });

        assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});

async function createDirectoryLink(
    target: string,
    link: string,
    context: test.TestContext,
): Promise<boolean> {
    try {
        await symlink(
            target,
            link,
            process.platform === 'win32' ? 'junction' : 'dir',
        );
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
            context.skip(`directory links are unavailable: ${code}`);
            return false;
        }
        throw error;
    }
}

test('bundled CommonJS adapter keeps the ESM runtime and binary assets external', async () => {
    await mkdir(path.join(packageRoot, 'dist-test'), { recursive: true });
    const outputDirectory = await mkdtemp(
        path.join(packageRoot, 'dist-test', 'module-boundary-'),
    );
    const bundlePath = path.join(outputDirectory, 'adapter.cjs');

    try {
        const bundled = await build({
            entryPoints: [adapterPath],
            bundle: true,
            external: ['@veriflow/iverilog-wasm'],
            format: 'cjs',
            metafile: true,
            platform: 'node',
            target: 'node24',
            write: false,
        });
        const output = bundled.outputFiles?.[0];
        assert.ok(output !== undefined);
        const source = output.text;

        assert.match(source, /@veriflow\/iverilog-wasm/);
        assert.doesNotMatch(source, /AGFzbQ|data:application\/wasm|worker\.js|wasmBinary/);
        assert.ok(
            Object.keys(bundled.metafile.inputs).every(
                input => !input.includes('node_modules/@veriflow/iverilog-wasm'),
            ),
        );

        await writeFile(bundlePath, output.contents);
        await assertVerilog2005Pass(await requireAdapter(bundlePath).loadIverilog());
    } finally {
        await rm(outputDirectory, { recursive: true, force: true });
    }
});
