import * as path from 'path';
import { ModuleScanResult } from './types';

export interface ModuleInstantiationChoice {
    label: string;
    description: string;
    moduleName: string;
    filepath: string;
}

function describeFile(root: string, filepath: string): string {
    const relative = path.relative(root, filepath);
    const outsideRoot = relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative);
    return relative && !outsideRoot ? relative : filepath;
}

export function buildModuleInstantiationChoices(
    result: ModuleScanResult
): ModuleInstantiationChoice[] {
    const choices: ModuleInstantiationChoice[] = [];

    for (const moduleName of result.modules) {
        const duplicateEntries = result.duplicatesWithLines[moduleName];
        const files = duplicateEntries && duplicateEntries.length > 0
            ? duplicateEntries.map(entry => entry.file)
            : [result.moduleFiles[moduleName]].filter((filepath): filepath is string => Boolean(filepath));
        const seen = new Set<string>();

        for (const filepath of files) {
            if (seen.has(filepath)) { continue; }
            seen.add(filepath);
            choices.push({
                label: moduleName,
                description: describeFile(result.root, filepath),
                moduleName,
                filepath,
            });
        }
    }

    return choices;
}
