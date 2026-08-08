import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');
const sourceRoot = path.join(repositoryRoot, 'packages', 'waveform-webview', 'src');
const destinationRoot = path.join(packageRoot, 'assets', 'waveform');

await build({
    entryPoints: [path.join(packageRoot, 'src', 'preload.ts')],
    outfile: path.join(packageRoot, 'dist', 'preload.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: true,
});

await rm(destinationRoot, { recursive: true, force: true });
await mkdir(destinationRoot, { recursive: true });

const body = await readFile(path.join(sourceRoot, 'index.html'), 'utf8');
const applicationScript = await readFile(path.join(sourceRoot, 'index.js'), 'utf8');
const desktopScript = applicationScript.replace('const bootstrap = ${stateJson};', 'const bootstrap = {};');
if (desktopScript === applicationScript) {
    throw new Error('waveform bootstrap marker was not found');
}

await Promise.all([
    copyFile(path.join(sourceRoot, 'index.css'), path.join(destinationRoot, 'index.css')),
    copyFile(
        path.join(sourceRoot, 'viewer-transport.js'),
        path.join(destinationRoot, 'viewer-transport.js')
    ),
    copyFile(path.join(sourceRoot, 'viewer-core.js'), path.join(destinationRoot, 'viewer-core.js')),
    writeFile(path.join(destinationRoot, 'index.js'), desktopScript, 'utf8'),
]);

await writeFile(path.join(destinationRoot, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VeriFlow Waveform</title>
<link rel="stylesheet" href="./index.css">
</head>
<body>
${body}
<script src="./viewer-transport.js"></script>
<script src="./viewer-core.js"></script>
<script src="./index.js"></script>
</body>
</html>
`, 'utf8');
