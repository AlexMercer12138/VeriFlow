import * as path from 'path';
import { fileURLToPath } from 'url';

import type { ModuleInfo } from '../types';
import type { HdlDefinitionSummary } from './workspaceIndexTypes';

function sourceLocation(uri: string): { filename: string; filepath: string } {
    try {
        const parsed = new URL(uri);
        if (parsed.protocol === 'file:') {
            const filepath = fileURLToPath(parsed);
            return { filename: path.basename(filepath), filepath };
        }
        let pathname = parsed.pathname;
        try {
            pathname = decodeURIComponent(pathname);
        } catch {
            // Keep the encoded URI path when it contains an invalid escape.
        }
        return {
            filename: path.posix.basename(pathname) || uri,
            filepath: uri,
        };
    } catch {
        return {
            filename: path.basename(uri) || uri,
            filepath: uri,
        };
    }
}

export function toModuleInfo(definition: HdlDefinitionSummary): ModuleInfo {
    const location = sourceLocation(definition.uri);
    return {
        name: definition.name,
        parameters: definition.parameters.map(item => ({
            name: item.name,
            value: item.defaultExpression ?? item.name,
        })),
        ports: definition.ports.map(item => ({
            name: item.name,
            direction: item.direction,
            width: item.packedRange,
        })),
        filename: location.filename,
        filepath: location.filepath,
        dependencies: [...definition.dependencies],
        isTB: false,
    };
}
