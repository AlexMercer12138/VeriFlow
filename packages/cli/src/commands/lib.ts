import { existsSync } from 'node:fs';
import path from 'node:path';

import { GlobalConfigStore } from '@veriflow/flow-core';

import { CommandEnvironment, CommandOptions } from './project';

function writeLine(environment: CommandEnvironment, text: string): void {
    environment.stdout(`${text}\n`);
}

function configStore(environment: CommandEnvironment): GlobalConfigStore {
    return new GlobalConfigStore({ homeDir: environment.homeDir });
}

export function libAdd(options: CommandOptions, environment: CommandEnvironment): number {
    const configured = options.lib!;
    const directory = path.resolve(environment.cwd, configured);
    if (!existsSync(directory)) {
        environment.stderr(`Error: Directory not found: ${configured}\n`);
        return 1;
    }

    configStore(environment).addLibDir(directory);
    writeLine(environment, `Added global lib: ${directory}`);
    return 0;
}

export function libRemove(options: CommandOptions, environment: CommandEnvironment): number {
    const directory = options.lib!;
    configStore(environment).removeLibDir(directory);
    writeLine(environment, `Removed global lib: ${directory}`);
    return 0;
}

export function libList(_options: CommandOptions, environment: CommandEnvironment): number {
    const directories = configStore(environment).getLibDirs();
    if (directories.length === 0) {
        writeLine(environment, 'No global lib dirs configured.');
        return 0;
    }

    writeLine(environment, `Global lib dirs (${directories.length}):`);
    for (const directory of directories) {
        const resolved = path.resolve(environment.cwd, directory);
        writeLine(environment, `  ${existsSync(resolved) ? '[OK]' : '[--]'} ${directory}`);
    }
    return 0;
}
