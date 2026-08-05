const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function defaultModuleInstanceIdentifier(moduleName: string): string {
    if (SIMPLE_IDENTIFIER.test(moduleName)) {
        return `u_${moduleName}`;
    }
    const source = (moduleName.startsWith('\\') ? moduleName.slice(1) : moduleName).trimEnd();
    const sanitized = source.replace(/[^A-Za-z0-9_$]/g, '_');
    return `u_${sanitized || 'module'}`;
}

export function effectiveModuleInstanceIdentifier(
    moduleName: string,
    instanceName: unknown
): string {
    const normalized = typeof instanceName === 'string' ? instanceName.trim() : '';
    return normalized || defaultModuleInstanceIdentifier(moduleName);
}
