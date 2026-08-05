import type { HdlDiagnostic, SourceSpan, WidthValue } from '../core/hdl/model';

export type GraphNodeKind =
    | 'port'
    | 'instance'
    | 'constant'
    | 'expression'
    | 'opaque'
    | 'generateArray';

export type PinDirection = 'driver' | 'load' | 'bidirectional';

export type GraphPin = {
    id: string;
    name: string;
    direction: PinDirection;
    side: 'left' | 'right' | 'bottom';
    width: WidthValue;
    readOnly: boolean;
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
