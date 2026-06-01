import { Port, Parameter, ModuleInfo } from './types';
import { preprocessVerilog, removeComments } from './verilogUtils';
import { readText } from './fileService';

const PARAM_DECL_RE = /\b(parameter|localparam)\b\s*([\s\S]*)/;
const ANSI_PORT_RE = /\b(input|output|inout)\b\s*([\s\S]*)/;

export class PortParser {
    parseFile(filepath: string): ModuleInfo {
        const content = readText(filepath);
        return this._parseContent(content, filepath);
    }

    private _parseContent(content: string, filepath: string): ModuleInfo {
        content = preprocessVerilog(removeComments(content));
        const parsed = this._parseModuleHeader(content);
        if (!parsed) {
            return {
                name: 'unknown',
                parameters: [],
                ports: [],
                filename: require('path').basename(filepath),
                filepath,
                dependencies: [],
                isTB: false,
            };
        }

        const body = content.substring(parsed.bodyStart, this._findMatchingEndmodule(content, parsed.bodyStart));
        const parameters = this._parseParameters(parsed.paramsStr);
        const ports = this._parsePorts(parsed.portsStr, body);

        return {
            name: parsed.moduleName,
            parameters,
            ports,
            filename: require('path').basename(filepath),
            filepath,
            dependencies: [],
            isTB: false,
        };
    }

    private _parseModuleHeader(content: string): {
        moduleName: string;
        paramsStr: string;
        portsStr: string;
        bodyStart: number;
    } | null {
        const moduleMatch = /\bmodule\s+(\w+)\b/.exec(content);
        if (!moduleMatch || moduleMatch.index === undefined) {
            return null;
        }

        const moduleName = moduleMatch[1];
        let i = moduleMatch.index + moduleMatch[0].length;
        while (i < content.length && /\s/.test(content[i])) { i++; }

        let paramsStr = '';
        if (content[i] === '#') {
            i++;
            while (i < content.length && /\s/.test(content[i])) { i++; }
            if (content[i] !== '(') { return null; }
            const end = this._findMatchingParen(content, i);
            if (end < 0) { return null; }
            paramsStr = content.substring(i + 1, end);
            i = end + 1;
            while (i < content.length && /\s/.test(content[i])) { i++; }
        }

        let portsStr = '';
        if (content[i] === '(') {
            const end = this._findMatchingParen(content, i);
            if (end < 0) { return null; }
            portsStr = content.substring(i + 1, end);
            i = end + 1;
        }

        const semi = content.indexOf(';', i);
        if (semi < 0) { return null; }
        return { moduleName, paramsStr, portsStr, bodyStart: semi + 1 };
    }

