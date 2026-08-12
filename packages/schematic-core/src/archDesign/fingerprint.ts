import type { InterfaceProtocolCatalog } from '../interfaces';
import type { ArchDesign } from './model';
import { fnv1a64 } from './hash';
import { serializeArchDesign } from './serializer';

function effectiveProtocolSnapshot(catalog: InterfaceProtocolCatalog): string {
    return JSON.stringify(catalog.entries.map(entry => ({
        format: entry.protocol.format,
        schemaVersion: entry.protocol.schemaVersion,
        id: entry.protocol.id,
        name: entry.protocol.name,
        separator: entry.protocol.separator,
        priority: entry.protocol.priority,
        members: entry.protocol.members.map(member => ({
            name: member.name,
            ...(member.aliases === undefined ? {} : { aliases: [...member.aliases] }),
            direction: member.direction,
            ...(member.defaultExpression === undefined
                ? {}
                : { defaultExpression: member.defaultExpression }),
        })),
        recognitionGroups: entry.protocol.recognitionGroups.map(group => [...group]),
    })));
}

export function semanticArchDesignFingerprint(
    design: ArchDesign,
    interfaceCatalog?: InterfaceProtocolCatalog
): string {
    const semanticDesign: ArchDesign = {
        ...design,
        export: design.export.language ? { language: design.export.language } : {},
        presentation: {},
    };
    const parts = [serializeArchDesign(semanticDesign)];
    if (interfaceCatalog) parts.push(effectiveProtocolSnapshot(interfaceCatalog));
    return `ad-v1-${fnv1a64(parts.join('\n'))}`;
}
