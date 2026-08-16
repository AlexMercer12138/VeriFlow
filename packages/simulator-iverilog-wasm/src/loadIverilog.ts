import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IverilogApi } from './iverilogApi';

const IVERILOG_PACKAGE = '@veriflow/iverilog-wasm';
const importEsm = new Function(
    'specifier',
    'return import(specifier);',
) as (specifier: string) => Promise<IverilogApi>;

export interface ExtensionIverilogLoader {
    load(specifier?: string | URL): Promise<IverilogApi>;
}

export function loadIverilog(): Promise<IverilogApi> {
    return importEsm(IVERILOG_PACKAGE);
}

export function createExtensionIverilogLoader(
    extensionRoot: URL,
): ExtensionIverilogLoader {
    const root = validateFileUrl(extensionRoot, 'Trusted extension root');

    return {
        async load(specifier = IVERILOG_PACKAGE): Promise<IverilogApi> {
            if (specifier === IVERILOG_PACKAGE) {
                return importEsm(IVERILOG_PACKAGE);
            }

            const moduleUrl = parseModuleUrl(specifier);
            assertContained(
                fileURLToPath(root),
                fileURLToPath(moduleUrl),
            );
            const [trustedRoot, modulePath] = await Promise.all([
                realpath(fileURLToPath(root)),
                realpath(fileURLToPath(moduleUrl)),
            ]);
            assertContained(trustedRoot, modulePath);

            return importEsm(moduleUrl.href);
        },
    };
}

function assertContained(root: string, candidate: string): void {
    const relativePath = path.relative(root, candidate);

    if (
        relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)
    ) {
        throw new Error(
            'Icarus module specifier is outside the trusted extension root',
        );
    }
}

function parseModuleUrl(specifier: string | URL): URL {
    if (specifier instanceof URL) {
        return validateFileUrl(specifier, 'Icarus module specifier');
    }
    if (!specifier.startsWith('file:')) {
        throw new TypeError(
            `Icarus module specifier must be ${IVERILOG_PACKAGE} or a file: URL`,
        );
    }

    return validateFileUrl(new URL(specifier), 'Icarus module specifier');
}

function validateFileUrl(url: URL, label: string): URL {
    if (url.protocol !== 'file:') {
        throw new TypeError(
            `${label} must be ${IVERILOG_PACKAGE} or a file: URL`,
        );
    }
    if (url.search !== '' || url.hash !== '') {
        throw new TypeError(`${label} must not contain a query or fragment`);
    }

    fileURLToPath(url);
    return new URL(url.href);
}
