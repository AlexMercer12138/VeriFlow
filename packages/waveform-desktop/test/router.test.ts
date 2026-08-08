import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WaveformWorkerClient } from '@veriflow/waveform-runtime/waveformWorkerClient';

import {
    WaveformRouter,
    type WaveformRendererMessage,
    type WaveformRouterTransport,
} from '../src/router';

type HostMessage = Record<string, unknown> & { type: string };

class MemoryTransport implements WaveformRouterTransport {
    readonly hostMessages: HostMessage[] = [];
    private readonly rendererListeners = new Set<(message: unknown) => void>();

    send(message: HostMessage): void {
        this.hostMessages.push(message);
    }

    onMessage(listener: (message: unknown) => void): () => void {
        this.rendererListeners.add(listener);
        return () => this.rendererListeners.delete(listener);
    }

    emitRenderer(message: WaveformRendererMessage): void {
        this.rendererListeners.forEach(listener => listener(message));
    }

    emitUnknown(message: unknown): void {
        this.rendererListeners.forEach(listener => listener(message));
    }

    get listenerCount(): number {
        return this.rendererListeners.size;
    }
}

const repositoryRoot = path.resolve(__dirname, '../../../..');
const waveformFixture = path.join(repositoryRoot, 'tests', 'fixtures', 'waveform_debug.vcd');

async function waitForMessage(
    transport: MemoryTransport,
    predicate: (message: HostMessage) => boolean
): Promise<HostMessage> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const message = transport.hostMessages.find(predicate);
        if (message) return message;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for routed waveform message');
}

test('ready opens the waveform through the real worker and forwards index messages', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-desktop-router-'));
    const cacheRoot = path.join(root, 'cache');
    mkdirSync(cacheRoot, { recursive: true });
    const transport = new MemoryTransport();
    const worker = new WaveformWorkerClient({ cacheRoot });
    const router = new WaveformRouter({ source: waveformFixture, transport, worker });
    try {
        transport.emitRenderer({ type: 'ready' });
        const metadata = await waitForMessage(
            transport,
            message => message.type === 'waveformMetadata'
        );
        const ready = await waitForMessage(
            transport,
            message => message.type === 'indexReady'
        );

        assert.equal(metadata.generation, 1);
        assert.equal(ready.generation, 1);
        assert.equal(ready.fileName, waveformFixture);
    } finally {
        await router.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});

test('window, value, and search requests keep renderer request ids', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-desktop-queries-'));
    const transport = new MemoryTransport();
    const worker = new WaveformWorkerClient({ cacheRoot: path.join(root, 'cache') });
    const router = new WaveformRouter({ source: waveformFixture, transport, worker });
    try {
        transport.emitRenderer({ type: 'ready' });
        await waitForMessage(transport, message => message.type === 'indexReady');

        transport.emitRenderer({
            type: 'windowRequest',
            generation: 1,
            requestId: 'window:renderer:1',
            references: ['clk'],
            start: 0,
            end: 20,
            pixelWidth: 64,
            prefetch: 0.5,
        });
        const windowData = await waitForMessage(
            transport,
            message => message.type === 'windowData'
                && message.requestId === 'window:renderer:1'
        );
        assert.deepEqual(
            (windowData.series as Array<{ times: number[] }>)[0].times,
            [0, 5, 10, 15, 20]
        );

        transport.emitRenderer({
            type: 'valueRequest',
            generation: 1,
            requestId: 'value:renderer:1',
            references: ['clk', 'data [3:0]'],
            time: 11,
        });
        const values = await waitForMessage(
            transport,
            message => message.type === 'cursorValues'
                && message.requestId === 'value:renderer:1'
        );
        assert.deepEqual(values.values, { clk: '0', 'data [3:0]': '1010' });

        transport.emitRenderer({
            type: 'searchRequest',
            generation: 1,
            requestId: 'search:renderer:1',
            targets: [{
                reference: 'clk',
                waveIndex: 0,
                name: 'top.clk',
                order: 0,
            }],
            cursorTime: 0,
            direction: 1,
            mode: 'rising',
        });
        const search = await waitForMessage(
            transport,
            message => message.type === 'searchResult'
                && message.requestId === 'search:renderer:1'
        );
        assert.equal((search.result as { time: number }).time, 5);
    } finally {
        await router.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});

