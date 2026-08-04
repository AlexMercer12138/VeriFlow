import * as path from 'path';

import type {
    DirectiveModel,
    HdlDiagnostic,
    IncludeModel,
    SourceFileSpan,
    SourceSpan,
} from './model';

export type ResolvedIncludeInput = {
    fromUri: string;
    rawPath: string;
    resolvedUri: string;
    text: string;
};

export type PreprocessOptions = {
    defines: Record<string, string | true>;
    resolvedIncludes?: ResolvedIncludeInput[];
    maxIncludeDepth?: number;
};

export type CompositeSourceSegment = {
    generatedStart: number;
    generatedEnd: number;
    sourceUri: string;
    sourceStart: number;
    sourceEnd: number;
};

function assertOffset(offset: number, minimum: number, maximum: number): void {
    if (!Number.isInteger(offset) || offset < minimum || offset > maximum) {
        throw new RangeError('composite source offset out of range');
    }
}

function mergeSourceParts(parts: SourceFileSpan[]): SourceFileSpan[] {
    const merged: SourceFileSpan[] = [];
    for (const part of parts) {
        if (part.start === part.end) {
            continue;
        }
        const previous = merged[merged.length - 1];
        if (previous && previous.uri === part.uri && previous.end === part.start) {
            previous.end = part.end;
        } else {
            merged.push({ ...part });
        }
    }
    return merged;
}

export class CompositeSourceMap {
    readonly segments: readonly CompositeSourceSegment[];
    private readonly generatedLength: number;

    constructor(segments: readonly CompositeSourceSegment[]) {
        const sorted = segments.map(segment => ({ ...segment })).sort((left, right) =>
            left.generatedStart - right.generatedStart
            || left.generatedEnd - right.generatedEnd
            || left.sourceUri.localeCompare(right.sourceUri)
            || left.sourceStart - right.sourceStart
        );
        if (sorted.length === 0) {
            throw new RangeError('composite source map requires at least one segment');
        }
        if (sorted[0].generatedStart !== 0) {
            throw new RangeError('composite source segments must start at generated offset 0');
        }

        let expectedStart = 0;
        for (const segment of sorted) {
            const values = [
                segment.generatedStart,
                segment.generatedEnd,
                segment.sourceStart,
                segment.sourceEnd,
            ];
            if (!values.every(Number.isInteger)
                || segment.generatedStart < 0
                || segment.sourceStart < 0
                || segment.generatedEnd < segment.generatedStart
                || segment.sourceEnd < segment.sourceStart) {
                throw new RangeError('composite source segment contains an invalid range');
            }
            if (segment.generatedStart !== expectedStart) {
                throw new RangeError(segment.generatedStart < expectedStart
                    ? 'composite source segments overlap'
                    : 'composite source segments contain a gap');
            }
            if (segment.generatedEnd - segment.generatedStart
                !== segment.sourceEnd - segment.sourceStart) {
                throw new RangeError('composite source segments must preserve UTF-16 length');
            }
            if (segment.generatedStart === segment.generatedEnd && sorted.length !== 1) {
                throw new RangeError('zero-length segment is only valid for an empty source map');
            }
            expectedStart = segment.generatedEnd;
        }
        this.segments = sorted;
        this.generatedLength = expectedStart;
    }

    mapOffset(generatedOffset: number, bias: 'start' | 'end'): SourceFileSpan {
        assertOffset(generatedOffset, 0, this.generatedLength);
        if (bias !== 'start' && bias !== 'end') {
            throw new RangeError('composite source offset bias must be start or end');
        }
        if (this.generatedLength === 0) {
            const only = this.segments[0];
            return { uri: only.sourceUri, start: only.sourceStart, end: only.sourceStart };
        }

        let selected: CompositeSourceSegment | undefined;
        if (bias === 'start') {
            selected = this.segments.find(segment =>
                generatedOffset >= segment.generatedStart
                && generatedOffset < segment.generatedEnd
            );
            selected ??= this.segments[this.segments.length - 1];
        } else {
            for (let index = this.segments.length - 1; index >= 0; index--) {
                const segment = this.segments[index];
                if (generatedOffset > segment.generatedStart
                    && generatedOffset <= segment.generatedEnd) {
                    selected = segment;
                    break;
                }
            }
            selected ??= this.segments[0];
        }
        const offset = selected.sourceStart + generatedOffset - selected.generatedStart;
        return { uri: selected.sourceUri, start: offset, end: offset };
    }

