export type SchematicPanelHandle = {
    uri: string;
    reveal(): void;
    selectModule(definitionKey: string): Promise<void> | void;
};

export class SchematicNavigationRegistry {
    private readonly panels = new Map<string, Set<SchematicPanelHandle>>();
    private readonly focusOrder = new Map<string, SchematicPanelHandle[]>();
    private readonly pending = new Map<string, string>();

    register(handle: SchematicPanelHandle): { dispose(): void } {
        let panelsForUri = this.panels.get(handle.uri);
        if (!panelsForUri) {
            panelsForUri = new Set();
            this.panels.set(handle.uri, panelsForUri);
        }
        panelsForUri.add(handle);

        let disposed = false;
        return {
            dispose: () => {
                if (disposed) return;
                disposed = true;
                const livePanels = this.panels.get(handle.uri);
                livePanels?.delete(handle);
                if (livePanels?.size === 0) {
                    this.panels.delete(handle.uri);
                }
                const focused = this.focusOrder.get(handle.uri);
                if (!focused) return;
                const remaining = focused.filter(candidate => candidate !== handle);
                if (remaining.length === 0) {
                    this.focusOrder.delete(handle.uri);
                } else {
                    this.focusOrder.set(handle.uri, remaining);
                }
            },
        };
    }

    markFocused(handle: SchematicPanelHandle): void {
        if (!this.panels.get(handle.uri)?.has(handle)) return;
        const focused = this.focusOrder.get(handle.uri) ?? [];
        this.focusOrder.set(handle.uri, [
            ...focused.filter(candidate => candidate !== handle),
            handle,
        ]);
    }

    findPreferred(uri: string): SchematicPanelHandle | undefined {
        const livePanels = this.panels.get(uri);
        const focused = this.focusOrder.get(uri);
        if (!livePanels || !focused) return undefined;
        for (let index = focused.length - 1; index >= 0; index--) {
            if (livePanels.has(focused[index])) return focused[index];
        }
        return undefined;
    }

    setPending(uri: string, definitionKey: string): void {
        this.pending.set(uri, definitionKey);
    }

    consumePending(uri: string): string | undefined {
        const definitionKey = this.pending.get(uri);
        if (definitionKey !== undefined) {
            this.pending.delete(uri);
        }
        return definitionKey;
    }
}