test('cancellation suppresses results and retry opens a new generation', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-desktop-cancel-'));
    const transport = new MemoryTransport();
    const worker = new WaveformWorkerClient({ cacheRoot: path.join(root, 'cache') });
    const router = new WaveformRouter({ source: waveformFixture, transport, worker });
    try {
        transport.emitRenderer({ type: 'ready' });
        await waitForMessage(
            transport,
            message => message.type === 'indexReady' && message.generation === 1
        );

        transport.emitRenderer({
            type: 'cancelRequest',
            generation: 1,
            requestId: 'cancelled:renderer:1',
        });
        transport.emitRenderer({
            type: 'windowRequest',
            generation: 1,
            requestId: 'cancelled:renderer:1',
            references: ['clk'],
            start: 0,
            end: 20,
            pixelWidth: 64,
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(transport.hostMessages.some(
            message => message.type === 'windowData'
                && message.requestId === 'cancelled:renderer:1'
        ), false);

        transport.emitRenderer({ type: 'cancelLoad', generation: 1 });
        transport.emitRenderer({ type: 'retryLoad', generation: 1 });
        const ready = await waitForMessage(
            transport,
            message => message.type === 'indexReady' && message.generation === 2
        );
        assert.equal(ready.fileName, waveformFixture);
    } finally {
        await router.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});

test('stale renderer generations cannot query or control the current worker', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-desktop-generation-'));
    const transport = new MemoryTransport();
    const worker = new WaveformWorkerClient({ cacheRoot: path.join(root, 'cache') });
    const router = new WaveformRouter({ source: waveformFixture, transport, worker });
    try {
        transport.emitRenderer({ type: 'ready' });
        await waitForMessage(
            transport,
            message => message.type === 'indexReady' && message.generation === 1
        );
        transport.emitRenderer({ type: 'retryLoad', generation: 1 });
        await waitForMessage(
            transport,
            message => message.type === 'indexReady' && message.generation === 2
        );

        const messageOffset = transport.hostMessages.length;
        transport.emitRenderer({
            type: 'windowRequest',
            generation: 1,
            requestId: 'window:stale:1',
            references: ['clk'],
            start: 0,
            end: 20,
            pixelWidth: 64,
        });
        transport.emitRenderer({
            type: 'cancelRequest',
            generation: 1,
            requestId: 'window:stale:1',
        });
        transport.emitRenderer({ type: 'cancelLoad', generation: 1 });
        transport.emitRenderer({ type: 'retryLoad', generation: 1 });
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.deepEqual(transport.hostMessages.slice(messageOffset), [
            {
                type: 'bridgeError',
                generation: 2,
                message: 'stale windowRequest generation',
            },
            {
                type: 'bridgeError',
                generation: 2,
                message: 'stale cancelRequest generation',
            },
            {
                type: 'bridgeError',
                generation: 2,
                message: 'stale cancelLoad generation',
            },
            {
                type: 'bridgeError',
                generation: 2,
                message: 'stale retryLoad generation',
            },
        ]);
        assert.equal(worker.currentGeneration, 2);
    } finally {
        await router.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});

test('malformed renderer messages are rejected and disposal detaches IPC', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'veriflow-desktop-invalid-'));
    const transport = new MemoryTransport();
    const worker = new WaveformWorkerClient({ cacheRoot: path.join(root, 'cache') });
    const router = new WaveformRouter({ source: waveformFixture, transport, worker });
    try {
        transport.emitUnknown(null);
        transport.emitUnknown({ type: 'openFile', source: '/untrusted.vcd' });
        transport.emitUnknown({
            type: 'windowRequest',
            requestId: 'invalid-window',
            references: [42],
            start: 0,
            end: 20,
            pixelWidth: 64,
        });

        assert.deepEqual(transport.hostMessages, [
            {
                type: 'bridgeError',
                generation: 0,
                message: 'waveform bridge message must be an object',
            },
            {
                type: 'bridgeError',
                generation: 0,
                message: 'unsupported waveform bridge message',
            },
            {
                type: 'bridgeError',
                generation: 0,
                message: 'invalid windowRequest payload',
            },
        ]);

        await router.dispose();
        await router.dispose();
        assert.equal(transport.listenerCount, 0);
        const messageCount = transport.hostMessages.length;
        transport.emitUnknown({ type: 'ready' });
        assert.equal(transport.hostMessages.length, messageCount);
    } finally {
        await router.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});
