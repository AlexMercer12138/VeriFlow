export type SourceFileSpan = { uri: string; start: number; end: number };

export type SourceSpan = {
    start: number;
    end: number;
    uri?: string;
    compositeParts?: SourceFileSpan[];
};

export type WidthValue =
    | { kind: 'known'; bits: number }
    | { kind: 'symbolic'; expression: string }
    | { kind: 'unknown' };

export type HdlDiagnostic = {
    severity: 'error' | 'warning' | 'info';
    code: string;
    message: string;
    span?: SourceSpan;
};

export type ParameterModel = {
    id: string;
    name: string;
    kind: 'parameter' | 'localparam';
    typeText: string;
    defaultExpression?: string;
    declarationSpan: SourceSpan;
    nameSpan: SourceSpan;
    valueSpan?: SourceSpan;
};

export type PortModel = {
    id: string;
    name: string;
    direction: 'input' | 'output' | 'inout';
    typeText: string;
    packedRange?: string;
    width: WidthValue;
    declarationSpan: SourceSpan;
    directionSpan?: SourceSpan;
    nameSpan: SourceSpan;
    headerItemSpan: SourceSpan;
    headerNameSpan: SourceSpan;
    bodyDeclarationSpan?: SourceSpan;
    bodyNameSpan?: SourceSpan;
    packedRangeSpan?: SourceSpan;
    declarationGroupId: string;
    inheritsDirection: boolean;
    inheritsType: boolean;
    inheritsPackedRange: boolean;
};

export type PortDeclarationGroupModel = {
    id: string;
    style: 'ansi' | 'non-ansi';
    declarationSpan: SourceSpan;
    sharedPrefixSpan: SourceSpan;
    items: Array<{ portId: string; itemSpan: SourceSpan; separatorSpan?: SourceSpan }>;
};

export type ModuleModel = {
    id: string;
    name: string;
    nameSpan: SourceSpan;
    endLabel?: string;
    declarationStyle: 'ansi' | 'non-ansi';
    declarationSpan: SourceSpan;
    headerSpan: SourceSpan;
    bodySpan: SourceSpan;
    declarationRegionSpan: SourceSpan;
    endmoduleSpan: SourceSpan;
    parameters: ParameterModel[];
    localParameters: ParameterModel[];
    ports: PortModel[];
    portDeclarationGroups: PortDeclarationGroupModel[];
    instances: InstanceModel[];
    instanceDeclarationGroups: InstanceDeclarationGroupModel[];
};

export type InstanceConnectionModel = {
    name?: string;
    expression: string;
    expressionSpan: SourceSpan;
    connectionSpan: SourceSpan;
    nameSpan?: SourceSpan;
    syntax: 'named' | 'implicit' | 'positional' | 'wildcard';
};

export type InstanceModel = {
    id: string;
    moduleName: string;
    instanceName: string;
    syntax: 'named' | 'implicit' | 'positional' | 'wildcard' | 'mixed';
    declarationSpan: SourceSpan;
    declarationGroupId: string;
    itemSpan: SourceSpan;
    separatorSpan?: SourceSpan;
    moduleNameSpan: SourceSpan;
    nameSpan: SourceSpan;
    parameterConnections: InstanceConnectionModel[];
    portConnections: InstanceConnectionModel[];
};

export type InstanceDeclarationGroupModel = {
    id: string;
    statementSpan: SourceSpan;
    moduleNameSpan: SourceSpan;
    parameterBlockSpan?: SourceSpan;
    items: Array<{ instanceId: string; itemSpan: SourceSpan; separatorSpan?: SourceSpan }>;
};

export type NamedUnitModel = {
    id: string;
    kind: 'interface' | 'package';
    name: string;
    nameSpan: SourceSpan;
    declarationSpan: SourceSpan;
};

export type DirectiveModel = {
    kind: string;
    text: string;
    span: SourceSpan;
    active: boolean;
};

export type IncludeModel = {
    path: string;
    span: SourceSpan;
    resolvedUri?: string;
};

export type HdlDocument = {
    uri: string;
    languageId: 'verilog' | 'systemverilog';
    version: number;
    textHash: string;
    lineEnding: '\n' | '\r\n';
    preprocessingFingerprint: string;
    modules: ModuleModel[];
    interfaces: NamedUnitModel[];
    packages: NamedUnitModel[];
    directives: DirectiveModel[];
    includes: IncludeModel[];
    diagnostics: HdlDiagnostic[];
};
