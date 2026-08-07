(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.VeriflowWaveCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const LAYOUT_VERSION = 1;
    const TIME_UNITS = [
        { unit: 'fs', seconds: 1e-15 },
        { unit: 'ps', seconds: 1e-12 },
        { unit: 'ns', seconds: 1e-9 },
        { unit: 'us', seconds: 1e-6 },
        { unit: 'ms', seconds: 1e-3 },
        { unit: 's', seconds: 1 },
    ];
    const FREQUENCY_UNITS = [
        { unit: 'Hz', factor: 1 },
        { unit: 'kHz', factor: 1e3 },
        { unit: 'MHz', factor: 1e6 },
        { unit: 'GHz', factor: 1e9 },
        { unit: 'THz', factor: 1e12 },
    ];

    function base64Bytes(value) {
        const text = String(value || '');
        if (typeof Buffer !== 'undefined') {
            return Uint8Array.from(Buffer.from(text, 'base64'));
        }
        const binary = atob(text);
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }

    function unpackLogicValue(bytes, width) {
        const targetWidth = Number(width);
        const stride = Math.ceil(targetWidth * 2 / 8);
        if (!Number.isInteger(targetWidth) || targetWidth <= 0 || bytes.length !== stride) {
            throw new Error('packed waveform value has an invalid size');
        }
        const symbols = '01xz';
        const slots = stride * 4;
        let value = '';
        for (let index = 0; index < targetWidth; index++) {
            const shift = (slots - index - 1) * 2;
            const byteIndex = Math.floor((stride * 8 - shift - 2) / 8);
            value += symbols[(bytes[byteIndex] >> (shift % 8)) & 3];
        }
        return value;
    }

    function decodeValues(encoded, width, stride, count) {
        const bytes = base64Bytes(encoded);
        const valueStride = Number(stride);
        if (!Number.isInteger(valueStride) || valueStride <= 0 || bytes.length !== count * valueStride) {
            throw new Error('packed waveform payload has an invalid length');
        }
        return Array.from({ length: count }, (_unused, index) => unpackLogicValue(
            bytes.slice(index * valueStride, (index + 1) * valueStride),
            width
        ));
    }

    function decodeWindowPayload(payload) {
        if (!payload || (payload.kind !== 'raw' && payload.kind !== 'summary')) {
            throw new Error('unsupported waveform window payload');
        }
        const width = Number(payload.width);
        if (payload.kind === 'raw') {
            const times = Array.isArray(payload.times) ? payload.times.map(Number) : [];
            const values = decodeValues(payload.values, width, payload.valueStride, times.length);
            return {
                kind: 'raw',
                width,
                changes: times.map((time, index) => ({ time, value: values[index] })),
            };
        }
        const firstTimes = Array.isArray(payload.firstTimes) ? payload.firstTimes.map(Number) : [];
        const lastTimes = Array.isArray(payload.lastTimes) ? payload.lastTimes.map(Number) : [];
        const flags = Array.isArray(payload.flags) ? payload.flags.map(Number) : [];
        if (lastTimes.length !== firstTimes.length || flags.length !== firstTimes.length) {
            throw new Error('waveform summary payload arrays do not match');
        }
        const firstValues = decodeValues(
            payload.firstValues,
            width,
            payload.valueStride,
            firstTimes.length
        );
        const lastValues = decodeValues(
            payload.lastValues,
            width,
            payload.valueStride,
            firstTimes.length
        );
        return {
            kind: 'summary',
            width,
            records: firstTimes.map((firstTime, index) => ({
                firstTime,
                lastTime: lastTimes[index],
                firstValue: firstValues[index],
                lastValue: lastValues[index],
                flags: flags[index],
            })),
        };
    }

    function calculateVirtualWindow(totalRows, viewportHeight, scrollTop, rowHeight, overscan) {
        const rows = Math.max(0, Math.trunc(Number(totalRows) || 0));
        const height = Math.max(0, Number(viewportHeight) || 0);
        const itemHeight = Math.max(1, Number(rowHeight) || 1);
        const extraRows = Math.max(0, Math.trunc(Number(overscan) || 0));
        const totalHeight = rows * itemHeight;
        const maxScrollTop = Math.max(0, totalHeight - height);
        const offset = Math.max(0, Math.min(Number(scrollTop) || 0, maxScrollTop));
        const visibleStart = Math.max(
            0,
            Math.min(Math.floor(offset / itemHeight), rows)
        );
        const visibleEnd = height === 0
            ? visibleStart
            : Math.min(rows, Math.ceil((offset + height) / itemHeight));
        const firstRow = Math.max(0, visibleStart - extraRows);
        const endRow = Math.min(
            rows,
            visibleEnd + extraRows
        );
        const renderedCount = Math.max(0, endRow - firstRow);
        return { firstRow, renderedCount, totalHeight, overflow: totalHeight > height };
    }

    function signalMatchesSelectedScope(signalScope, selectedScope) {
        return selectedScope === '' || signalScope === selectedScope;
    }

    class WindowCache {
        constructor(capacity = 128) {
            this.capacity = Math.max(1, Math.trunc(Number(capacity) || 1));
            this.entries = new Map();
        }

        get size() {
            return this.entries.size;
        }

        has(key) {
            return this.entries.has(key);
        }

        get(key) {
            if (!this.entries.has(key)) return undefined;
            const value = this.entries.get(key);
            this.entries.delete(key);
            this.entries.set(key, value);
            return value;
        }

        set(key, value) {
            this.entries.delete(key);
            this.entries.set(key, value);
            while (this.entries.size > this.capacity) {
                this.entries.delete(this.entries.keys().next().value);
            }
        }

        clear() {
            this.entries.clear();
        }
    }

    function finiteNumber(value) {
        try {
            const normalized = Number(value);
            return Number.isFinite(normalized) ? normalized : null;
        } catch (_error) {
            return null;
        }
    }

    function normalizeWindowDescriptor(value) {
        if (!value || typeof value !== 'object') return null;
        const generation = finiteNumber(value.generation);
        const start = finiteNumber(value.start);
        const end = finiteNumber(value.end);
        const ticksPerPixel = finiteNumber(value.ticksPerPixel);
        if (generation === null || start === null || end === null || ticksPerPixel === null
            || start > end || ticksPerPixel <= 0) {
            return null;
        }
        let reference;
        try {
            reference = String(value.reference || '');
        } catch (_error) {
            return null;
        }
        return { generation, reference, start, end, ticksPerPixel, series: value.series };
    }

    function windowCacheKey(entry) {
        return JSON.stringify([
            entry.generation,
            entry.reference,
            entry.start,
            entry.end,
            entry.ticksPerPixel,
        ]);
    }

    class WaveWindowCache {
        constructor(capacity = 128) {
            this.capacity = Math.max(1, Math.trunc(Number(capacity) || 1));
            this.entries = new Map();
        }

        get size() {
            return this.entries.size;
        }

        set(entry) {
            const normalized = normalizeWindowDescriptor(entry);
            if (!normalized) throw new TypeError('invalid waveform window entry');
            const key = windowCacheKey(normalized);
            this.entries.delete(key);
            this.entries.set(key, normalized);
            while (this.entries.size > this.capacity) {
                this.entries.delete(this.entries.keys().next().value);
            }
        }

        find(query) {
            const normalized = normalizeWindowDescriptor(query);
            if (!normalized) return undefined;
            const candidates = Array.from(this.entries.entries()).reverse();
            for (const [key, entry] of candidates) {
                if (entry.generation !== normalized.generation) continue;
                if (entry.reference !== normalized.reference) continue;
                if (entry.start > normalized.start || entry.end < normalized.end) continue;
                if (entry.series?.kind === 'summary' && entry.ticksPerPixel > normalized.ticksPerPixel) continue;
                this.entries.delete(key);
                this.entries.set(key, entry);
                return entry;
            }
            return undefined;
        }

        clear() {
            this.entries.clear();
        }
    }

    function effectiveWindowTicksPerPixel(descriptor, responsePixelWidth) {
        if (!descriptor || typeof descriptor !== 'object') {
            throw new TypeError('invalid waveform window descriptor');
        }
        const start = finiteNumber(descriptor.start);
        const end = finiteNumber(descriptor.end);
        const fallback = finiteNumber(descriptor.ticksPerPixel);
        const requestedPixelWidth = finiteNumber(descriptor.pixelWidth);
        if (start === null || end === null || fallback === null || requestedPixelWidth === null
            || start > end || fallback <= 0 || !Number.isInteger(requestedPixelWidth)
            || requestedPixelWidth <= 0) {
            throw new TypeError('invalid waveform window descriptor');
        }
        const pixelWidth = finiteNumber(responsePixelWidth);
        const span = end - start;
        if (!Number.isFinite(span)) {
            throw new TypeError('invalid waveform window descriptor');
        }
        const conservativeFallback = span > 0
            ? Math.max(fallback, span / requestedPixelWidth)
            : fallback;
        if (pixelWidth === null || !Number.isInteger(pixelWidth) || pixelWidth <= 0
            || pixelWidth > requestedPixelWidth || span <= 0) {
            return conservativeFallback;
        }
        const effective = span / pixelWidth;
        return Number.isFinite(effective) && effective > 0
            ? effective
            : fallback;
    }

    function matchPendingRequest(requestId, pending) {
        if (!pending || typeof pending !== 'object') return null;
        for (const [kind, request] of Object.entries(pending)) {
            if (request && request.requestId === requestId) {
                return { kind, pending: request };
            }
        }
        return null;
    }

    class BoundedRequestRetry {
        constructor(maxRetries = 1) {
            this.maxRetries = Math.max(0, Math.trunc(Number(maxRetries) || 0));
            this.exhausted = new Map();
        }

        canStart(kind, key) {
            const exhaustedKey = this.exhausted.get(kind);
            if (exhaustedKey === undefined) return true;
            if (exhaustedKey === key) return false;
            this.exhausted.delete(kind);
            return true;
        }

        recordFailure(kind, key, retryCount) {
            if (Math.max(0, Math.trunc(Number(retryCount) || 0)) < this.maxRetries) return true;
            this.exhausted.set(kind, key);
            return false;
        }

        recordSuccess(kind, key) {
            if (this.exhausted.get(kind) === key) this.exhausted.delete(kind);
        }

        clear() {
            this.exhausted.clear();
        }
    }

    function normalizeRange(value) {
        if (!value || typeof value !== 'object') return null;
        const start = finiteNumber(value.start);
        const end = finiteNumber(value.end);
        if (start === null || end === null || start > end) return null;
        return { start, end };
    }

    function windowNeedsRefresh(entry, viewport, threshold = 0.25, bounds) {
        const windowRange = normalizeRange(entry);
        const viewportRange = normalizeRange(viewport);
        if (!windowRange || !viewportRange) return true;
        const span = viewportRange.end - viewportRange.start;
        if (!Number.isFinite(span)) return true;
        // Invalid thresholds use the default margin; negative thresholds disable it.
        const normalizedThreshold = finiteNumber(threshold);
        const margin = span * Math.max(0, normalizedThreshold === null ? 0.25 : normalizedThreshold);
        if (!Number.isFinite(margin)) return true;
        let minimum = -Infinity;
        let maximum = Infinity;
        if (bounds !== undefined) {
            const rangeBounds = normalizeRange(bounds);
            if (!rangeBounds || viewportRange.start < rangeBounds.start || viewportRange.end > rangeBounds.end) {
                return true;
            }
            minimum = rangeBounds.start;
            maximum = rangeBounds.end;
        }
        const requiredStart = Math.max(minimum, viewportRange.start - margin);
        const requiredEnd = Math.min(maximum, viewportRange.end + margin);
        return windowRange.start > requiredStart || windowRange.end < requiredEnd;
    }

    class FrameScheduler {
        constructor(requestFrame) {
            this.requestFrame = requestFrame;
            this.pending = false;
            this.callback = null;
            this.token = 0;
        }

        schedule(callback) {
            this.callback = callback;
            if (this.pending) return;
            this.pending = true;
            const token = this.token;
            try {
                this.requestFrame(() => {
                    if (token !== this.token) return;
                    this.pending = false;
                    const next = this.callback;
                    this.callback = null;
                    if (next) next();
                });
            } catch (error) {
                if (token === this.token) {
                    this.pending = false;
                    this.callback = null;
                }
                throw error;
            }
        }

        cancel() {
            this.token += 1;
            this.pending = false;
            this.callback = null;
        }
    }

    class RequestTracker {
        constructor() {
            this.generation = 0;
            this.counter = 0;
            this.cancelled = new Set();
        }

        setGeneration(generation) {
            this.generation = Number(generation) || 0;
            this.counter = 0;
            this.cancelled.clear();
        }

        next(kind) {
            this.counter += 1;
            return this.generation + ':' + String(kind || 'request') + ':' + this.counter;
        }

        cancel(requestId) {
            this.cancelled.add(String(requestId));
        }

        accepts(message) {
            return !!message
                && Number(message.generation) === this.generation
                && (!message.requestId || !this.cancelled.has(String(message.requestId)));
        }
    }

    function prefetchRange(start, end, minimum, maximum) {
        const low = Math.min(Number(start), Number(end));
        const high = Math.max(Number(start), Number(end));
        const margin = Math.max(0, high - low) / 2;
        return {
            start: Math.max(Number(minimum), low - margin),
            end: Math.min(Number(maximum), high + margin),
        };
    }

    function validateLayout(value) {
        if (!value || value.version !== LAYOUT_VERSION || !Array.isArray(value.rows)) {
            return null;
        }
        const view = value.view && typeof value.view === 'object' ? value.view : {};
        const cursors = value.cursors && typeof value.cursors === 'object' ? value.cursors : {};
        return {
            version: LAYOUT_VERSION,
            rows: value.rows.filter(row => row && typeof row === 'object'),
            view,
            cursors,
        };
    }

    function sameSignal(left, right) {
        return left.fullName === right.fullName
            && left.reference === right.reference
            && Number(left.width) === Number(right.width);
    }

    function describeSignal(signal, signals) {
        const signalIndex = signals.findIndex(item => item === signal
            || (signal.key !== undefined && item.key === signal.key));
        const occurrence = signals
            .slice(0, Math.max(0, signalIndex))
            .filter(item => sameSignal(item, signal))
            .length;
        return {
            fullName: signal.fullName,
            reference: signal.reference,
            width: Number(signal.width),
            occurrence,
        };
    }

    function matchSignalDescriptors(descriptors, signals) {
        const used = new Set();
        return descriptors.map(descriptor => {
            let occurrence = -1;
            for (let index = 0; index < signals.length; index++) {
                if (!sameSignal(descriptor, signals[index])) continue;
                occurrence++;
                if (occurrence === Number(descriptor.occurrence || 0) && !used.has(index)) {
                    used.add(index);
                    return index;
                }
            }
            return null;
        });
    }

    function parseTimescale(value) {
        const match = String(value || '').trim().match(/^(?:(\d+(?:\.\d+)?)\s*)?(fs|ps|ns|us|ms|s)$/i);
        if (!match) return null;
        const multiplier = Number(match[1] || 1);
        const unit = match[2].toLowerCase();
        const definition = TIME_UNITS.find(item => item.unit === unit);
        if (!definition || !Number.isFinite(multiplier) || multiplier <= 0) return null;
        return {
            multiplier,
            unit,
            secondsPerTick: multiplier * definition.seconds,
        };
    }

    function formatNumber(value) {
        if (!Number.isFinite(value)) return '-';
        const abs = Math.abs(value);
        if (abs >= 100) return value.toFixed(0);
        if (abs >= 10) return value.toFixed(1).replace(/\.0$/, '');
        if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/, '');
        return value.toPrecision(3).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
    }

    function compactDuration(ticks, timescale) {
        const parsed = parseTimescale(timescale);
        if (!parsed) return null;
        let unitIndex = TIME_UNITS.findIndex(item => item.unit === parsed.unit);
        let value = ticks * parsed.multiplier;
        while (Math.abs(value) >= 1000 && unitIndex < TIME_UNITS.length - 1) {
            value /= 1000;
            unitIndex++;
        }
        return { value, unit: TIME_UNITS[unitIndex].unit };
    }

    function formatTicks(ticks, timescale) {
        const duration = compactDuration(ticks, timescale);
        if (!duration) return formatNumber(ticks) + ' ticks';
        return formatNumber(duration.value) + ' ' + duration.unit;
    }

    function formatFrequency(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return '-';
        const frequency = 1 / seconds;
        let definition = FREQUENCY_UNITS[0];
        for (const candidate of FREQUENCY_UNITS) {
            if (frequency >= candidate.factor) definition = candidate;
        }
        return formatNumber(frequency / definition.factor) + ' ' + definition.unit;
    }

    function measureCursors(cursorA, cursorB, timescale) {
        if (cursorB === null || cursorB === undefined || !Number.isFinite(cursorB)) {
            return { deltaTicks: null, deltaText: '-', frequencyText: '-' };
        }
        const deltaTicks = Math.abs(cursorB - cursorA);
        const parsed = parseTimescale(timescale);
        return {
            deltaTicks,
            deltaText: formatTicks(deltaTicks, timescale),
            frequencyText: deltaTicks > 0 && parsed
                ? formatFrequency(deltaTicks * parsed.secondsPerTick)
                : '-',
        };
    }

    function parseSearchValue(text, width) {
        const targetWidth = Number(width);
        if (!Number.isInteger(targetWidth) || targetWidth <= 0) {
            return { ok: false, error: 'invalid-width' };
        }
        const cleaned = String(text || '').toLowerCase().replace(/[\s_]+/g, '');
        let digits = '';
        let radix = 10;
        if (/^(?:0b|b)[01]+$/.test(cleaned)) {
            digits = cleaned.replace(/^(?:0b|b)/, '');
            radix = 2;
        } else if (/^(?:0x|h)[0-9a-f]+$/.test(cleaned)) {
            digits = cleaned.replace(/^(?:0x|h)/, '');
            radix = 16;
        } else if (/^\d+$/.test(cleaned)) {
            digits = cleaned;
        } else {
            return { ok: false, error: 'invalid-format' };
        }

        let numeric;
        try {
            numeric = radix === 16
                ? BigInt('0x' + digits)
                : radix === 2
                    ? BigInt('0b' + digits)
                    : BigInt(digits);
        } catch (_error) {
            return { ok: false, error: 'invalid-format' };
        }
        const limit = 1n << BigInt(targetWidth);
        if (numeric < 0n || numeric >= limit) {
            return { ok: false, error: 'value-overflow' };
        }
        return {
            ok: true,
            bits: numeric.toString(2).padStart(targetWidth, '0'),
        };
    }

    function normalizeChangeBits(value) {
        return String(value ?? '')
            .toLowerCase()
            .replace(/^b/, '')
            .replace(/[\s_]+/g, '');
    }

    function targetValue(target, value) {
        const bits = normalizeChangeBits(value);
        if (!Number.isInteger(target.bitIndex)) return bits;
        if (!bits) return 'x';
        if (bits.length === 1) return bits;
        const bitIndex = Number(target.bitIndex);
        if (bitIndex < 0) return 'x';
        if (bitIndex >= bits.length) return '0';
        return bits[bits.length - 1 - bitIndex] || 'x';
    }

    function isScalarTarget(target) {
        return Number(target.width) === 1 || Number.isInteger(target.bitIndex);
    }

    function candidateForTarget(target, cursorTime, direction, mode, queryBits) {
        const changes = Array.isArray(target.changes) ? target.changes : [];
        const indices = direction > 0
            ? Array.from({ length: changes.length }, (_unused, index) => index)
            : Array.from({ length: changes.length }, (_unused, index) => changes.length - 1 - index);

        for (const index of indices) {
            const change = changes[index];
            if (direction > 0 ? change.time <= cursorTime : change.time >= cursorTime) continue;
            const current = targetValue(target, change.value);
            let matches = false;
            if (mode === 'change') {
                matches = true;
            } else if (mode === 'xz') {
                matches = /[xz]/i.test(current);
            } else if (mode === 'value') {
                matches = current === queryBits;
            } else if ((mode === 'rising' || mode === 'falling') && index > 0) {
                const previous = targetValue(target, changes[index - 1].value);
                matches = mode === 'rising'
                    ? previous === '0' && current === '1'
                    : previous === '1' && current === '0';
            }
            if (matches) {
                return {
                    time: change.time,
                    target,
                    value: current,
                };
            }
        }
        return null;
    }

    function findSearchMatch(targets, cursorTime, direction, mode, query) {
        if (!Array.isArray(targets) || !targets.length) {
            return { match: null, error: 'no-targets' };
        }
        const normalizedDirection = direction < 0 ? -1 : 1;
        const validModes = new Set(['change', 'rising', 'falling', 'value', 'xz']);
        if (!validModes.has(mode)) {
            return { match: null, error: 'invalid-mode' };
        }

        let applicable = targets;
        if (mode === 'rising' || mode === 'falling') {
            applicable = targets.filter(isScalarTarget);
            if (!applicable.length) {
                return { match: null, error: 'edge-needs-scalar' };
            }
        }

        let validValueTarget = mode !== 'value';
        const candidates = [];
        for (const target of applicable) {
            let queryBits = '';
            if (mode === 'value') {
                const width = Number.isInteger(target.bitIndex) ? 1 : Number(target.width);
                const parsed = parseSearchValue(query, width);
                if (!parsed.ok) {
                    if (parsed.error === 'invalid-format') {
                        return { match: null, error: 'invalid-value' };
                    }
                    continue;
                }
                validValueTarget = true;
                queryBits = parsed.bits;
            }
            const candidate = candidateForTarget(
                target,
                cursorTime,
                normalizedDirection,
                mode,
                queryBits
            );
            if (candidate) candidates.push(candidate);
        }
        if (!validValueTarget) {
            return { match: null, error: 'invalid-value' };
        }
        if (!candidates.length) {
            return { match: null, error: 'no-match' };
        }

        candidates.sort((left, right) => {
            const timeOrder = normalizedDirection > 0
                ? left.time - right.time
                : right.time - left.time;
            if (timeOrder !== 0) return timeOrder;
            return Number(left.target.order || 0) - Number(right.target.order || 0);
        });
        const best = candidates[0];
        return {
            match: best,
            time: best.time,
            target: best.target,
            value: best.value,
        };
    }

    return {
        LAYOUT_VERSION,
        calculateVirtualWindow,
        signalMatchesSelectedScope,
        WindowCache,
        WaveWindowCache,
        effectiveWindowTicksPerPixel,
        matchPendingRequest,
        BoundedRequestRetry,
        windowNeedsRefresh,
        FrameScheduler,
        RequestTracker,
        decodeWindowPayload,
        prefetchRange,
        validateLayout,
        describeSignal,
        matchSignalDescriptors,
        parseTimescale,
        formatTicks,
        measureCursors,
        parseSearchValue,
        findSearchMatch,
    };
});
