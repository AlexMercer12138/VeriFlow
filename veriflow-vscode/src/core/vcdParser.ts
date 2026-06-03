export interface VcdChangePoint {
    time: number;
    value: string;
}

export interface VcdSignal {
    id: string;
    reference: string;
    fullName: string;
    scope: string;
    type: string;
    width: number;
    changes: VcdChangePoint[];
}

export interface VcdScope {
    name: string;
    fullName: string;
    depth: number;
}

export interface VcdParseIssue {
    line: number;
    message: string;
}

export interface VcdData {
    version: string;
    date: string;
    timescale: string;
    startTime: number;
    endTime: number;
    scopes: VcdScope[];
    signals: VcdSignal[];
    warnings: VcdParseIssue[];
}

interface MutableSignal extends VcdSignal {
    changes: VcdChangePoint[];
}

function readDirectiveBlock(lines: string[], startIndex: number, token: string): { value: string; nextIndex: number } {
    const firstLine = lines[startIndex].trim();
    const inline = firstLine.match(new RegExp(`^\\$${token}\\b\\s*(.*?)\\s*\\$end$`));
    if (inline) {
        return { value: inline[1].trim(), nextIndex: startIndex };
    }

    const parts: string[] = [];
    const firstContent = firstLine.replace(new RegExp(`^\\$${token}\\b`), '').trim();
    if (firstContent) {
        parts.push(firstContent);
    }

    let index = startIndex + 1;
    while (index < lines.length) {
        const line = lines[index].trim();
        if (line === '$end') {
            return { value: parts.join(' ').trim(), nextIndex: index };
        }
        if (line.endsWith('$end')) {
            parts.push(line.replace(/\$end$/, '').trim());
            return { value: parts.join(' ').trim(), nextIndex: index };
        }
        if (line) {
            parts.push(line);
        }
        index++;
    }

    return { value: parts.join(' ').trim(), nextIndex: startIndex };
}

function normalizeScalar(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) { return 'x'; }
    return trimmed[0].toLowerCase();
}

function normalizeVector(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) { return 'x'; }
    return trimmed.toLowerCase();
}

function uniqueFullName(scope: string, reference: string, usedNames: Set<string>): string {
    const base = scope ? `${scope}.${reference}` : reference;
    let candidate = base;
    let index = 1;
    while (usedNames.has(candidate)) {
        index++;
        candidate = `${base}#${index}`;
    }
    usedNames.add(candidate);
    return candidate;
}

export class VcdParser {
    parse(content: string): VcdData {
        const lines = content.split(/\r?\n/);
        const warnings: VcdParseIssue[] = [];
        const scopes: VcdScope[] = [];
        const scopeStack: string[] = [];
        const signalsById = new Map<string, MutableSignal[]>();
        const declaredSignals: MutableSignal[] = [];
        const usedNames = new Set<string>();
        let version = '';
        let date = '';
        let timescale = '';
        let currentTime = 0;
        let endDefinitions = false;

        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const line = raw.trim();
            const lineNumber = i + 1;
            if (!line) { continue; }

            if (!endDefinitions) {
                if (line.startsWith('$date')) {
                    const block = readDirectiveBlock(lines, i, 'date');
                    date = block.value;
                    i = block.nextIndex;
                    continue;
                }
                if (line.startsWith('$version')) {
                    const block = readDirectiveBlock(lines, i, 'version');
                    version = block.value;
                    i = block.nextIndex;
                    continue;
                }
                if (line.startsWith('$timescale')) {
                    const block = readDirectiveBlock(lines, i, 'timescale');
                    timescale = block.value;
                    i = block.nextIndex;
                    continue;
                }
                if (line.startsWith('$comment')) {
                    const block = readDirectiveBlock(lines, i, 'comment');
                    i = block.nextIndex;
                    continue;
                }
                if (line.startsWith('$scope')) {
                    const parts = line.split(/\s+/);
                    const name = parts.length >= 3 ? parts[2] : `scope_${scopes.length + 1}`;
                    scopeStack.push(name);
                    scopes.push({
                        name,
                        fullName: scopeStack.join('.'),
                        depth: Math.max(0, scopeStack.length - 1),
                    });
                    continue;
                }
                if (line.startsWith('$upscope')) {
                    scopeStack.pop();
                    continue;
                }
                if (line.startsWith('$var')) {
                    const match = line.match(/^\$var\s+(\S+)\s+(\d+)\s+(\S+)\s+(.+?)\s+\$end$/);
                    if (!match) {
                        warnings.push({ line: lineNumber, message: 'Could not parse $var declaration.' });
                        continue;
                    }
                    const [, type, widthText, id, refText] = match;
                    const reference = refText.trim();
                    const scope = scopeStack.join('.');
                    const fullName = uniqueFullName(scope, reference, usedNames);
                    const signal: MutableSignal = {
                        id,
                        reference,
                        fullName,
                        scope,
                        type,
                        width: Number.parseInt(widthText, 10) || 1,
                        changes: [],
                    };
                    const entries = signalsById.get(id) || [];
                    entries.push(signal);
                    signalsById.set(id, entries);
                    declaredSignals.push(signal);
                    continue;
                }
                if (line.startsWith('$enddefinitions')) {
                    endDefinitions = true;
                    continue;
                }
                continue;
            }

            if (line.startsWith('#')) {
                const parsed = Number.parseInt(line.slice(1), 10);
                if (!Number.isNaN(parsed)) {
                    currentTime = parsed;
                }
                continue;
            }
            if (line.startsWith('$')) {
                continue;
            }

            const vectorMatch = line.match(/^[bB]([01xXzZ]+)\s+(.+)$/);
            if (vectorMatch) {
                const value = normalizeVector(vectorMatch[1]);
                const id = vectorMatch[2].trim();
                const signals = signalsById.get(id) || [];
                for (const signal of signals) {
                    signal.changes.push({ time: currentTime, value });
                }
                continue;
            }

            const scalarMatch = line.match(/^([01xXzZ])(.+)$/);
            if (scalarMatch) {
                const value = normalizeScalar(scalarMatch[1]);
                const id = scalarMatch[2].trim();
                const signals = signalsById.get(id) || [];
                for (const signal of signals) {
                    signal.changes.push({ time: currentTime, value });
                }
                continue;
            }
        }

        const signals = declaredSignals
            .map(signal => ({
                ...signal,
                changes: (signal.changes.length > 0 ? signal.changes : [{ time: 0, value: 'x' }])
                    .sort((a, b) => a.time - b.time),
            }));

        let endTime = currentTime;
        for (const signal of signals) {
            const last = signal.changes[signal.changes.length - 1];
            if (last && last.time > endTime) {
                endTime = last.time;
            }
        }

        return {
            version,
            date,
            timescale,
            startTime: 0,
            endTime,
            scopes,
            signals,
            warnings,
        };
    }
}
