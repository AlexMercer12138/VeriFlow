import * as assert from 'assert';

import type { SchematicGraph } from '@veriflow/schematic-core';
import { projectArchDesignGraph } from '@veriflow/schematic-core/arch-design';
import { createInterfaceProtocolCatalog } from '@veriflow/schematic-core/interfaces';
import type {
    ArchDesign,
    ArchDesignModuleDefinition,
    ArchDesignValidationResult,
} from '@veriflow/schematic-core/arch-design';
import type { SchematicLayout } from '../schematic/layoutStore';
import {
    buildSchematicWebviewHtml,
    DebouncedLayoutSaveScheduler,
    formatSchematicDiagnosticDetails,
    mergeSchematicWebviewLayouts,
    navigationCommandForCell,
    projectArchDesignInspector,
    projectSchematicInspector,
    summarizeSchematicSelection,
    type TimerAdapter,
} from '../schematic/webviewSupport';
import { projectArchDesignInspectorData } from '../archDesign/editorSupport';

function fieldById(
    model: ReturnType<typeof projectArchDesignInspector>,
    id: string
): ReturnType<typeof projectArchDesignInspector>['fields'][number] {
    const field = model.fields.find(candidate => candidate.id === id);
    assert.ok(field, `missing Inspector field ${id}`);
    return field;
}

function actionById(
    model: ReturnType<typeof projectArchDesignInspector>,
    id: string
): NonNullable<ReturnType<typeof projectArchDesignInspector>['actions']>[number] {
    const action = model.actions?.find(candidate => candidate.id === id);
    assert.ok(action, `missing Inspector action ${id}`);
    return action;
}

function inspectorGraph(): SchematicGraph {
    return {
        fileUri: 'file:///inspector.sv',
        moduleKey: 'module:inspector:0',
        moduleName: 'inspector_top',
        nodes: [{
            id: 'port:clk',
            kind: 'port',
            label: 'clk',
            pins: [{
                id: 'port:clk:clk',
                name: 'clk',
                direction: 'driver',
                width: { kind: 'known', bits: 1 },
                readOnly: true,
            }],
            readOnly: true,
        }, {
            id: 'port:shared',
            kind: 'port',
            label: 'shared',
            pins: [{
                id: 'port:shared:shared',
                name: 'shared',
                direction: 'bidirectional',
                width: { kind: 'known', bits: 8 },
                readOnly: false,
            }],
            readOnly: false,
        }, {
            id: 'port:done',
            kind: 'port',
            label: 'done',
            pins: [{
                id: 'port:done:done',
                name: 'done',
                direction: 'load',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            }],
            readOnly: false,
        }, {
            id: 'instance:u_core',
            kind: 'instance',
            label: 'u_core',
            subtitle: 'core',
            definitionKey: 'module:file:///core.sv:0',
            pins: [{
                id: 'instance:u_core:clk',
                name: 'clk',
                direction: 'load',
                width: { kind: 'known', bits: 1 },
                readOnly: false,
            }, {
                id: 'instance:u_core:data',
                name: 'data',
                direction: 'driver',
                width: { kind: 'known', bits: 8 },
                readOnly: false,
            }],
            readOnly: false,
        }, {
            id: 'instance:u_sink',
            kind: 'instance',
            label: 'u_sink',
            subtitle: 'sink',
            pins: [{
                id: 'instance:u_sink:data',
                name: 'data',
                direction: 'load',
                width: { kind: 'known', bits: 8 },
                readOnly: false,
            }],
            readOnly: false,
        }],
        networks: [{
            id: 'network:clk',
            name: 'clk',
            width: { kind: 'known', bits: 1 },
            endpoints: [{
                nodeId: 'port:clk',
                pinId: 'port:clk:clk',
                role: 'driver',
            }, {
                nodeId: 'instance:u_core',
                pinId: 'instance:u_core:clk',
                role: 'load',
            }],
        }, {
            id: 'network:data',
            name: 'bus_data',
            adapterLabel: '[7:0]',
            width: { kind: 'known', bits: 8 },
            endpoints: [{
                nodeId: 'instance:u_core',
                pinId: 'instance:u_core:data',
                role: 'driver',
            }, {
                nodeId: 'instance:u_sink',
                pinId: 'instance:u_sink:data',
                role: 'load',
            }, {
                nodeId: 'port:shared',
                pinId: 'port:shared:shared',
                role: 'bidirectional',
            }],
        }],
        diagnostics: [],
    };
}

