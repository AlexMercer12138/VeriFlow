import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { _electron as electron, type Page } from 'playwright';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const mainEntry = path.join(repositoryRoot, 'packages', 'waveform-desktop', 'dist', 'main.js');
const waveformFixture = path.join(repositoryRoot, 'tests', 'fixtures', 'waveform_debug.vcd');
const screenshotRoot = path.join(repositoryRoot, '.artifacts', 'waveform-desktop');

function electronEnvironment(): Record<string, string> {
    return Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => (
            typeof entry[1] === 'string'
        ))
    );
}

function electronArguments(userDataDir: string): string[] {
    return [
        mainEntry,
        '--waveform',
        waveformFixture,
        `--user-data-dir=${userDataDir}`,
        '--disable-gpu',
    ];
}

async function canvasStats(page: Page): Promise<{
    width: number;
    height: number;
    checksum: number;
    changedPixels: number;
}> {
    return page.locator('#waveCanvas').evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext('2d');
        if (!context) return { width: 0, height: 0, checksum: 0, changedPixels: 0 };
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let checksum = 0;
        let changedPixels = 0;
        const background = [pixels[0], pixels[1], pixels[2], pixels[3]];
        for (let index = 0; index < pixels.length; index += 4) {
            checksum = (checksum + (
                pixels[index] * 3
                + pixels[index + 1] * 5
                + pixels[index + 2] * 7
                + pixels[index + 3] * 11
            ) * (index + 1)) >>> 0;
            if (
                pixels[index] !== background[0]
                || pixels[index + 1] !== background[1]
                || pixels[index + 2] !== background[2]
                || pixels[index + 3] !== background[3]
            ) {
                changedPixels += 1;
            }
        }
        return { width: canvas.width, height: canvas.height, checksum, changedPixels };
    });
}

async function waitForProcessExit(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Electron process ${pid} did not exit`);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(`timed out during ${label}`)), 5_000);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function startUntrustedServer(): Promise<{
    url: string;
    close(): Promise<void>;
}> {
    const server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Untrusted</title><body>untrusted</body>');
    });
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${address.port}/untrusted`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        }),
    };
}

