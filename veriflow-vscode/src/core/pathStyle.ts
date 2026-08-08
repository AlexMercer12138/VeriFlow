import * as path from 'path';

export interface RelativeDisplayPathOptions {
    allowOutsideRoot?: boolean;
}

const windowsDrivePath = /^[A-Za-z]:[\\/]/;
const windowsUncPath = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;

function isWindowsAbsolutePath(filepath: string): boolean {
    return windowsDrivePath.test(filepath) || windowsUncPath.test(filepath);
}

function displayPath(filepath: string): string {
    return filepath.replace(/\\/g, '/');
}

export function relativeDisplayPath(
    root: string,
    target: string,
    options: RelativeDisplayPathOptions = {}
): string {
    const rootIsWindows = isWindowsAbsolutePath(root);
    const targetIsWindows = isWindowsAbsolutePath(target);
    const rootIsPosix = path.posix.isAbsolute(root);
    const targetIsPosix = path.posix.isAbsolute(target);

    if (!((rootIsWindows && targetIsWindows) || (rootIsPosix && targetIsPosix))) {
        return displayPath(target);
    }

    const api = rootIsWindows ? path.win32 : path.posix;
    const relative = api.relative(root, target);
    const outsideRoot = relative === '..' || relative.startsWith(`..${api.sep}`);
    if (!relative
        || api.isAbsolute(relative)
        || (outsideRoot && !options.allowOutsideRoot)) {
        return displayPath(target);
    }
    return displayPath(relative);
}
