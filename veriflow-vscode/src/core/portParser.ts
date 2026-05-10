import { Port, Parameter, ModuleInfo } from './types';
import { removeComments } from './verilogUtils';
import { readText } from './fileService';

const MODULE_RE = /module\s+(\w+)\s*#\s*\(([\s\S]*?)\)\s*\(([\s\S]*?)\);/;
const MODULE_NO_PARAM_RE = /module\s+(\w+)\s*\(([\s\S]*?)\);/;
const PARAM_RE = /parameter\s+(?:\[[^\]]+\]\s*)?(?:\w+\s+)?(\w+)\s*=\s*([^,;]+)/g;
const PORT_RE = /(input|output|inout)\s*(?:wire|reg|logic)?\s*(\[[^\]]+\])?\s*(\w+)/g;

export class PortParser {
    parseFile(filepath: string): ModuleInfo {
        const content = readText(filepath);
        return this._parseContent(content, filepath);
    }

    private _parseContent(content: string, filepath: string): ModuleInfo {
        content = removeComments(content);

        let match = MODULE_RE.exec(content);
        if (!match) {
            match = MODULE_NO_PARAM_RE.exec(content);
            if (!match) {
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
        }

        const moduleName = match[1];

        let parameters: Parameter[] = [];
        let portsStr = '';

        if (match.length >= 4 && match[3] !== undefined) {
            // module with parameters: module name #(params)(ports);
            parameters = this._parseParameters(match[2]);
            portsStr = match[3];
        } else {
            // module without parameters: module name(ports);
            portsStr = match[2] || '';
        }

        const ports = this._parsePorts(portsStr);

        return {
            name: moduleName,
            parameters,
            ports,
            filename: require('path').basename(filepath),
            filepath,
            dependencies: [],
            isTB: false,
        };
    }

    private _parseParameters(paramsStr: string): Parameter[] {
        const parameters: Parameter[] = [];
        PARAM_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = PARAM_RE.exec(paramsStr)) !== null) {
            parameters.push({
                name: match[1].trim(),
                value: match[2].trim(),
            });
        }
        return parameters;
    }

    private _parsePorts(portsStr: string): Port[] {
        portsStr = portsStr.replace(/\(\*[^*]*\*\)/g, '');
        const portStrs = this._splitPorts(portsStr);
        const ports: Port[] = [];

        for (const portStr of portStrs) {
            const trimmed = portStr.trim();
            if (!trimmed) { continue; }

            PORT_RE.lastIndex = 0;
            const match = PORT_RE.exec(trimmed);
            if (match) {
                const direction = match[1] as 'input' | 'output' | 'inout';
                const widthStr = match[2];
                const name = match[3];

                let widthMsb: number | undefined;
                let widthLsb: number | undefined;
                if (widthStr) {
                    const wm = widthStr.match(/\[(\d+):(\d+)\]/);
                    if (wm) {
                        widthMsb = parseInt(wm[1], 10);
                        widthLsb = parseInt(wm[2], 10);
                    }
                }

                ports.push({
                    name,
                    direction,
                    width: widthStr || undefined,
                    widthMsb,
                    widthLsb,
                });
            }
        }

        return ports;
    }

    private _splitPorts(portsStr: string): string[] {
        const ports: string[] = [];
        const current: string[] = [];
        let braceDepth = 0;
        let parenDepth = 0;

        for (const char of portsStr) {
            if (char === '{') {
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
            } else if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                parenDepth--;
            } else if (char === ',' && braceDepth === 0 && parenDepth === 0) {
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
