import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createArchDesignDefinitionCatalog,
    migrateArchDesignDefinitionKey,
    selectArchDesignDefinitionKey,
} from '../src/archDesignDefinitionReference';
import { canonicalizeSourceUri } from '@veriflow/hdl-core/preprocessor';
import type { HdlDefinitionSummary } from '../src/workspaceIndexTypes';

function definition(
    filepath: string,
    name: string,
    declarationStart: number
): HdlDefinitionSummary {
    const uri = windowsFileUri(filepath);
    return {
        key: `module:${uri}:${declarationStart}`,
        kind: 'module',
        name,
        uri,
        declarationStart,
        declarationLine: 1,
        parameters: [],
        ports: [],
        dependencies: [],
        modelFingerprint: `${name}-${declarationStart}`,
    };
}

function windowsFileUri(filepath: string): string {
    assert.match(filepath, /^[A-Za-z]:\//);
    return new URL(`file:///${filepath}`).toString();
}

test('uses workspace-relative keys for modules inside the workspace', () => {
    const source = definition('D:/workspace/rtl/sys_pll.v', 'sys_pll', 3082);
    const catalog = createArchDesignDefinitionCatalog(
        [source],
        windowsFileUri('D:/workspace/')
    );

    assert.equal(
        catalog.definitions[0].key,
        'module:workspace:/rtl/sys_pll.v#sys_pll'
    );
    assert.equal(catalog.runtimeKey(catalog.definitions[0].key), source.key);
});

test('keeps absolute URIs for modules outside the workspace', () => {
    const source = definition('D:/fpga-libs/vendor/pll.v', 'pll', 10);
    const catalog = createArchDesignDefinitionCatalog(
        [source],
        windowsFileUri('D:/workspace/')
    );

    assert.equal(
        catalog.definitions[0].key,
        `module:${canonicalizeSourceUri(source.uri)}#pll`
    );
});

test('adds declaration-order indexes only for same-file same-name modules', () => {
    const first = definition('D:/workspace/rtl/duplicates.v', 'cell', 40);
    const second = definition('D:/workspace/rtl/duplicates.v', 'cell', 120);
    const other = definition('D:/workspace/rtl/duplicates.v', 'helper', 80);
    const catalog = createArchDesignDefinitionCatalog(
        [second, other, first],
        windowsFileUri('D:/workspace/')
    );

    assert.deepEqual(
        catalog.definitions.map(item => [item.name, item.key]),
        [
            ['cell', 'module:workspace:/rtl/duplicates.v#cell@1'],
            ['helper', 'module:workspace:/rtl/duplicates.v#helper'],
            ['cell', 'module:workspace:/rtl/duplicates.v#cell@0'],
        ]
    );
    assert.equal(
        catalog.runtimeKey('module:workspace:/rtl/duplicates.v#cell'),
        first.key
    );
});

test('migrates a legacy absolute offset key to its portable key', () => {
    const source = definition('D:/workspace/rtl/sys_pll.v', 'sys_pll', 3082);
    const catalog = createArchDesignDefinitionCatalog(
        [source],
        windowsFileUri('D:/workspace/')
    );

    assert.equal(
        migrateArchDesignDefinitionKey(source.key, 'sys_pll', catalog),
        'module:workspace:/rtl/sys_pll.v#sys_pll'
    );
});

test('migrates a VS Code encoded Windows legacy key among duplicate module names', () => {
    const selected = definition('D:/workspace/ip/sys_pll/sys_pll.v', 'sys_pll', 3082);
    const stub = definition('D:/workspace/ip/sys_pll/sys_pll_stub.v', 'sys_pll', 995);
    const catalog = createArchDesignDefinitionCatalog(
        [stub, selected],
        windowsFileUri('D:/workspace/')
    );

    assert.equal(
        migrateArchDesignDefinitionKey(
            'module:file:///d%3A/workspace/ip/sys_pll/sys_pll.v:3082',
            'sys_pll',
            catalog
        ),
        'module:workspace:/ip/sys_pll/sys_pll.v#sys_pll'
    );
});

test('migrates a stale legacy offset by unique module name within its source file', () => {
    const selected = definition('D:/workspace/ip/sys_pll/sys_pll.v', 'sys_pll', 4096);
    const stub = definition('D:/workspace/ip/sys_pll/sys_pll_stub.v', 'sys_pll', 995);
    const catalog = createArchDesignDefinitionCatalog(
        [stub, selected],
        windowsFileUri('D:/workspace/')
    );

    assert.equal(
        migrateArchDesignDefinitionKey(
            'module:file:///d%3A/workspace/ip/sys_pll/sys_pll.v:3082',
            'sys_pll',
            catalog
        ),
        'module:workspace:/ip/sys_pll/sys_pll.v#sys_pll'
    );
});

test('selects index zero for an omitted same-file duplicate key', () => {
    const first = definition('D:/workspace/rtl/duplicates.v', 'cell', 40);
    const second = definition('D:/workspace/rtl/duplicates.v', 'cell', 120);
    const catalog = createArchDesignDefinitionCatalog(
        [second, first],
        windowsFileUri('D:/workspace/')
    );

    assert.equal(
        selectArchDesignDefinitionKey(undefined, 'cell', catalog),
        'module:workspace:/rtl/duplicates.v#cell@0'
    );
});

test('upgrades a formerly unique key to index zero after a duplicate is added', () => {
    const first = definition('D:/workspace/rtl/duplicates.v', 'cell', 40);
    const second = definition('D:/workspace/rtl/duplicates.v', 'cell', 120);
    const catalog = createArchDesignDefinitionCatalog(
        [first, second],
        windowsFileUri('D:/workspace/')
    );

    assert.equal(
        selectArchDesignDefinitionKey(
            'module:workspace:/rtl/duplicates.v#cell',
            'cell',
            catalog
        ),
        'module:workspace:/rtl/duplicates.v#cell@0'
    );
});
