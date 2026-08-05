import { fileURLToPath } from 'url';

import type { WorkspaceHdlIndex } from './hdl/workspaceHdlIndex';
import type { HdlDefinitionSummary } from './hdl/workspaceIndexTypes';
import { DependencyResult } from './types';

function indexedUriToPath(uri: string): string {
    let parsed: URL;
    try {
        parsed = new URL(uri);
    } catch {
        return uri;
    }
    if (parsed.protocol !== 'file:') {
        return uri;
    }
    try {
        return fileURLToPath(parsed);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid indexed file URI "${uri}": ${message}`);
    }
}

export class DependencyAnalyzer {
    constructor(private readonly index: WorkspaceHdlIndex) {}

    resolve(
        topDefinitionKeyOrUniqueName: string,
        bindings: Record<string, string> = {}
    ): DependencyResult {
        const missing = new Set<string>();
        const ambiguous = new Map<string, string[]>();
        const exactTop = this.index.getDefinition(topDefinitionKeyOrUniqueName);
        let topDefinition = exactTop?.kind === 'module' ? exactTop : undefined;

        if (!topDefinition) {
            const candidates = this.index.findDefinitions(
                topDefinitionKeyOrUniqueName,
                'module'
            );
            if (candidates.length === 1) {
                topDefinition = candidates[0];
            } else if (candidates.length === 0) {
                missing.add(topDefinitionKeyOrUniqueName);
            } else {
                ambiguous.set(
                    topDefinitionKeyOrUniqueName,
                    candidates.map(candidate => candidate.key).sort()
                );
            }
        }

        const result: DependencyResult = {
            topModule: topDefinition?.name ?? topDefinitionKeyOrUniqueName,
            topDefinitionKey: topDefinition?.key ?? '',
            files: [],
            missingModules: [],
            ambiguousModules: {},
            moduleMap: {},
            depGraph: {},
        };
        if (!topDefinition) {
            return this.finalize(result, missing, ambiguous);
        }

        const definitionState = new Map<string, 'visiting' | 'done'>();
        const fileState = new Map<string, 'visiting' | 'done'>();

        const addFile = (uri: string): void => {
            const state = fileState.get(uri);
            if (state === 'visiting' || state === 'done') {
                return;
            }
            fileState.set(uri, 'visiting');
            const includes = [...new Set(this.index.getFile(uri)?.includeUris ?? [])].sort();
            for (const includeUri of includes) {
                addFile(includeUri);
            }
            result.files.push(indexedUriToPath(uri));
            fileState.set(uri, 'done');
        };

        const visit = (definition: HdlDefinitionSummary): void => {
            const state = definitionState.get(definition.key);
            if (state === 'visiting' || state === 'done') {
                return;
            }
            definitionState.set(definition.key, 'visiting');
            result.moduleMap[definition.name] = indexedUriToPath(definition.uri);

            const dependencyNames = [...new Set(definition.dependencies)].sort();
            result.depGraph[definition.name] = dependencyNames;
            for (const dependencyName of dependencyNames) {
                const candidates = this.index.findDefinitions(dependencyName, 'module');
                if (candidates.length === 0) {
                    missing.add(dependencyName);
                    continue;
                }
                let selected: HdlDefinitionSummary | undefined;
                if (candidates.length === 1) {
                    selected = candidates[0];
                } else {
                    const binding = bindings[dependencyName];
                    selected = candidates.find(candidate => candidate.key === binding);
                    if (!selected) {
                        ambiguous.set(
                            dependencyName,
                            candidates.map(candidate => candidate.key).sort()
                        );
                        continue;
                    }
                }
                visit(selected);
            }

            addFile(definition.uri);
            definitionState.set(definition.key, 'done');
        };

        visit(topDefinition);
        return this.finalize(result, missing, ambiguous);
    }

    private finalize(
        result: DependencyResult,
        missing: Set<string>,
        ambiguous: Map<string, string[]>
    ): DependencyResult {
        result.missingModules = [...missing].sort();
        result.ambiguousModules = Object.fromEntries(
            [...ambiguous.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, keys]) => [name, [...new Set(keys)].sort()])
        );
        return result;
    }
}
