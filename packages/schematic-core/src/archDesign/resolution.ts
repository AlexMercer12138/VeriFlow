import type {
    ArchDesignDefinitionParameter,
    ArchDesignDefinitionPort,
    ArchDesignModuleDefinition,
} from './definitions';
import type { ArchDesign, ArchDesignInstance } from './model';
import { compareCodeUnits } from './ordering';
import type { ArchDesignDiagnostic } from './parser';

export type ResolvedArchDesignModuleDefinition = Readonly<{
    key: string;
    name: string;
    parameters: readonly ArchDesignDefinitionParameter[];
    ports: readonly ArchDesignDefinitionPort[];
    parametersByName: ReadonlyMap<string, ArchDesignDefinitionParameter>;
}>;

export type ResolvedArchDesignInstance = Readonly<{
    index: number;
    instance: ArchDesignInstance;
    definition?: ResolvedArchDesignModuleDefinition;
}>;

export type ArchDesignResolution = Readonly<{
    instances: readonly ResolvedArchDesignInstance[];
    diagnostics: readonly ArchDesignDiagnostic[];
}>;

function snapshotArray<T>(source: readonly T[]): T[] {
    const length = source.length;
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
        result.push(source[index]);
    }
    return result;
}

function snapshotParameter(
    source: ArchDesignDefinitionParameter
): ArchDesignDefinitionParameter {
    const name = source.name;
    const defaultExpression = source.defaultExpression;
    return Object.freeze({
        name,
        ...(defaultExpression === undefined ? {} : { defaultExpression }),
    });
}

function snapshotPort(source: ArchDesignDefinitionPort): ArchDesignDefinitionPort {
    const name = source.name;
    const direction = source.direction;
    const width = source.width;
    const kind = width.kind;
    const widthSnapshot = kind === 'known'
        ? Object.freeze({ kind, bits: width.bits })
        : kind === 'symbolic'
            ? Object.freeze({ kind, expression: width.expression })
            : Object.freeze({ kind });
    return Object.freeze({ name, direction, width: widthSnapshot });
}

function snapshotDefinition(
    source: ArchDesignModuleDefinition
): ResolvedArchDesignModuleDefinition {
    const key = source.key;
    const name = source.name;
    const parameterSources = source.parameters;
    const portSources = source.ports;
    const parameters = snapshotArray(parameterSources).map(snapshotParameter);
    const ports = snapshotArray(portSources).map(snapshotPort);
    const parametersByName = new Map<string, ArchDesignDefinitionParameter>();
    for (const parameter of [...parameters].sort((left, right) =>
        compareCodeUnits(left.name, right.name))) {
        parametersByName.set(parameter.name, parameter);
    }
    return Object.freeze({
        key,
        name,
        parameters: Object.freeze(parameters),
        ports: Object.freeze(ports),
        parametersByName,
    });
}

function snapshotDefinitions(
    sources: readonly ArchDesignModuleDefinition[]
): readonly ResolvedArchDesignModuleDefinition[] {
    const definitions = snapshotArray(sources).map(snapshotDefinition);
    definitions.sort((left, right) =>
        compareCodeUnits(left.name, right.name) || compareCodeUnits(left.key, right.key));
    return Object.freeze(definitions);
}

function definitionsByName(
    definitions: readonly ResolvedArchDesignModuleDefinition[]
): ReadonlyMap<string, readonly ResolvedArchDesignModuleDefinition[]> {
    const mutable = new Map<string, ResolvedArchDesignModuleDefinition[]>();
    for (const definition of definitions) {
        const matches = mutable.get(definition.name);
        if (matches) {
            matches.push(definition);
        } else {
            mutable.set(definition.name, [definition]);
        }
    }
    const result = new Map<string, readonly ResolvedArchDesignModuleDefinition[]>();
    for (const [name, matches] of mutable) {
        result.set(name, Object.freeze(matches));
    }
    return result;
}

function diagnostic(path: string, code: string, message: string): ArchDesignDiagnostic {
    return Object.freeze({ path, code, message });
}

export function resolveArchDesign(
    design: ArchDesign,
    definitionSources: readonly ArchDesignModuleDefinition[]
): ArchDesignResolution {
    const catalog = definitionsByName(snapshotDefinitions(definitionSources));
    const resolvedInstances: ResolvedArchDesignInstance[] = [];
    const diagnostics: ArchDesignDiagnostic[] = [];

    for (let index = 0; index < design.instances.length; index += 1) {
        const instance = design.instances[index];
        const matches = catalog.get(instance.module) ?? [];
        const modulePath = `$.instances[${index}].module`;
        if (matches.length === 0) {
            diagnostics.push(diagnostic(
                modulePath,
                'AD_MODULE_UNRESOLVED',
                `No module definition is named ${instance.module}`
            ));
            resolvedInstances.push(Object.freeze({ index, instance }));
            continue;
        }
        if (matches.length > 1) {
            diagnostics.push(diagnostic(
                modulePath,
                'AD_MODULE_AMBIGUOUS',
                `More than one module definition is named ${instance.module}`
            ));
            resolvedInstances.push(Object.freeze({ index, instance }));
            continue;
        }

        const definition = matches[0];
        resolvedInstances.push(Object.freeze({ index, instance, definition }));
        const parameters = instance.parameters;
        if (!parameters) continue;
        for (const key of Object.keys(parameters).sort(compareCodeUnits)) {
            if (definition.parametersByName.has(key)) continue;
            diagnostics.push(diagnostic(
                `$.instances[${index}].parameters.${key}`,
                'AD_PARAMETER_UNKNOWN',
                `Parameter ${key} is not declared by module ${instance.module}`
            ));
        }
    }

    diagnostics.sort((left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    return Object.freeze({
        instances: Object.freeze(resolvedInstances),
        diagnostics: Object.freeze(diagnostics),
    });
}
