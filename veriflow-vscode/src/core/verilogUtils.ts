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
export const INST_RE = /\b(\w+)\s+(\w+)\s*\(/g;
export const INCLUDE_RE = /`include\s+["<]([^">]+)[">]/g;
