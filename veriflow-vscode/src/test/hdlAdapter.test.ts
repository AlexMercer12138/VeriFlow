import * as assert from 'assert';
import { readFile } from 'fs/promises';
import { pathToFileURL } from 'url';

import type { SourceSpan } from '../core/hdl/model';
import { fixturePath } from './helpers/fixturePath';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';

function sliceSpan(source: string, span: SourceSpan): string {
    return source.slice(span.start, span.end);
}

function assertSpan(source: string, uri: string, span: SourceSpan, expected: string): void {
    assert.strictEqual(span.uri, uri);
    assert.strictEqual(sliceSpan(source, span), expected);
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

    const secondPass = await parseWithRealWorker(uri, source);
    assert.deepStrictEqual(
        secondPass.modules[0].symbols.map(symbol => symbol.id),
        symbolIds
    );
}

async function main(): Promise<void> {
    await testStructuralFixture();
    await testAdvancedStructures();

    console.log('HDL adapter tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
