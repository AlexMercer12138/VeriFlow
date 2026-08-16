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
        includeDirs: readonly string[] = []
    ): string {
        return TemplateEngine.render(compileCmd, {
            output,
            files: files.map(f => `"${f}"`).join(' '),
            top_module: topModule,
            defines: Object.entries(defines).map(([name, value]) => (
                value === true
                    ? `-D"${name}"`
                    : `-D"${name}=${value === false ? 0 : value}"`
            )).join(' '),
            include_dirs: includeDirs.map(directory => `-I"${directory}"`).join(' '),
        });
    }

    static renderRun(runCmd: string, output: string): string {
        return TemplateEngine.render(runCmd, { output });
    }

    static renderWave(launchCmd: string, waveFile: string): string {
        return TemplateEngine.render(launchCmd, { wave_file: waveFile });
    }
}
