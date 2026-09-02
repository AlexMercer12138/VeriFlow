import type { HdlDiagnostic, SourceSpan } from '../core/hdl/model';
import type {
    GraphNode,
    GraphPin,
    PinDirection,
    SchematicGraph,
    SchematicNetwork,
} from '@veriflow/schematic-core';
import type {
    ArchDesign,
    ArchDesignEdit,
    ArchDesignEndpoint,
    ArchDesignModuleDefinition,
    ArchDesignPort,
    ArchDesignValidationResult,
} from '@veriflow/schematic-core/arch-design';
import type { ArchDesignInspectorData } from '../archDesign/editorSupport';
import type { SchematicLayout } from './layoutStore';
import type { WebviewCommand } from './protocol';

export type SchematicWebviewResources = {
    cspSource: string;
    styleUri: string;
    scriptUri: string;
    nonce: string;
};

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function replaceRequired(
    source: string,
    pattern: RegExp,
    replacement: string,
    description: string
): string {
    if (!pattern.test(source)) {
        throw new Error(`Schematic HTML is missing the ${description} placeholder`);
    }
    return source.replace(pattern, replacement);
}

export function buildSchematicWebviewHtml(
    shell: string,
    resources: SchematicWebviewResources
): string {
    if (!/^[A-Za-z0-9+/_=-]+$/.test(resources.nonce)) {
        throw new Error('Schematic webview nonce contains invalid characters');
    }
    const csp = [
        "default-src 'none'",
        `img-src ${resources.cspSource}`,
        `style-src ${resources.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${resources.nonce}'`,
    ].join('; ') + ';';
    let html = replaceRequired(
        shell,
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/i,
        `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`,
        'Content-Security-Policy'
    );
    html = replaceRequired(
        html,
        /href="\.\/index\.css"/,
        `href="${escapeHtmlAttribute(resources.styleUri)}"`,
        'stylesheet'
    );
    return replaceRequired(
        html,
        /<script\s+src="\.\/index\.js"><\/script>/,
        `<script nonce="${escapeHtmlAttribute(resources.nonce)}" src="${
            escapeHtmlAttribute(resources.scriptUri)
        }"></script>`,
        'script'
    );
}

export type TimerAdapter<Handle> = {
    set(callback: () => void, delayMs: number): Handle;
    clear(handle: Handle): void;
};

export type SchematicSelectionItem = {
    objectId: string;
    description: string;
};

export type SchematicSelectionSummary = {
    selectedObjectId?: string;
    statusText: string;
};

export type SchematicInspectorModel = Readonly<{
    kind: 'empty' | 'network' | 'instance' | 'port' | 'node' | 'multiple';
    title: string;
    readOnly: true;
    rows: readonly Readonly<{ label: string; value: string }>[];
}>;

export type ArchDesignAuthoringSnapshot = Readonly<{
    design: ArchDesign;
    catalog: readonly ArchDesignModuleDefinition[];
    validation: ArchDesignValidationResult;
    inspector?: ArchDesignInspectorData;
}>;

export type ArchDesignInspectorField = Readonly<{
    id: string;
    label: string;
    control: 'readonly' | 'text' | 'select';
    value: string;
    placeholder?: string;
    options?: readonly Readonly<{ value: string; label: string }>[];
    commit?: (value: string) => ArchDesignEdit | undefined;
}>;

export type ArchDesignInspectorModel = Readonly<{
    kind: 'design' | 'instance' | 'port' | 'pin' | 'interface' | 'network' | 'multiple';
    title: string;
    fields: readonly ArchDesignInspectorField[];
    actions?: readonly Readonly<{
        id: string;
        label: string;
        edit?: ArchDesignEdit;
        disabledReason?: string;
    }>[];
    deleteEdit?: ArchDesignEdit;
}>;

const MAX_INSPECTOR_ENDPOINT_PREVIEW = 8;

type InspectorGraphIndex = Readonly<{
    nodesById: ReadonlyMap<string, GraphNode>;
    pinsByNodeId: ReadonlyMap<string, ReadonlyMap<string, GraphPin>>;
}>;

function inspectorGraphIndex(graph: SchematicGraph): InspectorGraphIndex {
    const nodesById = new Map<string, GraphNode>();
    const pinsByNodeId = new Map<string, ReadonlyMap<string, GraphPin>>();
    for (const node of graph.nodes) {
        nodesById.set(node.id, node);
        pinsByNodeId.set(node.id, new Map(node.pins.map(pin => [pin.id, pin])));
    }
    return { nodesById, pinsByNodeId };
}

function formatWidth(width: GraphPin['width']): string {
    if (width.kind === 'known') {
        return `${width.bits} bit${width.bits === 1 ? '' : 's'}`;
    }
    return width.kind === 'symbolic' ? width.expression : 'Unknown';
}

function formatHdlDirection(
    direction: PinDirection,
    boundaryPort: boolean
): string {
    if (direction === 'bidirectional') return 'Inout';
    if (boundaryPort) return direction === 'driver' ? 'Input' : 'Output';
    return direction === 'load' ? 'input' : 'output';
}