    private _findMatchingParen(text: string, openIdx: number): number {
        let depth = 0;
        let inString = false;
        for (let i = openIdx; i < text.length; i++) {
            const ch = text[i];
            if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
                inString = !inString;
            } else if (!inString) {
                if (ch === '(') {
                    depth++;
                } else if (ch === ')') {
                    depth--;
                    if (depth === 0) { return i; }
                }
            }
        }
        return -1;
    }

    private _findMatchingEndmodule(content: string, start: number): number {
        const match = /\bendmodule\b/.exec(content.substring(start));
        return match && match.index !== undefined ? start + match.index : content.length;
    }

    private _parseParameters(paramsStr: string): Parameter[] {
        const parameters: Parameter[] = [];
        for (const item of this._splitPorts(paramsStr)) {
            let text = item.trim();
            if (!text) { continue; }
            const decl = PARAM_DECL_RE.exec(text);
            if (decl) {
                text = decl[2].trim();
            }
            const eqIdx = this._findTopLevelChar(text, '=');
            if (eqIdx < 0) { continue; }
            const left = text.substring(0, eqIdx).replace(/\[[^\]]+\]/g, ' ').trim();
            const value = text.substring(eqIdx + 1).trim();
            const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(left);
            if (!nameMatch) { continue; }
            parameters.push({
                name: nameMatch[1],
                value,
            });
        }
        return parameters;
    }

    private _parsePorts(portsStr: string, body: string = ''): Port[] {
        portsStr = portsStr.replace(/\(\*[^*]*\*\)/g, '');
        const portStrs = this._splitPorts(portsStr);
        const ports: Port[] = [];
        const headerNames: string[] = [];
        const declarations = new Map<string, Port>();
        let lastDirection: 'input' | 'output' | 'inout' | null = null;
        let lastWidth: string | undefined;

        for (const portStr of portStrs) {
            const trimmed = portStr.trim();
            if (!trimmed) { continue; }

            const match = ANSI_PORT_RE.exec(trimmed);
            if (match) {
                const direction = match[1] as 'input' | 'output' | 'inout';
                const parsedPorts = this._parsePortDeclTail(direction, match[2]);
                ports.push(...parsedPorts);
                if (parsedPorts.length > 0) {
                    lastDirection = direction;
                    lastWidth = parsedPorts[parsedPorts.length - 1].width;
                }
            } else if (lastDirection && ports.length > 0) {
                const name = this._cleanPortName(trimmed);
                if (name) {
                    const [widthMsb, widthLsb] = this._parseNumericWidth(lastWidth);
                    ports.push({
                        name,
                        direction: lastDirection,
                        width: lastWidth,
                        widthMsb,
                        widthLsb,
                    });
                }
            } else {
                const name = this._cleanPortName(trimmed);
                if (name) {
                    headerNames.push(name);
                }
            }
        }

        if (ports.length > 0) {
            return this._dedupePorts(ports);
        }

        for (const declaration of this._bodyPortDeclarations(body)) {
            const match = ANSI_PORT_RE.exec(declaration.trim());
            if (!match) { continue; }
            const direction = match[1] as 'input' | 'output' | 'inout';
            for (const port of this._parsePortDeclTail(direction, match[2])) {
                declarations.set(port.name, port);
            }
        }

        for (const name of headerNames) {
            const port = declarations.get(name);
            if (port) {
                ports.push(port);
            }
        }
        return ports;
    }

    private _parsePortDeclTail(direction: 'input' | 'output' | 'inout', tail: string): Port[] {
        let text = tail.trim().replace(/[,;]\s*$/, '').replace(/\s+/g, ' ');
        text = text.replace(/\b(wire|reg|logic|signed|unsigned|var|tri|bit)\b/g, ' ');
        const widthMatch = /\[[^\]]+\]/.exec(text);
        const widthStr = widthMatch ? widthMatch[0].trim() : undefined;
        if (widthMatch && widthMatch.index !== undefined) {
            text = text.substring(0, widthMatch.index) + ' ' + text.substring(widthMatch.index + widthMatch[0].length);
        }

        const ports: Port[] = [];
        for (const namePart of this._splitPorts(text)) {
            const name = this._cleanPortName(namePart);
            if (!name) { continue; }
            const [widthMsb, widthLsb] = this._parseNumericWidth(widthStr);
            ports.push({
                name,
                direction,
                width: widthStr,
                widthMsb,
                widthLsb,
            });
        }
        return ports;
    }

    private _bodyPortDeclarations(body: string): string[] {
        return this._splitStatements(body).filter(stmt => /^\s*(input|output|inout)\b/.test(stmt));
    }

    private _splitStatements(text: string): string[] {
        const result: string[] = [];
        const current: string[] = [];
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let inString = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
                inString = !inString;
            } else if (!inString) {
                if (char === '(') { parenDepth++; }
                else if (char === ')') { parenDepth--; }
                else if (char === '[') { bracketDepth++; }
                else if (char === ']') { bracketDepth--; }
                else if (char === '{') { braceDepth++; }
                else if (char === '}') { braceDepth--; }
                else if (char === ';' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                    result.push(current.join('').trim());
                    current.length = 0;
                    continue;
                }
            }
            current.push(char);
        }
        if (current.length > 0) {
            result.push(current.join('').trim());
        }
        return result;
    }

    private _cleanPortName(text: string): string {
        let clean = text.trim().replace(/[,;]\s*$/, '');
        clean = clean.replace(/=[\s\S]*$/, '').trim();
        clean = clean.replace(/\[[^\]]+\]\s*$/, '').trim();
        const match = /\\\S+|[A-Za-z_]\w*$/.exec(clean);
        if (!match) { return ''; }
        return match[0].startsWith('\\') ? match[0].substring(1) : match[0];
    }

    private _parseNumericWidth(widthStr?: string): [number | undefined, number | undefined] {
        if (!widthStr) { return [undefined, undefined]; }
        const wm = widthStr.match(/\[(\d+)\s*:\s*(\d+)\]/);
        if (!wm) { return [undefined, undefined]; }
        return [parseInt(wm[1], 10), parseInt(wm[2], 10)];
    }

    private _dedupePorts(ports: Port[]): Port[] {
        const result: Port[] = [];
        const seen = new Set<string>();
        for (const port of ports) {
            if (seen.has(port.name)) { continue; }
            seen.add(port.name);
            result.push(port);
        }
        return result;
    }

    private _findTopLevelChar(text: string, target: string): number {
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let inString = false;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
                inString = !inString;
            } else if (!inString) {
                if (char === '(') { parenDepth++; }
                else if (char === ')') { parenDepth--; }
                else if (char === '[') { bracketDepth++; }
                else if (char === ']') { bracketDepth--; }
                else if (char === '{') { braceDepth++; }
                else if (char === '}') { braceDepth--; }
                else if (char === target && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                    return i;
                }
            }
        }
        return -1;
    }

    private _splitPorts(portsStr: string): string[] {
        const ports: string[] = [];
        const current: string[] = [];
        let braceDepth = 0;
        let parenDepth = 0;
        let bracketDepth = 0;
        let inString = false;

        for (let i = 0; i < portsStr.length; i++) {
            const char = portsStr[i];
            if (char === '"' && (i === 0 || portsStr[i - 1] !== '\\')) {
                inString = !inString;
            } else if (inString) {
                // keep string text as-is
            } else if (char === '{') {
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
            } else if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                parenDepth--;
            } else if (char === '[') {
                bracketDepth++;
            } else if (char === ']') {
                bracketDepth--;
            } else if (char === ',' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
                ports.push(current.join('').trim());
                current.length = 0;
                continue;
            }
            current.push(char);
        }

        if (current.length > 0) {
            ports.push(current.join('').trim());
        }

        return ports;
    }
}
