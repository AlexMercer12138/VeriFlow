import * as assert from 'assert';

import { PositionMap } from '../core/hdl/positionMap';
import {
    canonicalizeSourceUri,
    CompositeSourceMap,
    getPreprocessMetadataForWorker,
    isSourceUriWithinRoot,
    preprocessForParsing,
} from '../core/hdl/preprocessor';
import { parseWithRealWorker } from './helpers/hdlWorkerFixture';

function assertNewlinesPreserved(source: string, transformed: string): void {
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\r' || source[index] === '\n') {
            assert.strictEqual(transformed[index], source[index]);
        }
    }
}

function testActiveBranchesAndDefineSideEffects(): void {
    const source = [
        '`define LOCAL',
        '`ifdef OUTER',
        'module inactive; endmodule',
        '`elsif LOCAL',
        'module active; child u_child(); endmodule',
        '`else',
        'module fallback; endmodule',
        '`endif',
        '`undef LOCAL',
    ].join('\r\n');
    const result = preprocessForParsing('file:///workspace/top.sv', source, { defines: {} });

    assert.strictEqual(result.text.length, source.length);
    assertNewlinesPreserved(source, result.text);
    assert.ok(result.text.includes('module active; child u_child(); endmodule'));
    assert.ok(!result.text.includes('module inactive'));
    assert.ok(!result.text.includes('module fallback'));
    assert.strictEqual(result.activeDefines.LOCAL, undefined);
    assert.deepStrictEqual(result.diagnostics, []);
}

function testTextualIncludesAndSourceMapping(): void {
    const includeResult = preprocessForParsing('file:///workspace/top.sv', [
        '`include "defs.svh"',
        '`ifdef FROM_INCLUDE',
        'module included_branch; endmodule',
        '`endif',
    ].join('\n'), {
        defines: {},
        resolvedIncludes: [{
            fromUri: 'file:///workspace/top.sv',
            rawPath: 'defs.svh',
            resolvedUri: 'file:///workspace/include/defs.svh',
            text: '`define FROM_INCLUDE 1\n',
        }],
    });
    assert.ok(includeResult.text.includes('module included_branch'));
    assert.strictEqual(includeResult.activeDefines.FROM_INCLUDE, '1');

    const parentUri = 'file:///workspace/with_ports.sv';
    const portsUri = 'file:///workspace/ports.svh';
    const bodyUri = 'file:///workspace/body.svh';
    const parent = [
        'module with_ports (',
        '`include "ports.svh"',
        ');',
        '`include "body.svh"',
        'endmodule',
        '',
    ].join('\n');
    const ports = 'input logic clk, output logic done';
    const body = 'child u_child(.clk(clk), .done(done));';
    const result = preprocessForParsing(parentUri, parent, {
        defines: {},
        resolvedIncludes: [
            { fromUri: parentUri, rawPath: 'ports.svh', resolvedUri: portsUri, text: ports },
            { fromUri: parentUri, rawPath: 'body.svh', resolvedUri: bodyUri, text: body },
        ],
    });

    assert.ok(result.text.includes(ports));
    assert.ok(result.text.includes(body));
    const includedPortOffset = result.text.indexOf('clk');
    assert.deepStrictEqual(
        result.sourceMap.mapSpan(includedPortOffset, includedPortOffset + 3),
        { start: 12, end: 15, uri: portsUri }
    );
    assert.strictEqual(result.sourceTexts[parentUri], parent);
    assert.strictEqual(result.sourceTexts[portsUri], ports);
    assert.strictEqual(result.sourceTexts[bodyUri], body);

    const declarationStart = result.text.indexOf('module');
    const declarationEnd = result.text.indexOf('endmodule') + 'endmodule'.length;
    const declarationSpan = result.sourceMap.mapSpan(declarationStart, declarationEnd);
    assert.strictEqual(declarationSpan.uri, parentUri);
    assert.ok(declarationSpan.compositeParts);
    assert.deepStrictEqual(
        declarationSpan.compositeParts!.map(part => part.uri),
        [parentUri, portsUri, parentUri, bodyUri, parentUri]
    );
}

