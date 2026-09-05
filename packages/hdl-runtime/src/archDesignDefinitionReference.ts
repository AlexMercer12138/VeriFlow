import { canonicalizeSourceUri, isSourceUriWithinRoot } from '@veriflow/hdl-core/preprocessor';

import type { HdlDefinitionSummary } from './workspaceIndexTypes';

export type ArchDesignDefinitionCatalog = Readonly<{
    definitions: readonly HdlDefinitionSummary[];
    portableKey(runtimeKey: string): string | undefined;
    runtimeKey(portableKey: string): string | undefined;
}>;

function encodedName(name: string): string {
    return encodeURIComponent(name);
}

function comparableUri(uri: string): string {
    return canonicalizeSourceUri(uri).replace(
        /^(file:\/\/\/)([a-z])(?:%3A|:)\//i,
        (_match, prefix: string, drive: string) => `${prefix}${drive.toLowerCase()}:/`
    );
}

type LegacyDefinitionReference = Readonly<{
    kind: string;
    uri: string;
    declarationStart: number;
}>;

function legacyReference(definitionKey: string): LegacyDefinitionReference | undefined {
    const kindEnd = definitionKey.indexOf(':');
    const offsetStart = definitionKey.lastIndexOf(':');
    if (kindEnd <= 0 || offsetStart <= kindEnd + 1) return undefined;
    const offset = definitionKey.slice(offsetStart + 1);
    if (!/^\d+$/.test(offset)) return undefined;
    return {
        kind: definitionKey.slice(0, kindEnd),
        uri: comparableUri(definitionKey.slice(kindEnd + 1, offsetStart)),
        declarationStart: Number(offset),
    };
}

function legacyIdentity(reference: LegacyDefinitionReference): string {
    return JSON.stringify([
        reference.kind,
        reference.uri,
        reference.declarationStart,
    ]);
}

function sourceReference(uri: string, workspaceRootUri: string): string {
    const source = canonicalizeSourceUri(uri);
    const root = canonicalizeSourceUri(workspaceRootUri);
    if (!isSourceUriWithinRoot(source, root)) return source;

    const sourceUrl = new URL(source);
    const rootUrl = new URL(root);
    const rootPath = rootUrl.pathname.replace(/\/+$/, '');
    const relativePath = sourceUrl.pathname.slice(rootPath.length).replace(/^\/+/, '');
    return `workspace:/${relativePath}`;
}

export function createArchDesignDefinitionCatalog(
    definitions: readonly HdlDefinitionSummary[],
    workspaceRootUri: string
): ArchDesignDefinitionCatalog {
    const duplicateGroups = new Map<string, HdlDefinitionSummary[]>();
    for (const definition of definitions) {
        const groupKey = JSON.stringify([
            canonicalizeSourceUri(definition.uri),
            definition.kind,
            definition.name,
        ]);
        const group = duplicateGroups.get(groupKey) ?? [];
        group.push(definition);
        duplicateGroups.set(groupKey, group);
    }
    for (const group of duplicateGroups.values()) {
        group.sort((left, right) => left.declarationStart - right.declarationStart);
    }

    const runtimeToPortable = new Map<string, string>();
    const legacyToPortable = new Map<string, string>();
    const portableToRuntime = new Map<string, string>();
    const portableDefinitions = definitions.map(definition => {
        const groupKey = JSON.stringify([
            canonicalizeSourceUri(definition.uri),
            definition.kind,
            definition.name,
        ]);
        const group = duplicateGroups.get(groupKey)!;
        const base = `${definition.kind}:${sourceReference(
            definition.uri,
            workspaceRootUri
        )}#${encodedName(definition.name)}`;
        const portableKey = group.length === 1
            ? base
            : `${base}@${group.indexOf(definition)}`;
        runtimeToPortable.set(definition.key, portableKey);
        legacyToPortable.set(legacyIdentity({
            kind: definition.kind,
            uri: comparableUri(definition.uri),
            declarationStart: definition.declarationStart,
        }), portableKey);
        portableToRuntime.set(portableKey, definition.key);
        if (group.length > 1) portableToRuntime.set(base, group[0].key);
        return { ...definition, key: portableKey };
    });

    return Object.freeze({
        definitions: Object.freeze(portableDefinitions),
        portableKey: runtimeKey => {
            const reference = legacyReference(runtimeKey);
            return runtimeToPortable.get(runtimeKey)
                ?? (reference === undefined
                    ? undefined
                    : legacyToPortable.get(legacyIdentity(reference)));
        },
        runtimeKey: portableKey => portableToRuntime.get(portableKey),
    });
}

export function migrateArchDesignDefinitionKey(
    definitionKey: string,
    moduleName: string,
    catalog: ArchDesignDefinitionCatalog
): string | undefined {
    const selectedRuntimeKey = catalog.runtimeKey(definitionKey);
    if (selectedRuntimeKey !== undefined) {
        return catalog.portableKey(selectedRuntimeKey);
    }

    const exact = catalog.portableKey(definitionKey);
    if (exact !== undefined) return exact;

    const legacy = legacyReference(definitionKey);
    if (legacy !== undefined) {
        const sameSource = catalog.definitions.filter(definition =>
            definition.kind === legacy.kind
            && definition.name === moduleName
            && comparableUri(definition.uri) === legacy.uri
        );
        if (sameSource.length === 1) return sameSource[0].key;
    }

    const matching = catalog.definitions.filter(definition =>
        definition.kind === 'module' && definition.name === moduleName
    );
    return matching.length === 1 ? matching[0].key : undefined;
}

export function selectArchDesignDefinitionKey(
    definitionKey: string | undefined,
    moduleName: string,
    catalog: ArchDesignDefinitionCatalog
): string | undefined {
    if (definitionKey !== undefined) {
        return migrateArchDesignDefinitionKey(definitionKey, moduleName, catalog);
    }
    const matches = catalog.definitions.filter(definition =>
        definition.kind === 'module' && definition.name === moduleName
    );
    const sourceUris = new Set(matches.map(definition =>
        canonicalizeSourceUri(definition.uri)
    ));
    if (matches.length < 2 || sourceUris.size !== 1) return undefined;
    return matches.find(definition => definition.key.endsWith('@0'))?.key;
}