test('Electron host isolates the shared waveform renderer', { timeout: 20_000 }, async () => {
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-electron-host-'));
    const untrusted = await startUntrustedServer();
    const electronApp = await electron.launch({
        args: electronArguments(userDataDir),
        env: electronEnvironment(),
    });
    try {
        const page = await electronApp.firstWindow();
        page.setDefaultTimeout(5_000);
        page.setDefaultNavigationTimeout(5_000);
        await page.locator('#statusText').filter({ hasText: 'Waveform index ready.' }).waitFor();

        const preferences = await electronApp.evaluate(({ BrowserWindow }) => (
            (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences()
        ));
        assert.equal(preferences.contextIsolation, true);
        assert.equal(preferences.nodeIntegration, false);

        const renderer = await page.evaluate(() => ({
            processType: typeof (globalThis as any).process,
            requireType: typeof (globalThis as any).require,
            transportKeys: Object.keys((globalThis as any).__waveformMemoryTransport).sort(),
            title: document.title,
        }));
        assert.deepEqual(renderer, {
            processType: 'undefined',
            requireType: 'undefined',
            transportKeys: ['onMessage', 'send'],
            title: 'VeriFlow Waveform',
        });

        const waveformUrl = page.url();
        await page.evaluate(url => { window.location.href = url; }, untrusted.url);
        await page.waitForTimeout(200);
        assert.equal(page.url(), waveformUrl);

        await page.evaluate(url => { window.open(url, '_blank'); }, untrusted.url);
        await page.waitForTimeout(100);
        const windowCount = await electronApp.evaluate(({ BrowserWindow }) => (
            BrowserWindow.getAllWindows().length
        ));
        assert.equal(windowCount, 1);
    } finally {
        await electronApp.close();
        await untrusted.close();
        rmSync(userDataDir, { recursive: true, force: true });
    }
});

test('shared waveform renderer draws, reloads, resizes, and exits cleanly', {
    timeout: 30_000,
}, async () => {
    mkdirSync(screenshotRoot, { recursive: true });
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'veriflow-electron-visual-'));
    const electronApp = await electron.launch({
        args: electronArguments(userDataDir),
        env: electronEnvironment(),
    });
    const pid = electronApp.process().pid!;
    let closed = false;
    try {
        const page = await electronApp.firstWindow();
        const rendererErrors: string[] = [];
        page.on('pageerror', error => rendererErrors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error') rendererErrors.push(message.text());
        });
        await page.locator('#statusText').filter({ hasText: 'Waveform index ready.' }).waitFor();

        const before = await canvasStats(page);
        await page.locator('#signalList .signal-row').first().dblclick();
        await page.waitForFunction((checksum: number) => {
            const canvas = document.querySelector('#waveCanvas') as HTMLCanvasElement | null;
            const context = canvas?.getContext('2d');
            if (!canvas || !context) return false;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let current = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                current = (current + (
                    pixels[index] * 3
                    + pixels[index + 1] * 5
                    + pixels[index + 2] * 7
                    + pixels[index + 3] * 11
                ) * (index + 1)) >>> 0;
            }
            return current !== checksum;
        }, before.checksum);
        const after = await canvasStats(page);
        assert.ok(after.width > 0 && after.height > 0);
        assert.notEqual(after.checksum, before.checksum);
        assert.ok(after.changedPixels > 1_000);
        await page.screenshot({
            path: path.join(screenshotRoot, 'desktop.png'),
            fullPage: true,
        });

        await electronApp.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].setSize(760, 640);
        });
        await page.waitForFunction(() => window.innerWidth <= 760 && window.innerHeight <= 640);
        const layout = await page.evaluate(() => ({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            toolbarColumns: getComputedStyle(document.querySelector('.toolbar')!).gridTemplateColumns,
            toolbarBottom: document.querySelector('.toolbar')!.getBoundingClientRect().bottom,
            mainTop: document.querySelector('.main')!.getBoundingClientRect().top,
            mainBottom: document.querySelector('.main')!.getBoundingClientRect().bottom,
            statusTop: document.querySelector('.status')!.getBoundingClientRect().top,
            controlsVisible: ['#changeSearchMode', '#goToTime', '#timeInput'].every(selector => {
                const rect = document.querySelector(selector)!.getBoundingClientRect();
                return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
            }),
        }));
        assert.ok(layout.scrollWidth <= layout.clientWidth);
        assert.equal(layout.controlsVisible, true, layout.toolbarColumns);
        assert.ok(layout.toolbarBottom <= layout.mainTop + 1);
        assert.ok(layout.mainBottom <= layout.statusTop + 1);

        await page.waitForFunction(() => Object.entries(localStorage).some(([key, value]) => {
            if (!key.startsWith('veriflow.waveform.layout.v1:')) return false;
            try {
                return JSON.parse(value).rows?.length === 1;
            } catch (_error) {
                return false;
            }
        }));
        await page.reload({ waitUntil: 'load' });
        await page.locator('#statusText').filter({ hasText: 'Waveform index ready.' }).waitFor();
        await page.locator('#waveNameList .wave-name-row').first().waitFor();
        assert.equal(await page.locator('#waveNameList .wave-name-row').count(), 1);
        await page.screenshot({
            path: path.join(screenshotRoot, 'compact.png'),
            fullPage: true,
        });
        assert.deepEqual(rendererErrors, []);

        await withTimeout(page.close(), 'renderer close');
        await withTimeout(electronApp.close(), 'Electron application close');
        await waitForProcessExit(pid);
        closed = true;
    } finally {
        if (!closed) await electronApp.close();
        rmSync(userDataDir, { recursive: true, force: true });
    }
});
