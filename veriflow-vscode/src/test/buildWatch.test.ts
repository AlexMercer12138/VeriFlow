import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
) as {
    main: string;
    scripts: { watch: string };
};
const buildScript = fs.readFileSync(
    path.join(extensionRoot, 'scripts', 'build.mjs'),
    'utf8'
);

assert.strictEqual(manifest.main, './dist/extension.js');
assert.strictEqual(manifest.scripts.watch, 'node ./scripts/build.mjs --watch');
assert.match(buildScript, /context\(options\)/);
assert.match(buildScript, /spawn\(process\.execPath/);
assert.match(buildScript, /['"]--watch['"],\s*['"]-p['"],\s*['"]\.\/['"]/);

console.log('build watch tests passed');
