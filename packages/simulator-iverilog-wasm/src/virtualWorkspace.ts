import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface VirtualWorkspaceInput {
    cwd: string;
    files: readonly string[];
    runtimeFiles: readonly string[];
    includeDirs: readonly string[];
    writableFiles?: readonly string[];
}

export interface VirtualWorkspaceFileSystem {
    readFile?(hostPath: string): Promise<Uint8Array>;
    realpath?(hostPath: string): Promise<string>;
}

export interface VirtualWorkspace {
    files: Array<{ path: string; data: Uint8Array }>;
    sources: string[];
    includeDirs: string[];
    runCwd: string;
    writableFiles: string[];
    hostPathByVirtualPath: ReadonlyMap<string, string>;
}

interface PathContext {
    implementation: typeof path.posix | typeof path.win32;
    windows: boolean;
}

interface ConfiguredRoot {
    mappingPath: string;
    comparisonPath: string;
    virtualPath: string;
    order: number;
}

interface ResolvedHostPath {
    hostPath: string;
    mappingPath: string;
}

interface MappedHostFile {
    hostPath: string;
    mappingPath: string;
    virtualPath: string;
}

const defaultFileSystem: VirtualWorkspaceFileSystem = { readFile, realpath };

export async function buildVirtualWorkspace(
    input: VirtualWorkspaceInput,
    fileSystem: VirtualWorkspaceFileSystem = defaultFileSystem,
): Promise<VirtualWorkspace> {
    const context = pathContext(input.cwd);
    const readHostFile = fileSystem.readFile ?? readFile;
    const canonicalizeHostPath = fileSystem.realpath ?? realpath;
    const cwdHostPath = normalizeHostPath(input.cwd, context);
    const sourceHostPaths = input.files.map(hostPath => (
        normalizeHostPath(hostPath, context, cwdHostPath)
    ));
    const runtimeHostPaths = input.runtimeFiles.map(hostPath => (
        normalizeHostPath(hostPath, context, cwdHostPath)
    ));
    assertUniqueNormalizedHostPaths(
        [...sourceHostPaths, ...runtimeHostPaths],
        context,
    );
    const includeHostPaths = input.includeDirs.map(includeDir => (
        normalizeHostPath(includeDir, context, cwdHostPath)
    ));
    const canonicalize = cachedCanonicalizer(canonicalizeHostPath, context);
    const cwd = await resolveHostPath(cwdHostPath, canonicalize);
    const [includeDirs, sourceFiles, runtimeFiles] = await Promise.all([
        Promise.all(includeHostPaths.map(hostPath => (
            resolveHostPath(hostPath, canonicalize)
        ))),
        Promise.all(sourceHostPaths.map(hostPath => (
            resolveHostPath(hostPath, canonicalize)
        ))),
        Promise.all(runtimeHostPaths.map(hostPath => (
            resolveHostPath(hostPath, canonicalize)
        ))),
    ]);
    const writableFiles = (input.writableFiles ?? []).map(logicalPath => ({
        logicalPath,
        mappingPath: resolveLogicalHostPath(
            cwd.mappingPath,
            logicalPath,
            context,
        ),
    }));
    const workspaceRoot = commonAncestor(
        [
            cwd.mappingPath,
            ...runtimeFiles.map(file => file.mappingPath),
            ...writableFiles.map(file => file.mappingPath),
        ],
        context,
    );
    const runCwd = joinVirtualPath(
        'workspace',
        context.implementation.relative(workspaceRoot, cwd.mappingPath),
        context,
    );
    const roots = configuredRoots(cwd, includeDirs, runCwd, context);
    const sources = sourceFiles.map(
        hostPath => mapHostFile(hostPath, roots, context),
    );
    const mappedRuntimeFiles = runtimeFiles.map(
        hostPath => mapWorkspaceFile(hostPath, workspaceRoot, context),
    );
    const mappedWritableFiles = writableFiles.map(file => joinVirtualPath(
        'workspace',
        context.implementation.relative(workspaceRoot, file.mappingPath),
        context,
    ));
    const mappedFiles = [...sources, ...mappedRuntimeFiles];

    assertUniqueVirtualPaths(mappedFiles);
    assertUniqueHostFiles(mappedFiles, context);

    const dataByHostPath = new Map<string, Promise<Uint8Array>>();
    const files = await Promise.all(mappedFiles.map(async mapped => {
        const comparisonPath = comparable(mapped.mappingPath, context);
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
        includeDirs: stableUnique(includeDirs.map(includeDir => mapHostPath(
            includeDir.mappingPath,
            roots,
            context,
        ))),
        runCwd,
        writableFiles: mappedWritableFiles,
        hostPathByVirtualPath,
    };
}

function resolveLogicalHostPath(
    cwd: string,
    logicalPath: string,
    context: PathContext,
): string {
    return context.implementation.resolve(cwd, ...logicalPath.split('/'));
}

function cachedCanonicalizer(
    canonicalizeHostPath: NonNullable<VirtualWorkspaceFileSystem['realpath']>,
    context: PathContext,
): (hostPath: string) => Promise<string> {
    const canonicalPaths = new Map<string, Promise<string>>();
    return hostPath => {
        const key = comparable(hostPath, context);
        let canonicalPath = canonicalPaths.get(key);
        if (canonicalPath === undefined) {
            canonicalPath = Promise.resolve(canonicalizeHostPath(hostPath))
                .then(result => normalizeHostPath(result, context));
            canonicalPaths.set(key, canonicalPath);
        }
        return canonicalPath;
    };
}

async function resolveHostPath(
    hostPath: string,
    canonicalize: (hostPath: string) => Promise<string>,
): Promise<ResolvedHostPath> {
    return { hostPath, mappingPath: await canonicalize(hostPath) };
}

function stableUnique(values: readonly string[]): string[] {
    return [...new Set(values)];
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
    cwd: ResolvedHostPath,
    includeDirs: readonly ResolvedHostPath[],
    runCwd: string,
    context: PathContext,
): ConfiguredRoot[] {
    return [
        { mappingPath: cwd.mappingPath, virtualPath: runCwd, order: -1 },
        ...includeDirs.map((includeDir, index) => ({
            mappingPath: includeDir.mappingPath,
            virtualPath: `libraries/${index}`,
            order: index,
        })),
    ].map(root => ({
        ...root,
        comparisonPath: comparable(root.mappingPath, context),
    }));
}

function mapHostFile(
    hostPath: ResolvedHostPath,
    roots: readonly ConfiguredRoot[],
    context: PathContext,
): MappedHostFile {
    const virtualPath = mapHostPath(hostPath.mappingPath, roots, context);

    return { ...hostPath, virtualPath };
}

function mapWorkspaceFile(
    hostPath: ResolvedHostPath,
    workspaceRoot: string,
    context: PathContext,
): MappedHostFile {
    const relativePath = context.implementation.relative(
        workspaceRoot,
        hostPath.mappingPath,
    );
    return {
        ...hostPath,
        virtualPath: joinVirtualPath('workspace', relativePath, context),
    };
}

function commonAncestor(
    hostPaths: readonly string[],
    context: PathContext,
): string {
    const first = hostPaths[0];
    if (first === undefined) throw new Error('At least one host path is required');

    const implementation = context.implementation;
    const root = implementation.parse(first).root;
    const rootKey = comparable(root, context);
    const firstComponents = hostPathComponents(first, root, context);
    let commonLength = firstComponents.length;

    for (const hostPath of hostPaths.slice(1)) {
        const candidateRoot = implementation.parse(hostPath).root;
        if (comparable(candidateRoot, context) !== rootKey) {
            const error = new TypeError(
                'Runtime files must be on the same Windows volume as the simulation cwd',
            ) as TypeError & { code: string };
            error.code = 'UNSUPPORTED_PATH_LAYOUT';
            throw error;
        }
        const components = hostPathComponents(hostPath, candidateRoot, context);
        commonLength = Math.min(commonLength, components.length);
        for (let index = 0; index < commonLength; index += 1) {
            if (comparable(components[index], context)
                !== comparable(firstComponents[index], context)) {
                commonLength = index;
                break;
            }
        }
    }

    return implementation.join(root, ...firstComponents.slice(0, commonLength));
}

function hostPathComponents(
    hostPath: string,
    root: string,
    context: PathContext,
): string[] {
    return context.implementation.relative(root, hostPath)
        .split(context.implementation.sep)
        .filter(component => component !== '');
}

function mapHostPath(
    normalizedHostPath: string,
    roots: readonly ConfiguredRoot[],
    context: PathContext,
): string {
    const matchingRoots = roots
        .map(root => ({
            root,
            relativePath: context.implementation.relative(
                root.mappingPath,
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
    return virtualPath;
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

function assertUniqueNormalizedHostPaths(
    hostPaths: readonly string[],
    context: PathContext,
): void {
    const normalizedPaths = new Set<string>();
    for (const hostPath of hostPaths) {
        const key = comparable(hostPath, context);
        if (normalizedPaths.has(key)) {
            throw new Error(`Duplicate host file: ${hostPath}`);
        }
        normalizedPaths.add(key);
    }
}

function assertUniqueHostFiles(
    files: readonly MappedHostFile[],
    context: PathContext,
): void {
    const hostPaths = new Set<string>();
    for (const file of files) {
        const key = comparable(file.mappingPath, context);
        if (hostPaths.has(key)) {
            throw new Error(`Duplicate host file: ${file.hostPath}`);
        }
        hostPaths.add(key);
    }
}
