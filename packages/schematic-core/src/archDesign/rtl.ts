import type { WidthValue } from '@veriflow/hdl-core/model';

import type { ArchDesignModuleDefinition } from './definitions';
import { semanticArchDesignFingerprint } from './fingerprint';
import { fnv1a64 } from './hash';
import {
    ARCH_DESIGN_SCHEMA_VERSION,
    type ArchDesign,
    type ArchDesignLanguage,
    type ArchDesignPort,
    type ArchDesignWidth,
} from './model';
import {
    parseArchDesignValue,
    type ArchDesignDiagnostic,
} from './parser';
import {
    resolveArchDesign,
    type ArchDesignResolution,
    type ResolvedArchDesignConnection,
    type ResolvedArchDesignEndpointTarget,
    type ResolvedArchDesignInstance,
} from './resolution';

export type ArchDesignRtlExportOptions = Readonly<{
    language?: ArchDesignLanguage;
    sourcePath?: string;
}>;

export type ArchDesignRtlMarker = Readonly<{
    schemaVersion: number;
    fingerprint: string;
    language: ArchDesignLanguage;
}>;

export type ArchDesignRtlExportResult =
    | Readonly<{
        status: 'generated';
        language: ArchDesignLanguage;
        extension: '.v' | '.sv';
        fingerprint: string;
        marker: string;
        text: string;
    }>
    | Readonly<{
        status: 'invalid';
        diagnostics: readonly ArchDesignDiagnostic[];
    }>;

const GENERATED_MARKER = /^\/\/ vik-veriflow:generated arch-design schema=(\d+) fingerprint=(ad-v1-[0-9a-f]{16}) language=(verilog|systemverilog)(?:\r?\n|$)/;

export function parseArchDesignRtlMarker(text: string): ArchDesignRtlMarker | undefined {
    const match = GENERATED_MARKER.exec(text);
    if (!match) return undefined;
    return Object.freeze({
        schemaVersion: Number(match[1]),
        fingerprint: match[2],
        language: match[3] as ArchDesignLanguage,
    });
}

function invalidExport(
    diagnostics: readonly ArchDesignDiagnostic[]
): ArchDesignRtlExportResult {
    return Object.freeze({
        status: 'invalid',
        diagnostics: Object.freeze(diagnostics.map(item => Object.freeze({
            path: item.path,
            code: item.code,
            message: item.message,
        }))),
    });
}

function rtlNameDiagnostics(
    resolution: ArchDesignResolution
): readonly ArchDesignDiagnostic[] {
    const portNames = new Set(resolution.ports.map(item => item.port.name));
    return resolution.instances.flatMap(item =>
        portNames.has(item.instance.name)
            ? [Object.freeze({
                path: `$.instances[${item.index}].name`,
                code: 'AD_RTL_NAME_COLLISION',
                message: `Instance ${item.instance.name} collides with a top-level port`,
            })]
            : []);
}

function packedRange(width: ArchDesignWidth | undefined): string {
    if (width === undefined) return '';
    return typeof width === 'number'
        ? width === 1 ? '' : `[${width - 1}:0] `
        : `[(${width.expression})-1:0] `;
}

function resolvedPackedRange(width: WidthValue): string {
    if (width.kind === 'known') return width.bits === 1 ? '' : `[${width.bits - 1}:0] `;
    if (width.kind === 'symbolic') return `[(${width.expression})-1:0] `;
    return '';
}

function portDeclaration(port: ArchDesignPort, final: boolean): string {
    return `    ${port.direction} wire ${packedRange(port.width)}${port.name}${final ? '' : ','}`;
}

function allocateIdentifier(preferred: string, used: Set<string>): string {
    if (!used.has(preferred)) {
        used.add(preferred);
        return preferred;
    }
    let suffix = 2;
    while (used.has(`${preferred}_${suffix}`)) suffix += 1;
    const result = `${preferred}_${suffix}`;
    used.add(result);
    return result;
}