function testSchematicInspectorProjection(): void {
    const graph = inspectorGraph();
    assert.deepStrictEqual(
        projectSchematicInspector(graph, [], 'network:data'),
        {
            kind: 'network',
            title: 'bus_data',
            readOnly: true,
            rows: [
                { label: 'Name', value: 'bus_data' },
                { label: 'Adapter', value: '[7:0]' },
                { label: 'Width', value: '8 bits' },
                { label: 'Drivers', value: 'u_core.data' },
                { label: 'Loads', value: 'u_sink.data' },
                { label: 'Bidirectional', value: 'shared' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['instance:u_core'], undefined),
        {
            kind: 'instance',
            title: 'u_core',
            readOnly: true,
            rows: [
                { label: 'Name', value: 'u_core' },
                { label: 'Module', value: 'core' },
                { label: 'Pins', value: 'clk (input, 1 bit), data (output, 8 bits)' },
                { label: 'Definition', value: 'Available' },
                { label: 'Read-only', value: 'No' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['port:clk'], undefined),
        {
            kind: 'port',
            title: 'clk',
            readOnly: true,
            rows: [
                { label: 'Name', value: 'clk' },
                { label: 'Direction', value: 'Input' },
                { label: 'Width', value: '1 bit' },
                { label: 'Network', value: 'clk' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['port:shared'], undefined).rows,
        [
            { label: 'Name', value: 'shared' },
            { label: 'Direction', value: 'Inout' },
            { label: 'Width', value: '8 bits' },
            { label: 'Network', value: 'bus_data' },
        ]
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['port:done'], undefined).rows,
        [
            { label: 'Name', value: 'done' },
            { label: 'Direction', value: 'Output' },
            { label: 'Width', value: '1 bit' },
            { label: 'Network', value: 'Unconnected' },
        ]
    );
    assert.deepStrictEqual(
        projectSchematicInspector(
            graph,
            ['port:clk', 'instance:u_core'],
            undefined
        ),
        {
            kind: 'multiple',
            title: '2 objects selected',
            readOnly: true,
            rows: [
                { label: 'Count', value: '2' },
                { label: 'Read-only', value: 'Mixed' },
            ],
        }
    );
    assert.deepStrictEqual(
        projectSchematicInspector(graph, ['node:stale'], 'network:stale'),
        {
            kind: 'empty',
            title: 'No selection',
            readOnly: true,
            rows: [],
        }
    );
}

function testArchDesignInspectorProjection(): void {
    const graph = inspectorGraph();
    const design: ArchDesign = {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 2,
        module: 'inspector_top',
        ports: [{ name: 'clk', direction: 'input' }, {
            name: 'shared',
            direction: 'inout',
            width: 8,
        }, { name: 'done', direction: 'output' }],
        instances: [{
            name: 'u_core',
            module: 'core',
            parameters: { WIDTH: 8 },
        }, { name: 'u_sink', module: 'sink' }],
        logic: [],
        connections: [{
            name: 'clk',
            endpoints: [{ kind: 'port', port: 'clk' }, {
                kind: 'instance',
                instance: 'u_core',
                port: 'clk',
            }],
        }, {
            name: 'bus_data',
            endpoints: [{ kind: 'instance', instance: 'u_core', port: 'data' }, {
                kind: 'instance',
                instance: 'u_sink',
                port: 'data',
            }, { kind: 'port', port: 'shared', signal: 'i' }],
            defaults: { 'u_sink.data': "8'h00" },
        }],
        interfacePorts: [],
        interfaceOverrides: {},
        interfaceConnections: [],
        defaults: { 'done.value': "1'b0", 'u_core.clk': "1'b0" },
        export: { language: 'systemverilog', output: 'rtl/generated_top.sv' },
        presentation: {},
    };
    const catalog: readonly ArchDesignModuleDefinition[] = [{
        key: 'module:file:///core.sv:0',
        name: 'core',
        parameters: [{ name: 'WIDTH', defaultExpression: '32' }, {
            name: 'MODE',
            defaultExpression: '0',
        }],
        ports: [{
            name: 'clk',
            direction: 'input',
            width: { kind: 'known', bits: 1 },
        }, {
            name: 'data',
            direction: 'output',
            width: { kind: 'known', bits: 8 },
        }],
    }, {
        key: 'module:file:///sink.sv:0',
        name: 'sink',
        parameters: [],
        ports: [{
            name: 'data',
            direction: 'input',
            width: { kind: 'known', bits: 8 },
        }],
    }];
    const validation: ArchDesignValidationResult = {
        valid: true,
        diagnostics: [],
        warnings: [],
        effectiveDefaults: [{
            endpoint: 'u_sink.data',
            expression: "8'h00",
            origin: 'connection',
            connection: 'bus_data',
        }, {
            endpoint: 'done.value',
            expression: "1'b0",
            origin: 'design',
        }, {
            endpoint: 'shared.t',
            expression: "1'b1",
            origin: 'implicit-inout-t',
        }],
    };
    const snapshot = { design, catalog, validation };

    const designModel = projectArchDesignInspector(snapshot, graph, [], undefined);
    assert.strictEqual(designModel.kind, 'design');
    assert.strictEqual(designModel.title, 'inspector_top');
    assert.strictEqual(fieldById(designModel, 'design-module').control, 'readonly');
    assert.deepStrictEqual(fieldById(designModel, 'export-language').options, [{
        value: 'verilog',
        label: 'Verilog (.v)',
    }, {
        value: 'systemverilog',
        label: 'SystemVerilog (.sv)',
    }]);
    assert.strictEqual(fieldById(designModel, 'export-language').value, 'systemverilog');
    assert.strictEqual(fieldById(designModel, 'export-output').value, 'rtl/generated_top.sv');
    assert.deepStrictEqual(
        fieldById(designModel, 'export-language').commit?.('verilog'),
        { type: 'setExport', language: 'verilog', output: 'rtl/generated_top.sv' }
    );

    const instanceModel = projectArchDesignInspector(
        snapshot,
        graph,
        ['instance:u_core'],
        undefined
    );
    assert.strictEqual(instanceModel.kind, 'instance');
    assert.strictEqual(fieldById(instanceModel, 'instance-module').control, 'readonly');
    assert.deepStrictEqual(
        fieldById(instanceModel, 'instance-name').commit?.('u_cpu'),
        { type: 'renameInstance', name: 'u_core', nextName: 'u_cpu' }
    );
    assert.strictEqual(fieldById(instanceModel, 'parameter-WIDTH').value, '8');
    assert.strictEqual(fieldById(instanceModel, 'parameter-MODE').placeholder, 'Default: 0');
    assert.deepStrictEqual(
        fieldById(instanceModel, 'parameter-MODE').commit?.('1'),
        { type: 'setInstanceParameter', instance: 'u_core', parameter: 'MODE', value: '1' }
    );
    assert.deepStrictEqual(instanceModel.deleteEdit, {
        type: 'removeInstance',
        name: 'u_core',
    });

    const selectedDuplicate: ArchDesignModuleDefinition = {
        ...catalog[0],
        key: 'module:file:///selected/core.sv:0',
        parameters: [{ name: 'SELECTED', defaultExpression: '7' }],
    };
    const duplicateModel = projectArchDesignInspector(
        {
            ...snapshot,
            design: {
                ...design,
                instances: [{
                    ...design.instances[0],
                    definitionKey: selectedDuplicate.key,
                }, design.instances[1]],
            },
            catalog: [catalog[0], selectedDuplicate, catalog[1]],
        },
        graph,
        ['instance:u_core'],
        undefined
    );
    assert.strictEqual(fieldById(duplicateModel, 'parameter-SELECTED').placeholder, 'Default: 7');

    const inputPinModel = projectArchDesignInspector(
        snapshot,
        graph,
        [],
        undefined,
        'instance:u_core:clk'
    );
    assert.strictEqual(inputPinModel.kind, 'pin');
    assert.strictEqual(fieldById(inputPinModel, 'pin-default').value, "1'b0");
    assert.strictEqual(
        fieldById(inputPinModel, 'pin-default').placeholder,
        'Implicit default: 0'
    );
    assert.deepStrictEqual(fieldById(inputPinModel, 'pin-default').commit?.(" 1'b1 "), {
        type: 'setDefault',
        endpoint: 'u_core.clk',
        expression: "1'b1",
    });
    assert.deepStrictEqual(fieldById(inputPinModel, 'pin-default').commit?.('  '), {
        type: 'setDefault',
        endpoint: 'u_core.clk',
    });

    const outputPinModel = projectArchDesignInspector(
        snapshot,
        graph,
        [],
        undefined,
        'instance:u_core:data'
    );
    assert.equal(outputPinModel.fields.some(field => field.id === 'pin-default'), false);

    const portModel = projectArchDesignInspector(
        snapshot,
        graph,
        ['port:done'],
        undefined
    );
    assert.strictEqual(portModel.kind, 'port');
    assert.deepStrictEqual(fieldById(portModel, 'port-direction').options?.map(
        option => option.value
    ), ['input', 'output', 'inout']);
    assert.deepStrictEqual(fieldById(portModel, 'port-width').commit?.('DATA_WIDTH'), {
        type: 'updatePort',
        name: 'done',
        port: { name: 'done', direction: 'output', width: { expression: 'DATA_WIDTH' } },
    });
    assert.strictEqual(fieldById(portModel, 'default-done.value').value, "1'b0");
    assert.deepStrictEqual(fieldById(portModel, 'default-done.value').commit?.(''), {
        type: 'setDefault',
        endpoint: 'done.value',
    });
    const inoutModel = projectArchDesignInspector(
        snapshot,
        graph,
        ['port:shared'],
        undefined
    );
    assert.strictEqual(
        fieldById(inoutModel, 'default-shared.t').placeholder,
        "Implicit default: 1'b1"
    );

    const networkModel = projectArchDesignInspector(
        snapshot,
        graph,
        [],
        'network:data'
    );
    assert.strictEqual(networkModel.kind, 'network');
    assert.deepStrictEqual(
        fieldById(networkModel, 'connection-name').commit?.('payload'),
        { type: 'renameConnection', name: 'bus_data', nextName: 'payload' }
    );
    assert.strictEqual(fieldById(networkModel, 'connection-endpoints').control, 'readonly');
    assert.strictEqual(fieldById(networkModel, 'default-u_sink.data').value, "8'h00");
    assert.deepStrictEqual(
        fieldById(networkModel, 'default-u_sink.data').commit?.("8'hff"),
        {
            type: 'setDefault',
            connection: 'bus_data',
            endpoint: 'u_sink.data',
            expression: "8'hff",
        }
    );
    assert.deepStrictEqual(networkModel.deleteEdit, {
        type: 'removeConnection',
        name: 'bus_data',
    });
}

function interfaceFixture() {
    const interfaceCatalog = createInterfaceProtocolCatalog([{
        source: '/workspace/protocols/link.json',
        value: {
            format: 'veriflow-interface-protocol',
            schemaVersion: 1,
            id: 'project.link',
            name: 'Project Link',
            separator: '_',
            priority: 100,
            members: [
                { name: 'request', direction: 'master-to-slave' },
                { name: 'accept', direction: 'slave-to-master', default: "1'b0" },
                { name: 'tag', direction: 'master-to-slave', default: "4'h0" },
            ],
            recognitionGroups: [['request', 'accept']],
        },
    }]);
    const catalog: ArchDesignModuleDefinition[] = [{
        key: 'master',
        name: 'master',
        parameters: [],
        ports: [
            { name: 'irq', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 'BUS_REQUEST', direction: 'output', width: { kind: 'known', bits: 32 } },
            { name: 'BUS_ACCEPT', direction: 'input', width: { kind: 'known', bits: 1 } },
        ],
    }, {
        key: 'slave',
        name: 'slave',
        parameters: [],
        ports: [
            { name: 'LINK_REQUEST', direction: 'input', width: { kind: 'known', bits: 16 } },
            { name: 'LINK_ACCEPT', direction: 'output', width: { kind: 'known', bits: 1 } },
            { name: 'LINK_TAG', direction: 'input', width: { kind: 'known', bits: 4 } },
        ],
    }];
    const design: ArchDesign = {
        format: 'vik-veriflow.arch-design',
        schemaVersion: 2,
        module: 'interface_top',
        ports: [],
        instances: [
            { name: 'u_master', module: 'master' },
            { name: 'u_slave', module: 'slave' },
        ],
        logic: [],
        connections: [],
        interfacePorts: [],
        interfaceOverrides: {},
        interfaceConnections: [{
            name: 'control',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'instance', instance: 'u_slave', interface: 'LINK' },
        }],
        defaults: {},
        export: {},
        presentation: {},
    };
    const projection = projectArchDesignGraph(design, catalog, {
        fileUri: 'file:///workspace/interface.ad',
        interfaceCatalog,
    });
    return {
        interfaceCatalog,
        catalog,
        design,
        graph: projection.graph,
        snapshot: {
            design,
            catalog,
            validation: projection.validation,
            inspector: projectArchDesignInspectorData(design, catalog, interfaceCatalog),
        },
    };
}

function testPinAndInterfaceInspectorProjection(): void {
    const fixture = interfaceFixture();
    const pin = projectArchDesignInspector(
        fixture.snapshot,
        fixture.graph,
        [],
        undefined,
        'instance:u_master:irq'
    );
    assert.strictEqual(pin.kind, 'pin');
    assert.strictEqual(fieldById(pin, 'pin-instance').value, 'u_master');
    assert.strictEqual(fieldById(pin, 'pin-name').value, 'irq');
    assert.strictEqual(fieldById(pin, 'pin-direction').value, 'output');
    assert.strictEqual(fieldById(pin, 'pin-width').value, '1 bit');
    assert.strictEqual(fieldById(pin, 'pin-interface').value, 'None');
    assert.strictEqual(fieldById(pin, 'pin-occupancy').value, 'Unconnected');
    assert.deepStrictEqual(actionById(pin, 'expose-port').edit, {
        type: 'promotePort',
        source: { kind: 'instance', instance: 'u_master', port: 'irq' },
        port: { name: 'irq', direction: 'output', width: 1 },
        connection: 'irq',
    });

    const interfaceModel = projectArchDesignInspector(
        fixture.snapshot,
        fixture.graph,
        [],
        undefined,
        'interface:instance:u_master:BUS'
    );
    assert.strictEqual(interfaceModel.kind, 'interface');
    assert.strictEqual(fieldById(interfaceModel, 'interface-protocol').value, 'Project Link');
    assert.strictEqual(fieldById(interfaceModel, 'interface-role').value, 'master');
    assert.strictEqual(fieldById(interfaceModel, 'interface-role-source').value, 'inferred');
    assert.deepStrictEqual(
        fieldById(interfaceModel, 'interface-protocol-override').commit?.('project.link'),
        {
            type: 'setInterfaceOverride',
            instance: 'u_master',
            interface: 'BUS',
            protocol: 'project.link',
        }
    );
    assert.strictEqual(
        fieldById(interfaceModel, 'interface-member-request').value,
        'BUS_REQUEST · 32 bits'
    );
    assert.strictEqual(
        fieldById(interfaceModel, 'interface-member-accept').value,
        'BUS_ACCEPT · 1 bit'
    );
    assert.strictEqual(fieldById(interfaceModel, 'interface-missing').value, 'tag');
    assert.strictEqual(fieldById(interfaceModel, 'interface-peer').value, 'u_slave.LINK');
    assert.strictEqual(fieldById(interfaceModel, 'interface-default-tag').placeholder,
        "Protocol default: 4'h0");
    assert.deepStrictEqual(
        fieldById(interfaceModel, 'interface-default-tag').commit?.("4'hf"),
        {
            type: 'setInterfaceDefault',
            connection: 'control',
            member: 'tag',
            expression: "4'hf",
        }
    );
    assert.deepStrictEqual(
        fieldById(interfaceModel, 'interface-collapse').commit?.('expanded'),
        {
            type: 'setPresentation',
            presentation: {
                collapsedInterfaces: {
                    'interface:instance:u_master:BUS': false,
                },
            },
        }
    );
    assert.strictEqual(fieldById(interfaceModel, 'interface-warnings').value,
        'Interface member request connects 32 bits to 16 bits');
    assert.strictEqual(actionById(interfaceModel, 'expose-interface').disabledReason,
        'Interface is connected by control');

    const unconnectedDesign: ArchDesign = {
        ...fixture.design,
        interfaceConnections: [],
    };
    const unconnectedProjection = projectArchDesignGraph(
        unconnectedDesign,
        fixture.catalog,
        {
            fileUri: 'file:///workspace/interface.ad',
            interfaceCatalog: fixture.interfaceCatalog,
        }
    );
    const unconnectedSnapshot = {
        design: unconnectedDesign,
        catalog: fixture.catalog,
        validation: unconnectedProjection.validation,
        inspector: projectArchDesignInspectorData(
            unconnectedDesign,
            fixture.catalog,
            fixture.interfaceCatalog
        ),
    };
    const exposed = projectArchDesignInspector(
        unconnectedSnapshot,
        unconnectedProjection.graph,
        [],
        undefined,
        'interface:instance:u_master:BUS'
    );
    assert.deepStrictEqual(actionById(exposed, 'expose-interface').edit, {
        type: 'promoteInterface',
        source: {
            endpoint: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            protocol: 'project.link',
            role: 'master',
            members: [
                { member: 'request', port: 'BUS_REQUEST', width: 32 },
                { member: 'accept', port: 'BUS_ACCEPT', width: 1 },
            ],
        },
        port: 'BUS',
        memberPrefix: 'BUS',
        connection: 'BUS',
    });
}

function testTopInterfaceResynchronizationProjection(): void {
    const fixture = interfaceFixture();
    const design: ArchDesign = {
        ...fixture.design,
        interfacePorts: [{
            name: 'm_link',
            protocol: 'project.link',
            role: 'master',
            memberPrefix: 'M_LINK',
            members: [{ member: 'request', width: 8 }],
        }],
        interfaceConnections: [{
            name: 'boundary',
            master: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            slave: { kind: 'port', port: 'm_link' },
        }],
    };
    const projection = projectArchDesignGraph(design, fixture.catalog, {
        fileUri: 'file:///workspace/interface.ad',
        interfaceCatalog: fixture.interfaceCatalog,
    });
    const snapshot = {
        design,
        catalog: fixture.catalog,
        validation: projection.validation,
        inspector: projectArchDesignInspectorData(
            design,
            fixture.catalog,
            fixture.interfaceCatalog
        ),
    };

    const model = projectArchDesignInspector(
        snapshot,
        projection.graph,
        [],
        undefined,
        'interface:port:m_link'
    );
    const nodeSelectionModel = projectArchDesignInspector(
        snapshot,
        projection.graph,
        ['interface:port:m_link'],
        undefined
    );

    assert.strictEqual(model.kind, 'interface');
    assert.strictEqual(nodeSelectionModel.kind, 'interface');
    assert.strictEqual(fieldById(nodeSelectionModel, 'interface-name').value, 'M_LINK');
    assert.strictEqual(fieldById(model, 'interface-top-level').value, 'Yes');
    assert.strictEqual(fieldById(model, 'interface-name').value, 'M_LINK');
    assert.deepStrictEqual(fieldById(model, 'interface-name').commit?.('ddr3'), {
        type: 'renameInterfacePort',
        name: 'm_link',
        nextName: 'ddr3',
        nextMemberPrefix: 'ddr3',
    });
    assert.deepStrictEqual(actionById(model, 'resync-interface').edit, {
        type: 'resyncInterfacePort',
        port: 'm_link',
        source: {
            endpoint: { kind: 'instance', instance: 'u_master', interface: 'BUS' },
            protocol: 'project.link',
            role: 'master',
            members: [
                { member: 'request', port: 'BUS_REQUEST', width: 32 },
                { member: 'accept', port: 'BUS_ACCEPT', width: 1 },
            ],
        },
    });
}

function testInterfaceNetworkInspectorProjection(): void {
    const fixture = interfaceFixture();
    const model = projectArchDesignInspector(
        fixture.snapshot,
        fixture.graph,
        [],
        'network:interface:control'
    );

    assert.strictEqual(model.kind, 'network');
    assert.strictEqual(model.title, 'control');
    assert.strictEqual(fieldById(model, 'interface-network-protocol').value, 'Project Link');
    assert.strictEqual(
        fieldById(model, 'interface-network-endpoints').value,
        'u_master.BUS -> u_slave.LINK'
    );
    assert.strictEqual(
        fieldById(model, 'interface-network-member-request').value,
        'BUS_REQUEST (32 bits) -> LINK_REQUEST (16 bits)'
    );
    assert.strictEqual(
        fieldById(model, 'interface-network-member-accept').value,
        'LINK_ACCEPT (1 bit) -> BUS_ACCEPT (1 bit)'
    );
    assert.deepStrictEqual(model.deleteEdit, {
        type: 'removeInterfaceConnection',
        name: 'control',
    });
}

function testLargeFanoutInspectorUsesBoundedIndexedPreview(): void {
    const withoutFind = <T>(values: T[]): T[] => new Proxy(values, {
        get(target, property, receiver): unknown {
            assert.notStrictEqual(
                property,
                'find',
                'Inspector projection must use an index instead of repeated array scans'
            );
            return Reflect.get(target, property, receiver);
        },
    });
    const source = {
        id: 'instance:source',
        kind: 'instance' as const,
        label: 'source',
        subtitle: 'source',
        pins: withoutFind([{
            id: 'instance:source:out',
            name: 'out',
            direction: 'driver' as const,
            width: { kind: 'known' as const, bits: 1 },
            readOnly: false,
        }]),
        readOnly: false,
    };
    const sinks = Array.from({ length: 32 }, (_, index) => ({
        id: `instance:sink-${index}`,
        kind: 'instance' as const,
        label: `sink-${index}`,
        subtitle: 'sink',
        pins: withoutFind([{
            id: `instance:sink-${index}:in`,
            name: 'in',
            direction: 'load' as const,
            width: { kind: 'known' as const, bits: 1 },
            readOnly: false,
        }]),
        readOnly: false,
    }));
    const graph: SchematicGraph = {
        fileUri: 'file:///large-fanout.sv',
        moduleKey: 'module:large-fanout:0',
        moduleName: 'large_fanout',
        nodes: withoutFind([source, ...sinks]),
        networks: [{
            id: 'network:fanout',
            name: 'fanout',
            width: { kind: 'known', bits: 1 },
            endpoints: [{
                nodeId: source.id,
                pinId: source.pins[0].id,
                role: 'driver',
            }, ...sinks.map(sink => ({
                nodeId: sink.id,
                pinId: sink.pins[0].id,
                role: 'load' as const,
            }))],
        }],
        diagnostics: [],
    };

    const model = projectSchematicInspector(graph, [], 'network:fanout');
    const loads = model.rows.find(row => row.label === 'Loads')?.value;
    assert.strictEqual(loads, [
        'sink-0.in',
        'sink-1.in',
        'sink-2.in',
        'sink-3.in',
        'sink-4.in',
        'sink-5.in',
        'sink-6.in',
        'sink-7.in',
        '... (+24 more)',
    ].join(', '));
    assert.ok((loads?.length ?? Infinity) < 160);
}

function testDiagnosticDetailFormatting(): void {
    assert.strictEqual(formatSchematicDiagnosticDetails([]), '');
    assert.strictEqual(formatSchematicDiagnosticDetails([{
        severity: 'error',
        code: 'HDL_BROKEN',
        message: 'Broken <declaration> & connection',
        span: { start: 1, end: 4 },
    }, {
        severity: 'warning',
        code: 'HDL_INCLUDED',
        message: 'Included source is read-only',
    }]), [
        'ERROR HDL_BROKEN: Broken <declaration> & connection',
        'WARNING HDL_INCLUDED: Included source is read-only',
    ].join('\n'));
}

function testSecureSchematicWebviewHtml(): void {
    const shell = [
        '<!doctype html>',
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\' \'unsafe-inline\'; script-src \'self\';">',
        '<link rel="stylesheet" href="./index.css">',
        '<main>schematic shell</main>',
        '<script src="./index.js"></script>',
    ].join('\n');
    const html = buildSchematicWebviewHtml(shell, {
        cspSource: 'vscode-webview://schematic',
        styleUri: 'vscode-webview://schematic/index.css',
        scriptUri: 'vscode-webview://schematic/index.js',
        nonce: 'nonceValue123',
    });

    assert.match(
        html,
        /default-src 'none'; img-src vscode-webview:\/\/schematic; style-src vscode-webview:\/\/schematic 'unsafe-inline'; script-src 'nonce-nonceValue123';/
    );
    assert.ok(html.includes('href="vscode-webview://schematic/index.css"'));
    assert.ok(html.includes(
        '<script nonce="nonceValue123" src="vscode-webview://schematic/index.js"></script>'
    ));
    assert.doesNotMatch(html, /script-src 'self'/);
    assert.doesNotMatch(html, /<script(?![^>]*\bnonce=)/);
    assert.ok(html.includes('<main>schematic shell</main>'));

    assert.throws(
        () => buildSchematicWebviewHtml('<main>incomplete</main>', {
            cspSource: 'vscode-webview://schematic',
            styleUri: 'vscode-webview://schematic/index.css',
            scriptUri: 'vscode-webview://schematic/index.js',
            nonce: 'nonceValue123',
        }),
        /Content-Security-Policy placeholder/
    );
}

function layout(x: number, selectedObjectId?: string): SchematicLayout {
    return {
        placement: {
            nodes: {
                node: { column: 0, order: 0, yOffset: x, fixed: true },
            },
        },
        viewport: { x: 1, y: 2, zoom: 1 },
        minimap: true,
        ...(selectedObjectId === undefined ? {} : { selectedObjectId }),
    };
}

function testSynchronousWebviewLayoutSnapshot(): void {
    const previous = layout(5, 'instance:previous');
    const current = layout(10, 'network:data');
    const merged = mergeSchematicWebviewLayouts(
        { 'module:previous': previous },
        'module:current',
        current
    );
    previous.placement.nodes.node.yOffset = 500;
    current.placement.nodes.node.yOffset = 1_000;

    assert.deepStrictEqual(merged, {
        'module:previous': layout(5, 'instance:previous'),
        'module:current': layout(10, 'network:data'),
    });
}

async function testModuleSafeLayoutSaveDebounce(): Promise<void> {
    let nextHandle = 0;
    const pending = new Map<number, () => void>();
    const timers: TimerAdapter<number> = {
        set(callback): number {
            nextHandle += 1;
            pending.set(nextHandle, callback);
            return nextHandle;
        },
        clear(handle): void {
            pending.delete(handle);
        },
    };
    const saves: Array<{
        moduleKey: string;
        revision: string;
        layout: SchematicLayout;
    }> = [];
    const scheduler = new DebouncedLayoutSaveScheduler(
        250,
        (moduleKey, revision, savedLayout) => saves.push({
            moduleKey,
            revision,
            layout: savedLayout,
        }),
        timers
    );
    const runPending = (): void => {
        for (const [handle, callback] of [...pending]) {
            pending.delete(handle);
            callback();
        }
    };

    const moduleA = layout(10);
    scheduler.schedule('module:a', 'revision:a1', moduleA);
    moduleA.placement.nodes.node.yOffset = 999;
    scheduler.schedule('module:b', 'revision:b1', layout(30));
    assert.strictEqual(pending.size, 2, 'module B must not cancel module A');

    runPending();
    assert.deepStrictEqual(saves.map(save => [
        save.moduleKey,
        save.revision,
        save.layout.placement.nodes.node.yOffset,
    ]), [
        ['module:a', 'revision:a1', 10],
        ['module:b', 'revision:b1', 30],
    ]);

    scheduler.schedule('module:a', 'revision:a1', layout(40));
    scheduler.schedule('module:a', 'revision:a2', layout(50));
    assert.strictEqual(pending.size, 1, 'same-module changes must debounce');
    runPending();
    assert.deepStrictEqual(saves.at(-1), {
        moduleKey: 'module:a',
        revision: 'revision:a2',
        layout: layout(50),
    });

    const flushedA = layout(60);
    scheduler.schedule('module:a', 'revision:a3', flushedA);
    flushedA.placement.nodes.node.yOffset = 600;
    scheduler.schedule('module:b', 'revision:b2', layout(70));
    scheduler.flush();
    assert.strictEqual(pending.size, 0);
    assert.deepStrictEqual(saves.slice(-2), [{
        moduleKey: 'module:a',
        revision: 'revision:a3',
        layout: layout(60),
    }, {
        moduleKey: 'module:b',
        revision: 'revision:b2',
        layout: layout(70),
    }]);
    const saveCountAfterFlush = saves.length;
    runPending();
    assert.strictEqual(saves.length, saveCountAfterFlush);

    scheduler.schedule('module:a', 'revision:a-before-switch', layout(75));
    scheduler.schedule('module:b', 'revision:b-still-pending', layout(76));
    scheduler.rebaseRevision('module:b', 'revision:b-after-ack');
    scheduler.flushModule('module:a');
    assert.deepStrictEqual(saves.at(-1), {
        moduleKey: 'module:a',
        revision: 'revision:a-before-switch',
        layout: layout(75),
    });
    assert.strictEqual(pending.size, 1, 'module B must remain pending');
    runPending();
    assert.deepStrictEqual(saves.at(-1), {
        moduleKey: 'module:b',
        revision: 'revision:b-after-ack',
        layout: layout(76),
    });
    const saveCountAfterModuleFlush = saves.length;

    scheduler.schedule('module:a', 'revision:a4', layout(80));
    scheduler.dispose();
    assert.strictEqual(pending.size, 0);
    assert.strictEqual(saves.length, saveCountAfterModuleFlush);
}

function testExactCellNavigationCommands(): void {
    const span = { uri: 'file:///top.sv', start: 12, end: 19 };
    const reveal = navigationCommandForCell({ sourceSpan: span }, false);
    assert.deepStrictEqual(reveal, { type: 'revealSource', span });
    if (reveal?.type === 'revealSource') assert.strictEqual(reveal.span, span);

    const definitionKey = 'module:file:///child.sv:44';
    assert.deepStrictEqual(
        navigationCommandForCell({ sourceSpan: span, definitionKey }, true),
        { type: 'openDefinition', definitionKey }
    );
    assert.strictEqual(
        navigationCommandForCell({ sourceSpan: span }, true),
        undefined
    );
    assert.strictEqual(
        navigationCommandForCell({ definitionKey }, false),
        undefined
    );
    assert.strictEqual(
        navigationCommandForCell({ definitionKey: '' }, true),
        undefined
    );
}

function testSelectionStatusSummary(): void {
    assert.deepStrictEqual(
        summarizeSchematicSelection([]),
        { statusText: 'No selection' }
    );
    assert.deepStrictEqual(summarizeSchematicSelection([{
        objectId: 'network:data',
        description: 'network: data',
    }]), {
        selectedObjectId: 'network:data',
        statusText: 'network: data',
    });
    assert.deepStrictEqual(summarizeSchematicSelection([{
        objectId: 'instance:new',
        description: 'instance: new',
    }]), {
        selectedObjectId: 'instance:new',
        statusText: 'instance: new',
    });
    assert.deepStrictEqual(summarizeSchematicSelection([
        { objectId: 'port:a', description: 'port: a' },
        { objectId: 'instance:new', description: 'instance: new' },
    ]), {
        selectedObjectId: 'instance:new',
        statusText: '2 objects selected',
    });
}

void Promise.resolve()
    .then(testSecureSchematicWebviewHtml)
    .then(testDiagnosticDetailFormatting)
    .then(testSchematicInspectorProjection)
    .then(testArchDesignInspectorProjection)
    .then(testPinAndInterfaceInspectorProjection)
    .then(testTopInterfaceResynchronizationProjection)
    .then(testInterfaceNetworkInspectorProjection)
    .then(testLargeFanoutInspectorUsesBoundedIndexedPreview)
    .then(testSynchronousWebviewLayoutSnapshot)
    .then(testSelectionStatusSummary)
    .then(testExactCellNavigationCommands)
    .then(testModuleSafeLayoutSaveDebounce)
    .then(() => console.log('schematic webview support tests passed'))
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