function endpointName(
    index: InspectorGraphIndex,
    endpoint: SchematicNetwork['endpoints'][number]
): string | undefined {
    const node = index.nodesById.get(endpoint.nodeId);
    const pin = index.pinsByNodeId.get(endpoint.nodeId)?.get(endpoint.pinId);
    if (!node || !pin) return undefined;
    return node.kind === 'port' ? node.label : `${node.label}.${pin.name}`;
}

function formattedEndpoints(
    index: InspectorGraphIndex,
    network: SchematicNetwork
): Record<PinDirection, string> {
    const summaries: Record<PinDirection, { count: number; names: string[] }> = {
        driver: { count: 0, names: [] },
        load: { count: 0, names: [] },
        bidirectional: { count: 0, names: [] },
    };
    for (const endpoint of network.endpoints) {
        const name = endpointName(index, endpoint);
        if (name === undefined) continue;
        const summary = summaries[endpoint.role];
        summary.count += 1;
        if (summary.names.length < MAX_INSPECTOR_ENDPOINT_PREVIEW) {
            summary.names.push(name);
        }
    }
    return Object.fromEntries(Object.entries(summaries).map(([role, summary]) => {
        if (summary.count === 0) return [role, 'None'];
        const hidden = summary.count - summary.names.length;
        const values = hidden > 0
            ? [...summary.names, `... (+${hidden} more)`]
            : summary.names;
        return [role, values.join(', ')];
    })) as Record<PinDirection, string>;
}

function projectNetworkInspector(
    graph: SchematicGraph,
    network: SchematicNetwork
): SchematicInspectorModel {
    const endpoints = formattedEndpoints(inspectorGraphIndex(graph), network);
    return {
        kind: 'network',
        title: network.name,
        readOnly: true,
        rows: [
            { label: 'Name', value: network.name },
            { label: 'Adapter', value: network.adapterLabel ?? 'None' },
            { label: 'Width', value: formatWidth(network.width) },
            { label: 'Drivers', value: endpoints.driver },
            { label: 'Loads', value: endpoints.load },
            {
                label: 'Bidirectional',
                value: endpoints.bidirectional,
            },
        ],
    };
}

function formatPins(node: GraphNode): string {
    if (node.pins.length === 0) return 'None';
    return node.pins.map(pin => `${pin.name} (${formatHdlDirection(
        pin.direction,
        false
    )}, ${formatWidth(pin.width)})`).join(', ');
}

function projectNodeInspector(
    graph: SchematicGraph,
    node: GraphNode
): SchematicInspectorModel {
    if (node.kind === 'instance') {
        return {
            kind: 'instance',
            title: node.label,
            readOnly: true,
            rows: [
                { label: 'Name', value: node.label },
                { label: 'Module', value: node.subtitle ?? 'Unknown' },
                { label: 'Pins', value: formatPins(node) },
                {
                    label: 'Definition',
                    value: node.definitionKey ? 'Available' : 'Unavailable',
                },
                { label: 'Read-only', value: node.readOnly ? 'Yes' : 'No' },
            ],
        };
    }
    if (node.kind === 'port') {
        const pin = node.pins[0];
        const networks = graph.networks.filter(network => network.endpoints.some(
            endpoint => endpoint.nodeId === node.id
                && (pin === undefined || endpoint.pinId === pin.id)
        ));
        return {
            kind: 'port',
            title: node.label,
            readOnly: true,
            rows: [
                { label: 'Name', value: node.label },
                {
                    label: 'Direction',
                    value: pin ? formatHdlDirection(pin.direction, true) : 'Unknown',
                },
                { label: 'Width', value: pin ? formatWidth(pin.width) : 'Unknown' },
                {
                    label: 'Network',
                    value: networks.length > 0
                        ? networks.map(network => network.name).join(', ')
                        : 'Unconnected',
                },
            ],
        };
    }
    return {
        kind: 'node',
        title: node.label,
        readOnly: true,
        rows: [
            { label: 'Name', value: node.label },
            { label: 'Type', value: node.kind },
            { label: 'Pins', value: formatPins(node) },
            { label: 'Read-only', value: node.readOnly ? 'Yes' : 'No' },
        ],
    };
}

export function projectSchematicInspector(
    graph: SchematicGraph,
    selectedNodeIds: readonly string[],
    selectedNetworkId: string | undefined
): SchematicInspectorModel {
    const network = selectedNetworkId === undefined
        ? undefined
        : graph.networks.find(candidate => candidate.id === selectedNetworkId);
    if (network) return projectNetworkInspector(graph, network);

    const wantedNodeIds = new Set(selectedNodeIds);
    const nodes = graph.nodes.filter(node => wantedNodeIds.has(node.id));
    if (nodes.length === 1) return projectNodeInspector(graph, nodes[0]);
    if (nodes.length > 1) {
        const readOnlyValues = new Set(nodes.map(node => node.readOnly));
        return {
            kind: 'multiple',
            title: `${nodes.length} objects selected`,
            readOnly: true,
            rows: [
                { label: 'Count', value: String(nodes.length) },
                {
                    label: 'Read-only',
                    value: readOnlyValues.size > 1
                        ? 'Mixed'
                        : nodes[0].readOnly ? 'Yes' : 'No',
                },
            ],
        };
    }
    return {
        kind: 'empty',
        title: 'No selection',
        readOnly: true,
        rows: [],
    };
}

