export interface NamedConnection {
    name: string;
    value: string;
}

export interface ModuleInstantiationOptions {
    moduleName: string;
    instanceName: string;
    parameters: NamedConnection[];
    ports: NamedConnection[];
    baseIndent?: string;
}

function formatConnections(
    connections: NamedConnection[],
    indent: string,
    finalSuffix: string
): string[] {
    const maxNameLength = Math.max(...connections.map(connection => connection.name.length));
    const maxValueLength = Math.max(...connections.map(connection => connection.value.length));

    return connections.map((connection, index) => {
        const nameSegment = `.${connection.name.padEnd(maxNameLength + 1)}`;
        const valueSegment = `( ${connection.value.padEnd(maxValueLength + 1)}`;
        const suffix = index === connections.length - 1 ? finalSuffix : '),';
        return `${indent}${nameSegment}${valueSegment}${suffix}`;
    });
}

export function formatModuleInstantiation(options: ModuleInstantiationOptions): string {
    const baseIndent = options.baseIndent ?? '';
    const connectionIndent = `${baseIndent}    `;
    const lines: string[] = [];

    if (options.parameters.length > 0) {
        lines.push(`${baseIndent}${options.moduleName} #(`);
        lines.push(...formatConnections(options.parameters, connectionIndent, '))'));
        if (options.ports.length === 0) {
            lines.push(`${baseIndent}${options.instanceName} ();`);
            return lines.join('\n');
        }
        lines.push(`${baseIndent}${options.instanceName} (`);
    } else if (options.ports.length > 0) {
        lines.push(`${baseIndent}${options.moduleName} ${options.instanceName} (`);
    } else {
        return `${baseIndent}${options.moduleName} ${options.instanceName} ();`;
    }

    lines.push(...formatConnections(options.ports, connectionIndent, '));'));
    return lines.join('\n');
}
