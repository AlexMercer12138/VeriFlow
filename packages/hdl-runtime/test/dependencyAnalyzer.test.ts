import assert from 'node:assert/strict';
import test from 'node:test';

import { DependencyAnalyzer } from '@veriflow/hdl-runtime/dependencyAnalyzer';
import type { WorkspaceHdlIndex } from '@veriflow/hdl-runtime/workspaceHdlIndex';
import type {
    HdlDefinitionSummary,
    HdlFileSummary,
} from '@veriflow/hdl-runtime/workspaceIndexTypes';

function definition(
    name: string,
    uri: string,
    dependencies: string[] = [],
    declarationStart = 0
): HdlDefinitionSummary {
    return {
        key: `module:${uri}:${declarationStart}`,
        kind: 'module',
        name,
        uri,
        declarationStart,
        declarationLine: 1,
        parameters: [],
        ports: [],
        dependencies,
        modelFingerprint: `fingerprint:${name}:${declarationStart}`,
    };
}

function indexOf(
    definitions: HdlDefinitionSummary[],
    includes: Record<string, string[]> = {}
): WorkspaceHdlIndex {
    const byKey = new Map(definitions.map(item => [item.key, item]));
    const files = new Map<string, HdlFileSummary>();
    for (const item of definitions) {
        const existing = files.get(item.uri);
        if (existing) {
            existing.definitions.push(item);
            continue;
        }
        files.set(item.uri, {
            uri: item.uri,
            mtimeMs: 1,
            size: 1,
            contentHash: `hash:${item.uri}`,
            includeUris: includes[item.uri] ?? [],
            definitions: [item],
            diagnostics: [],
        });
    }
    for (const uri of Object.values(includes).flat()) {
        if (!files.has(uri)) {
            files.set(uri, {
                uri,
                mtimeMs: 1,
                size: 1,
                contentHash: `hash:${uri}`,
                includeUris: [],
                definitions: [],
                diagnostics: [],
            });
        }
    }
    return {
        getDefinition: (key: string) => byKey.get(key),
        findDefinitions: (name: string, kind?: string) => definitions.filter(item =>
            item.name === name && (kind === undefined || item.kind === kind)
        ),
        getFile: (uri: string) => files.get(uri),
    } as unknown as WorkspaceHdlIndex;
}

test('dependency analyzer emits include-aware topological compile order', () => {
    const top = definition('top', 'file:///workspace/top.sv', ['child']);
    const child = definition('child', 'file:///workspace/child.sv', ['leaf']);
    const leaf = definition('leaf', 'file:///workspace/leaf.sv');
    const index = indexOf([top, child, leaf], {
        [child.uri]: ['file:///workspace/child_defs.svh'],
    });

    const result = new DependencyAnalyzer(index).resolve(top.key);

    assert.deepEqual(result.files, [
        '/workspace/leaf.sv',
        '/workspace/child_defs.svh',
        '/workspace/child.sv',
        '/workspace/top.sv',
    ]);
    assert.deepEqual(result.depGraph, {
        top: ['child'],
        child: ['leaf'],
        leaf: [],
    });
    assert.deepEqual(result.missingModules, []);
    assert.deepEqual(result.ambiguousModules, {});
});

test('dependency analyzer reports missing and ambiguous definitions deterministically', () => {
    const top = definition('top', 'memory:///top.sv', ['missing', 'child']);
    const childA = definition('child', 'memory:///a/child.sv');
    const childB = definition('child', 'memory:///b/child.sv');
    const analyzer = new DependencyAnalyzer(indexOf([top, childB, childA]));

    const unresolved = analyzer.resolve(top.key);

    assert.deepEqual(unresolved.files, ['memory:///top.sv']);
    assert.deepEqual(unresolved.missingModules, ['missing']);
    assert.deepEqual(unresolved.ambiguousModules, {
        child: [childA.key, childB.key].sort(),
    });

    const resolved = analyzer.resolve(top.key, { child: childB.key });
    assert.deepEqual(resolved.ambiguousModules, {});
    assert.equal(resolved.moduleMap.child, childB.uri);
});
