import type { HdlDiagnostic, SourceSpan } from '../core/hdl/model';

export type SchematicPanelHandle = {
    uri: string;
    reveal(): void;
    selectModule(definitionKey: string): Promise<void> | void;
};

export type SchematicSourceNavigationPorts<Document, Position> = {
    openTextDocument(uri: string): Promise<{
        document: Document;
        positionAt(offset: number): Position;
    }>;
    showTextDocument(
        document: Document,
        selection: { start: Position; end: Position }
    ): Promise<void>;
};

export function sourceNavigationTarget(
    currentDocumentUri: string,
    span: SourceSpan
): { uri: string; start: number; end: number } {
    const owningPart = span.compositeParts?.[0];
    return owningPart ?? {
        uri: span.uri ?? currentDocumentUri,
        start: span.start,
        end: span.end,
    };
}

export async function revealSchematicSource<Document, Position>(
    currentDocumentUri: string,
    span: SourceSpan,
    ports: SchematicSourceNavigationPorts<Document, Position>
): Promise<void> {
    const target = sourceNavigationTarget(currentDocumentUri, span);
    const opened = await ports.openTextDocument(target.uri);
    await ports.showTextDocument(opened.document, {
        start: opened.positionAt(target.start),
        end: opened.positionAt(target.end),
    });
}

export type SchematicDefinitionNavigationPorts = {
    getDefinition(
        definitionKey: string
    ): SchematicDefinitionTarget | undefined | Promise<SchematicDefinitionTarget | undefined>;
    openSchematic(uri: string, definitionKey: string): Promise<void>;
};

export type SchematicDefinitionTarget = { key: string; uri: string };

export async function openSchematicDefinition(
    currentPanel: SchematicPanelHandle,
    definitionKey: string,
    registry: SchematicNavigationRegistry,
    ports: SchematicDefinitionNavigationPorts
): Promise<void> {
    const definition = await ports.getDefinition(definitionKey);
    if (!definition) {
        return;
    }
    if (definition.uri === currentPanel.uri) {
        await currentPanel.selectModule(definition.key);
        return;
    }
    const preferred = registry.findPreferred(definition.uri);
    if (preferred) {
        preferred.reveal();
        await preferred.selectModule(definition.key);
        return;
    }
    registry.setPending(definition.uri, definition.key);
    await ports.openSchematic(definition.uri, definition.key);
}

export type SourceMappedSchematicDiagnostic = HdlDiagnostic & {
    uri: string;
    start: number;
    end: number;
};

export type SchematicDiagnosticSink = {
    set(uri: string, diagnostics: SourceMappedSchematicDiagnostic[]): Promise<void> | void;
    delete(uri: string): Promise<void> | void;
};

export class SchematicDiagnosticPublisher {
    private readonly sessions = new Map<object, Map<string, SourceMappedSchematicDiagnostic[]>>();
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(private readonly sink: SchematicDiagnosticSink) {}

    publish(
        owner: object,
        currentDocumentUri: string,
        diagnostics: HdlDiagnostic[]
    ): Promise<{ errors: number; warnings: number }> {
        const counts = {
            errors: diagnostics.filter(item => item.severity === 'error').length,
            warnings: diagnostics.filter(item => item.severity === 'warning').length,
        };
        return this.enqueue(async () => {
            const previousUris = new Set(this.sessions.get(owner)?.keys() ?? []);
            const mapped = new Map<string, SourceMappedSchematicDiagnostic[]>();
            for (const diagnostic of diagnostics) {
                if (!diagnostic.span) continue;
                const target = sourceNavigationTarget(currentDocumentUri, diagnostic.span);
                const entries = mapped.get(target.uri) ?? [];
                entries.push({
                    ...diagnostic,
                    uri: target.uri,
                    start: target.start,
                    end: target.end,
                });
                mapped.set(target.uri, entries);
            }
            this.sessions.set(owner, mapped);
            const affectedUris = new Set([...previousUris, ...mapped.keys()]);
            for (const uri of affectedUris) {
                await this.publishUri(uri);
            }
            return counts;
        });
    }

    clear(owner: object): Promise<void> {
        return this.enqueue(async () => {
            const previousUris = [...(this.sessions.get(owner)?.keys() ?? [])];
            this.sessions.delete(owner);
            for (const uri of previousUris) {
                await this.publishUri(uri);
            }
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation, operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async publishUri(uri: string): Promise<void> {
        const unique = new Map<string, SourceMappedSchematicDiagnostic>();
        for (const session of this.sessions.values()) {
            for (const diagnostic of session.get(uri) ?? []) {
                const key = JSON.stringify([
                    diagnostic.severity,
                    diagnostic.code,
                    diagnostic.message,
                    diagnostic.start,
                    diagnostic.end,
                ]);
                unique.set(key, diagnostic);
            }
        }
        const diagnostics = [...unique.values()];
        try {
            if (diagnostics.length === 0) {
                await this.sink.delete(uri);
            } else {
                await this.sink.set(uri, diagnostics);
            }
        } catch {
            try {
                await this.sink.delete(uri);
            } catch {
                // DiagnosticCollection updates are a best-effort side channel.
            }
        }
    }
}

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