    mapSpan(generatedStart: number, generatedEnd: number): SourceSpan {
        assertOffset(generatedStart, 0, this.generatedLength);
        assertOffset(generatedEnd, generatedStart, this.generatedLength);
        if (generatedStart === generatedEnd) {
            return this.mapOffset(generatedStart, 'start');
        }

        const parts = mergeSourceParts(this.segments.flatMap(segment => {
            const start = Math.max(generatedStart, segment.generatedStart);
            const end = Math.min(generatedEnd, segment.generatedEnd);
            if (start >= end) {
                return [];
            }
            return [{
                uri: segment.sourceUri,
                start: segment.sourceStart + start - segment.generatedStart,
                end: segment.sourceStart + end - segment.generatedStart,
            }];
        }));
        if (parts.length === 1) {
            return parts[0];
        }
        const primary = parts[0];
        return {
            uri: primary.uri,
            start: primary.start,
            end: primary.end,
            compositeParts: parts,
        };
    }
}

export type PreprocessResult = {
    text: string;
    sourceMap: CompositeSourceMap;
    sourceTexts: Readonly<Record<string, string>>;
    activeDefines: Record<string, string | true>;
    diagnostics: HdlDiagnostic[];
};

export type PreprocessMacroCandidate = {
    text: string;
    span: SourceFileSpan;
    generatedStart: number;
    generatedEnd: number;
};

export type PreprocessMetadata = {
    directives: readonly DirectiveModel[];
    includes: readonly IncludeModel[];
    macroCandidates: readonly PreprocessMacroCandidate[];
};

const emptyMetadata: PreprocessMetadata = Object.freeze({
    directives: Object.freeze([]),
    includes: Object.freeze([]),
    macroCandidates: Object.freeze([]),
});
const metadataByResult = new WeakMap<PreprocessResult, PreprocessMetadata>();

export function getPreprocessMetadataForWorker(result: PreprocessResult): PreprocessMetadata {
    return metadataByResult.get(result) ?? emptyMetadata;
}

type ConditionalFrame = {
    parentActive: boolean;
    branchActive: boolean;
    branchTaken: boolean;
    seenElse: boolean;
    openingSpan: SourceFileSpan;
};

type Directive = {
    name: string;
    argumentStart: number;
};

const conditionalDirectives = new Set(['ifdef', 'ifndef', 'elsif', 'else', 'endif']);
const handledDirectives = new Set([
    ...conditionalDirectives,
    'define',
    'undef',
    'include',
]);
const otherCompilerDirectives = new Set([
    'begin_keywords',
    'celldefine',
    'default_decay_time',
    'default_nettype',
    'default_trireg_strength',
    'delay_mode_distributed',
    'delay_mode_path',
    'delay_mode_unit',
    'delay_mode_zero',
    'end_keywords',
    'endcelldefine',
    'line',
    'nounconnected_drive',
    'pragma',
    'resetall',
    'timescale',
    'unconnected_drive',
    'undefineall',
]);

const directiveKinds: Readonly<Record<string, string>> = {
    begin_keywords: 'keywords_directive',
    celldefine: 'celldefine_compiler_directive',
    default_nettype: 'default_nettype_compiler_directive',
    define: 'text_macro_definition',
    else: 'conditional_compilation_directive',
    elsif: 'conditional_compilation_directive',
    end_keywords: 'endkeywords_directive',
    endcelldefine: 'endcelldefine_compiler_directive',
    endif: 'conditional_compilation_directive',
    ifdef: 'conditional_compilation_directive',
    ifndef: 'conditional_compilation_directive',
    include: 'include_compiler_directive',
    line: 'line_compiler_directive',
    nounconnected_drive: 'unconnected_drive_compiler_directive',
    pragma: 'pragma',
    resetall: 'resetall_compiler_directive',
    timescale: 'timescale_compiler_directive',
    unconnected_drive: 'unconnected_drive_compiler_directive',
    undef: 'undefine_compiler_directive',
    undefineall: 'undefineall_compiler_directive',
};

