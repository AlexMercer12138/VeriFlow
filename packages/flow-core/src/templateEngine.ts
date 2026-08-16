export class TemplateEngine {
    static render(template: string, variables: Record<string, string>): string {
        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            result = result.split(`{${key}}`).join(value);
        }
        return result;
    }

    static renderCompile(
        compileCmd: string,
        output: string,
        files: string[],
        topModule: string = '',
        defines: Readonly<Record<string, string | number | boolean>> = {},
        includeDirs: readonly string[] = [],
        platform: NodeJS.Platform = process.platform
    ): string {
        const quote = platform === 'win32'
            ? TemplateEngine.quoteWindowsShellArgument
            : TemplateEngine.quotePosixShellArgument;
        return TemplateEngine.render(compileCmd, {
            output,
            files: files.map(f => `"${f}"`).join(' '),
            top_module: topModule,
            defines: Object.entries(defines).map(([name, value]) => (
                quote(value === true
                    ? `-D${name}`
                    : `-D${name}=${value === false ? 0 : value}`)
            )).join(' '),
            include_dirs: includeDirs.map(directory => quote(`-I${directory}`)).join(' '),
        });
    }

    private static quotePosixShellArgument(value: string): string {
        return `'${value.split("'").join(`'"'"'`)}'`;
    }

    private static quoteWindowsShellArgument(value: string): string {
        const metaCharacters = /([()\][%!^"`<>&|;, *?])/g;
        let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
        escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
        return `"${escaped}"`.replace(metaCharacters, '^$1');
    }

    static renderRun(runCmd: string, output: string): string {
        return TemplateEngine.render(runCmd, { output });
    }

    static renderWave(launchCmd: string, waveFile: string): string {
        return TemplateEngine.render(launchCmd, { wave_file: waveFile });
    }
}
