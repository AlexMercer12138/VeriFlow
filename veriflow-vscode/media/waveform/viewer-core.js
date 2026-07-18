(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.VeriflowWaveCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const LAYOUT_VERSION = 1;

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

    return {
        LAYOUT_VERSION,
        validateLayout,
        describeSignal,
        matchSignalDescriptors,
    };
});
