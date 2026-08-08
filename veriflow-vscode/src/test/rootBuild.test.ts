import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

async function run(): Promise<void> {
    const root = path.resolve(__dirname, '../../..');
    const config = await import(path.join(root, 'scripts/lib/build-config.mjs'));
    assert.deepStrictEqual(config.browserBuildOptions(), {
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: false,
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8',
    });
    const extensionManifest = JSON.parse(fs.readFileSync(
        path.join(root, 'veriflow-vscode', 'package.json'),
        'utf8'
    )) as { scripts: Record<string, string> };
    assert.strictEqual(
        extensionManifest.scripts.test,
        'npm run vscode:prepublish && node ./scripts/run-tests.mjs'
    );
}

run().then(() => console.log('root build tests passed'));