function testUnicodeMaskingKeepsUtf16AndBytePositionsStable(): void {
    const source = '`ifdef OFF\n// \u4fe1\u53f7 \ud83d\ude00\n`endif\nmodule after_unicode; endmodule\n';
    const result = preprocessForParsing('file:///workspace/unicode.sv', source, { defines: {} });
    const transformedMap = new PositionMap(result.text);
    const originalOffset = source.indexOf('module after_unicode');
    const transformedByte = Buffer.byteLength(result.text.slice(0, originalOffset), 'utf8');

    assert.strictEqual(result.text.length, source.length);
    assertNewlinesPreserved(source, result.text);
    assert.strictEqual(transformedMap.byteToUtf16(transformedByte), originalOffset);
    assert.strictEqual(result.sourceMap.mapOffset(originalOffset, 'start').start, originalOffset);
}

function testInactiveCommentsDoNotHideConditionalDirectives(): void {
    const source = [
        '`ifdef OFF',
        '/* inactive and intentionally unterminated',
        '`endif',
        'module visible_after_comment; endmodule',
    ].join('\n');
    const result = preprocessForParsing('file:///workspace/inactive-comment.sv', source, {
        defines: {},
    });

    assert.ok(result.text.includes('module visible_after_comment; endmodule'));
    assert.ok(!result.diagnostics.some(
        diagnostic => diagnostic.code === 'HDL_PP_UNTERMINATED_CONDITIONAL'
    ));
}

function testCompositeSourceMapBoundariesAndValidation(): void {
    const map = new CompositeSourceMap([
        { generatedStart: 0, generatedEnd: 3, sourceUri: 'file:///a.sv', sourceStart: 5, sourceEnd: 8 },
        { generatedStart: 3, generatedEnd: 5, sourceUri: 'file:///b.svh', sourceStart: 10, sourceEnd: 12 },
        { generatedStart: 5, generatedEnd: 7, sourceUri: 'file:///a.sv', sourceStart: 20, sourceEnd: 22 },
    ]);

    assert.deepStrictEqual(map.mapOffset(3, 'end'), { uri: 'file:///a.sv', start: 8, end: 8 });
    assert.deepStrictEqual(map.mapOffset(3, 'start'), { uri: 'file:///b.svh', start: 10, end: 10 });
    assert.deepStrictEqual(map.mapSpan(1, 6), {
        uri: 'file:///a.sv',
        start: 6,
        end: 8,
        compositeParts: [
            { uri: 'file:///a.sv', start: 6, end: 8 },
            { uri: 'file:///b.svh', start: 10, end: 12 },
            { uri: 'file:///a.sv', start: 20, end: 21 },
        ],
    });
    assert.deepStrictEqual(map.mapSpan(3, 3), {
        uri: 'file:///b.svh', start: 10, end: 10,
    });
    assert.throws(() => map.mapOffset(-1, 'start'), RangeError);
    assert.throws(() => map.mapOffset(8, 'end'), RangeError);
    assert.throws(() => map.mapSpan(4, 3), RangeError);
    assert.throws(() => new CompositeSourceMap([
        { generatedStart: 1, generatedEnd: 2, sourceUri: 'file:///a.sv', sourceStart: 0, sourceEnd: 1 },
    ]), /start at generated offset 0/);
    assert.throws(() => new CompositeSourceMap([
        { generatedStart: 0, generatedEnd: 1, sourceUri: 'file:///a.sv', sourceStart: 0, sourceEnd: 1 },
        { generatedStart: 2, generatedEnd: 3, sourceUri: 'file:///a.sv', sourceStart: 2, sourceEnd: 3 },
    ]), /gap/);
}

function testCanonicalSourceUrisRespectPlatformCaseSemantics(): void {
    const upper = 'file:///workspace/A.sv';
    const lower = 'file:///workspace/a.sv';
    assert.notStrictEqual(
        canonicalizeSourceUri(upper, 'linux'),
        canonicalizeSourceUri(lower, 'linux')
    );
    assert.strictEqual(
        canonicalizeSourceUri(upper, 'win32'),
        canonicalizeSourceUri(lower, 'win32')
    );
    assert.strictEqual(
        canonicalizeSourceUri('FILE://Example.COM/work/./rtl/../rtl/%7eunit.sv', 'linux'),
        canonicalizeSourceUri('file://example.com/work/rtl/%7Eunit.sv', 'linux')
    );
    assert.strictEqual(
        canonicalizeSourceUri('NOT A URI\\RTL\\A.sv', 'win32'),
        'not a uri/rtl/a.sv'
    );
    assert.strictEqual(
        canonicalizeSourceUri('NOT A URI\\RTL\\A.sv', 'linux'),
        'NOT A URI/RTL/A.sv'
    );
}

