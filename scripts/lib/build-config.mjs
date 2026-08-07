export function browserBuildOptions() {
    return {
        bundle: true,
        platform: 'browser',
        format: 'iife',
        target: 'es2020',
        minify: false,
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8',
    };
}

export function nodeCjsBuildOptions() {
    return {
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node24',
        minify: false,
        sourcemap: false,
        legalComments: 'none',
        charset: 'utf8',
    };
}
