import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function recreate(directory) {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
}

export async function copyTree(source, destination) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true });
}

export async function copyFilePreservingMode(source, destination) {
    let destinationMode;
    try {
        destinationMode = (await stat(destination)).mode & 0o777;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    if (destinationMode !== undefined) {
        await chmod(destination, destinationMode);
    }
}

export async function sha256(file) {
    return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function writeJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