function testCanonicalSourceUrisPreserveWslUncPathCaseOnWindows(): void {
    for (const host of ['WSL.LOCALHOST', 'WSL$']) {
        assert.strictEqual(
            canonicalizeSourceUri(
                `FILE://${host}/Ubuntu/home/Alex/VeriFlow/rtl/Top.sv`,
                'win32'
            ),
            `file://${host.toLowerCase()}/Ubuntu/home/Alex/VeriFlow/rtl/Top.sv`
        );
    }
    assert.strictEqual(
        canonicalizeSourceUri('file://SERVER/Share/RTL/Top.sv', 'win32'),
        'file://server/share/rtl/top.sv'
    );
}

function testSourceUriContainmentRespectsPlatformCaseSemantics(): void {
    const fileRoot = 'file:///D:/Software/VeriFlow';
    const mixedCaseFile = 'file:///d:/software/veriflow/rtl/alu.sv';
    assert.strictEqual(isSourceUriWithinRoot(mixedCaseFile, fileRoot, 'win32'), true);
    assert.strictEqual(isSourceUriWithinRoot(mixedCaseFile, fileRoot, 'linux'), false);
    assert.strictEqual(isSourceUriWithinRoot(mixedCaseFile, fileRoot, 'darwin'), false);
    assert.strictEqual(
        isSourceUriWithinRoot('file:///D:/Software/VeriFlow-other/alu.sv', fileRoot, 'win32'),
        false
    );

    const remoteRoot = 'vscode-remote://ssh-host/Workspace/Project';
    const sameCaseRemote = 'vscode-remote://ssh-host/Workspace/Project/rtl/alu.sv';
    const mixedCaseRemote = 'vscode-remote://ssh-host/workspace/project/rtl/alu.sv';
    for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
        assert.strictEqual(isSourceUriWithinRoot(sameCaseRemote, remoteRoot, platform), true);
        assert.strictEqual(isSourceUriWithinRoot(mixedCaseRemote, remoteRoot, platform), false);
    }
}

function testPreprocessorDiagnosticsAndRecursionGuards(): void {
    const topUri = 'file:///workspace/top.sv';
    const childUri = 'file:///workspace/child.svh';
    const source = [
        '`include "missing.svh"',
        '`include "child.svh"',
        '`else',
        '`ifdef NEVER',
        '`else',
        '`else',
        '`elsif NEVER',
        '`endif',
        '`endif',
    ].join('\n');
    const result = preprocessForParsing(topUri, source, {
        defines: {},
        resolvedIncludes: [{
            fromUri: topUri,
            rawPath: 'child.svh',
            resolvedUri: childUri,
            text: '`include "top.sv"\n',
        }, {
            fromUri: childUri,
            rawPath: 'top.sv',
            resolvedUri: topUri,
            text: source,
        }],
    });
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes('HDL_INCLUDE_UNRESOLVED'));
    assert.ok(codes.includes('HDL_INCLUDE_CYCLE'));
    assert.ok(codes.includes('HDL_PP_UNMATCHED_ELSE'));
    assert.ok(codes.includes('HDL_PP_DUPLICATE_ELSE'));
    assert.ok(codes.includes('HDL_PP_ELSIF_AFTER_ELSE'));
    assert.ok(codes.includes('HDL_PP_UNMATCHED_ENDIF'));
    assert.ok(result.diagnostics.every(diagnostic => diagnostic.span?.uri));

    const depthResult = preprocessForParsing(topUri, '`include "child.svh"', {
        defines: {},
        maxIncludeDepth: 0,
        resolvedIncludes: [{
            fromUri: topUri,
            rawPath: 'child.svh',
            resolvedUri: childUri,
            text: 'module hidden_by_depth; endmodule',
        }],
    });
    assert.ok(depthResult.diagnostics.some(diagnostic => diagnostic.code === 'HDL_INCLUDE_DEPTH'));
    assert.ok(!depthResult.text.includes('hidden_by_depth'));
}

