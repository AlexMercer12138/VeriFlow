import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../../..');

const outputFiles = {
    waveform: [
        'index.css',
        'index.html',
        'index.js',
        'viewer-core.js',
        'viewer-transport.js',
    ],
    schematic: ['index.css', 'index.html', 'index.js'],
};

for (const [application, expectedFiles] of Object.entries(outputFiles)) {
    const outputRoot = path.join(root, 'web-dist', application);
    assert.deepStrictEqual(fs.readdirSync(outputRoot).sort(), expectedFiles);
    for (const fileName of expectedFiles) {
        assert.ok(
            fs.statSync(path.join(outputRoot, fileName)).size > 0,
            `web-dist/${application}/${fileName} is missing`
        );
    }
}

for (const [application, fileNames] of Object.entries({
    waveform: outputFiles.waveform,
    schematic: ['index.css', 'index.html'],
})) {
    for (const fileName of fileNames) {
        assert.deepStrictEqual(
            fs.readFileSync(path.join(root, 'web-dist', application, fileName)),
            fs.readFileSync(path.join(root, 'packages', `${application}-webview`, 'src', fileName)),
            `${application}/${fileName} must be copied byte-for-byte`
        );
    }
}

assert.ok(
    !fs.existsSync(path.join(root, 'veriflow-vscode', 'webview', 'schematic', 'index.ts')),
    'the old schematic webview source must not exist'
);

console.log('canonical web asset tests passed');