function textField(
    id: string,
    label: string,
    value: string,
    commit: (value: string) => ArchDesignEdit | undefined,
    placeholder?: string
): ArchDesignInspectorField {
    return {
        id,
        label,
        control: 'text',
        value,
        ...(placeholder === undefined ? {} : { placeholder }),
        commit,
    };
}

function readonlyField(
    id: string,
    label: string,
    value: string
): ArchDesignInspectorField {
    return { id, label, control: 'readonly', value };
}

function normalizedWidth(value: string): ArchDesignPort['width'] {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (/^[1-9][0-9]*$/.test(trimmed)) return Number(trimmed);
    return { expression: trimmed };
}

function displayedWidth(width: ArchDesignPort['width']): string {
    if (width === undefined) return '1';
    return typeof width === 'number' ? String(width) : width.expression;
}

function promotedWidth(width: GraphPin['width']): ArchDesignPort['width'] {
    if (width.kind === 'known') return width.bits;
    if (width.kind === 'symbolic') return { expression: width.expression };
    return undefined;
}

function promotedDirection(pin: GraphPin): ArchDesignPort['direction'] {
    return pin.direction === 'driver'
        ? 'output'
        : pin.direction === 'load' ? 'input' : 'inout';
}

function endpointLabel(endpoint: ArchDesignEndpoint): string {
    if (endpoint.kind === 'instance') return `${endpoint.instance}.${endpoint.port}`;
    return endpoint.signal === undefined
        ? endpoint.port
        : `${endpoint.port}.${endpoint.signal}`;
}

function endpointIdentity(endpoint: ArchDesignEndpoint): string {
    if (endpoint.kind === 'instance') {
        return `instance:${endpoint.instance}:${endpoint.port}`;
    }
    return `port:${endpoint.port}:${endpoint.signal ?? 'value'}`;
}

function endpointDefaultKey(endpoint: ArchDesignEndpoint): string {
    if (endpoint.kind === 'instance') return `${endpoint.instance}.${endpoint.port}`;
    return `${endpoint.port}.${endpoint.signal ?? 'value'}`;
}

function matchingDefinition(
    catalog: readonly ArchDesignModuleDefinition[],
    module: string
): ArchDesignModuleDefinition | undefined {
    const matches = catalog.filter(candidate => candidate.name === module);
    return matches.length === 1 ? matches[0] : undefined;
}

function projectDesignInspector(
    snapshot: ArchDesignAuthoringSnapshot
): ArchDesignInspectorModel {
    const { design } = snapshot;
    const language = design.export.language ?? 'verilog';
    const output = design.export.output ?? '';
    const languageOptions = [{ value: 'verilog', label: 'Verilog (.v)' }, {
        value: 'systemverilog',
        label: 'SystemVerilog (.sv)',
    }] as const;
    return {
        kind: 'design',
        title: design.module,
        fields: [
            readonlyField('design-module', 'Module', design.module),
            {
                id: 'export-language',
                label: 'RTL language',
                control: 'select',
                value: language,
                options: languageOptions,
                commit: value => value === 'verilog' || value === 'systemverilog'
                    ? {
                        type: 'setExport',
                        language: value,
                        ...(output.length === 0 ? {} : { output }),
                    }
                    : undefined,
            },
            textField('export-output', 'Output path', output, value => ({
                type: 'setExport',
                language,
                ...(value.trim().length === 0 ? {} : { output: value.trim() }),
            }), 'Sibling .v or .sv'),
        ],
    };
}

function projectInstanceInspector(
    snapshot: ArchDesignAuthoringSnapshot,
    name: string
): ArchDesignInspectorModel | undefined {
    const instance = snapshot.design.instances.find(candidate => candidate.name === name);
    if (!instance) return undefined;
    const definition = matchingDefinition(snapshot.catalog, instance.module);
    const fields: ArchDesignInspectorField[] = [
        textField('instance-name', 'Name', instance.name, value => value.trim().length > 0
            ? { type: 'renameInstance', name: instance.name, nextName: value.trim() }
            : undefined),
        readonlyField('instance-module', 'Module', instance.module),
    ];
    const parameterNames = new Set([
        ...(definition?.parameters.map(parameter => parameter.name) ?? []),
        ...Object.keys(instance.parameters ?? {}),
    ]);
    for (const parameter of parameterNames) {
        const value = instance.parameters?.[parameter];
        const defaultExpression = definition?.parameters.find(
            candidate => candidate.name === parameter
        )?.defaultExpression;
        fields.push(textField(
            `parameter-${parameter}`,
            parameter,
            value === undefined ? '' : String(value),
            next => ({
                type: 'setInstanceParameter',
                instance: instance.name,
                parameter,
                ...(next.length === 0 ? {} : { value: next }),
            }),
            defaultExpression === undefined ? 'No override' : `Default: ${defaultExpression}`
        ));
    }
    return {
        kind: 'instance',
        title: instance.name,
        fields,
        deleteEdit: { type: 'removeInstance', name: instance.name },
    };
}

function portDefaultKeys(port: ArchDesignPort): string[] {
    if (port.direction === 'output') return [`${port.name}.value`];
    if (port.direction === 'inout') return [`${port.name}.o`, `${port.name}.t`];
    return [];
}

