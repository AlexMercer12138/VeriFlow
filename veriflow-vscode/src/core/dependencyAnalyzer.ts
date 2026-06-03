import * as path from 'path';
import { DependencyResult } from './types';
import { listVerilogFiles, readText, findFile } from './fileService';
import {
    VERILOG_KEYWORDS, removeComments,
    preprocessVerilog, flattenParamBlocks, expandGenerateIfdef,
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
                    const cleaned = preprocessVerilog(removeComments(content));
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

        content = preprocessVerilog(removeComments(content));
        // 去除过程块（initial/always/task/function 等），这些块内部不可能有模块例化
        content = this._removeProceduralBlocks(content);
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

    private _removeProceduralBlocks(content: string): string {
        const result: string[] = [];
        let i = 0;
        const procKeywords = [
            'always_comb', 'always_ff', 'always_latch',
            'initial', 'always', 'task', 'function', 'specify', 'fork', 'final',
        ];

        while (i < content.length) {
            if (content[i] === '"') {
                const j = this._skipString(content, i);
                result.push(content.substring(i, j));
                i = j;
                continue;
            }

            if (content[i] === '\\') {
                const j = this._skipEscapedIdentifier(content, i);
                result.push(content.substring(i, j));
                i = j;
                continue;
            }

            const keyword = this._matchStandaloneKeyword(content, i, procKeywords);
            if (keyword) {
                i = this._skipProceduralRegion(content, i, keyword);
                result.push(' ');
                continue;
            }

            result.push(content[i]);
            i++;
        }

        return result.join('');
    }

    private _skipProceduralRegion(content: string, index: number, keyword: string): number {
        const start = index + keyword.length;
        if (keyword === 'task') {
            return this._skipUntilKeyword(content, start, ['endtask']);
        }
        if (keyword === 'function') {
            return this._skipUntilKeyword(content, start, ['endfunction']);
        }
        if (keyword === 'specify') {
            return this._skipUntilKeyword(content, start, ['endspecify']);
        }
        if (keyword === 'fork') {
            return this._skipForkBlock(content, index);
        }
        const bodyStart = this._skipProceduralPrefix(content, start);
        return this._skipStatement(content, bodyStart);
    }

    private _skipProceduralPrefix(content: string, index: number): number {
        let i = index;
        while (i < content.length) {
            i = this._skipWhitespace(content, i);
            if (i >= content.length) { return i; }
            if (content[i] === '@') {
                i++;
                i = this._skipWhitespace(content, i);
                if (content[i] === '(') {
                    i = this._skipBalanced(content, i, '(', ')');
                } else if (content[i] === '*') {
                    i++;
                } else {
                    while (i < content.length && !/\s/.test(content[i])) { i++; }
                }
                continue;
            }
            if (content[i] === '#') {
                i++;
                i = this._skipWhitespace(content, i);
                if (content[i] === '(') {
                    i = this._skipBalanced(content, i, '(', ')');
                } else {
                    while (i < content.length && !/\s/.test(content[i]) && content[i] !== ';') { i++; }
                }
                continue;
            }
            return i;
        }
        return i;
    }

    private _skipStatement(content: string, index: number): number {
        let i = this._skipWhitespace(content, index);
        if (i >= content.length) { return i; }

        const keyword = this._matchStandaloneKeyword(
            content,
            i,
            ['begin', 'fork', 'casez', 'casex', 'case', 'if', 'for', 'while', 'repeat', 'forever']
        );
        if (keyword === 'begin') { return this._skipBeginBlock(content, i); }
        if (keyword === 'fork') { return this._skipForkBlock(content, i); }
        if (keyword === 'case' || keyword === 'casex' || keyword === 'casez') {
            return this._skipCaseBlock(content, i);
        }
        if (keyword === 'if') { return this._skipIfStatement(content, i); }
        if (keyword === 'for' || keyword === 'while' || keyword === 'repeat') {
            let j = i + keyword.length;
            j = this._skipWhitespace(content, j);
            if (content[j] === '(') {
                j = this._skipBalanced(content, j, '(', ')');
            }
            return this._skipStatement(content, j);
        }
        if (keyword === 'forever') {
            return this._skipStatement(content, i + keyword.length);
        }
        return this._skipUntilSemicolon(content, i);
    }

    private _skipIfStatement(content: string, index: number): number {
        let i = index + 2;
        i = this._skipWhitespace(content, i);
        if (content[i] === '(') {
            i = this._skipBalanced(content, i, '(', ')');
        }
        i = this._skipStatement(content, i);
        const j = this._skipWhitespace(content, i);
        if (this._matchesStandaloneKeyword(content, j, 'else')) {
            return this._skipStatement(content, j + 4);
        }
        return i;
    }

    private _skipBeginBlock(content: string, index: number): number {
        let depth = 1;
        let i = index + 5;
        while (i < content.length) {
            if (content[i] === '"') {
                i = this._skipString(content, i);
                continue;
            }
            if (content[i] === '\\') {
                i = this._skipEscapedIdentifier(content, i);
                continue;
            }
            const keyword = this._matchStandaloneKeyword(
                content,
                i,
                ['begin', 'end', 'casez', 'casex', 'case', 'fork']
            );
            if (keyword === 'begin') {
                depth++;
                i += 5;
                continue;
            }
            if (keyword === 'end') {
                depth--;
                i += 3;
                if (depth === 0) { return i; }
                continue;
            }
            if (keyword === 'case' || keyword === 'casex' || keyword === 'casez') {
                i = this._skipCaseBlock(content, i);
                continue;
            }
            if (keyword === 'fork') {
                i = this._skipForkBlock(content, i);
                continue;
            }
            i++;
        }
        return content.length;
    }

    private _skipCaseBlock(content: string, index: number): number {
        const startKeyword = this._matchStandaloneKeyword(content, index, ['casez', 'casex', 'case']) || 'case';
        let depth = 1;
        let i = index + startKeyword.length;
        while (i < content.length) {
            if (content[i] === '"') {
                i = this._skipString(content, i);
                continue;
            }
            if (content[i] === '\\') {
                i = this._skipEscapedIdentifier(content, i);
                continue;
            }
            const keyword = this._matchStandaloneKeyword(content, i, ['casez', 'casex', 'case', 'endcase']);
            if (keyword === 'case' || keyword === 'casex' || keyword === 'casez') {
                depth++;
                i += keyword.length;
                continue;
            }
            if (keyword === 'endcase') {
                depth--;
                i += 7;
                if (depth === 0) { return i; }
                continue;
            }
            i++;
        }
        return content.length;
    }

    private _skipForkBlock(content: string, index: number): number {
        let depth = 1;
        let i = index + 4;
        while (i < content.length) {
            if (content[i] === '"') {
                i = this._skipString(content, i);
                continue;
            }
            if (content[i] === '\\') {
                i = this._skipEscapedIdentifier(content, i);
                continue;
            }
            const keyword = this._matchStandaloneKeyword(content, i, ['join_none', 'join_any', 'join', 'fork']);
            if (keyword === 'fork') {
                depth++;
                i += 4;
                continue;
            }
            if (keyword === 'join' || keyword === 'join_any' || keyword === 'join_none') {
                depth--;
                i += keyword.length;
                if (depth === 0) { return i; }
                continue;
            }
            i++;
        }
        return content.length;
    }

    private _skipUntilKeyword(content: string, index: number, keywords: string[]): number {
        let i = index;
        while (i < content.length) {
            if (content[i] === '"') {
                i = this._skipString(content, i);
                continue;
            }
            if (content[i] === '\\') {
                i = this._skipEscapedIdentifier(content, i);
                continue;
            }
            const keyword = this._matchStandaloneKeyword(content, i, keywords);
            if (keyword) {
                return i + keyword.length;
            }
            i++;
        }
        return content.length;
    }

    private _skipUntilSemicolon(content: string, index: number): number {
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let i = index;
        while (i < content.length) {
            const ch = content[i];
            if (ch === '"') {
                i = this._skipString(content, i);
                continue;
            }
            if (ch === '\\') {
                i = this._skipEscapedIdentifier(content, i);
                continue;
            }
            if (ch === '(') { parenDepth++; }
            else if (ch === ')' && parenDepth > 0) { parenDepth--; }
            else if (ch === '[') { bracketDepth++; }
            else if (ch === ']' && bracketDepth > 0) { bracketDepth--; }
            else if (ch === '{') { braceDepth++; }
            else if (ch === '}' && braceDepth > 0) { braceDepth--; }
            else if (ch === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                return i + 1;
            }
            i++;
        }
        return content.length;
    }

    private _skipBalanced(content: string, index: number, openCh: string, closeCh: string): number {
        let depth = 0;
        let i = index;
        while (i < content.length) {
            const ch = content[i];
            if (ch === '"') {
                i = this._skipString(content, i);
                continue;
            }
            if (ch === '\\') {
                i = this._skipEscapedIdentifier(content, i);
                continue;
            }
            if (ch === openCh) {
                depth++;
            } else if (ch === closeCh) {
                depth--;
                if (depth === 0) { return i + 1; }
            }
            i++;
        }
        return content.length;
    }

    private _skipWhitespace(content: string, index: number): number {
        while (index < content.length && /\s/.test(content[index])) {
            index++;
        }
        return index;
    }

    private _skipString(content: string, index: number): number {
        let i = index + 1;
        while (i < content.length) {
            if (content[i] === '"' && !this._isEscaped(content, i)) {
                return i + 1;
            }
            i++;
        }
        return content.length;
    }

    private _skipEscapedIdentifier(content: string, index: number): number {
        let i = index + 1;
        while (i < content.length && !/\s/.test(content[i])) {
            i++;
        }
        return i;
    }

    private _matchStandaloneKeyword(content: string, index: number, keywords: string[]): string {
        for (const keyword of keywords) {
            if (this._matchesStandaloneKeyword(content, index, keyword)) {
                return keyword;
            }
        }
        return '';
    }

    private _matchesStandaloneKeyword(content: string, index: number, keyword: string): boolean {
        if (!content.startsWith(keyword, index)) {
            return false;
        }
        const before = index > 0 ? content[index - 1] : '';
        const afterIndex = index + keyword.length;
        const after = afterIndex < content.length ? content[afterIndex] : '';
        return !this._isIdentifierChar(before) && !this._isIdentifierChar(after);
    }

    private _isIdentifierChar(ch: string | undefined): boolean {
        return !!ch && /[A-Za-z0-9_$]/.test(ch);
    }

    private _isEscaped(content: string, index: number): boolean {
        let backslashCount = 0;
        let i = index - 1;
        while (i >= 0 && content[i] === '\\') {
            backslashCount++;
            i--;
        }
        return backslashCount % 2 === 1;
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
