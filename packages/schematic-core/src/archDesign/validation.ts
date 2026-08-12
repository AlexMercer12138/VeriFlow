import type { InterfaceProtocolCatalog } from '../interfaces';
import type { ArchDesignModuleDefinition } from './definitions';
import type { ArchDesign } from './model';
import { compareCodeUnits } from './ordering';
import type { ArchDesignDiagnostic } from './parser';
import {
    resolveArchDesign,
    type ArchDesignEffectiveDefault,
} from './resolution';

export type {
    ArchDesignDefaultOrigin,
    ArchDesignEffectiveDefault,
} from './resolution';

export type ArchDesignValidationResult = Readonly<{
    valid: boolean;
    diagnostics: readonly ArchDesignDiagnostic[];
    warnings: readonly ArchDesignDiagnostic[];
    effectiveDefaults: readonly ArchDesignEffectiveDefault[];
}>;

export function validateArchDesign(
    design: ArchDesign,
    definitions: readonly ArchDesignModuleDefinition[],
    interfaceCatalog?: InterfaceProtocolCatalog
): ArchDesignValidationResult {
    const resolution = resolveArchDesign(design, definitions, interfaceCatalog);
    const diagnostics = resolution.diagnostics
        .map(item => Object.freeze({
            path: item.path,
            code: item.code,
            message: item.message,
        }))
        .sort((left, right) =>
            compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code));
    const effectiveDefaults: ArchDesignEffectiveDefault[] = resolution.effectiveDefaults.map(
        item => Object.freeze({
            endpoint: item.endpoint,
            expression: item.expression,
            origin: item.origin,
            ...(item.connection === undefined ? {} : { connection: item.connection }),
        })
    );
    const warnings = resolution.warnings.map(item => Object.freeze({
        path: item.path,
        code: item.code,
        message: item.message,
    }));
    return Object.freeze({
        valid: diagnostics.length === 0,
        diagnostics: Object.freeze(diagnostics),
        warnings: Object.freeze(warnings),
        effectiveDefaults: Object.freeze(effectiveDefaults),
    });
}
