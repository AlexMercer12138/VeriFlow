import type { HdlDiagnostic, WidthValue } from './model';

export type HdlDefinitionKind = 'module' | 'interface' | 'package';
export type HdlDefinitionKey = string;

export type IndexedParameterSummary = {
    name: string;
    defaultExpression?: string;
};

export type IndexedPortSummary = {
    name: string;
    direction: 'input' | 'output' | 'inout';
    packedRange?: string;
    width: WidthValue;
};

export type HdlDefinitionSummary = {
    key: HdlDefinitionKey;
    kind: HdlDefinitionKind;
    name: string;
    uri: string;
    declarationStart: number;
    declarationLine: number;
    parameters: IndexedParameterSummary[];
    ports: IndexedPortSummary[];
    dependencies: string[];
    /**
     * Hash of a canonical normalized definition representation and every participating
     * source or include URI/content-hash pair. The representation preserves parameter and
     * port order, parameter defaults, packed ranges, and included structural fragments.
     */
    modelFingerprint: string;
};

export type HdlFileSummary = {
    uri: string;
    mtimeMs: number;
    size: number;
    contentHash: string;
    includeUris: string[];
    definitions: HdlDefinitionSummary[];
    diagnostics: HdlDiagnostic[];
};

export type PersistedWorkspaceIndex = {
    schemaVersion: 1;
    parserFingerprint: string;
    files: HdlFileSummary[];
};
