import type { HdlDiagnostic, SourceSpan, WidthValue } from '@veriflow/hdl-core/model';

export type GraphNodeKind =
    | 'port'
    | 'instance'
    | 'constant'
    | 'expression'
    | 'opaque'
    | 'generateArray';

export type PinDirection = 'driver' | 'load' | 'bidirectional';

export type PinSide = 'left' | 'right';

export type GraphInterfaceRole = 'master' | 'slave' | 'unknown';

export type GraphInterfacePin = {
    id: string;
    protocol: string;
    protocolName: string;
    role: GraphInterfaceRole;
    roleSource: 'inferred' | 'override' | 'declared' | 'unknown';
    kind: 'aggregate' | 'member';
    topLevel: boolean;
    collapsed: boolean;
    member?: string;
};

export type GraphInterfaceNetwork = {
    id: string;
    connection: string;
    protocol: string;
    protocolName: string;
    collapsed: boolean;
    member?: string;
};

export type GraphPin = {
    id: string;
    name: string;
    direction: PinDirection;
    width: WidthValue;
    readOnly: boolean;
    interface?: GraphInterfacePin;
    sourceSpan?: SourceSpan;
};

export type GraphNode = {
    id: string;
    kind: GraphNodeKind;
    label: string;
    subtitle?: string;
    definitionKey?: string;
    pins: GraphPin[];
    readOnly: boolean;
    sourceSpan?: SourceSpan;
};

export type NetworkEndpoint = {
    nodeId: string;
    pinId: string;
    role: PinDirection;
};

export type SchematicNetwork = {
    id: string;
    name: string;
    width: WidthValue;
    endpoints: NetworkEndpoint[];
    renderWidth?: number;
    interface?: GraphInterfaceNetwork;
    sourceSpan?: SourceSpan;
    adapterLabel?: string;
};

export type SchematicGraph = {
    fileUri: string;
    moduleKey: string;
    moduleName: string;
    nodes: GraphNode[];
    networks: SchematicNetwork[];
    diagnostics: HdlDiagnostic[];
};
