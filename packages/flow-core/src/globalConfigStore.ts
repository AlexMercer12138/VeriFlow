import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_GLOBAL_CONFIG } from './defaults';
import { JsonObject } from './project';

export interface GlobalConfigStoreOptions {
    homeDir?: string;
    configPath?: string;
}

function defaultConfig(): JsonObject {
    return {
        ...DEFAULT_GLOBAL_CONFIG,
        lib_dirs: [...DEFAULT_GLOBAL_CONFIG.lib_dirs],
    };
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function libDirs(config: JsonObject): string[] {
    const value = config.lib_dirs;
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
        throw new TypeError('lib_dirs must be an array of strings');
    }
    return [...value];
}

export class GlobalConfigStore {
    readonly configPath: string;

    constructor(options: GlobalConfigStoreOptions = {}) {
        const homeDir = options.homeDir ?? os.homedir();
        this.configPath = options.configPath ?? path.join(homeDir, '.veriflow_config.json');
    }

    load(): JsonObject {
        try {
            const parsed: unknown = JSON.parse(readFileSync(this.configPath, 'utf8'));
            if (!isObject(parsed)) return defaultConfig();
            if (parsed.lib_dirs === undefined) parsed.lib_dirs = [];
            libDirs(parsed);
            return parsed;
        } catch (error) {
            if (error instanceof TypeError) throw error;
            return defaultConfig();
        }
    }

    save(config: JsonObject): void {
        libDirs(config);
        mkdirSync(path.dirname(this.configPath), { recursive: true });
        writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    }

    getLibDirs(): string[] {
        return libDirs(this.load());
    }

    setLibDirs(directories: string[]): void {
        const config = this.load();
        config.lib_dirs = [...directories];
        this.save(config);
    }

    addLibDir(directory: string): void {
        const directories = this.getLibDirs();
        if (!directories.includes(directory)) {
            directories.push(directory);
            this.setLibDirs(directories);
        }
    }

    removeLibDir(directory: string): void {
        const directories = this.getLibDirs();
        if (directories.includes(directory)) {
            this.setLibDirs(directories.filter(value => value !== directory));
        }
    }

    getLanguage(): string {
        const value = this.load().language;
        return typeof value === 'string' ? value : 'zh';
    }

    setLanguage(language: string): void {
        const config = this.load();
        config.language = language;
        this.save(config);
    }

    getTheme(): string {
        const value = this.load().theme;
        return typeof value === 'string' ? value : 'dark';
    }

    setTheme(theme: string): void {
        const config = this.load();
        config.theme = theme;
        this.save(config);
    }
}