const newlineTerminatedDirectiveKinds = new Set([
    'default_nettype_compiler_directive',
    'line_compiler_directive',
    'text_macro_definition',
    'timescale_compiler_directive',
    'unconnected_drive_compiler_directive',
]);

class CompositeEmitter {
    readonly pieces: string[] = [];
    readonly segments: CompositeSourceSegment[] = [];
    generatedLength = 0;

    emit(text: string, sourceUri: string, sourceStart: number, sourceEnd: number): void {
        if (text.length !== sourceEnd - sourceStart) {
            throw new RangeError('emitted source slice must preserve UTF-16 length');
        }
        if (text.length === 0) {
            return;
        }
        this.pieces.push(text);
        const previous = this.segments[this.segments.length - 1];
        if (previous
            && previous.generatedEnd === this.generatedLength
            && previous.sourceUri === sourceUri
            && previous.sourceEnd === sourceStart) {
            previous.generatedEnd += text.length;
            previous.sourceEnd = sourceEnd;
        } else {
            this.segments.push({
                generatedStart: this.generatedLength,
                generatedEnd: this.generatedLength + text.length,
                sourceUri,
                sourceStart,
                sourceEnd,
            });
        }
        this.generatedLength += text.length;
    }
}

function canonicalizeUri(uri: string): string {
    try {
        const parsed = new URL(uri);
        const protocol = parsed.protocol.toLowerCase();
        const host = parsed.host.toLowerCase();
        let pathname = path.posix.normalize(parsed.pathname.split('\\').join('/'));
        if (protocol === 'file:') {
            pathname = pathname.toLowerCase();
        }
        return `${protocol}//${host}${pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return uri.split('\\').join('/');
    }
}

function includeKey(fromUri: string, rawPath: string): string {
    return `${canonicalizeUri(fromUri)}\0${rawPath}`;
}

function mask(text: string): string {
    return ' '.repeat(text.length);
}

function directiveAtLineStart(line: string): Directive | undefined {
    let offset = 0;
    while (offset < line.length && /[ \t\f]/.test(line[offset])) {
        offset++;
    }
    if (line[offset] !== '`') {
        return undefined;
    }
    const nameStart = offset + 1;
    let nameEnd = nameStart;
    while (nameEnd < line.length && /[A-Za-z0-9_$]/.test(line[nameEnd])) {
        nameEnd++;
    }
    if (nameEnd === nameStart) {
        return undefined;
    }
    const name = line.slice(nameStart, nameEnd);
    return handledDirectives.has(name) || otherCompilerDirectives.has(name)
        ? { name, argumentStart: nameEnd }
        : undefined;
}

function readIdentifier(line: string, start: number): { name?: string; end: number } {
    let offset = start;
    while (offset < line.length && /\s/.test(line[offset])) {
        offset++;
    }
    const nameStart = offset;
    if (!/[A-Za-z_$]/.test(line[offset] ?? '')) {
        return { end: offset };
    }
    offset++;
    while (offset < line.length && /[A-Za-z0-9_$]/.test(line[offset])) {
        offset++;
    }
    return { name: line.slice(nameStart, offset), end: offset };
}

function readIncludePath(line: string, start: number): string | undefined {
    let offset = start;
    while (offset < line.length && /\s/.test(line[offset])) {
        offset++;
    }
    const opener = line[offset];
    const closer = opener === '"' ? '"' : opener === '<' ? '>' : undefined;
    if (!closer) {
        return undefined;
    }
    const end = line.indexOf(closer, offset + 1);
    return end < 0 ? undefined : line.slice(offset + 1, end);
}

function lineSpan(uri: string, start: number, end: number): SourceFileSpan {
    return { uri, start, end };
}

function compareDiagnostics(left: HdlDiagnostic, right: HdlDiagnostic): number {
    return (left.span?.uri ?? '').localeCompare(right.span?.uri ?? '')
        || (left.span?.start ?? Number.MAX_SAFE_INTEGER)
            - (right.span?.start ?? Number.MAX_SAFE_INTEGER)
        || left.code.localeCompare(right.code)
        || left.message.localeCompare(right.message);
}

