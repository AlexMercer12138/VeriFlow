import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DATA_MAGIC, INDEX_VERSION, validateManifest } from './vcdIndexFormat';
import {
    VcdIndexBuildOptions,
    VcdIndexCancelled,
    buildVcdIndex,
} from './vcdIndex';

export const DEFAULT_WAVEFORM_CACHE_BYTES = 4 * 1024 ** 3;
const SAMPLE_BYTES = 64 * 1024;

export type SourceFingerprint = {
    key: string;
    normalizedPath: string;
    size: number;
    mtimeNs: string;
    headSha256: string;
    tailSha256: string;
    indexVersion: number;
};

export type WaveformCacheConstructorOptions = {
    root?: string;
    maxBytes?: number;
    builder?: typeof buildVcdIndex;
    staleLockMs?: number;
    waitMs?: number;
};

export function waveformCacheRoot(): string {
    if (process.platform === 'win32') {
        const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        return path.join(base, 'VeriFlow', 'waveform-cache');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Caches', 'VeriFlow', 'waveform-cache');
    }
    const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
    return path.join(base, 'veriflow', 'waveform-cache');
}

function normalizedSourcePath(source: string): string {
    const normalized = path.resolve(source).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function sampleHashes(source: string, size: bigint): Promise<[string, string]> {
    const handle = await fs.promises.open(source, 'r');
    try {
        const headLength = Number(size < BigInt(SAMPLE_BYTES) ? size : BigInt(SAMPLE_BYTES));
        const tailLength = headLength;
        const head = Buffer.alloc(headLength);
        const tail = Buffer.alloc(tailLength);
        await handle.read(head, 0, head.length, 0);
        await handle.read(tail, 0, tail.length, Number(size - BigInt(tailLength)));
        return [
            crypto.createHash('sha256').update(head).digest('hex'),
            crypto.createHash('sha256').update(tail).digest('hex'),
        ];
    } finally {
        await handle.close();
    }
}

export async function sourceFingerprint(source: string): Promise<SourceFingerprint> {
    source = path.resolve(source);
    const stat = await fs.promises.stat(source, { bigint: true });
    const normalizedPath = normalizedSourcePath(source);
    const [headSha256, tailSha256] = await sampleHashes(source, stat.size);
    const digest = crypto.createHash('sha256');
    digest.update(Buffer.from('VFI-CACHE-1\0', 'ascii'));
    digest.update(Buffer.from(normalizedPath, 'utf8'));
    digest.update(Buffer.from('\0', 'ascii'));
    digest.update(Buffer.from(stat.size.toString(), 'ascii'));
    digest.update(Buffer.from('\0', 'ascii'));
    digest.update(Buffer.from(stat.mtimeNs.toString(), 'ascii'));
    digest.update(Buffer.from('\0', 'ascii'));
    digest.update(Buffer.from(headSha256, 'hex'));
    digest.update(Buffer.from(tailSha256, 'hex'));
    digest.update(Buffer.from(String(INDEX_VERSION), 'ascii'));
    return {
        key: digest.digest('hex'),
        normalizedPath,
        size: Number(stat.size),
        mtimeNs: stat.mtimeNs.toString(),
        headSha256,
        tailSha256,
        indexVersion: INDEX_VERSION,
    };
}

function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export class WaveformCacheLock {
    private readonly token = crypto.randomBytes(16).toString('hex');
    private heartbeat: NodeJS.Timeout | undefined;
    private heartbeatWrite: Promise<void> = Promise.resolve();
    private acquired = false;

    constructor(private readonly lockPath: string, private readonly staleMs: number) {}

    private payload(): Record<string, unknown> {
        const now = Date.now();
        return { pid: process.pid, createdAtMs: now, heartbeatMs: now, token: this.token };
    }

    private async writeInitial(): Promise<void> {
        const handle = await fs.promises.open(this.lockPath, 'wx');
        try {
            await handle.writeFile(JSON.stringify(this.payload()), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    private async writeHeartbeat(): Promise<void> {
        const temporary = `${this.lockPath}.heartbeat.${this.token}`;
        try {
            const current = JSON.parse(await fs.promises.readFile(this.lockPath, 'utf8'));
            if (current.token !== this.token) return;
            await fs.promises.writeFile(temporary, JSON.stringify(this.payload()), 'utf8');
            await fs.promises.rename(temporary, this.lockPath);
        } catch {
            // Another process may reclaim or remove the lock during shutdown.
        } finally {
            await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        }
    }

    private async reclaimIfStale(): Promise<boolean> {
        let original: Buffer;
        let modifiedMs: number;
        try {
            original = await fs.promises.readFile(this.lockPath);
            modifiedMs = (await fs.promises.stat(this.lockPath)).mtimeMs;
        } catch {
            return false;
        }
        let stale: boolean;
        try {
            const payload = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
            const heartbeatMs = Number(payload.heartbeatMs ?? 0);
            const pid = Number(payload.pid ?? 0);
            stale = !pidAlive(pid) || Date.now() - heartbeatMs > this.staleMs;
        } catch {
            stale = Date.now() - modifiedMs > this.staleMs;
        }
        if (!stale) return false;
        try {
            const current = await fs.promises.readFile(this.lockPath);
            if (!current.equals(original)) return false;
            await fs.promises.unlink(this.lockPath);
            return true;
        } catch {
            return false;
        }
    }

    async acquire(): Promise<boolean> {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.writeInitial();
                this.acquired = true;
                this.heartbeat = setInterval(
                    () => {
                        this.heartbeatWrite = this.heartbeatWrite.then(
                            () => this.writeHeartbeat(),
                            () => this.writeHeartbeat()
                        );
                    },
                    Math.max(100, Math.floor(this.staleMs / 3))
                );
                this.heartbeat.unref();
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (!await this.reclaimIfStale()) return false;
            }
        }
        return false;
    }

    async release(): Promise<void> {
        if (!this.acquired) return;
        if (this.heartbeat) clearInterval(this.heartbeat);
        await this.heartbeatWrite;
        try {
            const payload = JSON.parse(await fs.promises.readFile(this.lockPath, 'utf8'));
            if (payload.token === this.token) await fs.promises.unlink(this.lockPath);
        } catch {
            // The lock may already have been reclaimed after an owner failure.
        }
        this.acquired = false;
    }
}

export class WaveformCache {
    public readonly root: string;
    public maxBytes: number;
    private readonly builder: typeof buildVcdIndex;
    private readonly staleLockMs: number;
    private readonly waitMs: number;
    private readonly active = new Set<string>();
    private readonly startupCleanup: Promise<void>;

    constructor(options: WaveformCacheConstructorOptions = {}) {
        this.root = path.resolve(options.root ?? waveformCacheRoot());
        this.maxBytes = options.maxBytes ?? DEFAULT_WAVEFORM_CACHE_BYTES;
        if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
            throw new Error('waveform cache size must be positive');
        }
        this.builder = options.builder ?? buildVcdIndex;
        this.staleLockMs = options.staleLockMs ?? 30_000;
        this.waitMs = options.waitMs ?? 100;
        fs.mkdirSync(this.root, { recursive: true });
        this.startupCleanup = this.cleanupInternal();
    }

    private async validEntry(entry: string, fingerprint?: SourceFingerprint): Promise<boolean> {
        try {
            const manifest = validateManifest(
                JSON.parse(await fs.promises.readFile(path.join(entry, 'manifest.json'), 'utf8'))
            ) as Record<string, unknown>;
            if (
                fingerprint &&
                manifest.sourceFingerprint !== undefined &&
                manifest.sourceFingerprint !== fingerprint.key
            ) return false;
            const data = await fs.promises.open(path.join(entry, manifest.dataFile as string), 'r');
            try {
                const magic = Buffer.alloc(DATA_MAGIC.length);
                const { bytesRead } = await data.read(magic, 0, magic.length, 0);
                return bytesRead === magic.length && magic.equals(DATA_MAGIC);
            } finally {
                await data.close();
            }
        } catch {
            return false;
        }
    }

    private async atomicManifestWrite(manifestPath: string, manifest: unknown): Promise<void> {
        const temporary = path.join(
            path.dirname(manifestPath),
            `.${path.basename(manifestPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
        );
        try {
            const handle = await fs.promises.open(temporary, 'w');
            try {
                await handle.writeFile(JSON.stringify(manifest), 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.promises.rename(temporary, manifestPath);
        } finally {
            await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        }
    }

    private async touchEntry(entry: string, fingerprint: SourceFingerprint): Promise<void> {
        const manifestPath = path.join(entry, 'manifest.json');
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        manifest.sourceFingerprint = fingerprint.key;
        manifest.lastAccessNs = (BigInt(Date.now()) * 1_000_000n).toString();
        await this.atomicManifestWrite(manifestPath, manifest);
    }

    private async openFingerprint(fingerprint: SourceFingerprint): Promise<string | null> {
        const entry = path.join(this.root, fingerprint.key);
        if (!await this.validEntry(entry, fingerprint)) {
            if (fs.existsSync(entry) && !this.active.has(fingerprint.key)) {
                await fs.promises.rm(entry, { recursive: true, force: true });
            }
            return null;
        }
        await this.touchEntry(entry, fingerprint);
        this.active.add(fingerprint.key);
        return entry;
    }

    async openExisting(source: string): Promise<string | null> {
        await this.startupCleanup;
        return this.openFingerprint(await sourceFingerprint(source));
    }

    async getOrBuild(
        source: string,
        options: VcdIndexBuildOptions = {}
    ): Promise<string> {
        await this.startupCleanup;
        source = path.resolve(source);
        const fingerprint = await sourceFingerprint(source);
        let lock: WaveformCacheLock;
        while (true) {
            const existing = await this.openFingerprint(fingerprint);
            if (existing) return existing;
            if (options.cancelled?.()) throw new VcdIndexCancelled();
            lock = new WaveformCacheLock(
                path.join(this.root, `${fingerprint.key}.lock`),
                this.staleLockMs
            );
            if (await lock.acquire()) break;
            options.onProgress?.({ phase: 'waiting', completed: 0, total: 0, percent: 0 });
            await new Promise(resolve => setTimeout(resolve, this.waitMs));
        }

        const temporary = path.join(
            this.root,
            `${fingerprint.key}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
        );
        const final = path.join(this.root, fingerprint.key);
        try {
            const existing = await this.openFingerprint(fingerprint);
            if (existing) return existing;
            await this.builder(source, temporary, options);
            await this.touchEntry(temporary, fingerprint);
            if (!await this.validEntry(temporary, fingerprint)) {
                throw new Error('waveform cache build did not produce a valid index');
            }
            if (fs.existsSync(final)) {
                await fs.promises.rm(temporary, { recursive: true, force: true });
            } else {
                await fs.promises.rename(temporary, final);
            }
            this.active.add(fingerprint.key);
            await this.cleanupInternal(new Set([fingerprint.key]));
            return final;
        } finally {
            await fs.promises.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
            await lock.release();
        }
    }

    release(indexDir: string): void {
        this.active.delete(path.basename(path.resolve(indexDir)));
    }

    private async directorySize(directory: string): Promise<number> {
        let total = 0;
        for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
            const item = path.join(directory, entry.name);
            if (entry.isDirectory()) total += await this.directorySize(item);
            else if (entry.isFile()) total += (await fs.promises.stat(item)).size;
        }
        return total;
    }

    private async cleanupInternal(protectedKeys = new Set<string>()): Promise<void> {
        const protectedEntries = new Set([...this.active, ...protectedKeys]);
        const entries: Array<{ accessNs: bigint; size: number; entry: string; key: string }> = [];
        let total = 0;
        for (const directoryEntry of await fs.promises.readdir(this.root, { withFileTypes: true })) {
            if (!directoryEntry.isDirectory() || directoryEntry.name.includes('.tmp.')) continue;
            const entry = path.join(this.root, directoryEntry.name);
            if (!await this.validEntry(entry)) {
                if (!protectedEntries.has(directoryEntry.name)) {
                    await fs.promises.rm(entry, { recursive: true, force: true });
                }
                continue;
            }
            try {
                const manifest = JSON.parse(
                    await fs.promises.readFile(path.join(entry, 'manifest.json'), 'utf8')
                );
                const stat = await fs.promises.stat(entry, { bigint: true });
                const accessNs = BigInt(manifest.lastAccessNs ?? stat.mtimeNs);
                const size = await this.directorySize(entry);
                total += size;
                entries.push({ accessNs, size, entry, key: directoryEntry.name });
            } catch {
                // A concurrent publisher or accessor may be replacing the manifest.
            }
        }
        entries.sort((left, right) => left.accessNs < right.accessNs ? -1 : left.accessNs > right.accessNs ? 1 : 0);
        for (const item of entries) {
            if (total <= this.maxBytes) break;
            if (protectedEntries.has(item.key)) continue;
            await fs.promises.rm(item.entry, { recursive: true, force: true });
            total -= item.size;
        }
    }

    async cleanup(): Promise<void> {
        await this.startupCleanup;
        await this.cleanupInternal();
    }
}
