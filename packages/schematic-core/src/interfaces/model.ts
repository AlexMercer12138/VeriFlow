export const INTERFACE_PROTOCOL_FORMAT = 'veriflow-interface-protocol' as const;
export const INTERFACE_PROTOCOL_SCHEMA_VERSION = 1 as const;

export type InterfaceMemberDirection = 'master-to-slave' | 'slave-to-master';

export type InterfaceProtocolMember = Readonly<{
    name: string;
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