type ScannedMacroInvocation = {
    start: number;
    end: number;
};

function macroInvocationEnd(line: string, start: number): number {
    let offset = start + 1;
    while (offset < line.length && /[A-Za-z0-9_$]/.test(line[offset])) {
        offset++;
    }
    let argumentStart = offset;
    while (argumentStart < line.length && /[ \t\f]/.test(line[argumentStart])) {
        argumentStart++;
    }
    if (line[argumentStart] !== '(') {
        return offset;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = argumentStart; index < line.length; index++) {
        const char = line[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '(') {
            depth++;
        } else if (char === ')' && --depth === 0) {
            return index + 1;
        }
    }
    return line.length;
}

function scanMacroInvocations(line: string, initiallyInBlockComment: boolean): {
    invocations: ScannedMacroInvocation[];
    inBlockComment: boolean;
} {
    const invocations: ScannedMacroInvocation[] = [];
    let inBlockComment = initiallyInBlockComment;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const next = line[index + 1];
        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '/' && next === '/') {
            break;
        }
        if (char === '/' && next === '*') {
            inBlockComment = true;
            index++;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '`' && /[A-Za-z_$]/.test(next ?? '')) {
            invocations.push({ start: index, end: macroInvocationEnd(line, index) });
        }
    }
    return { invocations, inBlockComment };
}