function testUnterminatedConditionalAndUnexpandedMacroWarnings(): void {
    const uri = 'file:///workspace/macro.sv';
    const source = [
        '`timescale 1ns/1ps',
        '`define DECLARE(name) module name; endmodule',
        '`DECLARE(generated)',
        '`ifdef OPEN',
    ].join('\n');
    const result = preprocessForParsing(uri, source, { defines: {} });
    const macroWarnings = result.diagnostics.filter(
        diagnostic => diagnostic.code === 'HDL_MACRO_UNEXPANDED'
    );

    assert.strictEqual(macroWarnings.length, 0);
    assert.ok(result.diagnostics.some(
        diagnostic => diagnostic.code === 'HDL_PP_UNTERMINATED_CONDITIONAL'
    ));
    assert.ok(!result.text.includes('timescale'));
    assert.ok(result.text.includes('`DECLARE(generated)'));
    assert.deepStrictEqual(Object.keys(result).sort(), [
        'activeDefines',
        'diagnostics',
        'sourceMap',
        'sourceTexts',
        'text',
    ]);
}

async function testDirectiveContinuationsAreConsumedAsOneLogicalDirective(): Promise<void> {
    const uri = 'file:///workspace/multiline-define.sv';
    const firstLine = '`define DECLARE(name) \\';
    const macroBody = 'module fake; endmodule';
    const source = [
        firstLine,
        macroBody,
        'module real_module; endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(uri, source);

    assert.deepStrictEqual(document.modules.map(module => module.name), ['real_module']);
    assert.ok(!document.diagnostics.some(diagnostic =>
        diagnostic.code === 'systemverilog.syntax-error'
    ));
    assert.strictEqual(document.directives.length, 1);
    assert.strictEqual(document.directives[0].kind, 'text_macro_definition');
    assert.strictEqual(document.directives[0].text, `${firstLine}\n${macroBody}\n`);
    assert.strictEqual(document.directives[0].span.uri, uri);
    assert.strictEqual(
        source.slice(document.directives[0].span.start, document.directives[0].span.end),
        `${firstLine}\n${macroBody}\n`
    );

    const objectSource = [
        '`define WIDTH \\',
        '8',
        '`ifdef WIDTH',
        'module width_defined; endmodule',
        '`endif',
    ].join('\n');
    const preprocessed = preprocessForParsing(uri, objectSource, { defines: {} });
    assert.strictEqual(preprocessed.activeDefines.WIDTH, '8');
    assert.ok(preprocessed.text.includes('module width_defined; endmodule'));
    assert.strictEqual(preprocessed.text.length, objectSource.length);
    assertNewlinesPreserved(objectSource, preprocessed.text);
}

function testDirectiveTextAdvancesBlockCommentState(): void {
    const uri = 'file:///workspace/directive-comment.sv';
    const source = [
        '`timescale 1ns/1ps /*',
        '`ifdef HIDDEN_IN_COMMENT',
        '*/',
        'module visible_after_comment; endmodule',
    ].join('\n');
    const result = preprocessForParsing(uri, source, { defines: {} });
    const metadata = getPreprocessMetadataForWorker(result);

    assert.deepStrictEqual(metadata.directives.map(directive => directive.kind), [
        'timescale_compiler_directive',
    ]);
    assert.ok(result.text.includes('module visible_after_comment; endmodule'));
    assert.ok(!result.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_PP_UNTERMINATED_CONDITIONAL'
    ));
}

function testContinuedStringsHideDirectivesAndLineStatesReset(): void {
    const uri = 'file:///workspace/continued-string.sv';
    const continuedSource = [
        'module string_context;',
        'string value = "escaped quote: \\" and slash: \\\\ then continue \\',
        '`ifdef HIDDEN_IN_STRING',
        'suffix";',
        'module visible_after_string; endmodule',
        'endmodule',
    ].join('\n');
    const continued = preprocessForParsing(uri, continuedSource, { defines: {} });

    assert.strictEqual(continued.text, continuedSource);
    assert.ok(!continued.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_PP_UNTERMINATED_CONDITIONAL'
    ));
    assert.deepStrictEqual(getPreprocessMetadataForWorker(continued).directives, []);

    const resetSource = [
        'string invalid = "not continued',
        '`define AFTER_STRING 1',
        '// comment does not continue',
        '`define AFTER_LINE_COMMENT 1',
    ].join('\n');
    const reset = preprocessForParsing(uri, resetSource, { defines: {} });
    assert.strictEqual(reset.activeDefines.AFTER_STRING, '1');
    assert.strictEqual(reset.activeDefines.AFTER_LINE_COMMENT, '1');
}

function sourceForUri(
    uri: string,
    sources: Readonly<Record<string, string>>
): string {
    const source = sources[uri];
    assert.notStrictEqual(source, undefined, `missing source text for ${uri}`);
    return source;
}

