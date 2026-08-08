import { existsSync } from 'node:fs';
import path from 'node:path';

import { ProjectStore } from '@veriflow/flow-core';

import { CommandEnvironment, CommandOptions } from './project';

function openProject(
    store: ProjectStore,
    environment: CommandEnvironment,
    filepath: string
) {
    const resolved = path.resolve(environment.cwd, filepath);
    if (!existsSync(resolved)) {
        throw new Error(`Project file not found: ${filepath}`);
    }
    return { project: store.open(resolved), filepath: resolved };
}

export function topSet(options: CommandOptions, environment: CommandEnvironment): number {
    const store = new ProjectStore();
    const opened = openProject(store, environment, options.project!);
    opened.project.topModule = options.top!;
    store.save(opened.project, opened.filepath, { preserveUnknown: false });
    environment.stdout(`Top module set to: ${options.top}\n`);
    return 0;
}

export function topGet(options: CommandOptions, environment: CommandEnvironment): number {
    const opened = openProject(new ProjectStore(), environment, options.project!);
    environment.stdout(`${opened.project.topModule || '(not set)'}\n`);
    return 0;
}
