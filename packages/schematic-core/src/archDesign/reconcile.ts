import { applyArchDesignEdit } from './edit';
import type { ArchDesign, ArchDesignInstance } from './model';
import type { ArchDesignModuleDefinition } from './definitions';

function matchingDefinition(
    instance: ArchDesignInstance,
    definitionsByKey: ReadonlyMap<string, ArchDesignModuleDefinition>,
    definitionsByName: ReadonlyMap<string, readonly ArchDesignModuleDefinition[]>
): ArchDesignModuleDefinition | undefined {
    if (instance.definitionKey !== undefined) {
        const exact = definitionsByKey.get(instance.definitionKey);
        return exact?.name === instance.module ? exact : undefined;
    }
    const matches = definitionsByName.get(instance.module) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
}

export function reconcileArchDesignInstanceParameters(
    design: ArchDesign,
    definitions: readonly ArchDesignModuleDefinition[]
): ArchDesign {
    const definitionsByKey = new Map(definitions.map(definition => [
        definition.key,
        definition,
    ]));
    const mutableByName = new Map<string, ArchDesignModuleDefinition[]>();
    for (const definition of definitions) {
        const matches = mutableByName.get(definition.name) ?? [];
        matches.push(definition);
        mutableByName.set(definition.name, matches);
    }
    const definitionsByName = new Map<string, readonly ArchDesignModuleDefinition[]>(
        mutableByName
    );
    const instanceNameCounts = new Map<string, number>();
    for (const instance of design.instances) {
        instanceNameCounts.set(instance.name, (instanceNameCounts.get(instance.name) ?? 0) + 1);
    }

    let result = design;
    for (const instance of design.instances) {
        if (!instance.parameters || instanceNameCounts.get(instance.name) !== 1) continue;
        const definition = matchingDefinition(
            instance,
            definitionsByKey,
            definitionsByName
        );
        if (!definition) continue;
        const declared = new Set(definition.parameters.map(parameter => parameter.name));
        for (const parameter of Object.keys(instance.parameters)) {
            if (declared.has(parameter)) continue;
            result = applyArchDesignEdit(result, {
                type: 'setInstanceParameter',
                instance: instance.name,
                parameter,
            });
        }
    }
    return result;
}
