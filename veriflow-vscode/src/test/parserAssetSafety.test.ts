import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const extensionRoot = path.resolve(__dirname, '..', '..');
const buildScript = fs.readFileSync(
    path.join(extensionRoot, 'scripts', 'build.mjs'),
    'utf8'
);

const verifyCall = buildScript.indexOf('await verifyParserAssets(parserAssets);');
const copyCall = buildScript.indexOf('await copyParserAssets(parserAssets);');

assert.notStrictEqual(verifyCall, -1, 'build must verify parser source assets');
assert.notStrictEqual(copyCall, -1, 'build must copy parser assets after verification');
assert.ok(
    verifyCall < copyCall,
    'all parser source assets must be verified before any destination is overwritten'
);

console.log('parser asset safety tests passed');
