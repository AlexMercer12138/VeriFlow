import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs')], {
    cwd: root,
    stdio: 'inherit',
});
execFileSync('git', ['diff', '--exit-code', '--', 'web-dist'], {
    cwd: root,
    stdio: 'inherit',
});
