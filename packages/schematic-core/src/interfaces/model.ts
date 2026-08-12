import type { WidthValue } from '@veriflow/hdl-core/model';

export const INTERFACE_PROTOCOL_FORMAT = 'veriflow-interface-protocol' as const;
export const INTERFACE_PROTOCOL_SCHEMA_VERSION = 1 as const;

export type InterfaceMemberDirection = 'master-to-slave' | 'slave-to-master';

export type InterfaceProtocolMember = Readonly<{
    name: string;
    aliases?: readonly string[];
    direction: InterfaceMemberDirection;
    defaultExpression?: string;
}>;

export type InterfaceProtocol = Readonly<{
    format: typeof INTERFACE_PROTOCOL_FORMAT;
    schemaVersion: typeof INTERFACE_PROTOCOL_SCHEMA_VERSION;
    id: string;
    name: string;
    separator: string;
    priority: number;
    members: readonly InterfaceProtocolMember[];
    recognitionGroups: readonly (readonly string[])[];
}>;

export type InterfaceProtocolDiagnostic = Readonly<{
    path: string;
    code: string;
    message: string;
}>;

export type InterfaceProtocolReadResult =
    | Readonly<{ status: 'editable'; protocol: InterfaceProtocol }>
    | Readonly<{
        status: 'unsupported';
        schemaVersion: number;
        value: Readonly<Record<string, unknown>>;
    }>
    | Readonly<{
        status: 'invalid';
        diagnostics: readonly InterfaceProtocolDiagnostic[];
    }>;

export type InterfaceProtocolSource =
    | Readonly<{ kind: 'builtin'; source: string }>
    | Readonly<{ kind: 'project'; source: string; overrides?: string }>;

export type InterfaceProtocolCatalogEntry = Readonly<{
    protocol: InterfaceProtocol;
    source: InterfaceProtocolSource;
}>;

export type InterfaceProtocolCatalogDiagnostic = InterfaceProtocolDiagnostic & Readonly<{
    source: string;
}>;

export type InterfaceProtocolCatalog = Readonly<{
    entries: readonly InterfaceProtocolCatalogEntry[];
    diagnostics: readonly InterfaceProtocolCatalogDiagnostic[];
}>;

export type InterfaceProtocolCatalogInput = Readonly<{
    source: string;
    value: unknown;
}>;

export type InterfaceRecognitionPort = Readonly<{
    name: string;
    direction: 'input' | 'output' | 'inout';
    width: WidthValue;
}>;

export type RecognizedInterfaceMember = Readonly<{
    member: string;
    port: string;
    direction: InterfaceMemberDirection;
    portDirection: InterfaceRecognitionPort['direction'];
    width: WidthValue;
    declarationOrder: number;
}>;

export type RecognizedInterfaceRole = 'master' | 'slave' | 'unknown';

export type RecognizedInterface = Readonly<{
    key: string;
    protocol: string;
    protocolName: string;
    protocolSource: InterfaceProtocolSource;
    role: RecognizedInterfaceRole;
    roleSource: 'inferred' | 'unknown';
    members: readonly RecognizedInterfaceMember[];
    declarationOrder: number;
}>;

export type InterfaceRecognitionDiagnostic = Readonly<{
    code: string;
    message: string;
    interfaceKey: string;
    protocols: readonly string[];
    ports?: readonly string[];
}>;

export type InterfaceRecognitionResult = Readonly<{
    interfaces: readonly RecognizedInterface[];
    diagnostics: readonly InterfaceRecognitionDiagnostic[];
}>;
