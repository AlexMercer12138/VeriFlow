(function exposeWaveformTransport(root, factory) {
    const api = { createWaveformTransport: factory };
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root && typeof root.document === 'object') {
        root.waveformTransport = factory(root);
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWaveformTransport(environment) {
    'use strict';

    const listeners = new Set();
    const pending = [];
    let kind = 'memory';
    let sendToHost = message => pending.push(message);
    let getState = () => null;
    let setState = () => undefined;
    let removeHostListener = () => undefined;

    function dispatch(message, mirrorToWindow = true) {
        listeners.forEach(listener => listener(message));
        if (
            mirrorToWindow
            && typeof environment.dispatchEvent === 'function'
            && typeof environment.MessageEvent === 'function'
        ) {
            environment.dispatchEvent(new environment.MessageEvent('message', { data: message }));
        }
    }

    const memory = environment.__waveformMemoryTransport;
    if (memory && typeof memory.send === 'function') {
        kind = 'memory';
        sendToHost = message => memory.send(message);
        if (typeof memory.onMessage === 'function') {
            removeHostListener = memory.onMessage(message => dispatch(message));
        }
    } else if (typeof environment.acquireVsCodeApi === 'function') {
        kind = 'vscode';
        const vscode = environment.acquireVsCodeApi();
        sendToHost = message => vscode.postMessage(message);
        getState = () => vscode.getState?.() ?? null;
        setState = value => vscode.setState?.(value);
        environment.addEventListener?.('message', event => dispatch(event.data, false));
    } else if (environment.qt && typeof environment.QWebChannel === 'function') {
        kind = 'qt';
        new environment.QWebChannel(environment.qt.webChannelTransport, channel => {
            const bridge = channel.objects.waveformBridge;
            bridge.message.connect(payload => {
                try {
                    dispatch(JSON.parse(payload));
                } catch (error) {
                    dispatch({ type: 'bridgeError', message: String(error) });
                }
            });
            sendToHost = message => bridge.send(JSON.stringify(message));
            pending.splice(0).forEach(sendToHost);
        });
    }

    return {
        kind,
        send(message) {
            sendToHost(message);
        },
        onMessage(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getState() {
            return getState();
        },
        setState(value) {
            setState(value);
        },
        dispose() {
            removeHostListener?.();
            listeners.clear();
            pending.length = 0;
        },
        dispatch,
    };
});
