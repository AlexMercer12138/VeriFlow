import * as assert from 'assert';

import {
    isCurrentSchematicRefresh,
    selectableSchematicModules,
    selectSchematicModuleKey,
    SchematicBuildGeneration,
} from '../schematic/schematicEditorSupport';

function testWin32CanonicalIdentitySelectsExactPendingModule(): void {
    const documentUri = 'file:///D:/Software/VeriFlow/design.sv';
    const indexedUri = 'file:///d:/software/veriflow/design.sv';
    const modules = selectableSchematicModules(
        documentUri,
        documentUri,
        [
            {
                name: 'first',
                nameSpan: { uri: documentUri },
                declarationSpan: { start: 0 },
            },
            {
                name: 'target',
                nameSpan: { uri: indexedUri },
                declarationSpan: { start: 40 },
            },
            {
                name: 'foreign',
                nameSpan: { uri: 'file:///D:/Software/Other/foreign.sv' },
                declarationSpan: { start: 0 },
            },
        ],
        'win32'
    );
    const pendingKey = `module:${indexedUri}:40`;

    assert.deepStrictEqual(
        modules.map(module => ({ key: module.key, name: module.name })),
        [
            { key: `module:${indexedUri}:0`, name: 'first' },
            { key: pendingKey, name: 'target' },
        ]
    );
    assert.strictEqual(
        selectSchematicModuleKey(modules, pendingKey, undefined),
        pendingKey,
        'the exact indexed pending key must not fall back to the first module'
    );
}

function testRefreshMustRemainCurrentAcrossAwaitedBuild(): void {
    assert.strictEqual(isCurrentSchematicRefresh(2, 2, false, false), true);
    assert.strictEqual(isCurrentSchematicRefresh(1, 2, false, false), false);
    assert.strictEqual(isCurrentSchematicRefresh(2, 2, true, false), false);
    assert.strictEqual(isCurrentSchematicRefresh(2, 2, false, true), false);
}

function testNewDocumentInvalidatesOlderSameModuleBuild(): void {
    const builds = new SchematicBuildGeneration<object>();
    const firstDocument = {};
    const secondDocument = {};
    const moduleKey = 'module:file:///workspace/design.sv:0';
    const first = builds.begin(firstDocument, moduleKey);
    const second = builds.begin(secondDocument, moduleKey);

    assert.strictEqual(
        builds.isCurrent(first, secondDocument, moduleKey),
        false,
        'an older build must not combine a newer document with its captured module model'
    );
    assert.strictEqual(builds.isCurrent(second, secondDocument, moduleKey), true);
}

function testSelectionAndExplicitInvalidationRejectPendingBuilds(): void {
    const builds = new SchematicBuildGeneration<object>();
    const document = {};
    const build = builds.begin(document, 'module:file:///workspace/design.sv:0');

    assert.strictEqual(
        builds.isCurrent(build, document, 'module:file:///workspace/design.sv:40'),
        false
    );
    builds.invalidate();
    assert.strictEqual(
        builds.isCurrent(build, document, 'module:file:///workspace/design.sv:0'),
        false
    );
}

testNewDocumentInvalidatesOlderSameModuleBuild();
testSelectionAndExplicitInvalidationRejectPendingBuilds();
testRefreshMustRemainCurrentAcrossAwaitedBuild();
testWin32CanonicalIdentitySelectsExactPendingModule();
console.log('schematic editor support tests passed');
