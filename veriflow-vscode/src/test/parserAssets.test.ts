import * as assert from 'assert';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..');
const parserRoot = path.join(extensionRoot, 'media', 'parsers');

const grammarWasm = path.join(parserRoot, 'tree-sitter-systemverilog.wasm');
const runtimeWasm = path.join(parserRoot, 'web-tree-sitter.wasm');

assert.ok(fs.statSync(grammarWasm).size > 1_000_000);
assert.ok(fs.statSync(runtimeWasm).size > 100_000);

const sha256 = (file: string): string => createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');

assert.strictEqual(
    sha256(grammarWasm),
    'e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d'
);
assert.strictEqual(
    sha256(runtimeWasm),
    '715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc'
);

assert.ok(
    fs.readFileSync(path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
        .includes('tree-sitter-systemverilog')
);

const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
) as {
    engines: { vscode: string; node?: string };
};
assert.strictEqual(manifest.engines.vscode, '^1.82.0');
assert.strictEqual(manifest.engines.node, undefined);
assert.strictEqual(
    fs.readFileSync(path.join(extensionRoot, '.nvmrc'), 'utf8').trim(),
    '20'
);

const buildScript = fs.readFileSync(
    path.join(extensionRoot, 'scripts', 'build.mjs'),
    'utf8'
);
assert.match(buildScript, /target:\s*['"]node18['"]/);

console.log('parser asset tests passed');
