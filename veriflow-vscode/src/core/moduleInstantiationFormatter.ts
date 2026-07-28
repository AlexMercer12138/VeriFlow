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
    if (options.parameters.length === 0 || options.ports.length === 0) {
        throw new Error('Empty connection groups are not implemented yet.');
    }

    const baseIndent = '';
    const connectionIndent = `${baseIndent}    `;
    return [
        `${baseIndent}${options.moduleName} #(`,
        ...formatConnections(options.parameters, connectionIndent, '))'),
        `${baseIndent}${options.instanceName} (`,
        ...formatConnections(options.ports, connectionIndent, '));'),
    ].join('\n');
}
