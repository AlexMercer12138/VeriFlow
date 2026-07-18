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
        const signalIndex = signals.indexOf(signal);
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

    return {
        LAYOUT_VERSION,
        validateLayout,
        describeSignal,
        matchSignalDescriptors,
        parseTimescale,
        formatTicks,
        measureCursors,
    };
});
