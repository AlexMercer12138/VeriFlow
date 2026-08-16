import { appendFileSync, writeFileSync } from 'node:fs';

const [capturePath, action, ...args] = process.argv.slice(2);
appendFileSync(capturePath, `${JSON.stringify({ action, args, cwd: process.cwd() })}\n`);

switch (action) {
    case 'compile':
        process.stdout.write('COMPILE OK\n');
        break;
    case 'compile-fail':
        process.stdout.write('COMPILE OUTPUT\n');
        process.stderr.write('top.v:3: error: compile failed\n');
        process.exitCode = 2;
        break;
    case 'run':
        process.stdout.write('RUN OK\n');
        break;
    case 'run-artifact':
        writeFileSync(args[1], 'VCD DATA\n');
        process.stdout.write('RUN OK\n');
        break;
    case 'wait':
        writeFileSync(args.at(-1), String(process.pid));
        setInterval(() => {}, 1_000);
        break;
    default:
        process.stderr.write(`unknown fake simulator action: ${action}\n`);
        process.exitCode = 64;
}
