import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SimulatorBackendRegistry as RootSimulatorBackendRegistry,
} from '@veriflow/flow-core';
import {
    SimulatorBackendRegistry,
    type SimulatorBackendProvider,
} from '@veriflow/flow-core/simulatorBackendRegistry';
import {
    createSimulationRequest,
    type SimulationExecution,
    type SimulationRequest,
    type SimulatorBackend,
} from '@veriflow/flow-core/simulation';

function request(): SimulationRequest {
    return createSimulationRequest({
        files: ['top.v'],
        output: 'top.out',
        cwd: '/workspace',
    });
}

function execution(backendId: string): SimulationExecution {
    return {
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        logEntries: [],
        waveFile: null,
        elapsedTime: 0,
        backendId,
        stage: 'run',
        timings: {},
        commands: {},
        artifacts: [],
    };
}

test('registry API is available from root and direct package exports', () => {
    assert.equal(RootSimulatorBackendRegistry, SimulatorBackendRegistry);
});

test('registered providers create backends lazily and asynchronously', async () => {
    const registry = new SimulatorBackendRegistry();
    const backend: SimulatorBackend = {
        async compileAndRun() {
            return execution('experimental-ts');
        },
    };
    let providerCalls = 0;
    const provider: SimulatorBackendProvider = async () => {
        providerCalls += 1;
        return backend;
    };

    registry.register('experimental-ts', provider);
    assert.equal(providerCalls, 0);

    assert.equal(await registry.resolve('experimental-ts'), backend);
    assert.equal(providerCalls, 1);
});

test('duplicate backend IDs are rejected without replacing the provider', async () => {
    const registry = new SimulatorBackendRegistry();
    const original: SimulatorBackend = {
        async compileAndRun() {
            return execution('original');
        },
    };
    registry.register('native', () => original);

    assert.throws(
        () => registry.register('native', () => ({
            async compileAndRun() {
                return execution('replacement');
            },
        })),
        /Simulation backend already registered: native/
    );
    assert.equal(await registry.resolve('native'), original);
});

test('unknown backend IDs are rejected explicitly', async () => {
    const registry = new SimulatorBackendRegistry();

    await assert.rejects(
        registry.resolve('missing'),
        /Unknown simulation backend: missing/
    );
});

test('run dispatches the original request to the selected backend', async () => {
    const registry = new SimulatorBackendRegistry();
    const input = request();
    const expected = execution('experimental-ts');
    let received: SimulationRequest | undefined;
    registry.register('experimental-ts', () => ({
        async compileAndRun(actual: SimulationRequest) {
            received = actual;
            return expected;
        },
    }));

    assert.equal(await registry.run('experimental-ts', input), expected);
    assert.equal(received, input);
});

test('provider failure propagates without falling back to builtin', async () => {
    const registry = new SimulatorBackendRegistry();
    let builtinCalls = 0;
    registry.register('builtin', () => {
        builtinCalls += 1;
        return {
            async compileAndRun() {
                return execution('builtin');
            },
        };
    });
    registry.register('experimental-ts', async () => {
        throw new Error('experimental-ts unavailable');
    });

    await assert.rejects(
        registry.run('experimental-ts', request()),
        /experimental-ts unavailable/
    );
    assert.equal(builtinCalls, 0);
});

test('backend failure propagates without falling back to builtin', async () => {
    const registry = new SimulatorBackendRegistry();
    let builtinCalls = 0;
    registry.register('builtin', () => {
        builtinCalls += 1;
        return {
            async compileAndRun() {
                return execution('builtin');
            },
        };
    });
    registry.register('experimental-ts', () => ({
        async compileAndRun() {
            throw new Error('experimental-ts failed');
        },
    }));

    await assert.rejects(
        registry.run('experimental-ts', request()),
        /experimental-ts failed/
    );
    assert.equal(builtinCalls, 0);
});
