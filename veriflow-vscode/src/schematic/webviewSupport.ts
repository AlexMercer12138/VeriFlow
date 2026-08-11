import type { HdlDiagnostic, SourceSpan } from '../core/hdl/model';
import type { SchematicLayout } from './layoutStore';
import type { WebviewCommand } from './protocol';

export type SchematicWebviewResources = {
    cspSource: string;
    styleUri: string;
    scriptUri: string;
    nonce: string;
};

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function replaceRequired(
    source: string,
    pattern: RegExp,
    replacement: string,
    description: string
): string {
    if (!pattern.test(source)) {
        throw new Error(`Schematic HTML is missing the ${description} placeholder`);
    }
    return source.replace(pattern, replacement);
}

export function buildSchematicWebviewHtml(
    shell: string,
    resources: SchematicWebviewResources
): string {
    if (!/^[A-Za-z0-9+/_=-]+$/.test(resources.nonce)) {
        throw new Error('Schematic webview nonce contains invalid characters');
    }
    const csp = [
        "default-src 'none'",
        `img-src ${resources.cspSource}`,
        `style-src ${resources.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${resources.nonce}'`,
    ].join('; ') + ';';
    let html = replaceRequired(
        shell,
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/i,
        `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">`,
        'Content-Security-Policy'
    );
    html = replaceRequired(
        html,
        /href="\.\/index\.css"/,
        `href="${escapeHtmlAttribute(resources.styleUri)}"`,
        'stylesheet'
    );
    return replaceRequired(
        html,
        /<script\s+src="\.\/index\.js"><\/script>/,
        `<script nonce="${escapeHtmlAttribute(resources.nonce)}" src="${
            escapeHtmlAttribute(resources.scriptUri)
        }"></script>`,
        'script'
    );
}

export type TimerAdapter<Handle> = {
    set(callback: () => void, delayMs: number): Handle;
    clear(handle: Handle): void;
};

export type SchematicSelectionItem = {
    objectId: string;
    description: string;
};

export type SchematicSelectionSummary = {
    selectedObjectId?: string;
    statusText: string;
};

export function formatSchematicDiagnosticDetails(
    diagnostics: readonly HdlDiagnostic[]
): string {
    return diagnostics.map(diagnostic =>
        `${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`
    ).join('\n');
}

type DefaultTimerHandle = ReturnType<typeof setTimeout>;

const defaultTimers: TimerAdapter<DefaultTimerHandle> = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: handle => clearTimeout(handle),
};

export function navigationCommandForCell(
    target: { sourceSpan?: SourceSpan; definitionKey?: string },
    openDefinition: boolean
): WebviewCommand | undefined {
    if (openDefinition) {
        return typeof target.definitionKey === 'string'
            && target.definitionKey.length > 0
            ? { type: 'openDefinition', definitionKey: target.definitionKey }
            : undefined;
    }
    return target.sourceSpan
        ? { type: 'revealSource', span: target.sourceSpan }
        : undefined;
}

export function summarizeSchematicSelection(
    items: readonly SchematicSelectionItem[]
): SchematicSelectionSummary {
    const last = items[items.length - 1];
    if (!last) return { statusText: 'No selection' };
    return {
        selectedObjectId: last.objectId,
        statusText: items.length === 1
            ? last.description
            : `${items.length} objects selected`,
    };
}

export function cloneSchematicLayout(layout: SchematicLayout): SchematicLayout {
    return {
        placement: {
            nodes: Object.fromEntries(Object.entries(layout.placement.nodes).map(
                ([id, node]) => [id, { ...node }]
            )),
        },
        viewport: { ...layout.viewport },
        minimap: layout.minimap,
        ...(layout.selectedObjectId === undefined
            ? {}
            : { selectedObjectId: layout.selectedObjectId }),
    };
}

export function mergeSchematicWebviewLayouts(
    layouts: Readonly<Record<string, SchematicLayout>> | undefined,
    moduleKey: string,
    layout: SchematicLayout
): Record<string, SchematicLayout> {
    return Object.fromEntries([
        ...Object.entries(layouts ?? {}).filter(([key]) => key !== moduleKey),
        [moduleKey, layout] as const,
    ].map(([key, value]) => [key, cloneSchematicLayout(value)]));
}

export class DebouncedLayoutSaveScheduler<Handle = DefaultTimerHandle> {
    private readonly pending = new Map<string, {
        handle?: Handle;
        revision: string;
        layout: SchematicLayout;
    }>();

    constructor(
        private readonly delayMs: number,
        private readonly save: (
            moduleKey: string,
            revision: string,
            layout: SchematicLayout
        ) => void,
        private readonly timers: TimerAdapter<Handle> = defaultTimers as unknown as
            TimerAdapter<Handle>
    ) {}

    schedule(moduleKey: string, revision: string, layout: SchematicLayout): void {
        const previous = this.pending.get(moduleKey);
        if (previous?.handle !== undefined) this.timers.clear(previous.handle);

        const pending: {
            handle?: Handle;
            revision: string;
            layout: SchematicLayout;
        } = {
            revision,
            layout: cloneSchematicLayout(layout),
        };
        this.pending.set(moduleKey, pending);
        pending.handle = this.timers.set(() => {
            this.commit(moduleKey, pending);
        }, this.delayMs);
    }

    flush(): void {
        for (const [moduleKey, pending] of [...this.pending]) {
            this.commit(moduleKey, pending);
        }
    }

    flushModule(moduleKey: string): void {
        const pending = this.pending.get(moduleKey);
        if (pending) this.commit(moduleKey, pending);
    }

    dispose(): void {
        for (const pending of this.pending.values()) {
            if (pending.handle !== undefined) this.timers.clear(pending.handle);
        }
        this.pending.clear();
    }

    private commit(
        moduleKey: string,
        pending: { handle?: Handle; revision: string; layout: SchematicLayout }
    ): void {
        if (this.pending.get(moduleKey) !== pending) return;
        if (pending.handle !== undefined) this.timers.clear(pending.handle);
        this.pending.delete(moduleKey);
        this.save(moduleKey, pending.revision, pending.layout);
    }
}