export function preprocessForParsing(
    sourceUri: string,
    source: string,
    options: PreprocessOptions
): PreprocessResult {
    const emitter = new CompositeEmitter();
    const defines: Record<string, string | true> = { ...options.defines };
    const diagnostics: HdlDiagnostic[] = [];
    const directives: DirectiveModel[] = [];
    const includes: IncludeModel[] = [];
    const macroCandidates: PreprocessMacroCandidate[] = [];
    const sourceTexts: Record<string, string> = { [sourceUri]: source };
    const maximumDepth = options.maxIncludeDepth ?? 32;
    if (!Number.isInteger(maximumDepth) || maximumDepth < 0) {
        throw new RangeError('maxIncludeDepth must be a non-negative integer');
    }

    const includeIndex = new Map<string, ResolvedIncludeInput>();
    const sortedIncludes = [...(options.resolvedIncludes ?? [])].sort((left, right) =>
        includeKey(left.fromUri, left.rawPath).localeCompare(includeKey(right.fromUri, right.rawPath))
        || canonicalizeUri(left.resolvedUri).localeCompare(canonicalizeUri(right.resolvedUri))
        || left.resolvedUri.localeCompare(right.resolvedUri)
        || left.text.localeCompare(right.text)
    );
    for (const include of sortedIncludes) {
        const key = includeKey(include.fromUri, include.rawPath);
        if (!includeIndex.has(key)) {
            includeIndex.set(key, include);
        }
    }

    const addDiagnostic = (
        severity: HdlDiagnostic['severity'],
        code: string,
        message: string,
        span: SourceFileSpan
    ): void => {
        diagnostics.push({ severity, code, message, span });
    };

    const processFile = (
        uri: string,
        text: string,
        depth: number,
        canonicalStack: readonly string[]
    ): void => {
        sourceTexts[uri] = text;
        const frames: ConditionalFrame[] = [];
        let offset = 0;
        let inBlockComment = false;
        const isActive = (): boolean => frames.length === 0
            ? true
            : frames[frames.length - 1].branchActive;

        while (offset < text.length) {
            let contentEnd = offset;
            while (contentEnd < text.length
                && text[contentEnd] !== '\r'
                && text[contentEnd] !== '\n') {
                contentEnd++;
            }
            let newlineEnd = contentEnd;
            if (text[newlineEnd] === '\r') {
                newlineEnd++;
                if (text[newlineEnd] === '\n') {
                    newlineEnd++;
                }
            } else if (text[newlineEnd] === '\n') {
                newlineEnd++;
            }

            const line = text.slice(offset, contentEnd);
            const directive = inBlockComment ? undefined : directiveAtLineStart(line);
            const span = lineSpan(uri, offset, contentEnd);
            let included = false;

            if (directive) {
                const activeBeforeDirective = isActive();
                const enclosingFrame = frames[frames.length - 1];
                const active = directive.name === 'elsif'
                    || directive.name === 'else'
                    || directive.name === 'endif'
                    ? enclosingFrame?.parentActive ?? activeBeforeDirective
                    : activeBeforeDirective;
                const kind = directiveKinds[directive.name]
                    ?? `${directive.name}_compiler_directive`;
                const directiveEnd = newlineTerminatedDirectiveKinds.has(kind)
                    ? newlineEnd
                    : contentEnd;
                directives.push({
                    kind,
                    text: text.slice(offset, directiveEnd),
                    span: lineSpan(uri, offset, directiveEnd),
                    active,
                });
                const includePath = directive.name === 'include'
                    ? readIncludePath(line, directive.argumentStart)
                    : undefined;
                const includeModel: IncludeModel | undefined = directive.name === 'include'
                    ? { path: includePath ?? '', span }
                    : undefined;
                if (includeModel && active) {
                    includes.push(includeModel);
                }
                const identifier = readIdentifier(line, directive.argumentStart);
                switch (directive.name) {
                    case 'ifdef':
                    case 'ifndef': {
                        if (!identifier.name) {
                            addDiagnostic(
                                'error',
                                'HDL_PP_INVALID_CONDITION',
                                `\`${directive.name} requires a macro name`,
                                span
                            );
                        }
                        const parentActive = isActive();
                        const defined = identifier.name !== undefined
                            && Object.prototype.hasOwnProperty.call(defines, identifier.name);
                        const condition = directive.name === 'ifdef' ? defined : !defined;
                        frames.push({
                            parentActive,
                            branchActive: parentActive && condition,
                            branchTaken: condition,
                            seenElse: false,
                            openingSpan: span,
                        });
                        break;
                    }
                    case 'elsif': {
                        const frame = frames[frames.length - 1];
                        if (!frame) {
                            addDiagnostic(
                                'error', 'HDL_PP_UNMATCHED_ELSIF',
                                '`elsif has no matching conditional', span
                            );
                        } else if (frame.seenElse) {
                            frame.branchActive = false;
                            addDiagnostic(
                                'error', 'HDL_PP_ELSIF_AFTER_ELSE',
                                '`elsif cannot follow `else', span
                            );
                        } else {
                            if (!identifier.name) {
                                addDiagnostic(
                                    'error', 'HDL_PP_INVALID_CONDITION',
                                    '`elsif requires a macro name', span
                                );
                            }
                            const condition = identifier.name !== undefined
                                && Object.prototype.hasOwnProperty.call(defines, identifier.name);
                            frame.branchActive = frame.parentActive
                                && !frame.branchTaken
                                && condition;
                            frame.branchTaken ||= condition;
                        }
                        break;
                    }
                    case 'else': {
                        const frame = frames[frames.length - 1];
                        if (!frame) {
                            addDiagnostic(
                                'error', 'HDL_PP_UNMATCHED_ELSE',
                                '`else has no matching conditional', span
                            );
                        } else if (frame.seenElse) {
                            frame.branchActive = false;
                            addDiagnostic(
                                'error', 'HDL_PP_DUPLICATE_ELSE',
                                'conditional contains more than one `else', span
                            );
                        } else {
                            frame.seenElse = true;
                            frame.branchActive = frame.parentActive && !frame.branchTaken;
                            frame.branchTaken = true;
                        }
                        break;
                    }
                    case 'endif':
                        if (frames.length === 0) {
                            addDiagnostic(
                                'error', 'HDL_PP_UNMATCHED_ENDIF',
                                '`endif has no matching conditional', span
                            );
                        } else {
                            frames.pop();
                        }
                        break;
                    case 'define':
                        if (isActive()) {
                            if (!identifier.name) {
                                addDiagnostic(
                                    'error', 'HDL_PP_INVALID_DEFINE',
                                    '`define requires a macro name', span
                                );
                            } else if (line[identifier.end] === '(') {
                                defines[identifier.name] = true;
                            } else {
                                const value = line.slice(identifier.end).trim();
                                defines[identifier.name] = value.length === 0 ? true : value;
                            }
                        }
                        break;
                    case 'undef':
                        if (isActive() && identifier.name) {
                            delete defines[identifier.name];
                        } else if (isActive()) {
                            addDiagnostic(
                                'error', 'HDL_PP_INVALID_UNDEF',
                                '`undef requires a macro name', span
                            );
                        }
                        break;
                    case 'undefineall':
                        if (isActive()) {
                            for (const name of Object.keys(defines)) {
                                delete defines[name];
                            }
                        }
                        break;
                    case 'include':
                        if (isActive()) {
                            const rawPath = includePath;
                            if (!rawPath) {
                                addDiagnostic(
                                    'error', 'HDL_INCLUDE_INVALID',
                                    '`include requires a quoted or angle-bracket path', span
                                );
                            } else {
                                const resolved = includeIndex.get(includeKey(uri, rawPath));
                                if (!resolved) {
                                    addDiagnostic(
                                        'warning', 'HDL_INCLUDE_UNRESOLVED',
                                        `Unable to resolve include "${rawPath}" from ${uri}`, span
                                    );
                                } else {
                                    includeModel!.resolvedUri = resolved.resolvedUri;
                                    sourceTexts[resolved.resolvedUri] = resolved.text;
                                    const canonicalResolved = canonicalizeUri(resolved.resolvedUri);
                                    if (canonicalStack.includes(canonicalResolved)) {
                                        addDiagnostic(
                                            'error', 'HDL_INCLUDE_CYCLE',
                                            `Include cycle detected for ${resolved.resolvedUri}`, span
                                        );
                                    } else if (depth >= maximumDepth) {
                                        addDiagnostic(
                                            'error', 'HDL_INCLUDE_DEPTH',
                                            `Include depth exceeds maximum ${maximumDepth}`, span
                                        );
                                    } else {
                                        processFile(
                                            resolved.resolvedUri,
                                            resolved.text,
                                            depth + 1,
                                            [...canonicalStack, canonicalResolved]
                                        );
                                        included = true;
                                    }
                                }
                            }
                        }
                        break;
                }
                if (!included) {
                    emitter.emit(mask(line), uri, offset, contentEnd);
                }
            } else {
                const active = isActive();
                if (active) {
                    const scan = scanMacroInvocations(line, inBlockComment);
                    inBlockComment = scan.inBlockComment;
                    const generatedLineStart = emitter.generatedLength;
                    emitter.emit(line, uri, offset, contentEnd);
                    for (const invocation of scan.invocations) {
                        macroCandidates.push({
                            text: line.slice(invocation.start, invocation.end),
                            span: lineSpan(
                                uri,
                                offset + invocation.start,
                                offset + invocation.end
                            ),
                            generatedStart: generatedLineStart + invocation.start,
                            generatedEnd: generatedLineStart + invocation.end,
                        });
                    }
                } else {
                    emitter.emit(mask(line), uri, offset, contentEnd);
                }
            }
            emitter.emit(text.slice(contentEnd, newlineEnd), uri, contentEnd, newlineEnd);
            offset = newlineEnd;
        }

        for (const frame of frames) {
            addDiagnostic(
                'error', 'HDL_PP_UNTERMINATED_CONDITIONAL',
                'Conditional directive is not closed by `endif', frame.openingSpan
            );
        }
    };

    processFile(sourceUri, source, 0, [canonicalizeUri(sourceUri)]);
    const text = emitter.pieces.join('');
    const segments = emitter.segments.length > 0
        ? emitter.segments
        : [{
            generatedStart: 0,
            generatedEnd: 0,
            sourceUri,
            sourceStart: 0,
            sourceEnd: 0,
        }];
    diagnostics.sort(compareDiagnostics);
    const result: PreprocessResult = {
        text,
        sourceMap: new CompositeSourceMap(segments),
        sourceTexts,
        activeDefines: defines,
        diagnostics,
    };
    metadataByResult.set(result, { directives, includes, macroCandidates });
    return result;
}
