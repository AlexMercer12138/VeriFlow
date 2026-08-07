import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

type RootWatchModule = {
    watchVscode(options: {
        repositoryRoot: string;
        buildWebAssets: () => Promise<void>;
        extensionWatch: {
            command: string;
            args: string[];
            cwd: string;
            stdio: 'ignore';
        };
    }): Promise<void>;
};

const timeoutMs = 15_000;
const loadEsmModule = new Function(
    'specifier',
    'return import(specifier);'
) as (specifier: string) => Promise<RootWatchModule>;

const delay = (milliseconds: number): Promise<void> => new Promise(
    resolve => setTimeout(resolve, milliseconds)
);

async function waitUntil(
    predicate: () => boolean,
    description: string,
    timeout = timeoutMs
): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(50);
    }
    throw new Error(`Timed out waiting for ${description}`);
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function run(): Promise<void> {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const watchModule = await loadEsmModule(pathToFileURL(
        path.join(repositoryRoot, 'scripts', 'watch-vscode.mjs')
    ).href);
    const rootManifest = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    const extensionManifest = JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, 'veriflow-vscode', 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> };

    assert.strictEqual(rootManifest.scripts['watch:vscode'], 'node scripts/watch-vscode.mjs');
    assert.strictEqual(extensionManifest.scripts.watch, 'node ../scripts/watch-vscode.mjs');

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-root-watch-'));
    const waveformSource = path.join(
        fixtureRoot,
        'packages',
        'waveform-webview',
        'src',
        'marker.txt'
    );
    const schematicSource = path.join(
        fixtureRoot,
        'packages',
        'schematic-webview',
        'src',
        'marker.txt'
    );
    const waveformMedia = path.join(
        fixtureRoot,
        'veriflow-vscode',
        'media',
        'waveform',
        'index.js'
    );
    const schematicMedia = path.join(
        fixtureRoot,
        'veriflow-vscode',
        'media',
        'schematic',
        'index.js'
    );
    const childScript = path.join(fixtureRoot, 'extension-watch-child.mjs');
    const childPidFile = path.join(fixtureRoot, 'extension-watch.pid');
    let running: Promise<void> | undefined;
    let childPid: number | undefined;
    let buildCount = 0;
    let watchError: unknown;
    const initialSigintListeners = process.listenerCount('SIGINT');

    try {
        fs.mkdirSync(path.dirname(waveformSource), { recursive: true });
        fs.mkdirSync(path.dirname(schematicSource), { recursive: true });
        fs.writeFileSync(waveformSource, 'initial-waveform\n');
        fs.writeFileSync(schematicSource, 'initial-schematic\n');
        fs.writeFileSync(childScript, [
            "import { writeFileSync } from 'node:fs';",
            'writeFileSync(process.argv[2], String(process.pid));',
            'setInterval(() => undefined, 1_000);',
        ].join('\n'));
        assert.strictEqual(fs.existsSync(path.dirname(waveformMedia)), false);
        assert.strictEqual(fs.existsSync(path.dirname(schematicMedia)), false);

        const buildWebAssets = async (): Promise<void> => {
            buildCount += 1;
            const waveformMarker = fs.readFileSync(waveformSource, 'utf8').trim();
            const schematicMarker = fs.readFileSync(schematicSource, 'utf8').trim();
            const webDist = path.join(fixtureRoot, 'web-dist');
            fs.rmSync(webDist, { recursive: true, force: true });
            for (const [application, marker, files] of [
                ['waveform', waveformMarker, [
                    'index.css',
                    'index.html',
                    'index.js',
                    'viewer-core.js',
                    'viewer-transport.js',
                ]],
                ['schematic', schematicMarker, ['index.css', 'index.html', 'index.js']],
            ] as const) {
                const destination = path.join(webDist, application);
                fs.mkdirSync(destination, { recursive: true });
                for (const file of files) {
                    fs.writeFileSync(path.join(destination, file), `${marker}:${file}\n`);
                }
            }
        };
        running = watchModule.watchVscode({
            repositoryRoot: fixtureRoot,
            buildWebAssets,
            extensionWatch: {
                command: process.execPath,
                args: [childScript, childPidFile],
                cwd: fixtureRoot,
                stdio: 'ignore',
            },
        }).catch(error => { watchError = error; });

        await waitUntil(() => {
            if (watchError) throw watchError;
            return fs.existsSync(waveformMedia)
                && fs.existsSync(schematicMedia)
                && fs.existsSync(childPidFile);
        }, 'clean media build and extension watcher startup');
        assert.match(fs.readFileSync(waveformMedia, 'utf8'), /initial-waveform/);
        assert.match(fs.readFileSync(schematicMedia, 'utf8'), /initial-schematic/);
        childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
        assert.ok(Number.isInteger(childPid) && processExists(childPid));

        const previousBuildCount = buildCount;
        fs.writeFileSync(waveformSource, 'updated-waveform\n');
        await waitUntil(() => {
            if (watchError) throw watchError;
            return buildCount > previousBuildCount
                && fs.existsSync(waveformMedia)
                && fs.readFileSync(waveformMedia, 'utf8').includes('updated-waveform');
        }, 'waveform source change propagation');

        process.emit('SIGINT');
        await running;
        assert.strictEqual(watchError, undefined);
        assert.strictEqual(process.listenerCount('SIGINT'), initialSigintListeners);
        await waitUntil(() => !processExists(childPid!), 'extension watcher shutdown');

        const completedBuildCount = buildCount;
        fs.writeFileSync(waveformSource, 'after-stop\n');
        await delay(250);
        assert.strictEqual(buildCount, completedBuildCount);
    } finally {
        if (running) {
            process.emit('SIGINT');
            await Promise.race([running, delay(2_000)]);
        }
        if (childPid && processExists(childPid)) {
            process.kill(childPid);
        }
        fs.rmSync(fixtureRoot, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50,
        });
    }
}

run()
    .then(() => console.log('root watch tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
