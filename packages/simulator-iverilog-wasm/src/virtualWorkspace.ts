import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface VirtualWorkspaceInput {
    cwd: string;
    files: readonly string[];
    runtimeFiles: readonly string[];
    includeDirs: readonly string[];
}

export interface VirtualWorkspaceFileSystem {
    readFile?(hostPath: string): Promise<Uint8Array>;
    realpath?(hostPath: string): Promise<string>;
}

export interface VirtualWorkspace {
    files: Array<{ path: string; data: Uint8Array }>;
    sources: string[];
    includeDirs: string[];
    hostPathByVirtualPath: ReadonlyMap<string, string>;
}

interface PathContext {
    implementation: typeof path.posix | typeof path.win32;
    windows: boolean;
}

interface ConfiguredRoot {
    hostPath: string;
    comparisonPath: string;
    virtualPath: string;
    order: number;
}

interface MappedHostFile {
    hostPath: string;
    normalizedHostPath: string;
    virtualPath: string;
}

const defaultFileSystem: VirtualWorkspaceFileSystem = { readFile, realpath };

export async function buildVirtualWorkspace(
    input: VirtualWorkspaceInput,
    fileSystem: VirtualWorkspaceFileSystem = defaultFileSystem,
): Promise<VirtualWorkspace> {
    const context = pathContext(input.cwd);
    const readHostFile = fileSystem.readFile ?? readFile;
    const cwd = normalizeHostPath(input.cwd, context);
    const roots = configuredRoots(cwd, input.includeDirs, context);
    const sources = input.files.map(
        hostPath => mapHostFile(hostPath, cwd, roots, context),
    );
    const runtimeFiles = input.runtimeFiles.map(
        hostPath => mapHostFile(hostPath, cwd, roots, context),
    );
    const mappedFiles = [...sources, ...runtimeFiles];

    assertUniqueVirtualPaths(mappedFiles);
    await assertUniqueHostFiles(mappedFiles, fileSystem.realpath, context);

    const dataByHostPath = new Map<string, Promise<Uint8Array>>();
    const files = await Promise.all(mappedFiles.map(async mapped => {
        const comparisonPath = comparable(mapped.normalizedHostPath, context);
        let data = dataByHostPath.get(comparisonPath);
        if (data === undefined) {
            data = Promise.resolve(readHostFile(mapped.hostPath))
                .then(contents => new Uint8Array(contents));
            dataByHostPath.set(comparisonPath, data);
        }
        return {
            path: mapped.virtualPath,
            data: await data,
        };
    }));
    const hostPathByVirtualPath = new Map(
        mappedFiles.map(mapped => [mapped.virtualPath, mapped.hostPath]),
    );

    return {
        files,
        sources: sources.map(source => source.virtualPath),
        includeDirs: input.includeDirs.map((_, index) => `libraries/${index}`),
        hostPathByVirtualPath,
    };
}

function pathContext(cwd: string): PathContext {
    const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\');
    return {
        implementation: windows ? path.win32 : path.posix,
        windows,
    };
}

function normalizeHostPath(
    hostPath: string,
    context: PathContext,
    basePath?: string,
): string {
    if (hostPath.includes('\0')) {
        throw new TypeError('Host paths must not contain NUL bytes');
    }
    return basePath === undefined
        ? context.implementation.resolve(hostPath)
        : context.implementation.resolve(basePath, hostPath);
}

function comparable(hostPath: string, context: PathContext): string {
    return context.windows ? hostPath.toLowerCase() : hostPath;
}

function configuredRoots(
    cwd: string,
    includeDirs: readonly string[],
    context: PathContext,
): ConfiguredRoot[] {
    return [
        { hostPath: cwd, virtualPath: 'workspace', order: -1 },
        ...includeDirs.map((includeDir, index) => ({
            hostPath: normalizeHostPath(includeDir, context, cwd),
            virtualPath: `libraries/${index}`,
            order: index,
        })),
    ].map(root => ({
        ...root,
        comparisonPath: comparable(root.hostPath, context),
    }));
}

function mapHostFile(
    hostPath: string,
    cwd: string,
    roots: readonly ConfiguredRoot[],
    context: PathContext,
): MappedHostFile {
    const normalizedHostPath = normalizeHostPath(hostPath, context, cwd);
    const matchingRoots = roots
        .map(root => ({
            root,
            relativePath: context.implementation.relative(
                root.hostPath,
                normalizedHostPath,
            ),
        }))
        .filter(({ relativePath }) => isContained(relativePath, context))
        .sort((left, right) => (
            right.root.comparisonPath.length - left.root.comparisonPath.length
            || left.root.order - right.root.order
        ));
    const match = matchingRoots[0];
    const virtualPath = match === undefined
        ? externalVirtualPath(normalizedHostPath, context)
        : joinVirtualPath(match.root.virtualPath, match.relativePath, context);

    return { hostPath: normalizedHostPath, normalizedHostPath, virtualPath };
}

function isContained(relativePath: string, context: PathContext): boolean {
    return relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${context.implementation.sep}`)
        && !context.implementation.isAbsolute(relativePath)
    );
}

function joinVirtualPath(
    root: string,
    relativePath: string,
    context: PathContext,
): string {
    const components = relativePath
        .split(context.implementation.sep)
        .filter(component => component !== '');
    return path.posix.join(root, ...components);
}

function externalVirtualPath(
    hostPath: string,
    context: PathContext,
): string {
    const parent = context.implementation.dirname(hostPath);
    const stableParent = context.windows
        ? parent.replace(/\\/g, '/').toLowerCase()
        : parent;
    const digest = createHash('sha256').update(stableParent).digest('hex');
    return path.posix.join(
        'external',
        digest,
        context.implementation.basename(hostPath),
    );
}

function assertUniqueVirtualPaths(files: readonly MappedHostFile[]): void {
    const virtualPaths = new Set<string>();
    for (const file of files) {
        if (virtualPaths.has(file.virtualPath)) {
            throw new Error(`Duplicate virtual path: ${file.virtualPath}`);
        }
        virtualPaths.add(file.virtualPath);
    }
}

async function assertUniqueHostFiles(
    files: readonly MappedHostFile[],
    canonicalize: VirtualWorkspaceFileSystem['realpath'],
    context: PathContext,
): Promise<void> {
    if (canonicalize === undefined) return;

    const canonicalPaths = await Promise.all(files.map(async file => (
        canonicalize(file.normalizedHostPath)
    )));
    const hostPaths = new Set<string>();
    for (const hostPath of canonicalPaths) {
        const key = comparable(context.implementation.normalize(hostPath), context);
        if (hostPaths.has(key)) {
            throw new Error(`Duplicate host file: ${hostPath}`);
        }
        hostPaths.add(key);
    }
}
