import * as assert from 'assert';
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
}

run().then(() => console.log('root build tests passed'));
