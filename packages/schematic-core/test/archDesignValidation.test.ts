import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createEmptyArchDesign,
    parseArchDesignValue,
    validateArchDesign,
    type ArchDesign,
    type ArchDesignModuleDefinition,
} from '../src/archDesign';

function designOf(overrides: Partial<ArchDesign>): ArchDesign {
    const result = parseArchDesignValue({
        ...createEmptyArchDesign('soc_top'),
        ...overrides,
    });
    if (result.status !== 'editable') throw new Error('expected editable design');
    return result.design;
}

const coreDefinition: ArchDesignModuleDefinition = {
    key: 'rtl/core.sv#core',
    name: 'core',
    parameters: [
        { name: 'WIDTH', defaultExpression: '8' },
        { name: 'ENABLED' },
    ],
    ports: [
        { name: 'clk', direction: 'input', width: { kind: 'known', bits: 1 } },
        { name: 'result', direction: 'output', width: { kind: 'symbolic', expression: 'WIDTH' } },
    ],
};

const definitions: readonly ArchDesignModuleDefinition[] = [coreDefinition];

function pathCodes(result: ReturnType<typeof validateArchDesign>): [string, string][] {
    return result.diagnostics.map(item => [item.path, item.code]);
}

test('accepts an instance whose module resolves uniquely', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core' }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, true);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.effectiveDefaults, []);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.diagnostics));
    assert.ok(Object.isFrozen(result.effectiveDefaults));
});

test('reports an unresolved instance module', () => {
    const design = designOf({
        instances: [{ name: 'u_missing', module: 'missing' }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, false);
    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].module', 'AD_MODULE_UNRESOLVED'],
    ]);
    assert.ok(Object.isFrozen(result.diagnostics[0]));
});

test('reports an ambiguous instance module without selecting a definition', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core', parameters: { UNKNOWN: 1 } }],
    });
    const duplicate = { ...coreDefinition, key: 'generated/core.sv#core' };

    const result = validateArchDesign(design, [coreDefinition, duplicate]);

    assert.equal(result.valid, false);
    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].module', 'AD_MODULE_AMBIGUOUS'],
    ]);
});

test('reports an override absent from the resolved module parameter declarations', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core', parameters: { DEPTH: 16 } }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, false);
    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].parameters.DEPTH', 'AD_PARAMETER_UNKNOWN'],
    ]);
});

test('accepts an override on a declared module parameter', () => {
    const design = designOf({
        instances: [{ name: 'u_core', module: 'core', parameters: { WIDTH: 32 } }],
    });

    const result = validateArchDesign(design, definitions);

    assert.equal(result.valid, true);
    assert.deepEqual(result.diagnostics, []);
});

test('orders semantic diagnostics deterministically by path and code', () => {
    const design = designOf({
        instances: [{
            name: 'u_core',
            module: 'core',
            parameters: {
                a_unknown: 1,
                Z_UNKNOWN: 2,
            },
        }, {
            name: 'u_valid_1',
            module: 'core',
        }, {
            name: 'u_missing_2',
            module: 'missing',
        }, {
            name: 'u_valid_3',
            module: 'core',
        }, {
            name: 'u_valid_4',
            module: 'core',
        }, {
            name: 'u_valid_5',
            module: 'core',
        }, {
            name: 'u_valid_6',
            module: 'core',
        }, {
            name: 'u_valid_7',
            module: 'core',
        }, {
            name: 'u_valid_8',
            module: 'core',
        }, {
            name: 'u_valid_9',
            module: 'core',
        }, {
            name: 'u_ambiguous_10',
            module: 'duplicate',
        }],
    });
    const duplicateDefinitions: readonly ArchDesignModuleDefinition[] = [
        { ...coreDefinition, key: 'rtl/duplicate-a.sv#duplicate', name: 'duplicate' },
        { ...coreDefinition, key: 'rtl/duplicate-b.sv#duplicate', name: 'duplicate' },
        coreDefinition,
    ];

    const result = validateArchDesign(design, duplicateDefinitions);

    assert.deepEqual(pathCodes(result), [
        ['$.instances[0].parameters.Z_UNKNOWN', 'AD_PARAMETER_UNKNOWN'],
        ['$.instances[0].parameters.a_unknown', 'AD_PARAMETER_UNKNOWN'],
        ['$.instances[10].module', 'AD_MODULE_AMBIGUOUS'],
        ['$.instances[2].module', 'AD_MODULE_UNRESOLVED'],
    ]);
});
