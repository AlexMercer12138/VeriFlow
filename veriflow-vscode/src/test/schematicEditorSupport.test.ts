import * as assert from 'assert';

import {
    isCurrentSchematicRefresh,
    SchematicBuildGeneration,
} from '../schematic/schematicEditorSupport';

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
console.log('schematic editor support tests passed');