async function testWorkerPreservesDirectiveAndIncludeMetadata(): Promise<void> {
    const topUri = 'file:///workspace/metadata.sv';
    const nestedUri = 'file:///workspace/nested.svh';
    const leafUri = 'file:///workspace/leaf.svh';
    const inactiveUri = 'file:///workspace/inactive.svh';
    const top = [
        '`timescale 1ns/1ps',
        '`define ENABLE 1',
        '`ifdef ENABLE',
        '`include "nested.svh"',
        '`else',
        '`include "inactive.svh"',
        '`endif',
        'module metadata; endmodule',
    ].join('\n');
    const nested = [
        '`define CHILD 1',
        '`include "leaf.svh"',
    ].join('\n');
    const leaf = '// leaf\n';
    const inactive = '`define SHOULD_NOT_EXIST 1\n';
    const sources = { [topUri]: top, [nestedUri]: nested, [leafUri]: leaf, [inactiveUri]: inactive };
    const document = await parseWithRealWorker(topUri, top, {
        defines: {},
        resolvedIncludes: [
            { fromUri: topUri, rawPath: 'nested.svh', resolvedUri: nestedUri, text: nested },
            { fromUri: nestedUri, rawPath: 'leaf.svh', resolvedUri: leafUri, text: leaf },
            { fromUri: topUri, rawPath: 'inactive.svh', resolvedUri: inactiveUri, text: inactive },
        ],
    });

    assert.deepStrictEqual(
        document.directives.map(directive => [directive.kind, directive.active]),
        [
            ['timescale_compiler_directive', true],
            ['text_macro_definition', true],
            ['conditional_compilation_directive', true],
            ['include_compiler_directive', true],
            ['text_macro_definition', true],
            ['include_compiler_directive', true],
            ['conditional_compilation_directive', true],
            ['include_compiler_directive', false],
            ['conditional_compilation_directive', true],
        ]
    );
    for (const directive of document.directives) {
        assert.ok(directive.span.uri);
        assert.strictEqual(
            sourceForUri(directive.span.uri, sources).slice(
                directive.span.start,
                directive.span.end
            ),
            directive.text
        );
    }
    assert.strictEqual(document.directives[0].text, '`timescale 1ns/1ps\n');
    assert.strictEqual(document.directives[1].text, '`define ENABLE 1\n');
    assert.strictEqual(document.directives[4].span.uri, nestedUri);
    assert.deepStrictEqual(document.includes.map(include => ({
        path: include.path,
        uri: include.span.uri,
        resolvedUri: include.resolvedUri,
        text: sourceForUri(include.span.uri!, sources).slice(include.span.start, include.span.end),
    })), [
        {
            path: 'nested.svh', uri: topUri, resolvedUri: nestedUri,
            text: '`include "nested.svh"',
        },
        {
            path: 'leaf.svh', uri: nestedUri, resolvedUri: leafUri,
            text: '`include "leaf.svh"',
        },
    ]);
    assert.ok(!document.diagnostics.some(diagnostic =>
        diagnostic.code === 'HDL_INCLUDE_UNRESOLVED'
        && diagnostic.span?.start === top.indexOf('`include "inactive.svh"')
    ));
}

async function testWorkerWarnsForStandaloneStructuralMacros(): Promise<void> {
    const topLevelUri = 'file:///workspace/top-level-macro.sv';
    const topLevelSource = '`DECLARE(generated)\n';
    const topLevel = await parseWithRealWorker(topLevelUri, topLevelSource);
    const topLevelWarnings = topLevel.diagnostics.filter(
        diagnostic => diagnostic.code === 'HDL_MACRO_UNEXPANDED'
    );
    assert.strictEqual(topLevelWarnings.length, 1);
    assert.strictEqual(topLevelWarnings[0].span?.uri, topLevelUri);
    assert.strictEqual(
        topLevelSource.slice(topLevelWarnings[0].span!.start, topLevelWarnings[0].span!.end),
        '`DECLARE(generated)'
    );

    const moduleItemUri = 'file:///workspace/module-item-macro.sv';
    const moduleItemSource = [
        'module macro_host;',
        '`INSTANCE(u_child)',
        'endmodule',
    ].join('\n');
    const moduleItem = await parseWithRealWorker(moduleItemUri, moduleItemSource);
    const moduleItemWarnings = moduleItem.diagnostics.filter(
        diagnostic => diagnostic.code === 'HDL_MACRO_UNEXPANDED'
    );
    assert.strictEqual(moduleItemWarnings.length, 1);
    assert.strictEqual(moduleItemWarnings[0].span?.uri, moduleItemUri);
    assert.strictEqual(
        moduleItemSource.slice(
            moduleItemWarnings[0].span!.start,
            moduleItemWarnings[0].span!.end
        ),
        '`INSTANCE(u_child)'
    );
}

