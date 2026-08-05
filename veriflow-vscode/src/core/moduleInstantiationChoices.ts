import * as path from 'path';
import { fileURLToPath } from 'url';

import type { HdlDefinitionSummary } from './hdl/workspaceIndexTypes';

export interface ModuleInstantiationChoice {
    label: string;
    description: string;
    moduleName: string;
    definitionKey: string;
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
    return [...definitions]
        .sort((left, right) => left.name.localeCompare(right.name)
            || left.uri.localeCompare(right.uri)
            || left.declarationStart - right.declarationStart)
        .map(definition => ({
            label: definition.name,
            description: describeDefinition(definition, workspaceRoot),
            moduleName: definition.name,
            definitionKey: definition.key,
        }));
}
