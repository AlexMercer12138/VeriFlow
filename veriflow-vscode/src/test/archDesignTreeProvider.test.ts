import * as assert from 'assert';
import Module = require('module');

type Listener<T> = (value: T) => void;

class FakeEventEmitter<T> {
    private readonly listeners = new Set<Listener<T>>();

    readonly event = (listener: Listener<T>): { dispose(): void } => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    fire(value: T): void {
        for (const listener of this.listeners) listener(value);
    }

    dispose(): void {
        this.listeners.clear();
    }
}

class FakeUri {
    readonly fsPath: string;

    constructor(readonly path: string) {
        this.fsPath = path;
    }

    toString(): string {
        return `file://${this.path}`;
    }
}

class FakeTreeItem {
    description?: string;
    tooltip?: string;
    contextValue?: string;
    resourceUri?: FakeUri;
    iconPath?: FakeThemeIcon;
    command?: { command: string; title: string; arguments?: unknown[] };

    constructor(
        readonly label: string,
        readonly collapsibleState: number
    ) {}
}

class FakeThemeIcon {
    constructor(readonly id: string) {}
}

async function main(): Promise<void> {
    const moduleLoader = Module as typeof Module & {
        _load(request: string, parent: NodeModule | undefined, isMain: boolean): unknown;
    };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function loadWithVscodeStub(
        request: string,
        parent: NodeModule | undefined,
        isMain: boolean
    ): unknown {
        if (request === 'vscode') {
            return {
                EventEmitter: FakeEventEmitter,
                ThemeIcon: FakeThemeIcon,
                TreeItem: FakeTreeItem,
                TreeItemCollapsibleState: { None: 0 },
                workspace: {
                    findFiles: async (): Promise<FakeUri[]> => [],
                    asRelativePath: (uri: FakeUri): string => uri.path,
                },
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        const { ArchDesignTreeProvider } = require(
            '../archDesign/archDesignTreeProvider'
        ) as typeof import('../archDesign/archDesignTreeProvider');
        const resources = [
            new FakeUri('z/top.ad'),
            new FakeUri('a/sub/system.ad'),
            new FakeUri('a/Upper.AD'),
        ];
        const provider = new ArchDesignTreeProvider({
            findFiles: async () => resources as never,
            asRelativePath: uri => (uri as unknown as FakeUri).path,
        });

        const items = await provider.getChildren();
        assert.deepStrictEqual(items.map(item => item.label), [
            'Upper.AD',
            'system.ad',
            'top.ad',
        ]);
        assert.strictEqual(items[0].description, 'a');
        assert.strictEqual(items[1].description, 'a/sub');
        assert.strictEqual(items[2].description, 'z');
        for (const item of items) {
            assert.strictEqual(item.contextValue, 'archDesignFile');
            assert.strictEqual(item.command?.command, 'veriflow.openArchDesign');
            assert.deepStrictEqual(item.command?.arguments, [item.resourceUri]);
            assert.strictEqual((item.iconPath as FakeThemeIcon).id, 'circuit-board');
        }
        assert.deepStrictEqual(await provider.getChildren(items[0]), []);
        assert.deepStrictEqual(provider.getTreeItem(items[0]), items[0]);

        let refreshes = 0;
        const subscription = provider.onDidChangeTreeData(() => { refreshes += 1; });
        provider.refresh();
        assert.strictEqual(refreshes, 1);
        subscription.dispose();
        provider.dispose();

        const empty = new ArchDesignTreeProvider({
            findFiles: async () => [],
            asRelativePath: uri => (uri as unknown as FakeUri).path,
        });
        assert.deepStrictEqual(await empty.getChildren(), []);
        empty.dispose();
    } finally {
        moduleLoader._load = originalLoad;
        const modulePath = require.resolve('../archDesign/archDesignTreeProvider');
        delete require.cache[modulePath];
    }

    console.log('Arch Design tree provider tests passed');
}

void main();