async function testRepeatedIncludeMacroWarningsAreDeduplicatedByOwnerSpan(): Promise<void> {
    const topUri = 'file:///workspace/repeated-include.sv';
    const includeUri = 'file:///workspace/standalone-macro.svh';
    const include = '`DECLARE(generated)\n';
    const source = [
        '`include "standalone-macro.svh"',
        '`include "standalone-macro.svh"',
    ].join('\n');
    const document = await parseWithRealWorker(topUri, source, {
        defines: {},
        resolvedIncludes: [{
            fromUri: topUri,
            rawPath: 'standalone-macro.svh',
            resolvedUri: includeUri,
            text: include,
        }],
    });
    const warnings = document.diagnostics.filter(
        diagnostic => diagnostic.code === 'HDL_MACRO_UNEXPANDED'
    );

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].span?.uri, includeUri);
    assert.strictEqual(
        include.slice(warnings[0].span!.start, warnings[0].span!.end),
        '`DECLARE(generated)'
    );
}

async function testRepeatedIncludeUsesGeneratedMacroContext(): Promise<void> {
    const includeUri = 'file:///workspace/mixed-context-macro.svh';
    const include = '`DECLARE(generated)\n';
    const includeLine = '`include "mixed-context-macro.svh"';
    const cases = [
        {
            uri: 'file:///workspace/structural-first.sv',
            lines: [
                includeLine,
                'module structural_first;',
                'always_comb begin',
                includeLine,
                'end',
                'endmodule',
            ],
        },
        {
            uri: 'file:///workspace/opaque-first.sv',
            lines: [
                'module opaque_first;',
                'always_comb begin',
                includeLine,
                'end',
                includeLine,
                'endmodule',
            ],
        },
    ];
    for (const fixture of cases) {
        const source = fixture.lines.join('\n');
        const document = await parseWithRealWorker(fixture.uri, source, {
            defines: {},
            resolvedIncludes: [{
                fromUri: fixture.uri,
                rawPath: 'mixed-context-macro.svh',
                resolvedUri: includeUri,
                text: include,
            }],
        });
        const warnings = document.diagnostics.filter(
            diagnostic => diagnostic.code === 'HDL_MACRO_UNEXPANDED'
        );
        assert.strictEqual(warnings.length, 1, fixture.uri);
        assert.strictEqual(warnings[0].span?.uri, includeUri);
        assert.strictEqual(
            include.slice(warnings[0].span!.start, warnings[0].span!.end),
            '`DECLARE(generated)'
        );
    }

    const opaqueUri = 'file:///workspace/opaque-only.sv';
    const opaqueSource = [
        'module opaque_only;',
        'always_comb begin',
        includeLine,
        'end',
        'initial begin',
        includeLine,
        'end',
        'endmodule',
    ].join('\n');
    const opaqueDocument = await parseWithRealWorker(opaqueUri, opaqueSource, {
        defines: {},
        resolvedIncludes: [{
            fromUri: opaqueUri,
            rawPath: 'mixed-context-macro.svh',
            resolvedUri: includeUri,
            text: include,
        }],
    });
    assert.strictEqual(opaqueDocument.diagnostics.filter(
        diagnostic => diagnostic.code === 'HDL_MACRO_UNEXPANDED'
    ).length, 0);
}

async function testWorkerWarnsOnlyForStructuralMacros(): Promise<void> {
    const topUri = 'file:///workspace/macro-context.sv';
    const instanceUri = 'file:///workspace/macro-instance.svh';
    const instance = 'child u_child(.a(`CONNECT(a)));';
    const source = [
        'module macro_context(input logic a, output logic y);',
        '`include "macro-instance.svh"',
        'assign y = `PASS(a);',
        'always_comb begin',
        '    y = `PROC(a);',
        'end',
        'endmodule',
    ].join('\n');
    const document = await parseWithRealWorker(topUri, source, {
        defines: {},
        resolvedIncludes: [{
            fromUri: topUri,
            rawPath: 'macro-instance.svh',
            resolvedUri: instanceUri,
            text: instance,
        }],
    });
    const warnings = document.diagnostics.filter(
        diagnostic => diagnostic.code === 'HDL_MACRO_UNEXPANDED'
    );

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].span?.uri, instanceUri);
    assert.strictEqual(
        instance.slice(warnings[0].span!.start, warnings[0].span!.end),
        '`CONNECT(a)'
    );
    assert.strictEqual(document.modules[0].continuousAssignments.length, 1);
    assert.strictEqual(document.modules[0].opaqueRegions.length, 1);
}