function connectionWidth(connection: ResolvedArchDesignConnection): WidthValue {
    const source = connection.endpoints.find(endpoint =>
        endpoint.role === 'driver' && endpoint.width.kind !== 'unknown');
    const selected = source
        ?? connection.endpoints.find(endpoint => endpoint.width.kind !== 'unknown');
    return selected?.width ?? { kind: 'unknown' };
}

type RtlBindings = Readonly<{
    netByConnection: ReadonlyMap<number, string>;
    netByEndpoint: ReadonlyMap<string, string>;
    usedIdentifiers: Set<string>;
}>;

function createBindings(resolution: ArchDesignResolution): RtlBindings {
    const used = new Set<string>();
    for (const port of resolution.ports) used.add(port.port.name);
    for (const instance of resolution.instances) used.add(instance.instance.name);
    const netByConnection = new Map<number, string>();
    const netByEndpoint = new Map<string, string>();
    for (const connection of resolution.connections) {
        const net = allocateIdentifier(`__vf_net_${connection.connection.name}`, used);
        netByConnection.set(connection.index, net);
        for (const endpoint of connection.endpoints) netByEndpoint.set(endpoint.identity, net);
    }
    return { netByConnection, netByEndpoint, usedIdentifiers: used };
}

function targetsByNode(
    resolution: ArchDesignResolution
): ReadonlyMap<string, readonly ResolvedArchDesignEndpointTarget[]> {
    const result = new Map<string, ResolvedArchDesignEndpointTarget[]>();
    for (const target of resolution.endpointTargets) {
        const existing = result.get(target.nodeId);
        if (existing) existing.push(target);
        else result.set(target.nodeId, [target]);
    }
    return result;
}

function renderParameterValue(value: string | number | boolean): string {
    if (typeof value === 'boolean') return value ? "1'b1" : "1'b0";
    return String(value);
}

function renderInstance(
    item: ResolvedArchDesignInstance,
    targets: readonly ResolvedArchDesignEndpointTarget[],
    netByEndpoint: ReadonlyMap<string, string>,
    defaultByEndpoint: ReadonlyMap<string, string>
): readonly string[] {
    if (!item.definition) return [];
    const parameters = item.instance.parameters;
    const parameterMappings = parameters
        ? item.definition.parameters.flatMap(parameter =>
            Object.prototype.hasOwnProperty.call(parameters, parameter.name)
                ? [[parameter.name, renderParameterValue(parameters[parameter.name])] as const]
                : [])
        : [];
    const prefix = parameterMappings.length === 0
        ? [`${item.instance.module} ${item.instance.name} (`]
        : [
            `${item.instance.module} #(`,
            ...parameterMappings.map(([name, value], index) =>
                `    .${name}(${value})${index === parameterMappings.length - 1 ? '' : ','}`),
            `) ${item.instance.name} (`,
        ];
    const ports = targets.map((target, index) => {
        const binding = netByEndpoint.get(target.identity)
            ?? (target.role === 'load' ? defaultByEndpoint.get(target.identity) : undefined)
            ?? '';
        return `    .${target.port}(${binding})${index === targets.length - 1 ? '' : ','}`;
    });
    return [
        ...prefix,
        ...ports,
        ');',
    ];
}

function archWidthValue(width: ArchDesignWidth | undefined): WidthValue {
    if (width === undefined) return { kind: 'known', bits: 1 };
    return typeof width === 'number'
        ? { kind: 'known', bits: width }
        : { kind: 'symbolic', expression: width.expression };
}

function widthExpression(width: WidthValue): string {
    if (width.kind === 'known') return String(width.bits);
    if (width.kind === 'symbolic') return `(${width.expression})`;
    return '1';
}

function highImpedanceExpression(width: WidthValue): string {
    if (width.kind === 'known' && width.bits === 1) return "1'bz";
    return `{${widthExpression(width)}{1'bz}}`;
}

