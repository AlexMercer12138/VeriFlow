#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseError, runRelease } from './lib/release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
    process.exitCode = runRelease(process.argv.slice(2), { root });
} catch (error) {
    const message = error instanceof ReleaseError || error instanceof Error
        ? error.message
        : String(error);
    console.error(`[release] ERROR: ${message}`);
    process.exitCode = 2;
}
