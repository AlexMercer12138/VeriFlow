import * as fs from 'fs';
import * as path from 'path';
import { PortParser } from './portParser';
import { Port, Parameter } from './types';

export interface TbModuleConfig {
    module_name: string;
    instance_name: string;
    filepath: string;
    port_signals: Record<string, string>;
    param_values: Record<string, string>;
}

function clog2(val: number): number {
    if (val <= 0) { return 0; }
    return Math.ceil(Math.log2(val));
}

function replaceClog2(expr: string): string {
    return expr.replace(/\$clog2\s*\(\s*([^)]+)\s*\)/g, (_match, inner) => {
        const val = parseInt(inner.trim(), 10);
        if (isNaN(val)) { return _match; }
        return String(clog2(val));
    });
}

function evalExpr(expr: string, paramMap: Record<string, string>): number {
    if (!expr) { return 1; }
    expr = expr.trim();
    if (/^\d+$/.test(expr)) { return parseInt(expr, 10); }
    // Replace parameter references (longest first to avoid partial matches)
    const sorted = Object.keys(paramMap).sort((a, b) => b.length - a.length);
    for (const pname of sorted) {
        const pval = paramMap[pname];
        const re = new RegExp('\\b' + pname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
        expr = expr.replace(re, pval);
    }
    // Handle $clog2() function
    expr = replaceClog2(expr);
    try {
        // eslint-disable-next-line no-new-func
        return Math.floor(new Function('return (' + expr + ')')());
    } catch {
        return 1;
    }
}

function resolvePortWidth(widthStr: string | undefined, paramMap: Record<string, string>): string | undefined {
    if (!widthStr) { return undefined; }
    const m = widthStr.match(/^\[(.+?):(.+?)\]$/);
    if (!m) { return widthStr; }
    const msbVal = evalExpr(m[1].trim(), paramMap);
    const lsbVal = evalExpr(m[2].trim(), paramMap);
    if (msbVal === 0 && lsbVal === 0) { return undefined; }
    return `[${msbVal}:${lsbVal}]`;
}

export interface TbConfig {
    name: string;
    time_unit: string;
    time_precision: string;
    clocks_mhz: string[];
    reset_active_high: boolean;
    reset_duration: string;
    modules: TbModuleConfig[];
    wave_file: string;
    timeout: string;
}

export class TestbenchGenerator {
    private _parser = new PortParser();

    generate(config: TbConfig, outputDir: string): string {
        const name = config.name || 'tb_top';
        const timeUnit = config.time_unit || '1ns';
        const timePrecision = config.time_precision || '1ps';
        const clocksMhz = config.clocks_mhz || ['100'];
        const resetActiveHigh = config.reset_active_high !== false;
        const resetDuration = config.reset_duration || '100';
        const modules = config.modules || [];
        const waveFile = config.wave_file || `${name}.vcd`;
        const timeout = config.timeout || '1000000';

        const lines = this._build(name, timeUnit, timePrecision, clocksMhz, resetActiveHigh, resetDuration, modules, waveFile, timeout);

        const filepath = path.join(outputDir, `${name}.v`);
        fs.writeFileSync(filepath, lines.join('\n'), 'utf-8');
        return filepath;
    }

    private _build(
        name: string,
        timeUnit: string,
        timePrecision: string,
        clocksMhz: string[],
        resetActiveHigh: boolean,
        resetDuration: string,
        modules: TbModuleConfig[],
        waveFile: string,
        timeout: string
    ): string[] {
        const L: string[] = [];

        L.push(`\`timescale ${timeUnit} / ${timePrecision}`);
        L.push('');
        L.push(`module ${name};`);
        L.push('');

        // ---- Clock signals ----
        for (let i = 0; i < clocksMhz.length; i++) {
            const freq = clocksMhz[i];
            if (!freq) { continue; }
            let freqVal = 100.0;
            try { freqVal = parseFloat(freq); } catch { /* ignore */ }
            const halfPeriod = 1000.0 / (2.0 * freqVal);
            const cname = i > 0 ? `clk_${i}` : 'clk';
            L.push(`    reg ${cname} = 0;`);
            L.push(`    always #(${halfPeriod.toFixed(1)}) ${cname} = ~${cname};`);
            L.push('');
        }

        // ---- Reset signal ----
        const rstSignal = resetActiveHigh ? 'rst' : 'rst_n';
        const rstValInit = resetActiveHigh ? "1'b1" : "1'b0";
        const rstValRelease = resetActiveHigh ? "1'b0" : "1'b1";
        L.push(`    reg ${rstSignal} = ${rstValInit};`);
        L.push('    initial begin');
        let dur = 100;
        try { dur = parseInt(resetDuration || '100', 10); } catch { /* ignore */ }
        L.push(`        #(${dur}) ${rstSignal} = ${rstValRelease};`);
        L.push('    end');
        L.push('');

        // ---- Collect all ports across modules, merge same-name ----
        const excludeSignals = new Set<string>([rstSignal]);
        for (let i = 0; i < clocksMhz.length; i++) {
            if (!clocksMhz[i]) { continue; }
            excludeSignals.add(i > 0 ? `clk_${i}` : 'clk');
        }

        const mergedSignals = new Map<string, { port: Port; paramMap: Record<string, string> }>();
        const allParsed: { mod: TbModuleConfig; ports: Port[]; params: Parameter[] }[] = [];

        for (const mod of modules) {
            const filepath = mod.filepath || '';
            const { ports, params } = this._parseModule(filepath);
            // Build param value map for width resolution
            const paramValues = mod.param_values || {};
            const paramMap: Record<string, string> = {};
            for (const p of params) {
                paramMap[p.name] = paramValues[p.name] || p.value;
            }
            allParsed.push({ mod, ports, params });
            const portSignals = mod.port_signals || {};
            for (const port of ports) {
                const sigName = portSignals[port.name] || port.name;
                if (excludeSignals.has(sigName)) { continue; }
                const existing = mergedSignals.get(sigName);
                if (!existing) {
                    mergedSignals.set(sigName, { port, paramMap });
                } else {
                    const wOld = this._widthBits(existing.port, existing.paramMap);
                    const wNew = this._widthBits(port, paramMap);
                    if (wNew > wOld) {
                        mergedSignals.set(sigName, { port, paramMap });
                    }
                }
            }
        }

        // ---- Generate shared signal declarations ----
        const inputSignals: Record<string, string | undefined> = {};
        const outputSignals: Record<string, string | undefined> = {};
        const inoutSignals: Record<string, string | undefined> = {};

        for (const [sigName, { port, paramMap }] of mergedSignals.entries()) {
            const widthStr = this._getWidthStr(port, paramMap);
            if (port.direction === 'input') {
                inputSignals[sigName] = widthStr;
            } else if (port.direction === 'inout') {
                inoutSignals[sigName] = widthStr;
            } else {
                outputSignals[sigName] = widthStr;
            }
        }

        if (Object.keys(inputSignals).length > 0) {
            L.push('    // ---- Shared DUT input signals (reg) ----');
            for (const sig of Object.keys(inputSignals).sort()) {
                const w = inputSignals[sig];
                const decl = w ? `    reg ${w} ${sig};` : `    reg ${sig};`;
                L.push(decl);
            }
            L.push('');
        }

        if (Object.keys(outputSignals).length > 0) {
            L.push('    // ---- Shared DUT output signals (wire) ----');
            for (const sig of Object.keys(outputSignals).sort()) {
                const w = outputSignals[sig];
                const decl = w ? `    wire ${w} ${sig};` : `    wire ${sig};`;
                L.push(decl);
            }
            L.push('');
        }

        if (Object.keys(inoutSignals).length > 0) {
            L.push('    // ---- Shared DUT inout signals (wire) ----');
            for (const sig of Object.keys(inoutSignals).sort()) {
                const w = inoutSignals[sig];
                const decl = w ? `    wire ${w} ${sig};` : `    wire ${sig};`;
                L.push(decl);
            }
            L.push('');
        }

        // ---- DUT instantiations ----
        for (const { mod, ports, params } of allParsed) {
            const modName = mod.module_name || 'unknown';
            const instName = mod.instance_name || `u_${modName}`;
            const portSignals = mod.port_signals || {};
            const paramValues = mod.param_values || {};

            L.push(`    // ---- DUT: ${modName} (${instName}) ----`);

            const hasParams = params.length > 0;
            if (hasParams) {
                L.push(`    ${modName} #(`);
                for (let i = 0; i < params.length; i++) {
                    const param = params[i];
                    const pvalue = paramValues[param.name] || param.value;
                    const comma = i < params.length - 1 ? ',' : '';
                    L.push(`        .${param.name}(${pvalue})${comma}`);
                }
                L.push(`    ) ${instName} (`);
            } else {
                L.push(`    ${modName} ${instName} (`);
            }

            for (let i = 0; i < ports.length; i++) {
                const port = ports[i];
                const sigName = portSignals[port.name] || port.name;
                const comma = i < ports.length - 1 ? ',' : '';
                L.push(`        .${port.name}(${sigName})${comma}`);
            }

            L.push('    );');
            L.push('');
        }

        // ---- $dump ----
        L.push('    initial begin');
        L.push(`        $dumpfile("${waveFile}");`);
        L.push(`        $dumpvars(0, ${name});`);
        L.push('    end');
        L.push('');

        // ---- Timeout ----
        let t = 1000000;
        try { t = parseInt(timeout || '1000000', 10); } catch { /* ignore */ }
        L.push('    initial begin');
        L.push(`        #(${t}) $finish;`);
        L.push('    end');
        L.push('');
        L.push('endmodule');
        L.push('');

        return L;
    }

    private _widthBits(port: Port, paramMap?: Record<string, string>): number {
        if (paramMap && port.width) {
            const resolved = resolvePortWidth(port.width, paramMap);
            if (resolved) {
                const m = resolved.match(/\[(\d+):(\d+)\]/);
                if (m) {
                    return Math.abs(parseInt(m[1], 10) - parseInt(m[2], 10)) + 1;
                }
            }
        }
        if (port.widthMsb !== undefined && port.widthLsb !== undefined) {
            return Math.abs(port.widthMsb - port.widthLsb) + 1;
        }
        if (port.width) {
            const m = port.width.match(/\[(\d+):(\d+)\]/);
            if (m) {
                return Math.abs(parseInt(m[1], 10) - parseInt(m[2], 10)) + 1;
            }
        }
        return 1;
    }

    private _getWidthStr(port: Port, paramMap?: Record<string, string>): string | undefined {
        if (paramMap && port.width) {
            return resolvePortWidth(port.width, paramMap);
        }
        return port.width;
    }

    private _parseModule(filepath: string): { ports: Port[]; params: Parameter[] } {
        if (!filepath || !fs.existsSync(filepath)) {
            return { ports: [], params: [] };
        }
        try {
            const info = this._parser.parseFile(filepath);
            return { ports: info.ports, params: info.parameters };
        } catch {
            return { ports: [], params: [] };
        }
    }
}