function isPerBitInoutControl(
    resolution: ArchDesignResolution,
    target: ResolvedArchDesignEndpointTarget,
    portWidth: WidthValue
): boolean {
    if (portWidth.kind === 'known' && portWidth.bits === 1) return false;
    const connection = resolution.connections.find(item =>
        item.endpoints.some(endpoint => endpoint.identity === target.identity));
    if (!connection) return false;
    const peers = connection.endpoints.filter(endpoint => endpoint.identity !== target.identity);
    const peer = peers.find(endpoint =>
        endpoint.role === 'driver' || endpoint.role === 'bidirectional') ?? peers[0];
    if (!peer) return false;
    if (portWidth.kind === 'known') {
        return peer.width.kind === 'known' && peer.width.bits === portWidth.bits;
    }
    return portWidth.kind === 'symbolic'
        && peer.width.kind === 'symbolic'
        && peer.width.expression === portWidth.expression;
}

function renderInoutLogic(
    resolution: ArchDesignResolution,
    item: ArchDesignResolution['ports'][number],
    targets: readonly ResolvedArchDesignEndpointTarget[],
    bindings: RtlBindings,
    defaultByEndpoint: ReadonlyMap<string, string>
): Readonly<{ assignments: readonly string[]; generate: readonly string[] }> {
    const bySignal = new Map(targets.map(target => [target.signal, target]));
    const input = bySignal.get('i');
    const output = bySignal.get('o');
    const control = bySignal.get('t');
    const outputBinding = output
        ? bindings.netByEndpoint.get(output.identity) ?? defaultByEndpoint.get(output.identity)
        : undefined;
    const controlBinding = control
        ? bindings.netByEndpoint.get(control.identity) ?? defaultByEndpoint.get(control.identity)
        : undefined;
    if (!outputBinding || !controlBinding || !control) {
        return { assignments: [], generate: [] };
    }
    const assignments: string[] = [];
    const inputNet = input ? bindings.netByEndpoint.get(input.identity) : undefined;
    if (inputNet) assignments.push(`assign ${inputNet} = ${item.port.name};`);
    const portWidth = archWidthValue(item.port.width);
    if (!isPerBitInoutControl(resolution, control, portWidth)) {
        assignments.push(
            `assign ${item.port.name} = ${controlBinding} ? ${highImpedanceExpression(portWidth)} : ${outputBinding};`
        );
        return { assignments, generate: [] };
    }
    const index = allocateIdentifier(
        `__vf_${item.port.name}_index`,
        bindings.usedIdentifiers
    );
    const block = allocateIdentifier(
        `__vf_${item.port.name}_tristate`,
        bindings.usedIdentifiers
    );
    const limit = widthExpression(portWidth);
    return {
        assignments,
        generate: [
            `genvar ${index};`,
            'generate',
            `    for (${index} = 0; ${index} < ${limit}; ${index} = ${index} + 1) begin : ${block}`,
            `        assign ${item.port.name}[${index}] = ${controlBinding}[${index}] ? 1'bz : ${outputBinding}[${index}];`,
            '    end',
            'endgenerate',
        ],
    };
}