function effectiveDefaultPlaceholder(
    snapshot: ArchDesignAuthoringSnapshot,
    endpoint: string,
    connection?: string
): string {
    const effective = snapshot.validation.effectiveDefaults.find(candidate =>
        candidate.endpoint === endpoint
        && (connection === undefined || candidate.connection === connection)
    );
    if (!effective) return 'No default';
    const source = effective.origin === 'implicit-inout-t'
        ? 'Implicit default'
        : effective.origin === 'design'
            ? 'Design default'
            : 'Connection default';
    return `${source}: ${effective.expression}`;
}

function projectPortInspector(
    snapshot: ArchDesignAuthoringSnapshot,
    name: string
): ArchDesignInspectorModel | undefined {
    const port = snapshot.design.ports.find(candidate => candidate.name === name);
    if (!port) return undefined;
    const updatedPort = (
        next: Partial<Pick<ArchDesignPort, 'name' | 'direction' | 'width'>>
    ): ArchDesignEdit => ({
        type: 'updatePort',
        name: port.name,
        port: {
            name: next.name ?? port.name,
            direction: next.direction ?? port.direction,
            ...(next.width === undefined
                && !Object.prototype.hasOwnProperty.call(next, 'width')
                ? (port.width === undefined ? {} : { width: port.width })
                : next.width === undefined ? {} : { width: next.width }),
        },
    });
    const fields: ArchDesignInspectorField[] = [
        textField('port-name', 'Name', port.name, value => value.trim().length > 0
            ? updatedPort({ name: value.trim() })
            : undefined),
        {
            id: 'port-direction',
            label: 'Direction',
            control: 'select',
            value: port.direction,
            options: ['input', 'output', 'inout'].map(value => ({ value, label: value })),
            commit: value => value === 'input' || value === 'output' || value === 'inout'
                ? updatedPort({ direction: value })
                : undefined,
        },
        textField('port-width', 'Width', displayedWidth(port.width), value =>
            updatedPort({ width: normalizedWidth(value) })),
    ];
    for (const key of portDefaultKeys(port)) {
        fields.push(textField(
            `default-${key}`,
            `Default ${key.slice(port.name.length + 1)}`,
            snapshot.design.defaults[key] ?? '',
            value => ({
                type: 'setDefault',
                endpoint: key,
                ...(value.trim().length === 0 ? {} : { expression: value.trim() }),
            }),
            effectiveDefaultPlaceholder(snapshot, key)
        ));
    }
    return {
        kind: 'port',
        title: port.name,
        fields,
        deleteEdit: { type: 'removePort', name: port.name },
    };
}

function projectNetworkAuthoringInspector(
    snapshot: ArchDesignAuthoringSnapshot,
    graph: SchematicGraph,
    networkId: string
): ArchDesignInspectorModel | undefined {
    const graphNetwork = graph.networks.find(candidate => candidate.id === networkId);
    if (!graphNetwork) return undefined;
    const connection = snapshot.design.connections.find(
        candidate => candidate.name === graphNetwork.name
    );
    if (!connection) return undefined;
    const roles = new Map(graphNetwork.endpoints.map(endpoint => [endpoint.pinId, endpoint.role]));
    const fields: ArchDesignInspectorField[] = [
        textField('connection-name', 'Name', connection.name, value =>
            value.trim().length > 0 ? {
                type: 'renameConnection',
                name: connection.name,
                nextName: value.trim(),
            } : undefined),
        readonlyField(
            'connection-endpoints',
            'Endpoints',
            connection.endpoints.map(endpointLabel).join(', ')
        ),
    ];
    for (const endpoint of connection.endpoints) {
        if (roles.get(endpointIdentity(endpoint)) !== 'load') continue;
        const key = endpointDefaultKey(endpoint);
        fields.push(textField(
            `default-${key}`,
            `Default ${key}`,
            connection.defaults?.[key] ?? '',
            value => ({
                type: 'setDefault',
                connection: connection.name,
                endpoint: key,
                ...(value.trim().length === 0 ? {} : { expression: value.trim() }),
            }),
            effectiveDefaultPlaceholder(snapshot, key, connection.name)
        ));
    }
    return {
        kind: 'network',
        title: connection.name,
        fields,
        deleteEdit: { type: 'removeConnection', name: connection.name },
    };
}

function findPin(
    graph: SchematicGraph,
    pinId: string
): { node: GraphNode; pin: GraphPin } | undefined {
    for (const node of graph.nodes) {
        const pin = node.pins.find(candidate => candidate.id === pinId);
        if (pin) return { node, pin };
    }
    return undefined;
}

function scalarConnectionForPin(
    snapshot: ArchDesignAuthoringSnapshot,
    node: GraphNode,
    pin: GraphPin
): string | undefined {
    if (node.kind !== 'instance') return undefined;
    return snapshot.design.connections.find(connection => connection.endpoints.some(endpoint =>
        endpoint.kind === 'instance'
        && endpoint.instance === node.label
        && endpoint.port === pin.name
    ))?.name;
}

