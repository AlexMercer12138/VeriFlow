import * as path from 'path';
import { fileURLToPath } from 'url';

import type { HdlDefinitionSummary } from './hdl/workspaceIndexTypes';

export interface ModuleInstantiationChoice {
    label: string;
    description: string;
    moduleName: string;
    definitionKey: string;
    modelFingerprint: string;
}

function localFilepath(uri: string): string | undefined {
    try {
        const parsed = new URL(uri);
        return parsed.protocol === 'file:' ? fileURLToPath(parsed) : undefined;
    } catch {
        return undefined;
    }
}

function describeDefinition(definition: HdlDefinitionSummary, root: string): string {
    const filepath = localFilepath(definition.uri);
    if (!filepath) {
        return definition.uri;
    }
    const relative = path.relative(root, filepath);
    const outsideRoot = relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative);
    if (!relative || outsideRoot) {
        return filepath;
    }
    return relative.split(path.sep).join('/');
}

export function buildModuleInstantiationChoices(
    definitions: readonly HdlDefinitionSummary[],
    workspaceRoot: string = process.cwd()
): ModuleInstantiationChoice[] {
    const countsByNameAndUri = new Map<string, number>();
    for (const definition of definitions) {
        const key = JSON.stringify([definition.name, definition.uri]);
        countsByNameAndUri.set(key, (countsByNameAndUri.get(key) ?? 0) + 1);
    }
    return [...definitions]
        .sort((left, right) => left.name.localeCompare(right.name)
            || left.uri.localeCompare(right.uri)
            || left.declarationStart - right.declarationStart)
        .map(definition => {
            const sourceCount = countsByNameAndUri.get(JSON.stringify([
                definition.name,
                definition.uri,
            ])) ?? 0;
            const description = describeDefinition(definition, workspaceRoot);
            return {
                label: definition.name,
                description: sourceCount > 1
                    ? `${description}:${definition.declarationLine}`
                    : description,
                moduleName: definition.name,
                definitionKey: definition.key,
                modelFingerprint: definition.modelFingerprint,
            };
        });
}
