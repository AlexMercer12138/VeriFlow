import * as path from 'path';
import * as vscode from 'vscode';

export type ArchDesignTreeHost = Readonly<{
    findFiles(): Thenable<readonly vscode.Uri[]>;
    asRelativePath(uri: vscode.Uri): string;
}>;

const DEFAULT_HOST: ArchDesignTreeHost = Object.freeze({
    findFiles: () => vscode.workspace.findFiles('**/*.ad'),
    asRelativePath: uri => vscode.workspace.asRelativePath(uri, true),
});

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/');
}

function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

export class ArchDesignTreeItem extends vscode.TreeItem {
    constructor(resource: vscode.Uri, relativePath: string) {
        const normalized = normalizePath(relativePath);
        super(path.posix.basename(normalized), vscode.TreeItemCollapsibleState.None);
        const parent = path.posix.dirname(normalized);
        this.description = parent === '.' ? undefined : parent;
        this.tooltip = normalized;
        this.resourceUri = resource;
        this.contextValue = 'archDesignFile';
        this.iconPath = new vscode.ThemeIcon('circuit-board');
        this.command = {
            command: 'veriflow.openArchDesign',
            title: 'Open Arch Design',
            arguments: [resource],
        };
    }
}

export class ArchDesignTreeProvider implements
    vscode.TreeDataProvider<ArchDesignTreeItem>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<
        ArchDesignTreeItem | undefined | null
    >();

    readonly onDidChangeTreeData = this.changeEmitter.event;

    constructor(private readonly host: ArchDesignTreeHost = DEFAULT_HOST) {}

    refresh(): void {
        this.changeEmitter.fire(undefined);
    }

    getTreeItem(element: ArchDesignTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ArchDesignTreeItem): Promise<ArchDesignTreeItem[]> {
        if (element) return [];
        const resources = await this.host.findFiles();
        return resources
            .map(resource => ({
                resource,
                relativePath: normalizePath(this.host.asRelativePath(resource)),
            }))
            .sort((left, right) => compareCodeUnits(
                left.relativePath,
                right.relativePath
            ))
            .map(item => new ArchDesignTreeItem(item.resource, item.relativePath));
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
