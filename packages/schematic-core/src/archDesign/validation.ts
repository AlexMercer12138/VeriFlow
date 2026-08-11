import type { ArchDesignModuleDefinition } from './definitions';
import type { ArchDesign } from './model';
import { compareCodeUnits } from './ordering';
import type { ArchDesignDiagnostic } from './parser';
import { resolveArchDesign } from './resolution';

export type ArchDesignDefaultOrigin = 'connection' | 'design' | 'implicit-inout-t';

export type ArchDesignEffectiveDefault = Readonly<{
    endpoint: string;
    expression: string;
    origin: ArchDesignDefaultOrigin;
    connection?: string;
}>;

export type ArchDesignValidationResult = Readonly<{
    valid: boolean;
    diagnostics: readonly ArchDesignDiagnostic[];
    effectiveDefaults: readonly ArchDesignEffectiveDefault[];
}>;

const EMPTY_EFFECTIVE_DEFAULTS: readonly ArchDesignEffectiveDefault[] = Object.freeze([]);

export function validateArchDesign(
    design: ArchDesign,
    definitions: readonly ArchDesignModuleDefinition[]
): ArchDesignValidationResult {
    const resolution = resolveArchDesign(design, definitions);
    const diagnostics = resolution.diagnostics
        .map(item => Object.freeze({
            path: item.path,
            code: item.code,
            message: item.message,
        }))
        .sort((left, right) =>
            compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    return Object.freeze({
        valid: diagnostics.length === 0,
        diagnostics: Object.freeze(diagnostics),
        effectiveDefaults: EMPTY_EFFECTIVE_DEFAULTS,
    });
}
