import * as path from 'path';
import { DependencyResult } from './types';
import { listVerilogFiles, readText, findFile } from './fileService';
import {
    VERILOG_KEYWORDS, removeComments,
    flattenParamBlocks, expandGenerateIfdef,
    MODULE_DECL_RE, INST_RE, INCLUDE_RE,
} from './verilogUtils';

export class DependencyAnalyzer {
    resolve(topModule: string, searchDirs: string[]): DependencyResult {
        const { index } = this._buildIndex(searchDirs);

        const result: DependencyResult = {
            topModule,
            files: [],
            missingModules: [],
            moduleMap: {},
            depGraph: {},
        };

        const visited = new Set<string>();
        const queue: string[] = [topModule];

        while (queue.length > 0) {
            const moduleName = queue.shift()!;
            if (visited.has(moduleName)) { continue; }
            visited.add(moduleName);

            const filepath = index.get(moduleName);
            if (!filepath) {
                result.missingModules.push(moduleName);
                continue;
            }

            result.moduleMap[moduleName] = filepath;
            if (!result.files.includes(filepath)) {
                result.files.push(filepath);
            }

            const includes = this._extractIncludes(filepath);
            for (const incName of includes) {
                const incPath = findFile(incName, searchDirs);
                if (incPath && !result.files.includes(incPath)) {
                    result.files.splice(Math.max(0, result.files.length - 1), 0, incPath);
                }
            }

            const deps = this._extractDependencies(filepath);
            result.depGraph[moduleName] = deps;
            for (const dep of deps) {
                if (!visited.has(dep)) {
                    queue.push(dep);
                }
            }
        }

        const topoOrder = this._topologicalSort(result);
        const ordered = new Set<string>();
        for (const f of topoOrder) {
            if (!ordered.has(f)) {
                ordered.add(f);
            }
        }
        for (const f of result.files) {
            if (!ordered.has(f)) {
                ordered.add(f);
            }
        }
        result.files = Array.from(ordered);

        return result;
    }

    scanModules(searchDirs: string[]): {
        index: Map<string, string>;
        allModules: string[];
    } {
        const { index } = this._buildIndex(searchDirs);
        return {
            index,
            allModules: Array.from(index.keys()).sort(),
        };
    }

    private _buildIndex(searchDirs: string[]): {
        index: Map<string, string>;
        fileModules: Map<string, string[]>;
    } {
        const index = new Map<string, string>();
        const fileModules = new Map<string, string[]>();

        for (const searchDir of searchDirs) {
            if (!require('fs').existsSync(searchDir)) { continue; }
            for (const vfile of listVerilogFiles(searchDir)) {
                try {
                    const content = readText(vfile);
                    const cleaned = removeComments(content);
                    MODULE_DECL_RE.lastIndex = 0;
                    let match: RegExpExecArray | null;
                    while ((match = MODULE_DECL_RE.exec(cleaned)) !== null) {
                        const moduleName = match[1];
                        if (!fileModules.has(vfile)) {
                            fileModules.set(vfile, []);
                        }
                        fileModules.get(vfile)!.push(moduleName);
                        if (!index.has(moduleName)) {
                            index.set(moduleName, vfile);
                        }
                    }
                } catch {
                    // skip unreadable files
                }
            }
        }

        return { index, fileModules };
    }

    private _extractDependencies(filepath: string): string[] {
        let content: string;
        try {
            content = readText(filepath);
        } catch {
            return [];
        }

        content = removeComments(content);
        content = flattenParamBlocks(content);
        content = expandGenerateIfdef(content);

        const deps = new Set<string>();
        const moduleDeclNames = new Set<string>();

        MODULE_DECL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = MODULE_DECL_RE.exec(content)) !== null) {
            moduleDeclNames.add(m[1]);
        }

        INST_RE.lastIndex = 0;
        while ((m = INST_RE.exec(content)) !== null) {
            const instModule = m[1];
            const instName = m[2];
            if (instModule.length <= 1 || instName.length <= 1) { continue; }
            if (VERILOG_KEYWORDS.has(instModule.toLowerCase())) { continue; }
            if (VERILOG_KEYWORDS.has(instName.toLowerCase())) { continue; }
            if (instModule === instName) { continue; }
            if (moduleDeclNames.has(instModule)) { continue; }
            deps.add(instModule);
        }

        return Array.from(deps).sort();
    }

    private _extractIncludes(filepath: string): string[] {
        let content: string;
        try {
            content = readText(filepath);
        } catch {
            return [];
        }
        const includes: string[] = [];
        INCLUDE_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = INCLUDE_RE.exec(content)) !== null) {
            includes.push(match[1]);
        }
        return includes;
    }

    private _topologicalSort(result: DependencyResult): string[] {
        const inDegree: Map<string, number> = new Map();
        const adj: Map<string, Set<string>> = new Map();

        for (const filepath of result.files) {
            inDegree.set(filepath, 0);
        }

        for (const [moduleName, children] of Object.entries(result.depGraph)) {
            const parentFile = result.moduleMap[moduleName];
            if (!parentFile) { continue; }
            for (const child of children) {
                const childFile = result.moduleMap[child];
                if (!childFile) { continue; }
                if (parentFile !== childFile) {
                    if (!adj.has(childFile)) {
                        adj.set(childFile, new Set());
                    }
                    if (!adj.get(childFile)!.has(parentFile)) {
                        adj.get(childFile)!.add(parentFile);
                        inDegree.set(parentFile, (inDegree.get(parentFile) || 0) + 1);
                    }
                }
            }
        }

        const queue: string[] = [];
        for (const [filepath, degree] of inDegree.entries()) {
            if (degree === 0) {
                queue.push(filepath);
            }
        }

        const ordered: string[] = [];
        while (queue.length > 0) {
            const current = queue.shift()!;
            ordered.push(current);
            for (const neighbor of adj.get(current) || []) {
                inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1);
                if (inDegree.get(neighbor) === 0) {
                    queue.push(neighbor);
                }
            }
        }

        for (const filepath of result.files) {
            if (!ordered.includes(filepath)) {
                ordered.push(filepath);
            }
        }

        return ordered;
    }
}
