import * as assert from 'assert';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';

import type { SourceSpan, SymbolReferenceModel } from '../core/hdl/model';
import { fixturePath } from './helpers/fixturePath';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';

function sliceSpan(source: string, span: SourceSpan): string {
    return source.slice(span.start, span.end);
}

function assertSpan(source: string, uri: string, span: SourceSpan, expected: string): void {
    assert.strictEqual(span.uri, uri);
    assert.strictEqual(sliceSpan(source, span), expected);
}

function referencesWithin(
    source: string,
    references: SymbolReferenceModel[],
    fragment: string
): SymbolReferenceModel[] {
    const start = source.indexOf(fragment);
    assert.notStrictEqual(start, -1, `missing source fragment: ${fragment}`);
    return references.filter(reference =>
        reference.span.start >= start && reference.span.end <= start + fragment.length
    );
}

function bindingSummary(references: SymbolReferenceModel[]): Array<[string, boolean]> {
    return references.map(reference => [reference.name, reference.symbolId !== undefined]);
}

async function testStructuralFixture(): Promise<void> {
    const path = fixturePath('hdl', 'structural.sv');
    const source = await readFile(path, 'utf8');
    const uri = pathToFileURL(path).toString();
    const document = await parseWithRealWorker(uri, source);

    assert.deepStrictEqual(document.modules.map(module => module.name), [
        'child',
        'top',
        'legacy',
    ]);
    assert.deepStrictEqual(document.interfaces.map(unit => unit.name), ['bus_if']);
    assert.deepStrictEqual(document.packages.map(unit => unit.name), ['widths_pkg']);

    const child = document.modules[0];
    assert.strictEqual(child.parameters[0].name, 'WIDTH');
    assert.strictEqual(child.parameters[0].defaultExpression, '8');
    assert.strictEqual(child.parameters[0].defaultValue?.text, '8');
    assert.strictEqual(child.parameters[0].defaultValue?.kind, 'constant');
    assert.deepStrictEqual(
        child.ports.map(port => [port.name, port.direction]),
        [['clk', 'input'], ['data_i', 'input'], ['data_o', 'output']]
    );

    const top = document.modules[1];
    const instance = top.instances[0];
    assert.strictEqual(instance.moduleName, 'child');
    assert.strictEqual(instance.instanceName, 'u_child');
    assert.strictEqual(instance.parameterConnections[0].expression, '8');
    assert.strictEqual(instance.portConnections[0].syntax, 'implicit');
    assert.strictEqual(
        sliceSpan(source, instance.parameterConnections[0].expressionSpan),
        instance.parameterConnections[0].expression
    );
    assert.strictEqual(
        sliceSpan(source, instance.portConnections[1].expressionSpan),
        instance.portConnections[1].expression
    );
    assertSpan(source, uri, instance.portConnections[0].connectionSpan, '.clk');
    assertSpan(source, uri, instance.portConnections[0].expressionSpan, 'clk');

    const pairGroup = top.instanceDeclarationGroups[1];
    assert.deepStrictEqual(
        pairGroup.items.map(item => sliceSpan(source, item.itemSpan).split(/\s|\(/, 1)[0]),
        ['u_pair_a', 'u_pair_b']
    );

    const legacy = document.modules[2];
    assert.strictEqual(legacy.declarationStyle, 'non-ansi');
    assert.deepStrictEqual(
        legacy.ports.map(port => [port.name, port.direction]),
        [['clk', 'input'], ['data_o', 'output']]
    );
    assertSpan(source, uri, legacy.ports[0].headerNameSpan, 'clk');
    assertSpan(source, uri, legacy.ports[0].bodyNameSpan!, 'clk');
    assert.strictEqual(legacy.portDeclarationGroups.length, 2);

    assert.deepStrictEqual(top.nets.map(net => net.names.map(name => name.name)), [['linked']]);
    assert.deepStrictEqual(top.nets[0].width, { kind: 'known', bits: 8 });
    assert.strictEqual(top.continuousAssignments.length, 1);
    assertSpan(source, uri, top.continuousAssignments[0].target.span, 'sink');
    assertSpan(source, uri, top.continuousAssignments[0].value.span, 'linked');
    assert.ok(top.symbols.some(symbol => symbol.kind === 'instance' && symbol.name === 'u_child'));
    assert.ok(top.references.some(reference =>
        reference.context === 'assignmentValue'
        && reference.name === 'linked'
        && reference.symbolId
    ));
    assert.deepStrictEqual(top.opaqueRegions, []);

    assert.strictEqual(document.directives.length, 1);
    assert.strictEqual(document.directives[0].kind, 'timescale_compiler_directive');
    assertSpan(source, uri, document.directives[0].span, '`timescale 1ns/1ps\n');

    for (const span of [
        child.parameters[0].nameSpan,
        child.ports[0].nameSpan,
        instance.moduleNameSpan,
        instance.nameSpan,
        document.interfaces[0].nameSpan,
        document.packages[0].nameSpan,
    ]) {
        assert.strictEqual(span.uri, uri);
        assert.ok(sliceSpan(source, span).length > 0);
    }
}

async function testAdvancedStructures(): Promise<void> {
    const source = [
        '`include "defs.svh"',
        'module advanced #(',
        '    parameter int WIDTH = 8,',
        '    int EXTRA = 2,',
        "    localparam logic [3:0] MASK = 4'hf",
        ') (',
        '    input logic [7:0] a, b,',
        '    output logic y',
        ');',
        '    localparam int BODY_WIDTH = WIDTH;',
        '    wire [7:0] first, second;',
        '    logic state;',
        '    reg old_state;',
        '    integer count;',
        '    child #(.WIDTH()) u_empty (.clk(), .data_i, .data_o(first));',
        '    child u_positional (a[0], {a[3:0], b[3:0]}, y);',
        '    child u_wildcard (.*);',
        '    assign second = a;',
        '    assign y = state;',
        '    always_comb begin',
        '        logic state;',
        '        state = a[0];',
        '        old_state = b[0];',
        '    end',
        '    function automatic logic helper(input logic state);',
        '        helper = state;',
        '    endfunction',
        'endmodule',
        '',
        'module grouped(a, b);',
        '    input [3:0] a, b;',
        'endmodule',
    ].join('\n');
    const uri = 'memory:/advanced.sv';
    const document = await parseWithRealWorker(uri, source);
    const advanced = document.modules[0];

    assert.deepStrictEqual(
        advanced.parameters.map(parameter => parameter.name),
        ['WIDTH', 'EXTRA']
    );
    assert.deepStrictEqual(
        advanced.localParameters.map(parameter => parameter.name),
        ['MASK', 'BODY_WIDTH']
    );
    assert.deepStrictEqual(advanced.localParameters[0].defaultValue?.width, {
        kind: 'known',
        bits: 4,
    });
    assert.strictEqual(advanced.localParameters[1].defaultValue?.kind, 'identifier');
    assertSpan(source, uri, advanced.localParameters[1].valueSpan!, 'WIDTH');
    assert.strictEqual(advanced.ports[1].name, 'b');
    assert.strictEqual(advanced.ports[1].inheritsDirection, true);
    assert.strictEqual(advanced.ports[1].inheritsType, true);
    assert.strictEqual(advanced.ports[1].inheritsPackedRange, true);
    assert.strictEqual(advanced.ports[1].directionSpan, undefined);
    assert.strictEqual(advanced.ports[1].packedRangeSpan, undefined);
    assert.strictEqual(advanced.portDeclarationGroups[0].items.length, 2);
    assertSpan(source, uri, advanced.portDeclarationGroups[0].items[0].separatorSpan!, ', ');
    assert.strictEqual(advanced.portDeclarationGroups[0].items[1].separatorSpan, undefined);

    assert.deepStrictEqual(
        advanced.nets.map(net => [net.kind, net.names.map(name => name.name)]),
        [
            ['wire', ['first', 'second']],
            ['logic', ['state']],
            ['reg', ['old_state']],
            ['other', ['count']],
        ]
    );
    assertSpan(source, uri, advanced.nets[0].declarationSpan, 'wire [7:0] first, second;');

    const empty = advanced.instances[0];
    assert.strictEqual(empty.parameterConnections[0].syntax, 'named');
    assert.strictEqual(empty.parameterConnections[0].expression, '');
    assert.strictEqual(empty.parameterConnections[0].expressionSpan.start,
        empty.parameterConnections[0].expressionSpan.end);
    assert.strictEqual(sliceSpan(source, empty.parameterConnections[0].expressionSpan), '');
    assert.strictEqual(empty.portConnections[0].syntax, 'named');
    assert.strictEqual(empty.portConnections[0].expression, '');
    assert.strictEqual(empty.portConnections[1].syntax, 'implicit');
    assertSpan(source, uri, empty.portConnections[1].expressionSpan, 'data_i');

    const positional = advanced.instances[1];
    assert.deepStrictEqual(
        positional.portConnections.map(connection => connection.syntax),
        ['positional', 'positional', 'positional']
    );
    assert.strictEqual(positional.portConnections[0].expressionModel?.kind, 'select');
    assert.strictEqual(positional.portConnections[1].expressionModel?.kind, 'concat');
    assert.strictEqual(advanced.instances[2].portConnections[0].syntax, 'wildcard');
    assertSpan(
        source,
        uri,
        advanced.instances[2].portConnections[0].connectionSpan,
        '.*'
    );
    assertSpan(
        source,
        uri,
        advanced.instances[2].portConnections[0].expressionSpan,
        '*'
    );

    assert.deepStrictEqual(
        advanced.continuousAssignments.map(assignment => [
            assignment.target.text,
            assignment.value.text,
        ]),
        [['second', 'a'], ['y', 'state']]
    );
    const symbolIds = advanced.symbols.map(symbol => symbol.id);
    assert.strictEqual(new Set(symbolIds).size, symbolIds.length);
    assert.deepStrictEqual(
        advanced.symbols.map(symbol => symbol.declarationSpans[0].start),
        advanced.symbols.map(symbol => symbol.declarationSpans[0].start).sort((a, b) => a - b)
    );
    assert.ok(advanced.references.some(reference =>
        reference.context === 'connection'
        && reference.name === 'first'
        && reference.symbolId
    ));
    assert.ok(advanced.references.some(reference =>
        reference.context === 'assignmentTarget'
        && reference.name === 'second'
        && reference.symbolId
    ));
    assert.deepStrictEqual(
        advanced.references.map(reference => reference.span.start),
        advanced.references.map(reference => reference.span.start).sort((a, b) => a - b)
    );

    assert.strictEqual(
        advanced.symbols.find(symbol => symbol.name === 'count')?.kind,
        'variable'
    );

    assert.strictEqual(advanced.opaqueRegions.length, 2);
    assert.strictEqual(advanced.opaqueRegions[0].reason, 'always_construct');
    assert.deepStrictEqual(advanced.opaqueRegions[0].boundaryNames, ['a', 'old_state', 'b']);
    assert.strictEqual(advanced.opaqueRegions[1].reason, 'function_declaration');
    assert.deepStrictEqual(advanced.opaqueRegions[1].boundaryNames, []);
    assert.ok(!advanced.references.some(reference =>
        reference.context === 'unknown' && reference.name === 'state'
    ));

    const grouped = document.modules[1];
    assert.strictEqual(grouped.portDeclarationGroups.length, 1);
    assert.strictEqual(grouped.portDeclarationGroups[0].items.length, 2);
    assert.strictEqual(grouped.ports[1].inheritsDirection, true);
    assert.strictEqual(grouped.ports[1].inheritsPackedRange, true);
    assert.strictEqual(grouped.ports[1].directionSpan, undefined);
    assert.strictEqual(grouped.ports[1].packedRangeSpan, undefined);
    assert.strictEqual(grouped.symbols.find(symbol => symbol.name === 'b')?.declarationSpans.length, 2);

    assert.strictEqual(document.includes.length, 1);
    assert.strictEqual(document.includes[0].path, 'defs.svh');
    assert.strictEqual(document.includes[0].resolvedUri, undefined);
    assertSpan(source, uri, document.includes[0].span, '`include "defs.svh"');
    const unresolvedInclude = document.diagnostics.find(
        diagnostic => diagnostic.code === 'HDL_INCLUDE_UNRESOLVED'
    );
    assert.ok(unresolvedInclude?.span);
    assertSpan(source, uri, unresolvedInclude.span, '`include "defs.svh"');

    const secondPass = await parseWithRealWorker(uri, source);
    assert.deepStrictEqual(
        secondPass.modules[0].symbols.map(symbol => symbol.id),
        symbolIds
    );
}

async function testReferenceBindingEligibility(): Promise<void> {
    const source = [
        'module reference_case(input logic sig, input logic index, output logic y);',
        '    child u_ref (',
        '        .plain(sig),',
        '        .macro(`PASS(sig)),',
        '        .member(u_ref.sig),',
        '        .member_call(u_ref.sig(index)),',
        '        .scoped(pkg::sig),',
        '        .scope_call(pkg::consume(sig)),',
        '        .selected(sig[index])',
        '    );',
        '    assign y = sig;',
        '    assign y = `PASS(sig);',
        '    assign y = u_ref.sig;',
        '    assign y = u_ref.sig(index);',
        '    assign y = pkg::sig;',
        '    assign y = pkg::consume(sig);',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/reference-case.sv', source);
    const references = document.modules[0].references;

    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, '.plain(sig)')),
        [['sig', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, '.macro(`PASS(sig))')),
        [['PASS', false], ['sig', false]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, '.member(u_ref.sig)')),
        [['u_ref', true], ['sig', false]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, '.member_call(u_ref.sig(index))')),
        [['u_ref', true], ['sig', false], ['index', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, '.scoped(pkg::sig)')),
        [['pkg', false], ['sig', false]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, '.scope_call(pkg::consume(sig))')),
        [['pkg', false], ['consume', false], ['sig', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, '.selected(sig[index])')),
        [['sig', true], ['index', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, 'assign y = sig;')),
        [['y', true], ['sig', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, 'assign y = `PASS(sig);')),
        [['y', true], ['PASS', false], ['sig', false]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, 'assign y = u_ref.sig;')),
        [['y', true], ['u_ref', true], ['sig', false]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, 'assign y = u_ref.sig(index);')),
        [['y', true], ['u_ref', true], ['sig', false], ['index', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, 'assign y = pkg::sig;')),
        [['y', true], ['pkg', false], ['sig', false]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, references, 'assign y = pkg::consume(sig);')),
        [['y', true], ['pkg', false], ['consume', false], ['sig', true]]
    );
}

