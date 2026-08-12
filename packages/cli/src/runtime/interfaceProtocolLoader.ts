import { readFile } from 'node:fs/promises';

import {
    createInterfaceProtocolCatalog,
    parseInterfaceProtocolText,
    type InterfaceProtocolCatalog,
    type InterfaceProtocolCatalogInput,
} from '@veriflow/schematic-core/interfaces';

export type InterfaceProtocolFileDiagnostic = Readonly<{
    source: string;
    path: string;
    code: string;
    message: string;
}>;

export type LoadedInterfaceProtocolCatalog = Readonly<{
    catalog: InterfaceProtocolCatalog;
    diagnostics: readonly InterfaceProtocolFileDiagnostic[];
}>;

export async function loadInterfaceProtocolCatalog(
    files: readonly string[]
): Promise<LoadedInterfaceProtocolCatalog> {
    const inputs: InterfaceProtocolCatalogInput[] = [];
    const diagnostics: InterfaceProtocolFileDiagnostic[] = [];
    for (const source of files) {
        let text: string;
        try {
            text = await readFile(source, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                diagnostics.push({
                    source,
                    path: '$',
                    code: 'IF_PROTOCOL_FILE_NOT_FOUND',
                    message: 'Interface protocol file not found',
                });
                continue;
            }
            throw error;
        }
        const parsed = parseInterfaceProtocolText(text);
        if (parsed.status === 'invalid') {
            diagnostics.push(...parsed.diagnostics.map(item => ({ source, ...item })));
            continue;
        }
        if (parsed.status === 'unsupported') {
            diagnostics.push({
                source,
                path: '$.schemaVersion',
                code: 'IF_PROTOCOL_SCHEMA_UNSUPPORTED',
                message: `Interface protocol schema version ${parsed.schemaVersion} is not supported`,
            });
            continue;
        }
        inputs.push({ source, value: JSON.parse(text) as unknown });
    }
    const catalog = createInterfaceProtocolCatalog(inputs);
    diagnostics.push(...catalog.diagnostics);
    return Object.freeze({
        catalog,
        diagnostics: Object.freeze(diagnostics.map(item => Object.freeze({ ...item }))),
    });
}
