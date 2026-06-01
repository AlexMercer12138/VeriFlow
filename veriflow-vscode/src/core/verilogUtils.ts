export const VERILOG_KEYWORDS: Set<string> = new Set([
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
    'assign', 'always', 'initial', 'begin', 'end', 'if', 'else', 'for', 'while',
    'case', 'endcase', 'posedge', 'negedge', 'or', 'and', 'generate', 'endgenerate',
    'function', 'endfunction', 'task', 'endtask', 'parameter', 'localparam',
    'integer', 'real', 'time', 'signed', 'unsigned', 'supply0', 'supply1',
    'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'wand', 'wor',
    'specify', 'endspecify', 'defparam', 'event', 'genvar', 'forever',
    'repeat', 'wait', 'disable', 'force', 'release', 'fork', 'join',
    'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1', 'nmos', 'pmos',
    'cmos', 'rnmos', 'rpmos', 'rcmos', 'pullup', 'pulldown', 'tran',
    'tranif0', 'tranif1', 'rtran', 'rtranif0', 'rtranif1',
    'typedef', 'enum', 'struct', 'union', 'class', 'endclass',
    'package', 'endpackage', 'import', 'export', 'virtual', 'interface',
    'endinterface', 'modport', 'covergroup', 'endgroup', 'property',
    'endproperty', 'sequence', 'endsequence', 'assert', 'assume', 'cover',
    'expect', 'rand', 'randc', 'constraint', 'new', 'this', 'super',
    'null', 'void', 'do', 'foreach', 'return', 'continue', 'break',
    'automatic', 'static', 'extern', 'pure', 'ref', 'cross', 'inside',
    'dist', 'solve', 'before', 'extends', 'implements', 'with', 'unique',
    'priority', 'tagged', 'matches', 'let', 'checker', 'endchecker',
    'config', 'endconfig', 'design', 'instance', 'cell', 'liblist',
    'use', 'library', 'include',
]);

export function removeComments(content: string): string {
    content = content.replace(/\/\/.*$/gm, '');
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    return content;
}

export function preprocessVerilog(content: string, defines: Set<string> = new Set()): string {
    const activeDefines = new Set(defines);
    const output: string[] = [];
    const stack: Array<{ outer: boolean; active: boolean; taken: boolean }> = [];
    const lines = content.match(/^.*(?:\r?\n|$)/gm) || [];

    const currentActive = (): boolean => stack.every(frame => frame.active);
    const macroName = (rest: string): string => {
        const match = rest.trim().match(/^([A-Za-z_]\w*)/);
        return match ? match[1] : '';
    };

    for (const line of lines) {
        if (!line) { continue; }
        const stripped = line.replace(/^\s+/, '');
        const directive = stripped.match(/^`(ifdef|ifndef|elsif|else|endif|define|undef)\b(.*)/);
        if (!directive) {
            output.push(currentActive() ? line : line.endsWith('\n') ? '\n' : '');
            continue;
        }

        const kind = directive[1];
        const name = macroName(directive[2] || '');

        if (kind === 'ifdef' || kind === 'ifndef') {
            const outer = currentActive();
            let condition = activeDefines.has(name);
            if (kind === 'ifndef') { condition = !condition; }
            const branchActive = outer && condition;
            stack.push({ outer, active: branchActive, taken: branchActive });
            output.push('\n');
        } else if (kind === 'elsif') {
            const frame = stack[stack.length - 1];
            if (frame) {
                const branchActive = frame.outer && !frame.taken && activeDefines.has(name);
                frame.active = branchActive;
                frame.taken = frame.taken || branchActive;
            }
            output.push('\n');
        } else if (kind === 'else') {
            const frame = stack[stack.length - 1];
            if (frame) {
                const branchActive = frame.outer && !frame.taken;
                frame.active = branchActive;
                frame.taken = true;
            }
            output.push('\n');
        } else if (kind === 'endif') {
            stack.pop();
            output.push('\n');
        } else if (kind === 'define') {
            if (currentActive() && name) {
                activeDefines.add(name);
            }
            output.push('\n');
        } else if (kind === 'undef') {
            if (currentActive() && name) {
                activeDefines.delete(name);
            }
            output.push('\n');
        }
    }

    return output.join('');
}

export function flattenParamBlocks(content: string): string {
    const result: string[] = [];
    let i = 0;
    const len = content.length;
    while (i < len) {
        if (i + 1 < len && content[i] === '#' && content[i + 1] === '(') {
            let depth = 1;
            let j = i + 2;
            while (j < len && depth > 0) {
                if (content[j] === '(') {
                    depth++;
                } else if (content[j] === ')') {
                    depth--;
                }
                j++;
            }
            i = j;
            result.push(' ');
        } else {
            result.push(content[i]);
            i++;
        }
    }
    return result.join('');
}

export function expandGenerateIfdef(content: string): string {
    content = stripBlocks(content, 'generate', 'endgenerate');
    content = stripBlocks(content, '`ifdef', '`endif');
    content = stripBlocks(content, '`ifndef', '`endif');
    return stripBlocks(content, 'generate if', 'end');
}

function stripBlocks(content: string, startKw: string, endKw: string): string {
    const result: string[] = [];
    let i = 0;
    const len = content.length;
    while (i < len) {
        const posStart = content.indexOf(startKw, i);
        if (posStart === -1) {
            result.push(content.substring(i));
            break;
        }
        result.push(content.substring(i, posStart));
        let localStart = posStart + startKw.length;
        let depth = 1;
        let j = localStart;
        while (j < len && depth > 0) {
            if (content.startsWith(startKw, j)) {
                depth++;
                j += startKw.length;
            } else if (content.startsWith(endKw, j)) {
                depth--;
                if (depth === 0) {
                    j += endKw.length;
                    break;
                }
                j += endKw.length;
            } else if (content.startsWith('end', j) && endKw === 'end') {
                depth--;
                if (depth === 0) {
                    j += 3;
                    break;
                }
                j += 3;
            } else if (content.startsWith('generate', j) && endKw === 'end') {
                depth++;
                j += 8;
            } else if (content.startsWith('`ifdef', j) && endKw === 'end') {
                depth++;
                j += 6;
            } else if (content.startsWith('`ifndef', j) && endKw === 'end') {
                depth++;
                j += 7;
            } else if (content.startsWith('`else', j) && endKw === 'end') {
                j += 5;
            } else if (content.startsWith('`elsif', j) && endKw === 'end') {
                j += 6;
            } else if (content.startsWith('`endif', j) && endKw === 'end') {
                depth--;
                if (depth === 0) {
                    j += 6;
                    break;
                }
                j += 6;
            } else {
                j++;
            }
        }
        result.push(content.substring(localStart, j - endKw.length));
        i = j;
    }
    return result.join('');
}

export const MODULE_DECL_RE = /\bmodule\s+(\w+)/g;
export const INST_RE = /\b(?!module\b)(?!endmodule\b)(\w+)\s+(?:#\s*\([^)]*\)\s*)?(\w+)\s*\(/g;
export const INCLUDE_RE = /`include\s+["<]([^">]+)[">]/g;