async function testOpaqueLexicalShadowing(): Promise<void> {
    const source = [
        'module opaque_case(input logic x, input logic a, output logic y);',
        '    always_comb begin',
        '        y = x;',
        '        begin',
        '            logic x;',
        '            x = a;',
        '        end',
        '        y = x;',
        '    end',
        '    function automatic logic helper(input logic x);',
        '        helper = x;',
        '    endfunction',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/opaque-case.sv', source);
    const module = document.modules[0];

    assert.deepStrictEqual(module.opaqueRegions.map(region => region.boundaryNames), [
        ['y', 'x', 'a'],
        [],
    ]);
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'y = x;\n        begin')),
        [['y', true], ['x', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'x = a;')),
        [['a', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'y = x;\n    end')),
        [['y', true], ['x', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'helper = x;')),
        []
    );
}

async function testDeclaredUdpIsNotModuleInstance(): Promise<void> {
    const source = [
        'primitive myudp(out, a, b);',
        '    output out;',
        '    input a, b;',
        '    table',
        '        00 : 0;',
        '        01 : 1;',
        '        10 : 1;',
        '        11 : 0;',
        '    endtable',
        'endprimitive',
        '',
        'module positional_child(input logic a, input logic b, output logic y);',
        'endmodule',
        '',
        'module udp_top(input logic a, input logic b, output logic y);',
        '    myudp u_udp(y, a, b);',
        '    positional_child u_child(a, b, y);',
        '    and g_and(y, a, b);',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/udp-case.sv', source);
    const top = document.modules.find(module => module.name === 'udp_top');
    assert.ok(top);
    assert.deepStrictEqual(
        top.instances.map(instance => [instance.moduleName, instance.instanceName]),
        [['positional_child', 'u_child']]
    );
}

async function testMultiplePackedDimensions(): Promise<void> {
    const source = [
        'module packed_dims #(',
        '    parameter WIDTH = 4',
        ') (',
        '    input logic [1:0] [3:0] p, q,',
        '    input logic [WIDTH-1:0] [1:0] symbolic_p,',
        '    output struct packed { logic [3:0] member; } [1:0] packed_struct_p,',
        '    output union packed { logic [3:0] member; logic flag; } packed_union_p,',
        '    input int int_p,',
        '    input byte byte_p,',
        '    input bit [1:0] bit_vector_p',
        ');',
        '    wire [1:0] [3:0] n;',
        '    logic [WIDTH-1:0] [1:0] symbolic_n;',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/packed-dims.sv', source);
    const module = document.modules[0];
    const p = module.ports.find(port => port.name === 'p');
    const q = module.ports.find(port => port.name === 'q');
    const symbolicPort = module.ports.find(port => port.name === 'symbolic_p');
    const packedStructPort = module.ports.find(port => port.name === 'packed_struct_p');
    const packedUnionPort = module.ports.find(port => port.name === 'packed_union_p');
    const intPort = module.ports.find(port => port.name === 'int_p');
    const bytePort = module.ports.find(port => port.name === 'byte_p');
    const bitVectorPort = module.ports.find(port => port.name === 'bit_vector_p');
    assert.ok(p && q && symbolicPort && packedStructPort && packedUnionPort
        && intPort && bytePort && bitVectorPort);

    assert.strictEqual(p.typeText, 'logic');
    assert.strictEqual(p.packedRange, '[1:0] [3:0]');
    assert.deepStrictEqual(p.width, { kind: 'known', bits: 8 });
    assertSpan(source, document.uri, p.packedRangeSpan!, '[1:0] [3:0]');
    assert.strictEqual(q.packedRange, '[1:0] [3:0]');
    assert.deepStrictEqual(q.width, { kind: 'known', bits: 8 });
    assert.strictEqual(q.packedRangeSpan, undefined);
    assert.strictEqual(q.inheritsPackedRange, true);
    assert.strictEqual(symbolicPort.typeText, 'logic');
    assert.strictEqual(symbolicPort.packedRange, '[WIDTH-1:0] [1:0]');
    assert.deepStrictEqual(symbolicPort.width, {
        kind: 'symbolic',
        expression: '[WIDTH-1:0] [1:0]',
    });
    assert.strictEqual(packedStructPort.typeText,
        'struct packed { logic [3:0] member; }');
    assert.strictEqual(packedStructPort.packedRange, '[1:0]');
    assert.deepStrictEqual(packedStructPort.width, { kind: 'unknown' });
    assert.strictEqual(packedUnionPort.typeText,
        'union packed { logic [3:0] member; logic flag; }');
    assert.strictEqual(packedUnionPort.packedRange, undefined);
    assert.deepStrictEqual(packedUnionPort.width, { kind: 'unknown' });
    assert.deepStrictEqual(intPort.width, { kind: 'known', bits: 32 });
    assert.deepStrictEqual(bytePort.width, { kind: 'known', bits: 8 });
    assert.strictEqual(bitVectorPort.typeText, 'bit');
    assert.strictEqual(bitVectorPort.packedRange, '[1:0]');
    assert.deepStrictEqual(bitVectorPort.width, { kind: 'known', bits: 2 });

    const n = module.nets.find(net => net.names[0].name === 'n');
    const symbolicNet = module.nets.find(net => net.names[0].name === 'symbolic_n');
    assert.ok(n && symbolicNet);
    assert.strictEqual(n.typeText, 'wire');
    assert.strictEqual(n.packedRange, '[1:0] [3:0]');
    assert.deepStrictEqual(n.width, { kind: 'known', bits: 8 });
    assert.strictEqual(symbolicNet.typeText, 'logic');
    assert.deepStrictEqual(symbolicNet.width, {
        kind: 'symbolic',
        expression: '[WIDTH-1:0] [1:0]',
    });
}

async function testEmptyPositionalConnections(): Promise<void> {
    const source = [
        'module positional_empty(input logic a, input logic b, input logic c);',
        '    child u_middle(a, /* intentionally empty */ , c);',
        '    child u_first(, b);',
        '    child u_last(a,);',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/positional-empty.sv', source);
    const module = document.modules[0];
    const middle = module.instances.find(instance => instance.instanceName === 'u_middle');
    const first = module.instances.find(instance => instance.instanceName === 'u_first');
    const last = module.instances.find(instance => instance.instanceName === 'u_last');
    assert.ok(middle && first && last);

    assert.deepStrictEqual(
        middle.portConnections.map(connection => connection.expression),
        ['a', '', 'c']
    );
    assert.strictEqual(middle.portConnections[1].syntax, 'positional');
    assert.strictEqual(middle.portConnections[1].expressionSpan.start,
        middle.portConnections[1].expressionSpan.end);
    assert.deepStrictEqual(
        middle.portConnections[1].connectionSpan,
        middle.portConnections[1].expressionSpan
    );
    const middleFirstComma = source.indexOf(',', source.indexOf('u_middle'));
    assert.strictEqual(middle.portConnections[1].expressionSpan.start, middleFirstComma + 1);

    assert.deepStrictEqual(first.portConnections.map(connection => connection.expression), ['', 'b']);
    assert.strictEqual(
        first.portConnections[0].expressionSpan.start,
        source.indexOf('(', source.indexOf('u_first')) + 1
    );
    assert.deepStrictEqual(last.portConnections.map(connection => connection.expression), ['a', '']);
    const lastComma = source.indexOf(',', source.indexOf('u_last'));
    assert.strictEqual(last.portConnections[1].expressionSpan.start, lastComma + 1);
}

async function testTypeParameters(): Promise<void> {
    const source = [
        'module type_parameters #(',
        '    parameter type T = logic [3:0],',
        '    parameter A = 1, B = 2',
        ') (output logic y);',
        '    parameter type U = bit;',
        '    assign y = A;',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/type-parameters.sv', source);
    const module = document.modules[0];
    assert.deepStrictEqual(module.parameters.map(parameter => parameter.name), ['T', 'A', 'B', 'U']);

    const t = module.parameters[0];
    assert.strictEqual(t.kind, 'parameter');
    assert.strictEqual(t.typeText, 'type');
    assert.strictEqual(t.defaultExpression, 'logic [3:0]');
    assert.strictEqual(t.defaultValue?.kind, 'unknown');
    assert.strictEqual(t.defaultValue?.text, 'logic [3:0]');
    assertSpan(source, document.uri, t.nameSpan, 'T');
    assertSpan(source, document.uri, t.valueSpan!, 'logic [3:0]');

    const u = module.parameters[3];
    assert.strictEqual(u.typeText, 'type');
    assert.strictEqual(u.defaultExpression, 'bit');
    assert.ok(module.symbols.some(symbol => symbol.kind === 'parameter' && symbol.name === 'T'));
    assert.ok(module.symbols.some(symbol => symbol.kind === 'parameter' && symbol.name === 'U'));
    assert.ok(module.references.some(reference =>
        reference.name === 'A'
        && reference.context === 'assignmentValue'
        && reference.symbolId === module.symbols.find(symbol => symbol.name === 'A')?.id
    ));
}

async function testNonAnsiSupplementalDeclarations(): Promise<void> {
    const source = [
        'module supplemental(q);',
        '    output q;',
        '    reg q;',
        '    wire other_net;',
        '    logic other_var;',
        '    assign q = other_net;',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/supplemental.sv', source);
    const module = document.modules[0];
    assert.strictEqual(module.ports.find(port => port.name === 'q')?.direction, 'output');
    assert.ok(module.nets.some(net =>
        net.kind === 'reg' && net.names.some(name => name.name === 'q')
    ));

    const qSymbols = module.symbols.filter(symbol => symbol.name === 'q');
    assert.strictEqual(qSymbols.length, 1);
    assert.strictEqual(qSymbols[0].kind, 'port');
    assert.deepStrictEqual(
        qSymbols[0].declarationSpans.map(span => sliceSpan(source, span)),
        ['q', 'output q;', 'reg q;']
    );
    assert.strictEqual(
        module.references.find(reference =>
            reference.name === 'q' && reference.context === 'assignmentTarget'
        )?.symbolId,
        qSymbols[0].id
    );
    assert.strictEqual(module.symbols.find(symbol => symbol.name === 'other_net')?.kind, 'net');
    assert.strictEqual(module.symbols.find(symbol => symbol.name === 'other_var')?.kind, 'variable');
}

async function testOpaqueNonReferenceIdentifiers(): Promise<void> {
    const source = [
        'module opaque_names #(',
        '    parameter W = 9',
        ') (input logic blk, input logic x, input logic my_t, output logic y);',
        '    always_comb begin',
        '        y = W;',
        '        begin : blk',
        '            localparam int W = 2;',
        '            logic x;',
        '            my_t local_value;',
        '            y = (W);',
        '            x = x;',
        '        end',
        '        y = f(.x(x));',
        '        begin : enum_scope',
        '            typedef enum {W} e_t;',
        '            y = W;',
        '        end',
        '        y = W + 1;',
        '    end',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/opaque-names.sv', source);
    const module = document.modules[0];
    assert.deepStrictEqual(module.opaqueRegions[0].boundaryNames, ['y', 'W', 'x']);
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'begin : blk')),
        []
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'localparam int W = 2;')),
        []
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'my_t local_value;')),
        []
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'y = (W);')),
        [['y', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'x = x;')),
        []
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'y = f(.x(x));')),
        [['y', true], ['x', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'typedef enum {W} e_t;')),
        []
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, '            y = W;')),
        [['y', true]]
    );
    assert.deepStrictEqual(
        bindingSummary(referencesWithin(source, module.references, 'y = W + 1;')),
        [['y', true], ['W', true]]
    );
}

