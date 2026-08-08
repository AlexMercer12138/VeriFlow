export function resolveNpmInvocation(args, options = {}) {
    const nodeExecutable = options.nodeExecutable ?? process.execPath;
    const npmExecutable = options.npmExecutable ?? process.env.npm_execpath;
    if (!npmExecutable) {
        throw new Error('npm_execpath is unavailable; run this command through npm');
    }
    return {
        executable: nodeExecutable,
        args: [npmExecutable, ...args],
    };
}