function renderModule(resolution: ArchDesignResolution): string {
    const bindings = createBindings(resolution);
    const { netByConnection, netByEndpoint } = bindings;
    const defaultByEndpoint = new Map(
        resolution.effectiveDefaults.map(item => [item.identity, item.expression])
    );
    const header = resolution.ports.length === 0
        ? [`module ${resolution.moduleName};`]
        : [
            `module ${resolution.moduleName} (`,
            ...resolution.ports.map((item, index) =>
                portDeclaration(item.port, index === resolution.ports.length - 1)),
            ');',
        ];
    const declarations = resolution.connections.map(connection =>
        `wire ${resolvedPackedRange(connectionWidth(connection))}${netByConnection.get(connection.index)};`);
    const targets = targetsByNode(resolution);
    const assignments: string[] = [];
    const generateBlocks: string[] = [];
    for (const item of resolution.ports) {
        if (item.port.direction === 'inout') {
            const logic = renderInoutLogic(
                resolution,
                item,
                targets.get(item.nodeId) ?? [],
                bindings,
                defaultByEndpoint
            );
            assignments.push(...logic.assignments);
            if (generateBlocks.length > 0 && logic.generate.length > 0) {
                generateBlocks.push('');
            }
            generateBlocks.push(...logic.generate);
            continue;
        }
        const target = targets.get(item.nodeId)?.[0];
        const net = target ? netByEndpoint.get(target.identity) : undefined;
        if (item.port.direction === 'input') {
            if (net) assignments.push(`assign ${net} = ${item.port.name};`);
            continue;
        }
        const binding = net ?? (target ? defaultByEndpoint.get(target.identity) : undefined);
        if (binding) assignments.push(`assign ${item.port.name} = ${binding};`);
    }
    for (const source of resolution.connectionDefaultSources) {
        const net = netByConnection.get(source.connectionIndex);
        if (net) assignments.push(`assign ${net} = ${source.default.expression};`);
    }
    const instances: string[] = [];
    for (const item of resolution.instances) {
        const block = renderInstance(
            item,
            targets.get(item.nodeId) ?? [],
            netByEndpoint,
            defaultByEndpoint
        );
        if (block.length === 0) continue;
        if (instances.length > 0) instances.push('');
        instances.push(...block);
    }
    const sections = [header, declarations, assignments, generateBlocks, instances]
        .filter(section => section.length > 0);
    return [
        ...sections.flatMap((section, index) => index === 0 ? section : ['', ...section]),
        ...(sections.length > 1 ? [''] : []),
        'endmodule',
        '',
    ].join('\n');
}

export function exportArchDesignRtl(
    design: ArchDesign,
    definitions: readonly ArchDesignModuleDefinition[],
    options: ArchDesignRtlExportOptions = {}
): ArchDesignRtlExportResult {
    const parsed = parseArchDesignValue(design);
    if (parsed.status === 'invalid') return invalidExport(parsed.diagnostics);
    if (parsed.status === 'unsupported') {
        return invalidExport([Object.freeze({
            path: '$.schemaVersion',
            code: 'AD_SCHEMA_UNSUPPORTED',
            message: `Arch Design schema version ${parsed.schemaVersion} is not supported for RTL export`,
        })]);
    }
    const snapshot = parsed.design;
    const resolution = resolveArchDesign(snapshot, definitions);
    if (resolution.diagnostics.length > 0) {
        return invalidExport(resolution.diagnostics);
    }
    const nameDiagnostics = rtlNameDiagnostics(resolution);
    if (nameDiagnostics.length > 0) return invalidExport(nameDiagnostics);
    const language = options.language ?? snapshot.export.language ?? 'verilog';
    const semanticDesign = {
        ...snapshot,
        export: { ...snapshot.export, language },
    };
    const moduleText = renderModule(resolution);
    const fingerprint = `ad-v1-${fnv1a64([
        semanticArchDesignFingerprint(semanticDesign),
        moduleText,
    ].join('\n'))}`;
    const marker = [
        '// vik-veriflow:generated arch-design',
        `schema=${ARCH_DESIGN_SCHEMA_VERSION}`,
        `fingerprint=${fingerprint}`,
        `language=${language}`,
    ].join(' ');
    const sourcePath = options.sourcePath ?? '<memory>';
    const text = [
        marker,
        `// vik-veriflow:source ${JSON.stringify(sourcePath)}`,
        '',
        moduleText,
    ].join('\n');
    return Object.freeze({
        status: 'generated',
        language,
        extension: language === 'verilog' ? '.v' : '.sv',
        fingerprint,
        marker,
        text,
    });
}