async function testUnsupportedInterfacePortDiagnostic(): Promise<void> {
    const source = [
        'interface bus_if;',
        '    logic data;',
        '    modport master(input data);',
        'endinterface',
        '',
        'module interface_user(bus_if.master bus, bus2, input logic clk);',
        'endmodule',
    ].join('\n');
    const uri = 'memory:/interface-port.sv';
    const document = await parseWithRealWorker(uri, source);
    const module = document.modules[0];
    assert.deepStrictEqual(module.ports.map(port => port.name), ['clk']);
    const diagnostics = document.diagnostics.filter(item =>
        item.code === 'systemverilog.unsupported-interface-port'
    );
    assert.deepStrictEqual(
        diagnostics.map(item => item.span && sliceSpan(source, item.span)),
        ['bus_if.master bus', 'bus2']
    );
    assert.ok(diagnostics.every(item => item.severity === 'warning'));
    assert.ok(diagnostics.every(item => item.span?.uri === uri));
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(document)));
}

async function testOperationExpressionClassification(): Promise<void> {
    const source = [
        'module operation_kinds(',
        '    input logic [3:0] a, b, c,',
        '    output logic [3:0] y',
        ');',
        '    assign y = a + b;',
        '    assign y = -a;',
        '    assign y = a ? b : c;',
        '    assign y = a;',
        '    assign y = a[0];',
        '    assign y = {a, b};',
        "    assign y = 4'hf;",
        '    assign y = a[b + 1];',
        '    assign y = {a + b, c};',
        '    assign y = a + {b, c};',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/operation-kinds.sv', source);
    assert.deepStrictEqual(
        document.modules[0].continuousAssignments.map(assignment => assignment.value.kind),
        [
            'operation', 'operation', 'operation', 'identifier', 'select', 'concat', 'constant',
            'select', 'concat', 'operation',
        ]
    );
}

async function testNetTypeText(): Promise<void> {
    const source = [
        'module net_types;',
        '    wire [7:0] n;',
        '    logic [3:0] l;',
        '    reg [1:0] r;',
        '    tri [0:0] t;',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker('memory:/net-types.sv', source);
    assert.deepStrictEqual(
        document.modules[0].nets.map(net => [net.kind, net.typeText]),
        [['wire', 'wire'], ['logic', 'logic'], ['reg', 'reg'], ['other', 'tri']]
    );
}

async function testQualityReviewRegressions(): Promise<void> {
    const tests: Array<[string, () => Promise<void>]> = [
        ['multiple packed dimensions', testMultiplePackedDimensions],
        ['empty positional connections', testEmptyPositionalConnections],
        ['type parameters', testTypeParameters],
        ['non-ANSI supplemental declarations', testNonAnsiSupplementalDeclarations],
        ['opaque non-reference identifiers', testOpaqueNonReferenceIdentifiers],
        ['unsupported interface port diagnostic', testUnsupportedInterfacePortDiagnostic],
        ['operation expression classification', testOperationExpressionClassification],
        ['net declaration type text', testNetTypeText],
    ];
    const failures: string[] = [];
    for (const [name, test] of tests) {
        try {
            await test();
        } catch (error) {
            failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (failures.length > 0) {
        assert.fail(failures.join('\n'));
    }
}

async function testReviewRegressions(): Promise<void> {
    const tests: Array<[string, () => Promise<void>]> = [
        ['reference binding eligibility', testReferenceBindingEligibility],
        ['opaque lexical shadowing', testOpaqueLexicalShadowing],
        ['declared UDP filtering', testDeclaredUdpIsNotModuleInstance],
    ];
    const failures: string[] = [];
    for (const [name, test] of tests) {
        try {
            await test();
        } catch (error) {
            failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (failures.length > 0) {
        assert.fail(failures.join('\n'));
    }
}

async function main(): Promise<void> {
    await testStructuralFixture();
    await testAdvancedStructures();
    await testReviewRegressions();
    await testQualityReviewRegressions();

    console.log('HDL adapter tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
