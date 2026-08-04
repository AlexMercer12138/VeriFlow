import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const testRoot = path.join(process.cwd(), 'out', 'test');
const files = (await readdir(testRoot))
    .filter(name => name.endsWith('.test.js'))
    .sort();

for (const file of files) {
    const result = spawnSync(process.execPath, [path.join(testRoot, file)], {
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

console.log(`passed ${files.length} test files`);
