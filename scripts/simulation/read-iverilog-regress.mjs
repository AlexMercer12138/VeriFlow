#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPPORTED_TYPES = new Set(['normal', 'CE', 'RE', 'CO']);
const NON_VERILOG_2005_GENERATIONS = new Set([
    '-g1995',
    '-g2001',
    '-g2001-noconfig',
    '-g2005-sv',
    '-g2009',
    '-g2012',
    '-g2017',
    '-g2023',
]);

export function parseRegressionList(sourceText) {
    const cases = [];
    const exclusions = [];

    for (const logicalLine of logicalLines(sourceText)) {
        const line = logicalLine.text.replace(/#.*$/, '').trim();
        if (line === '') continue;
        const fields = line.split(/\s+/);
        if (fields.length < 3 || fields.length > 5) {
            throw new Error(
                `Invalid regression entry at line ${logicalLine.lineNumber}: expected 3 to 5 fields`,
            );
        }

        const name = fields[0];
        const [type, ...options] = fields[1].split(',');
        if (!SUPPORTED_TYPES.has(type)) {
            throw new Error(
                `Unsupported regression type ${type} for ${name} at line ${logicalLine.lineNumber}`,
            );
        }

        const compilerOptions = options.filter(option => !option.startsWith('+'));
        const plusargs = options.filter(option => option.startsWith('+'));
        const sourceDirectory = fields[2];
        const entry = {
            name,
            type,
            sourceDirectory,
            source: path.posix.join(sourceDirectory, `${name}.v`),
            compilerOptions,
            plusargs,
            ...parseOptionalFields(fields.slice(3), name, logicalLine.lineNumber),
        };
        cases.push(entry);

        const generation = compilerOptions.find(option => (
            NON_VERILOG_2005_GENERATIONS.has(option)
        ));
        if (generation !== undefined) {
            const reason = `explicit non-Verilog-2005 generation: ${generation}`;
            entry.exclusionReason = reason;
            exclusions.push({ name, reason, generation });
        }
    }

    return {
        schemaVersion: 1,
        activeCount: cases.length,
        eligibleCount: cases.length - exclusions.length,
        cases,
        exclusions,
    };
}

function logicalLines(sourceText) {
    const physicalLines = sourceText.replace(/\r\n?/g, '\n').split('\n');
    const result = [];
    for (let index = 0; index < physicalLines.length; index += 1) {
        const lineNumber = index + 1;
        let text = physicalLines[index];
        while (/\\\s*$/.test(text)) {
            text = text.replace(/\\\s*$/, '');
            index += 1;
            if (index >= physicalLines.length) {
                throw new Error(`Unterminated continuation at line ${lineNumber}`);
            }
            text += physicalLines[index].trimStart();
        }
        result.push({ lineNumber, text });
    }
    return result;
}

function parseOptionalFields(fields, name, lineNumber) {
    if (fields.length === 0) return {};
    if (fields.length === 1) {
        const comparison = parseComparison(fields[0]);
        return comparison === undefined
            ? { topModule: fields[0] }
            : { comparison };
    }
    const comparison = parseComparison(fields[1]);
    if (comparison === undefined) {
        throw new Error(
            `Invalid comparison for ${name} at line ${lineNumber}: ${fields[1]}`,
        );
    }
    return { topModule: fields[0], comparison };
}

function parseComparison(field) {
    if (field.startsWith('gold=')) {
        return { kind: 'gold', path: path.posix.join('gold', field.slice(5)) };
    }
    if (field.startsWith('unordered=')) {
        return {
            kind: 'unordered',
            path: path.posix.join('gold', field.slice('unordered='.length)),
        };
    }
    if (field.startsWith('diff=')) {
        const [actual, expected, offsetText] = field.slice(5).split(':');
        return {
            kind: 'diff',
            actual,
            path: expected,
            offset: offsetText === undefined ? 0 : Number(offsetText),
        };
    }
    return undefined;
}

export async function readRegressionManifest({ iverilogRoot }) {
    const listPath = path.join(iverilogRoot, 'ivtest', 'regress-vlg.list');
    const sourceText = await readFile(listPath, 'utf8');
    return {
        ...parseRegressionList(sourceText),
        list: 'ivtest/regress-vlg.list',
    };
}

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument !== '--iverilog-root' && argument !== '--output') {
            throw new Error(`Unknown option: ${argument}`);
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        const key = argument === '--iverilog-root' ? 'iverilogRoot' : 'output';
        if (options[key] !== undefined) throw new Error(`Duplicate option: ${argument}`);
        options[key] = value;
        index += 1;
    }
    if (options.iverilogRoot === undefined) throw new Error('--iverilog-root is required');
    if (options.output === undefined) throw new Error('--output is required');
    return options;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const manifest = await readRegressionManifest(options);
    await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`active=${manifest.activeCount} eligible=${manifest.eligibleCount}`);
    for (const exclusion of manifest.exclusions) {
        console.log(`excluded ${exclusion.name}: ${exclusion.reason}`);
    }
}

const isMain = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
