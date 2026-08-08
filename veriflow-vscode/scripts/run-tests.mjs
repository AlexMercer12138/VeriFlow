import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const testRoot = path.join(process.cwd(), 'out', 'test');
const registeredTests = ['pathStyle.test.js', 'rootBuild.test.js', 'webDistAssets.test.js'];
const finalTests = ['vsixPackaging.test.js'];
const regularFiles = [...new Set([
    ...(await readdir(testRoot)).filter(name => name.endsWith('.test.js')),
    ...registeredTests,
])].filter(name => !finalTests.includes(name)).sort();
const files = [...regularFiles, ...finalTests];

for (const file of files) {
    const result = spawnSync(process.execPath, [path.join(testRoot, file)], {
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

console.log(`passed ${files.length} test files`);