function projectPinAuthoringInspector(
    snapshot: ArchDesignAuthoringSnapshot,
    node: GraphNode,
    pin: GraphPin
): ArchDesignInspectorModel | undefined {
    if (node.kind !== 'instance') return undefined;
    if (pin.interface?.kind === 'aggregate') {
        return projectInterfaceAuthoringInspector(snapshot, pin.interface.id);
    }
    const instance = snapshot.design.instances.find(candidate => candidate.name === node.label);
    if (!instance) return undefined;
    const definition = matchingDefinition(snapshot.catalog, instance.module);
    const definitionPort = definition?.ports.find(candidate => candidate.name === pin.name);
    const interfaceItem = pin.interface === undefined
        ? undefined
        : snapshot.inspector?.interfaces.find(item => item.identity === pin.interface?.id);
    const occupancy = scalarConnectionForPin(snapshot, node, pin)
        ?? interfaceItem?.members.find(member => member.port === pin.name)?.occupancy;
    const width = promotedWidth(pin.width);
    const direction = definitionPort?.direction ?? promotedDirection(pin);
    const port: ArchDesignPort = {
        name: pin.name,
        direction,
        ...(width === undefined ? {} : { width }),
    };
    const fields: ArchDesignInspectorField[] = [
        readonlyField('pin-instance', 'Instance', instance.name),
        readonlyField('pin-name', 'Port', pin.name),
        readonlyField('pin-direction', 'Direction', direction),
        readonlyField('pin-width', 'Width', formatWidth(pin.width)),
        readonlyField(
            'pin-interface',
            'Interface',
            interfaceItem ? `${interfaceItem.protocolName} ${interfaceEndpointName(
                interfaceItem.endpoint
            )}` : 'None'
        ),
        readonlyField('pin-occupancy', 'Occupancy', occupancy ?? 'Unconnected'),
    ];
    if (direction === 'input') {
        const defaultKey = endpointDefaultKey({
            kind: 'instance',
            instance: instance.name,
            port: pin.name,
        });
        const explicit = Object.prototype.hasOwnProperty.call(
            snapshot.design.defaults,
            defaultKey
        ) ? snapshot.design.defaults[defaultKey] : '';
        fields.push(textField(
            'pin-default',
            'Default',
            explicit,
            value => {
                const expression = value.trim();
                return {
                    type: 'setDefault',
                    endpoint: defaultKey,
                    ...(expression.length === 0 ? {} : { expression }),
                };
            },
            'Implicit default: 0'
        ));
    }
    return {
        kind: 'pin',
        title: `${instance.name}.${pin.name}`,
        fields,
        actions: [{
            id: 'expose-port',
            label: 'Expose as top-level port',
            ...(occupancy ? { disabledReason: `Port is connected by ${occupancy}` } : {
                edit: {
                    type: 'promotePort',
                    source: { kind: 'instance', instance: instance.name, port: pin.name },
                    port,
                    connection: pin.name,
                },
            }),
        }],
    };
}

function interfaceEndpointName(
    endpoint: ArchDesignInspectorData['interfaces'][number]['endpoint']
): string {
    return endpoint.kind === 'port'
        ? endpoint.port
        : `${endpoint.instance}.${endpoint.interface}`;
}

function interfaceEndpointIdentity(
    endpoint: ArchDesignInspectorData['interfaces'][number]['endpoint']
): string {
    return endpoint.kind === 'port'
        ? `interface:port:${endpoint.port}`
        : `interface:instance:${endpoint.instance}:${endpoint.interface}`;
}

