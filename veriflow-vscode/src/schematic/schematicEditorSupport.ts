import { canonicalizeSourceUri } from '../core/hdl/preprocessor';

export type SchematicModuleIdentitySource = {
    name: string;
    nameSpan: { uri?: string };
    declarationSpan: { start: number };
};

export type SelectableSchematicModule<TModule extends SchematicModuleIdentitySource> = {
    key: string;
    name: string;
    model: TModule;
};

export function selectableSchematicModules<TModule extends SchematicModuleIdentitySource>(
    documentUri: string,
    parsedDocumentUri: string,
    modules: readonly TModule[],
    platform: NodeJS.Platform = process.platform
): Array<SelectableSchematicModule<TModule>> {
    const canonicalDocumentUri = canonicalizeSourceUri(documentUri, platform);
    return modules
        .filter(module => canonicalizeSourceUri(
            module.nameSpan.uri ?? parsedDocumentUri,
            platform
        ) === canonicalDocumentUri)
        .map(module => ({
            key: `module:${canonicalDocumentUri}:${module.declarationSpan.start}`,
            name: module.name,
            model: module,
        }));
}

export function selectSchematicModuleKey(
    modules: readonly { key: string }[],
    pendingModuleKey: string | undefined,
    currentModuleKey: string | undefined
): string | undefined {
    if (modules.some(module => module.key === pendingModuleKey)) {
        return pendingModuleKey;
    }
    if (modules.some(module => module.key === currentModuleKey)) {
        return currentModuleKey;
    }
    return modules[0]?.key;
}

export type SchematicBuildSnapshot<TDocument> = {
    generation: number;
    document: TDocument;
    moduleKey: string;
};

export function isCurrentSchematicRefresh(
    generation: number,
    currentGeneration: number,
    disposed: boolean,
    cancelled: boolean
): boolean {
    return generation === currentGeneration && !disposed && !cancelled;
}

export class SchematicBuildGeneration<TDocument> {
    private generation = 0;

    begin(document: TDocument, moduleKey: string): SchematicBuildSnapshot<TDocument> {
        return {
            generation: ++this.generation,
            document,
            moduleKey,
        };
    }

    isCurrent(
        snapshot: SchematicBuildSnapshot<TDocument>,
        document: TDocument | undefined,
        moduleKey: string | undefined
    ): boolean {
        return snapshot.generation === this.generation
            && snapshot.document === document
            && snapshot.moduleKey === moduleKey;
    }

    invalidate(): void {
        this.generation++;
    }
}
