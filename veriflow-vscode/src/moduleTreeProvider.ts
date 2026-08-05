import * as vscode from 'vscode';
import * as path from 'path';
import { DependencyResult, ModuleDefinitionEntry, ModuleScanResult } from './core';
import type { TopModuleSelection } from './config';

type TreeItemType = 'top' | 'depSection' | 'depBranch' | 'depModule' | 'libSection' | 'libModule' | 'empty' | 'missingModule';

class ModuleTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: TreeItemType,
        public readonly moduleName?: string,
        public readonly filePath?: string,
        public readonly children?: ModuleTreeItem[],
        public readonly fileUri?: string,
        itemDescription?: string
    ) {
        super(label, collapsibleState);

        if (itemType === 'top') {
            this.iconPath = new vscode.ThemeIcon('symbol-keyword');
            this.description = moduleName || 'select one';
            this.tooltip = moduleName
                ? `Top module: ${moduleName}`
                : 'Click to select a top module from scanned workspace modules';
            this.command = {
                command: 'veriflow.selectTop',
                title: 'Select Top Module',
            };
        } else if (itemType === 'depSection') {
            this.iconPath = new vscode.ThemeIcon('type-hierarchy');
            this.contextValue = 'depSection';
        } else if (itemType === 'depBranch') {
            this.iconPath = new vscode.ThemeIcon('symbol-module');
            this.tooltip = filePath || moduleName;
            this.description = filePath ? path.basename(filePath) : undefined;
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: filePath ? [vscode.Uri.file(filePath)] : [],
            };
        } else if (itemType === 'depModule') {
            this.iconPath = new vscode.ThemeIcon('symbol-module');
            this.tooltip = filePath || moduleName;
            this.description = filePath ? path.basename(filePath) : undefined;
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: filePath ? [vscode.Uri.file(filePath)] : [],
            };
        } else if (itemType === 'missingModule') {
            this.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('errorForeground'));
            this.tooltip = `Module "${moduleName}" is not declared in any search directory`;
            this.description = 'not declared';
            // 红色字体
            this.resourceUri = vscode.Uri.parse(`veriflow-missing://${moduleName}`);
        } else if (itemType === 'libSection') {
            this.iconPath = new vscode.ThemeIcon('folder-library');
            this.contextValue = 'libSection';
        } else if (itemType === 'libModule') {
            this.iconPath = new vscode.ThemeIcon('symbol-module');
            this.tooltip = fileUri || filePath || moduleName;
            this.description = itemDescription
                ?? (filePath ? path.basename(filePath) : undefined);
            this.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: fileUri
                    ? [vscode.Uri.parse(fileUri)]
                    : filePath ? [vscode.Uri.file(filePath)] : [],
            };
        } else if (itemType === 'empty') {
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

export class ModuleTreeProvider implements vscode.TreeDataProvider<ModuleTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ModuleTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _topModule: TopModuleSelection | undefined;
    private _scanResult: ModuleScanResult | null = null;
    private _analyzeResult: DependencyResult | null = null;

    set topModule(value: TopModuleSelection | undefined) {
        this._topModule = value;
        this.refresh();
    }

    get topModule(): TopModuleSelection | undefined {
        return this._topModule;
    }

    get analyzeResult(): DependencyResult | null {
        return this._analyzeResult;
    }

    setScanResult(result: ModuleScanResult): void {
        this._scanResult = result;
        this.refresh();
    }

    setAnalyzeResult(result: DependencyResult | null): void {
        this._analyzeResult = result;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ModuleTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ModuleTreeItem): vscode.ProviderResult<ModuleTreeItem[]> {
        if (!element) {
            return this._buildRootItems();
        }
        return element.children || [];
    }

    getParent(): vscode.ProviderResult<ModuleTreeItem> {
        return null;
    }

    private _buildRootItems(): ModuleTreeItem[] {
        const items: ModuleTreeItem[] = [];

        items.push(new ModuleTreeItem(
            'Top Module',
            vscode.TreeItemCollapsibleState.None,
            'top',
            this._topModule?.name
        ));

        if (this._analyzeResult) {
            items.push(this._buildDepTree());
        }

        if (this._scanResult && this._scanResult.totalModules > 0) {
            items.push(this._buildLibTree());
        } else {
            const message = this._scanResult
                ? 'No Verilog/SystemVerilog modules found. Add .v/.sv files or configure veriflow.libDirs.'
                : 'Open a Verilog workspace or click refresh to scan modules.';
            items.push(new ModuleTreeItem(
                message,
                vscode.TreeItemCollapsibleState.None,
                'empty'
            ));
        }

        return items;
    }

    private _buildDepTree(): ModuleTreeItem {
        const result = this._analyzeResult!;
        const depGraph = result.depGraph || {};
        const moduleMap = result.moduleMap || {};
        const topMod = result.topModule;
        const missingModules = result.missingModules || [];

        const visited = new Set<string>();
        let totalCount = 0;

        const buildNode = (moduleName: string): ModuleTreeItem | null => {
            if (visited.has(moduleName)) {
                totalCount++;
                return new ModuleTreeItem(
                    moduleName + ' \u2191',
                    vscode.TreeItemCollapsibleState.None,
                    'depModule',
                    moduleName,
                    moduleMap[moduleName] || ''
                );
            }
            visited.add(moduleName);
            totalCount++;

            const directDeps = depGraph[moduleName] || [];
            const children: ModuleTreeItem[] = [];

            for (const dep of directDeps) {
                const child = buildNode(dep);
                if (child) {
                    children.push(child);
                }
            }

            const filePath = moduleMap[moduleName] || '';
            if (children.length > 0) {
                return new ModuleTreeItem(
                    moduleName,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'depBranch',
                    moduleName,
                    filePath,
                    children
                );
            } else {
                return new ModuleTreeItem(
                    moduleName,
                    vscode.TreeItemCollapsibleState.None,
                    'depModule',
                    moduleName,
                    filePath
                );
            }
        };

        const rootChildren: ModuleTreeItem[] = [];

        if (topMod) {
            const rootNode = buildNode(topMod);
            if (rootNode) {
                rootChildren.push(rootNode);
            }
        }

        // 添加 missing modules（未声明的实例）用红色标记
        for (const mname of missingModules) {
            if (!visited.has(mname)) {
                visited.add(mname);
                totalCount++;
                rootChildren.push(new ModuleTreeItem(
                    `❓ ${mname}`,
                    vscode.TreeItemCollapsibleState.None,
                    'missingModule',
                    mname,
                    ''
                ));
            }
        }

        return new ModuleTreeItem(
            `Dependency Tree (${totalCount} modules)`,
            vscode.TreeItemCollapsibleState.Expanded,
            'depSection',
            undefined,
            undefined,
            rootChildren
        );
    }

    private _buildLibTree(): ModuleTreeItem {
        const result = this._scanResult!;
        const depModules = new Set(Object.keys(this._analyzeResult?.moduleMap || {}));
        const nameCounts = new Map<string, number>();
        const definitionsByDir = new Map<string, ModuleDefinitionEntry[]>();
        for (const definition of result.definitions) {
            nameCounts.set(definition.name, (nameCounts.get(definition.name) ?? 0) + 1);
            const dir = definition.filepath
                ? path.dirname(definition.filepath)
                : definition.uri;
            const definitions = definitionsByDir.get(dir) ?? [];
            definitions.push(definition);
            definitionsByDir.set(dir, definitions);
        }

        const sectionChildren: ModuleTreeItem[] = [];

        for (const [dirLabel, definitions] of [...definitionsByDir.entries()]
            .sort(([left], [right]) => left.localeCompare(right))) {
            const dirChildren: ModuleTreeItem[] = [];

            for (const definition of definitions.sort((left, right) =>
                left.name.localeCompare(right.name)
                || left.uri.localeCompare(right.uri)
                || left.line - right.line
            )) {
                const inDep = depModules.has(definition.name);
                const suffix = inDep ? ' [dep]' : '';
                dirChildren.push(new ModuleTreeItem(
                    definition.name + suffix,
                    vscode.TreeItemCollapsibleState.None,
                    'libModule',
                    definition.name,
                    definition.filepath,
                    undefined,
                    definition.uri,
                    (nameCounts.get(definition.name) ?? 0) > 1
                        ? path.relative(result.root, definition.filepath) || definition.filepath
                        : undefined
                ));
            }

            sectionChildren.push(new ModuleTreeItem(
                path.basename(dirLabel) || dirLabel,
                vscode.TreeItemCollapsibleState.Collapsed,
                'libSection',
                undefined,
                undefined,
                dirChildren
            ));
        }

        return new ModuleTreeItem(
            `All Modules (${result.totalModules})`,
            vscode.TreeItemCollapsibleState.Collapsed,
            'libSection',
            undefined,
            undefined,
            sectionChildren
        );
    }

    getModuleNames(): string[] {
        return this._scanResult?.modules || [];
    }

    // 只返回工作区目录中的模块名
    getWorkspaceModuleNames(): string[] {
        return this._scanResult?.workspaceModules || [];
    }

    getWorkspaceDefinitions(): ModuleDefinitionEntry[] {
        return this._scanResult?.definitions.filter(definition => definition.workspace) ?? [];
    }
}