function interfaceMemberFieldId(scope: string, member: string): string {
    return `${scope}-${member.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
}

function interfaceMemberValue(
    member: ArchDesignInspectorData['interfaces'][number]['members'][number]
): string {
    return `${member.port} · ${formatWidth(member.width)}`;
}

function interfaceCollapseEdit(
    snapshot: ArchDesignAuthoringSnapshot,
    identity: string,
    collapsed: boolean
): ArchDesignEdit {
    return {
        type: 'setPresentation',
        presentation: {
            ...snapshot.design.presentation,
            collapsedInterfaces: {
                ...snapshot.design.presentation.collapsedInterfaces,
                [identity]: collapsed,
            },
        },
    };
}

function projectInterfaceAuthoringInspector(
    snapshot: ArchDesignAuthoringSnapshot,
    identity: string
): ArchDesignInspectorModel | undefined {
    const item = snapshot.inspector?.interfaces.find(candidate => candidate.identity === identity);
    if (!item) return undefined;
    const override = item.endpoint.kind === 'instance'
        ? snapshot.design.interfaceOverrides[`${item.endpoint.instance}.${item.endpoint.interface}`]
        : undefined;
    const topLevelPort = item.endpoint.kind === 'port' ? item.endpoint.port : undefined;
    const fields: ArchDesignInspectorField[] = [
        ...(topLevelPort === undefined ? [] : [textField(
            'interface-name',
            'Name',
            snapshot.design.interfacePorts.find(port => port.name === topLevelPort)
                ?.memberPrefix ?? topLevelPort,
            value => value.trim().length > 0 ? {
                type: 'renameInterfacePort',
                name: topLevelPort,
                nextName: value.trim(),
                nextMemberPrefix: value.trim(),
            } : undefined
        )]),
        readonlyField('interface-protocol', 'Protocol', item.protocolName),
        readonlyField('interface-role', 'Role', item.role),
        readonlyField('interface-role-source', 'Role source', item.roleSource),
        readonlyField('interface-top-level', 'Top-level', item.topLevel ? 'Yes' : 'No'),
        ...(item.members.length === 0
            ? [readonlyField('interface-members-empty', 'Members', 'None')]
            : item.members.map(member => readonlyField(
                interfaceMemberFieldId('interface-member', member.member),
                member.member,
                interfaceMemberValue(member)
            ))),
        readonlyField(
            'interface-missing',
            'Missing members',
            item.missingMembers.length === 0 ? 'None' : item.missingMembers.join(', ')
        ),
        readonlyField(
            'interface-peer',
            'Peer',
            item.connection?.peer ?? 'Unconnected'
        ),
        readonlyField(
            'interface-warnings',
            'Warnings',
            item.connection?.warnings.map(warning => warning.message).join('; ') || 'None'
        ),
        {
            id: 'interface-collapse',
            label: 'Display',
            control: 'select',
            value: item.collapsed ? 'collapsed' : 'expanded',
            options: [
                { value: 'collapsed', label: 'Collapsed' },
                { value: 'expanded', label: 'Expanded' },
            ],
            commit: value => value === 'collapsed' || value === 'expanded'
                ? interfaceCollapseEdit(snapshot, item.identity, value === 'collapsed')
                : undefined,
        },
    ];
    if (item.endpoint.kind === 'instance') {
        const endpoint = item.endpoint;
        fields.push({
            id: 'interface-protocol-override',
            label: 'Protocol override',
            control: 'select',
            value: override?.protocol ?? '',
            options: [
                { value: '', label: 'Automatic' },
                ...(snapshot.inspector?.protocols.map(protocol => ({
                    value: protocol.id,
                    label: protocol.name,
                })) ?? []),
            ],
            commit: value => value === '' && override?.role === undefined
                ? {
                    type: 'clearInterfaceOverride',
                    instance: endpoint.instance,
                    interface: endpoint.interface,
                }
                : value === '' ? {
                    type: 'setInterfaceOverride',
                    instance: endpoint.instance,
                    interface: endpoint.interface,
                    role: override!.role,
                }
                    : snapshot.inspector?.protocols.some(protocol => protocol.id === value)
                        ? {
                            type: 'setInterfaceOverride',
                            instance: endpoint.instance,
                            interface: endpoint.interface,
                            protocol: value,
                            ...(override?.role === undefined ? {} : { role: override.role }),
                        } : undefined,
        });
        fields.push({
            id: 'interface-role-override',
            label: 'Role override',
            control: 'select',
            value: override?.role ?? '',
            options: [
                { value: '', label: 'Automatic' },
                { value: 'master', label: 'Master' },
                { value: 'slave', label: 'Slave' },
            ],
            commit: value => value === 'master' || value === 'slave'
                ? {
                    type: 'setInterfaceOverride',
                    instance: endpoint.instance,
                    interface: endpoint.interface,
                    role: value,
                    ...(override?.protocol === undefined ? {} : { protocol: override.protocol }),
                }
                : value === '' && override?.protocol === undefined
                    ? {
                        type: 'clearInterfaceOverride',
                        instance: endpoint.instance,
                        interface: endpoint.interface,
                    }
                    : value === '' ? {
                        type: 'setInterfaceOverride',
                        instance: endpoint.instance,
                        interface: endpoint.interface,
                        protocol: override!.protocol,
                    } : undefined,
        });
    }
    for (const value of item.connection?.defaults ?? []) {
        fields.push(textField(
            `interface-default-${value.member}`,
            `Default ${value.member}`,
            value.origin === 'connection' ? value.expression : '',
            expression => ({
                type: 'setInterfaceDefault',
                connection: item.connection!.name,
                member: value.member,
                ...(expression.trim().length === 0 ? {} : { expression: expression.trim() }),
            }),
            value.protocolExpression === undefined
                ? 'No protocol default'
                : `Protocol default: ${value.protocolExpression}`
        ));
    }
    const actions: NonNullable<ArchDesignInspectorModel['actions']>[number][] = [];
    if (item.topLevel) {
        const peer = item.connection?.peerIdentity === undefined
            ? undefined
            : snapshot.inspector?.interfaces.find(
                candidate => candidate.identity === item.connection?.peerIdentity
            );
        actions.push({
            id: 'resync-interface',
            label: 'Resynchronize from current connection',
            ...(peer?.snapshot === undefined ? {
                disabledReason: 'No connected module interface is available',
            } : {
                edit: {
                    type: 'resyncInterfacePort',
                    port: item.endpoint.kind === 'port' ? item.endpoint.port : '',
                    source: peer.snapshot,
                },
            }),
        });
    } else {
        actions.push({
            id: 'expose-interface',
            label: 'Expose as top-level interface',
            ...(item.connection ? {
                disabledReason: `Interface is connected by ${item.connection.name}`,
            } : item.snapshot === undefined ? {
                disabledReason: 'Resolve the interface role and member widths first',
            } : {
                edit: {
                    type: 'promoteInterface',
                    source: item.snapshot,
                    port: item.endpoint.kind === 'instance' ? item.endpoint.interface : '',
                    memberPrefix: item.endpoint.kind === 'instance'
                        ? item.endpoint.interface
                        : '',
                    connection: item.endpoint.kind === 'instance'
                        ? item.endpoint.interface
                        : '',
                },
            }),
        });
    }
    return {
        kind: 'interface',
        title: interfaceEndpointName(item.endpoint),
        fields,
        actions,
    };
}

function projectInterfaceNetworkAuthoringInspector(
    snapshot: ArchDesignAuthoringSnapshot,
    network: SchematicNetwork
): ArchDesignInspectorModel | undefined {
    const metadata = network.interface;
    if (!metadata) return undefined;
    const connection = snapshot.design.interfaceConnections.find(
        candidate => candidate.name === metadata.connection
    );
    if (!connection) return undefined;
    const interfaces = snapshot.inspector?.interfaces ?? [];
    const master = interfaces.find(item =>
        item.identity === interfaceEndpointIdentity(connection.master)
    );
    const slave = interfaces.find(item =>
        item.identity === interfaceEndpointIdentity(connection.slave)
    );
    const memberNames = new Set([
        ...(master?.members.map(member => member.member) ?? []),
        ...(slave?.members.map(member => member.member) ?? []),
    ]);
    const defaults = new Map(
        (master?.connection?.defaults ?? slave?.connection?.defaults ?? []).map(item => [
            item.member.toLowerCase(),
            item.expression,
        ])
    );
    const memberFields = [...memberNames].map(memberName => {
        const masterMember = master?.members.find(member => member.member === memberName);
        const slaveMember = slave?.members.find(member => member.member === memberName);
        const direction = masterMember?.direction ?? slaveMember?.direction;
        const sender = direction === 'slave-to-master' ? slaveMember : masterMember;
        const receiver = direction === 'slave-to-master' ? masterMember : slaveMember;
        const source = sender === undefined
            ? defaults.has(memberName.toLowerCase())
                ? `Default ${defaults.get(memberName.toLowerCase())}`
                : 'Undriven'
            : `${sender.port} (${formatWidth(sender.width)})`;
        const target = receiver === undefined
            ? 'Open'
            : `${receiver.port} (${formatWidth(receiver.width)})`;
        return readonlyField(
            interfaceMemberFieldId('interface-network-member', memberName),
            memberName,
            `${source} -> ${target}`
        );
    });
    return {
        kind: 'network',
        title: connection.name,
        fields: [
            readonlyField('interface-network-protocol', 'Protocol', metadata.protocolName),
            readonlyField(
                'interface-network-endpoints',
                'Endpoints',
                `${interfaceEndpointName(connection.master)} -> ${
                    interfaceEndpointName(connection.slave)}`
            ),
            ...(memberFields.length === 0
                ? [readonlyField('interface-network-members-empty', 'Members', 'None')]
                : memberFields),
        ],
        deleteEdit: { type: 'removeInterfaceConnection', name: connection.name },
    };
}

export function projectArchDesignInspector(
    snapshot: ArchDesignAuthoringSnapshot,
    graph: SchematicGraph,
    selectedNodeIds: readonly string[],
    selectedNetworkId: string | undefined,
    selectedPinId?: string
): ArchDesignInspectorModel {
    if (selectedPinId !== undefined) {
        const selectedPin = findPin(graph, selectedPinId);
        if (selectedPin) {
            const pin = projectPinAuthoringInspector(
                snapshot,
                selectedPin.node,
                selectedPin.pin
            );
            if (pin) return pin;
        }
        const interfaceModel = projectInterfaceAuthoringInspector(snapshot, selectedPinId);
        if (interfaceModel) return interfaceModel;
    }
    if (selectedNetworkId !== undefined) {
        const selectedNetwork = graph.networks.find(
            candidate => candidate.id === selectedNetworkId
        );
        if (selectedNetwork?.interface) {
            const interfaceNetwork = projectInterfaceNetworkAuthoringInspector(
                snapshot,
                selectedNetwork
            );
            if (interfaceNetwork) return interfaceNetwork;
        }
        const network = projectNetworkAuthoringInspector(
            snapshot,
            graph,
            selectedNetworkId
        );
        if (network) return network;
    }
    const selected = [...new Set(selectedNodeIds)];
    if (selected.length > 1) {
        return {
            kind: 'multiple',
            title: `${selected.length} objects selected`,
            fields: [readonlyField('selection-count', 'Count', String(selected.length))],
        };
    }
    const [nodeId] = selected;
    if (nodeId?.startsWith('instance:')) {
        const model = projectInstanceInspector(snapshot, nodeId.slice('instance:'.length));
        if (model) return model;
    }
    if (nodeId?.startsWith('port:')) {
        const model = projectPortInspector(snapshot, nodeId.slice('port:'.length));
        if (model) return model;
    }
    if (nodeId?.startsWith('interface:port:')) {
        const model = projectInterfaceAuthoringInspector(snapshot, nodeId);
        if (model) return model;
    }
    return projectDesignInspector(snapshot);
}

function ownsArchDesignPin(node: GraphNode, pin: GraphPin): boolean {
    return node.pins.some(candidate => candidate.id === pin.id);
}

export function archDesignEndpointForPin(
    design: ArchDesign,
    node: GraphNode,
    pin: GraphPin
): ArchDesignEndpoint | undefined {
    if (!ownsArchDesignPin(node, pin)) return undefined;
    if (node.kind === 'instance') {
        const instance = design.instances.find(candidate => candidate.name === node.label);
        return instance
            ? { kind: 'instance', instance: instance.name, port: pin.name }
            : undefined;
    }
    if (node.kind !== 'port') return undefined;
    const port = design.ports.find(candidate => candidate.name === node.label);
    if (!port) return undefined;
    if (port.direction !== 'inout') return { kind: 'port', port: port.name };
    const prefix = `${port.name}_`;
    const signal = pin.name.startsWith(prefix) ? pin.name.slice(prefix.length) : '';
    return signal === 'i' || signal === 'o' || signal === 't'
        ? { kind: 'port', port: port.name, signal }
        : undefined;
}

export function formatSchematicDiagnosticDetails(
    diagnostics: readonly HdlDiagnostic[]
): string {
    return diagnostics.map(diagnostic =>
        `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`
    ).join('\n');
}

type DefaultTimerHandle = ReturnType<typeof setTimeout>;

const defaultTimers: TimerAdapter<DefaultTimerHandle> = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: handle => clearTimeout(handle),
};

export function navigationCommandForCell(
    target: { sourceSpan?: SourceSpan; definitionKey?: string },
    openDefinition: boolean
): WebviewCommand | undefined {
    if (openDefinition) {
        return typeof target.definitionKey === 'string'
            && target.definitionKey.length > 0
            ? { type: 'openDefinition', definitionKey: target.definitionKey }
            : undefined;
    }
    return target.sourceSpan
        ? { type: 'revealSource', span: target.sourceSpan }
        : undefined;
}

export function summarizeSchematicSelection(
    items: readonly SchematicSelectionItem[]
): SchematicSelectionSummary {
    const last = items[items.length - 1];
    if (!last) return { statusText: 'No selection' };
    return {
        selectedObjectId: last.objectId,
        statusText: items.length === 1
            ? last.description
            : `${items.length} objects selected`,
    };
}

export function cloneSchematicLayout(layout: SchematicLayout): SchematicLayout {
    return {
        placement: {
            nodes: Object.fromEntries(Object.entries(layout.placement.nodes).map(
                ([id, node]) => [id, { ...node }]
            )),
        },
        viewport: { ...layout.viewport },
        minimap: layout.minimap,
        ...(layout.selectedObjectId === undefined
            ? {}
            : { selectedObjectId: layout.selectedObjectId }),
    };
}

export function mergeSchematicWebviewLayouts(
    layouts: Readonly<Record<string, SchematicLayout>> | undefined,
    moduleKey: string,
    layout: SchematicLayout
): Record<string, SchematicLayout> {
    return Object.fromEntries([
        ...Object.entries(layouts ?? {}).filter(([key]) => key !== moduleKey),
        [moduleKey, layout] as const,
    ].map(([key, value]) => [key, cloneSchematicLayout(value)]));
}

export class DebouncedLayoutSaveScheduler<Handle = DefaultTimerHandle> {
    private readonly pending = new Map<string, {
        handle?: Handle;
        revision: string;
        layout: SchematicLayout;
    }>();

    constructor(
        private readonly delayMs: number,
        private readonly save: (
            moduleKey: string,
            revision: string,
            layout: SchematicLayout
        ) => void,
        private readonly timers: TimerAdapter<Handle> = defaultTimers as unknown as
            TimerAdapter<Handle>
    ) {}

    schedule(moduleKey: string, revision: string, layout: SchematicLayout): void {
        const previous = this.pending.get(moduleKey);
        if (previous?.handle !== undefined) this.timers.clear(previous.handle);

        const pending: {
            handle?: Handle;
            revision: string;
            layout: SchematicLayout;
        } = {
            revision,
            layout: cloneSchematicLayout(layout),
        };
        this.pending.set(moduleKey, pending);
        pending.handle = this.timers.set(() => {
            this.commit(moduleKey, pending);
        }, this.delayMs);
    }

    flush(): void {
        for (const [moduleKey, pending] of [...this.pending]) {
            this.commit(moduleKey, pending);
        }
    }

    flushModule(moduleKey: string): void {
        const pending = this.pending.get(moduleKey);
        if (pending) this.commit(moduleKey, pending);
    }

    rebaseRevision(moduleKey: string, revision: string): void {
        const pending = this.pending.get(moduleKey);
        if (pending) pending.revision = revision;
    }

    dispose(): void {
        for (const pending of this.pending.values()) {
            if (pending.handle !== undefined) this.timers.clear(pending.handle);
        }
        this.pending.clear();
    }

    private commit(
        moduleKey: string,
        pending: { handle?: Handle; revision: string; layout: SchematicLayout }
    ): void {
        if (this.pending.get(moduleKey) !== pending) return;
        if (pending.handle !== undefined) this.timers.clear(pending.handle);
        this.pending.delete(moduleKey);
        this.save(moduleKey, pending.revision, pending.layout);
    }
}
