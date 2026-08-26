import { isDeepStrictEqual } from 'node:util';

const OBSERVABLE_FIELDS = [
    'status',
    'exitClass',
    'termination',
    'signalCode',
    'stdout',
    'stderr',
    'combinedOutput',
    'diagnostics',
    'unexpectedFiles',
    'cause',
];

export function normalizeRegressionResult(result, options = {}) {
    const normalize = value => normalizeText(value, options);
    return {
        ...result,
        ...(typeof result.stdout === 'string' ? { stdout: normalize(result.stdout) } : {}),
        ...(typeof result.stderr === 'string' ? { stderr: normalize(result.stderr) } : {}),
        ...(typeof result.combinedOutput === 'string'
            ? { combinedOutput: normalize(result.combinedOutput) }
            : {}),
        ...(Array.isArray(result.diagnostics) ? {
            diagnostics: result.diagnostics.map(diagnostic => (
                normalizeStructuredText(diagnostic, normalize)
            )),
        } : {}),
        ...(Array.isArray(result.unexpectedFiles) ? {
            unexpectedFiles: result.unexpectedFiles.map(file => (
                typeof file === 'string' ? normalize(file) : file
            )),
        } : {}),
        ...(result.cause === undefined ? {} : {
            cause: normalizeStructuredText(result.cause, normalize),
        }),
    };
}

function normalizeStructuredText(value, normalize) {
    if (typeof value === 'string') return normalize(value);
    if (Array.isArray(value)) {
        return value.map(item => normalizeStructuredText(item, normalize));
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            normalizeStructuredText(item, normalize),
        ]));
    }
    return value;
}

export function normalizeText(value, options = {}) {
    let normalized = value.replace(/\r\n?/g, '\n');
    for (const root of options.rootPrefixes ?? []) {
        if (root.path === '') throw new Error('Root prefix path must not be empty');
        normalized = normalized.replaceAll(root.path, root.replacement);
    }
    for (const timing of options.timingPatterns ?? []) {
        if (!(timing.pattern instanceof RegExp)) {
            throw new TypeError('Timing pattern must be a RegExp');
        }
        normalized = normalized.replace(timing.pattern, timing.replacement);
    }
    return normalized;
}

export function compareNormalizedResults(left, right) {
    const fields = OBSERVABLE_FIELDS.filter(field => (
        !sameValue(left[field], right[field])
    ));
    return { match: fields.length === 0, fields };
}

function sameValue(left, right) {
    return isDeepStrictEqual(left, right);
}