async function testWorkerParsesTextualPortAndBodyIncludes(): Promise<void> {
    const parentUri = 'file:///workspace/parent.sv';
    const portsUri = 'file:///workspace/ports.svh';
    const bodyUri = 'file:///workspace/body.svh';
    const ports = 'clk, output logic done';
    const body = 'child u_child(.clk(clk), .done(done));';
    const source = [
        'module parent (input logic base_port,',
        '`include "ports.svh"',
        ');',
        '`include "body.svh"',
        'endmodule',
        '',
    ].join('\n');
    const document = await parseWithRealWorker(parentUri, source, {
        defines: {},
        resolvedIncludes: [
            { fromUri: parentUri, rawPath: 'ports.svh', resolvedUri: portsUri, text: ports },
            { fromUri: parentUri, rawPath: 'body.svh', resolvedUri: bodyUri, text: body },
        ],
    });

    assert.deepStrictEqual(document.modules.map(module => module.name), ['parent']);
    const module = document.modules[0];
    assert.deepStrictEqual(module.ports.map(port => port.name), ['base_port', 'clk', 'done']);
    assert.strictEqual(module.ports[0].nameSpan.uri, parentUri);
    for (const port of module.ports.slice(1)) {
        assert.strictEqual(port.nameSpan.uri, portsUri);
        assert.strictEqual(ports.slice(port.nameSpan.start, port.nameSpan.end), port.name);
        assert.strictEqual(port.nameSpan.compositeParts, undefined);
    }
    assert.strictEqual(module.instances.length, 1);
    const instance = module.instances[0];
    assert.strictEqual(instance.moduleName, 'child');
    assert.strictEqual(instance.instanceName, 'u_child');
    for (const span of [
        instance.declarationSpan,
        instance.itemSpan,
        instance.moduleNameSpan,
        instance.nameSpan,
        ...instance.portConnections.flatMap(connection => [
            connection.connectionSpan,
            connection.nameSpan!,
            connection.expressionSpan,
        ]),
    ]) {
        assert.strictEqual(span.uri, bodyUri);
        assert.strictEqual(span.compositeParts, undefined);
        assert.ok(body.slice(span.start, span.end).length > 0);
    }
    assert.strictEqual(body.slice(instance.nameSpan.start, instance.nameSpan.end), 'u_child');
    assert.ok(module.declarationSpan.compositeParts);
    assert.ok(module.headerSpan.compositeParts);
    assert.deepStrictEqual(
        module.portDeclarationGroups[0].declarationSpan.compositeParts!.map(part => part.uri),
        [parentUri, portsUri]
    );
    assert.deepStrictEqual(
        module.declarationSpan.compositeParts!.map(part => part.uri),
        [parentUri, portsUri, parentUri, bodyUri, parentUri]
    );
}

async function testWorkerKeepsIncludedUnitsAndActiveBranches(): Promise<void> {
    const includeOnlyUri = 'file:///workspace/include-only.sv';
    const unitUri = 'file:///workspace/unit.svh';
    const unit = 'module included_unit(input logic clk); endmodule';
    const includeOnly = await parseWithRealWorker(
        includeOnlyUri,
        '`include "unit.svh"\n',
        { defines: {}, resolvedIncludes: [{
            fromUri: includeOnlyUri,
            rawPath: 'unit.svh',
            resolvedUri: unitUri,
            text: unit,
        }] }
    );
    assert.deepStrictEqual(includeOnly.modules.map(module => module.name), ['included_unit']);
    assert.strictEqual(includeOnly.modules[0].nameSpan.uri, unitUri);
    assert.strictEqual(
        unit.slice(includeOnly.modules[0].nameSpan.start, includeOnly.modules[0].nameSpan.end),
        'included_unit'
    );

    const branchUri = 'file:///workspace/branches.sv';
    const definesUri = 'file:///workspace/defines.svh';
    const branchSource = [
        '`include "defines.svh"',
        '`ifdef FROM_INCLUDE',
        'module include_effect; endmodule',
        '`endif',
        '`ifdef SELECTED',
        'module selected; endmodule',
        '`else',
        'module rejected; endmodule',
        '`endif',
    ].join('\n');
    const branches = await parseWithRealWorker(branchUri, branchSource, {
        defines: { SELECTED: true },
        resolvedIncludes: [{
            fromUri: branchUri,
            rawPath: 'defines.svh',
            resolvedUri: definesUri,
            text: '`define FROM_INCLUDE 1\n',
        }],
    });
    assert.deepStrictEqual(
        branches.modules.map(module => module.name),
        ['include_effect', 'selected']
    );
}

