import type { ArchDesign } from './model';
import { fnv1a64 } from './hash';
import { serializeArchDesign } from './serializer';

export function semanticArchDesignFingerprint(design: ArchDesign): string {
    const semanticDesign: ArchDesign = {
        ...design,
        export: design.export.language ? { language: design.export.language } : {},
        presentation: {},
    };
    return `ad-v1-${fnv1a64(serializeArchDesign(semanticDesign))}`;
}
