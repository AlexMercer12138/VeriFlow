import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, '.artifacts', 'parser-worker', 'parser-worker.exe');
const request = {
    protocolVersion: 1,
    requestId: 'smoke-1',
    type: 'probe',
    payload: {
        source: 'module top; endmodule',
    },
};

function runProbe() {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [], {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 10_000);
        child.once('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal, stderr, stdout, timedOut });
        });
        child.stdin.end(`${JSON.stringify(request)}\n`);
    });
}

const result = await runProbe();
if (result.timedOut) {
    throw new Error('Parser SEA smoke probe timed out after 10 seconds');
}
if (result.code !== 0) {
    throw new Error(
        `Parser SEA exited with code ${result.code} and signal ${result.signal ?? 'none'}: ${result.stderr}`
    );
}
if (result.stderr !== '') {
    throw new Error(`Parser SEA wrote unexpected stderr: ${result.stderr}`);
}

const lines = result.stdout.split(/\r?\n/);
if (lines.at(-1) === '') lines.pop();
if (lines.length !== 1 || lines[0].length === 0) {
    throw new Error(`Expected exactly one JSONL response, received: ${JSON.stringify(result.stdout)}`);
}

let response;
try {
    response = JSON.parse(lines[0]);
} catch (error) {
    throw new Error(`Parser SEA returned invalid JSON: ${error.message}`);
}
if (response.protocolVersion !== 1
    || response.requestId !== 'smoke-1'
    || response.type !== 'probe'
    || response.ok !== true
    || response.payload?.containsModule !== true) {
    throw new Error(`Parser SEA returned an invalid probe response: ${lines[0]}`);
}

process.stdout.write(`${lines[0]}\n`);
