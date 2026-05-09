import * as fs from 'fs';
import * as path from 'path';

const VERILOG_PATTERNS = ['*.v', '*.sv', '*.vh', '*.svh'];
const DEFAULT_ENCODINGS = ['utf-8', 'utf-8-sig', 'latin1'];

export function listVerilogFiles(directory: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(directory)) {
        return results;
    }
    _walkDir(directory, results);
    return results.sort((a, b) => a.localeCompare(b));
}

function _walkDir(dir: string, results: string[]): void {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.')) {
                    _walkDir(full, results);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (['.v', '.sv', '.vh', '.svh'].includes(ext)) {
                    results.push(full);
                }
            }
        }
    } catch {
        // skip inaccessible directories
    }
}

export function readText(filepath: string): string {
    const raw = fs.readFileSync(filepath);
    for (const enc of DEFAULT_ENCODINGS) {
        try {
            return Buffer.from(raw).toString(enc as BufferEncoding);
        } catch {
            continue;
        }
    }
    return Buffer.from(raw).toString('utf-8');
}

export function findFile(filename: string, searchDirs: string[]): string | null {
    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) {
            continue;
        }
        const results: string[] = [];
        _findInDir(dir, filename, results);
        if (results.length > 0) {
            return results[0];
        }
    }
    return null;
}

function _findInDir(dir: string, filename: string, results: string[]): void {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.')) {
                    _findInDir(full, filename, results);
                }
            } else if (entry.name === filename) {
                results.push(full);
            }
        }
    } catch {
        // skip
    }
}
