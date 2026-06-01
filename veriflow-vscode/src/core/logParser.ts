import { LogEntry } from './types';

const ERROR_PATTERNS: RegExp[] = [
    /^(?<file>[^:]+):(?<line>\d+):\s*error\s*:\s*(?<msg>.+)$/i,
    /^(?<file>[^:]+):(?<line>\d+):\s*(?<msg>.+)$/i,
    /^ERROR:\s*(?<msg>.+)$/i,
    /^Error\s*\([^)]*\):\s*(?<msg>.+)$/,
];

const WARNING_PATTERNS: RegExp[] = [
    /^(?<file>[^:]+):(?<line>\d+):\s*warning\s*:\s*(?<msg>.+)$/i,
    /^WARNING:\s*(?<msg>.+)$/i,
];

export class LogParser {
    parse(text: string): LogEntry[] {
        const entries: LogEntry[] = [];
        for (const line of text.split('\n')) {
            const entry = this._parseLine(line.trim());
            if (entry) {
                entries.push(entry);
            }
        }
        return entries;
    }

    hasErrors(text: string): boolean {
        return this.parse(text).some(e => e.level === 'ERROR');
    }

    private _parseLine(line: string): LogEntry | null {
        if (!line) { return null; }

        for (const pattern of WARNING_PATTERNS) {
            const m = line.match(pattern);
            if (m) {
                const groups = m.groups || {};
                return {
                    level: 'WARNING',
                    message: groups.msg || line,
                    fileRef: groups.file || undefined,
                    lineNo: groups.line ? parseInt(groups.line, 10) : undefined,
                };
            }
        }

        for (const pattern of ERROR_PATTERNS) {
            const m = line.match(pattern);
            if (m) {
                const groups = m.groups || {};
                return {
                    level: 'ERROR',
                    message: groups.msg || line,
                    fileRef: groups.file || undefined,
                    lineNo: groups.line ? parseInt(groups.line, 10) : undefined,
                };
            }
        }

        if (/error/i.test(line)) {
            return { level: 'ERROR', message: line };
        }
        if (/warning/i.test(line)) {
            return { level: 'WARNING', message: line };
        }

        return { level: 'INFO', message: line };
    }
}
