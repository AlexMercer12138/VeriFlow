(function installWaveformTransport(global) {
    const listeners = new Set();
    const pending = [];
    let sendToHost = message => pending.push(message);

    function dispatch(message) {
        listeners.forEach(listener => listener(message));
        global.dispatchEvent(new MessageEvent('message', { data: message }));
    }

    function connectQWebChannel() {
        if (!global.qt || typeof global.QWebChannel !== 'function') return false;
        new global.QWebChannel(global.qt.webChannelTransport, channel => {
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
        return true;
    }

    if (typeof global.acquireVsCodeApi === 'function') {
        const vscode = global.acquireVsCodeApi();
        sendToHost = message => vscode.postMessage(message);
        global.addEventListener('message', event => {
            listeners.forEach(listener => listener(event.data));
        });
    } else {
        connectQWebChannel();
    }

    global.waveformTransport = {
        send(message) {
            sendToHost(message);
        },
        onMessage(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        dispose() {
            listeners.clear();
            pending.length = 0;
        },
        dispatch,
    };
})(globalThis);
