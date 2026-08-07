import * as assert from 'assert';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const extensionRoot = path.resolve(__dirname, '..', '..');
const supportUrl = pathToFileURL(
    path.join(extensionRoot, 'scripts', 'build-support.mjs')
).href;
const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8')
) as {
    main: string;
    scripts: { watch: string };
};
const timeoutMs = 15_000;

function testWatchTypeScriptCliResolvesFromWorkspace(): void {
    const buildScript = path.join(extensionRoot, 'scripts', 'build.mjs');
    const nestedTypeScriptCli = path.join(
        extensionRoot,
        'node_modules',
        'typescript',
        'bin',
        'tsc'
    );
    const resolvedTypeScriptCli = createRequire(buildScript).resolve('typescript/bin/tsc');
    const buildSource = fs.readFileSync(buildScript, 'utf8');

    assert.strictEqual(fs.existsSync(nestedTypeScriptCli), false);
    assert.ok(fs.existsSync(resolvedTypeScriptCli));
    assert.notStrictEqual(resolvedTypeScriptCli, nestedTypeScriptCli);
    assert.doesNotMatch(
        buildSource,
        /path\.join\(extensionRoot,\s*'node_modules',\s*'typescript',\s*'bin',\s*'tsc'\)/
    );
    assert.match(
        buildSource,
        /workspaceRequire\.resolve\(\s*'typescript\/bin\/tsc'\s*\)/
    );
}

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

function terminateProcess(pid: number): void {
    try {
        process.kill(pid);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
}

async function waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for process ${child.pid} to exit`)),
            timeoutMs
        );
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

async function stopProcess(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.connected) {
        child.send('stop');
    } else {
        child.kill();
    }
    try {
        await waitForExit(child);
    } catch {
        child.kill();
        await waitForExit(child);
    }
}

async function testBuildWatch(): Promise<void> {
    testWatchTypeScriptCliResolvesFromWorkspace();
    assert.strictEqual(manifest.main, './dist/extension.js');
    assert.strictEqual(manifest.scripts.watch, 'node ./scripts/build.mjs --watch');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-build-watch-'));
    const sourceRoot = path.join(root, 'src');
    const distRoot = path.join(root, 'dist');
    const childPidFile = path.join(root, 'typecheck.pid');
    const typecheckScript = path.join(root, 'typecheck-child.mjs');
    const sourceFiles = ['extension.js', 'hdl-worker.js', 'waveform-worker.js']
        .map(name => path.join(sourceRoot, name));
    const outputFiles = ['extension.js', 'workers/hdlParserWorker.js', 'workers/waveformWorker.js']
        .map(name => path.join(distRoot, name));
    let parent: ChildProcess | undefined;
    let childPid: number | undefined;
    let output = '';
    const testFailures: unknown[] = [];

    try {
        fs.mkdirSync(sourceRoot, { recursive: true });
        sourceFiles.forEach((file, index) => {
            fs.writeFileSync(file, `export const marker = 'initial-${index}';\n`);
        });
        fs.writeFileSync(typecheckScript, [
            "import { writeFileSync } from 'node:fs';",
            'writeFileSync(process.argv[2], String(process.pid));',
            'setInterval(() => undefined, 1_000);',
        ].join('\n'));

        const runner = `
const { runWatch } = await import(process.env.VERIFLOW_BUILD_SUPPORT);
const fixture = JSON.parse(process.env.VERIFLOW_WATCH_FIXTURE);
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node18' };
const stopRequested = new Promise(resolve => process.once('message', resolve));
await runWatch({
    bundleOptions: fixture.sourceFiles.map((entry, index) => ({
        ...common,
        entryPoints: [entry],
        outfile: fixture.outputFiles[index],
    })),
    cwd: fixture.root,
    typecheck: {
        command: process.execPath,
        args: [fixture.typecheckScript, fixture.childPidFile],
        stdio: 'ignore',
    },
    stopRequested,
});
`;
        parent = spawn(process.execPath, ['--input-type=module', '--eval', runner], {
            env: {
                ...process.env,
                VERIFLOW_BUILD_SUPPORT: supportUrl,
                VERIFLOW_WATCH_FIXTURE: JSON.stringify({
                    root,
                    sourceFiles,
                    outputFiles,
                    typecheckScript,
                    childPidFile,
                }),
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        parent.stdout?.on('data', data => { output += data.toString(); });
        parent.stderr?.on('data', data => { output += data.toString(); });

        await waitUntil(() => {
            if (parent?.exitCode !== null || parent?.signalCode !== null) {
                throw new Error(`Watcher exited before initial build:\n${output}`);
            }
            return outputFiles.every(file => fs.existsSync(file))
                && fs.existsSync(childPidFile);
        }, 'three initial bundles and the typecheck child');

        outputFiles.forEach((file, index) => {
            assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`initial-${index}`));
        });
        childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
        assert.ok(Number.isInteger(childPid) && processExists(childPid));

        const changedOutput = outputFiles[1];
        const previousMtime = fs.statSync(changedOutput).mtimeMs;
        fs.writeFileSync(sourceFiles[1], "export const marker = 'updated-worker';\n");
        await waitUntil(() => {
            if (!fs.existsSync(changedOutput)) return false;
            return fs.statSync(changedOutput).mtimeMs > previousMtime
                && fs.readFileSync(changedOutput, 'utf8').includes('updated-worker');
        }, 'incremental worker bundle update');

        parent.send?.('stop');
        await waitForExit(parent);
        assert.strictEqual(parent.exitCode, 0, output);
        await waitUntil(
            () => !processExists(parent!.pid!) && !processExists(childPid!),
            'watch parent and typecheck child termination'
        );
    } catch (error) {
        testFailures.push(error);
    }

    const cleanupFailures: unknown[] = [];
    if (parent) {
        try {
            await stopProcess(parent);
        } catch (error) {
            cleanupFailures.push(error);
        }
    }
    if (childPid && processExists(childPid)) {
        try {
            terminateProcess(childPid);
        } catch (error) {
            cleanupFailures.push(error);
        }
    }
    try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
        cleanupFailures.push(error);
    }

    if (testFailures.length) {
        throw testFailures[0];
    }
    if (cleanupFailures.length) {
        throw cleanupFailures[0];
    }
}

testBuildWatch()
    .then(() => console.log('build watch tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