async function testWorkerDiagnosticsAndFingerprint(): Promise<void> {
    const uri = 'file:///workspace/fingerprint.sv';
    const firstUri = 'file:///workspace/first.svh';
    const secondUri = 'file:///workspace/second.svh';
    const source = [
        '`include "first.svh"',
        '`include "second.svh"',
        '`include "missing.svh"',
        'module fingerprint; endmodule',
    ].join('\n');
    const includes = [
        { fromUri: uri, rawPath: 'first.svh', resolvedUri: firstUri, text: '// first\n' },
        { fromUri: uri, rawPath: 'second.svh', resolvedUri: secondUri, text: '// second\n' },
    ];
    const base = await parseWithRealWorker(uri, source, { defines: { B: '2', A: true }, resolvedIncludes: includes });
    const reversed = await parseWithRealWorker(uri, source, {
        defines: { A: true, B: '2' },
        resolvedIncludes: [...includes].reverse(),
    });
    const changedDefine = await parseWithRealWorker(uri, source, {
        defines: { A: true, B: '3' }, resolvedIncludes: includes,
    });
    const changedInclude = await parseWithRealWorker(uri, source, {
        defines: { A: true, B: '2' },
        resolvedIncludes: [includes[0], { ...includes[1], text: '// changed\n' }],
    });

    assert.match(base.preprocessingFingerprint, /^[0-9a-f]{64}$/);
    assert.strictEqual(base.preprocessingFingerprint, reversed.preprocessingFingerprint);
    assert.notStrictEqual(base.preprocessingFingerprint, changedDefine.preprocessingFingerprint);
    assert.notStrictEqual(base.preprocessingFingerprint, changedInclude.preprocessingFingerprint);
    const unresolved = base.diagnostics.find(
        diagnostic => diagnostic.code === 'HDL_INCLUDE_UNRESOLVED'
    );
    assert.ok(unresolved);
    assert.strictEqual(unresolved.span?.uri, uri);
    assert.strictEqual(source.slice(unresolved.span!.start, unresolved.span!.end), '`include "missing.svh"');
    assert.deepStrictEqual(base.includes.map(include => [include.path, include.resolvedUri]), [
        ['first.svh', firstUri],
        ['second.svh', secondUri],
        ['missing.svh', undefined],
    ]);
}

async function main(): Promise<void> {
    testActiveBranchesAndDefineSideEffects();
    testTextualIncludesAndSourceMapping();
    testUnicodeMaskingKeepsUtf16AndBytePositionsStable();
    testInactiveCommentsDoNotHideConditionalDirectives();
    testCompositeSourceMapBoundariesAndValidation();
    testCanonicalSourceUrisRespectPlatformCaseSemantics();
    testCanonicalSourceUrisPreserveWslUncPathCaseOnWindows();
    testSourceUriContainmentRespectsPlatformCaseSemantics();
    testPreprocessorDiagnosticsAndRecursionGuards();
    testUnterminatedConditionalAndUnexpandedMacroWarnings();
    await testDirectiveContinuationsAreConsumedAsOneLogicalDirective();
    testDirectiveTextAdvancesBlockCommentState();
    testContinuedStringsHideDirectivesAndLineStatesReset();
    await testWorkerParsesTextualPortAndBodyIncludes();
    await testWorkerKeepsIncludedUnitsAndActiveBranches();
    await testWorkerWarnsForStandaloneStructuralMacros();
    await testRepeatedIncludeMacroWarningsAreDeduplicatedByOwnerSpan();
    await testRepeatedIncludeUsesGeneratedMacroContext();
    await testWorkerPreservesDirectiveAndIncludeMetadata();
    await testWorkerWarnsOnlyForStructuralMacros();
    await testWorkerDiagnosticsAndFingerprint();
    console.log('HDL preprocessor tests passed');
}

void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
