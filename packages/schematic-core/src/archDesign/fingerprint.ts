import type { ArchDesign } from './model';
import { serializeArchDesign } from './serializer';

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

function fnv1a64(source: string): string {
    let hash = FNV_OFFSET_BASIS_64;
    for (const byte of new TextEncoder().encode(source)) {
        hash ^= BigInt(byte);
        hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
    }
    return hash.toString(16).padStart(16, '0');
}

export function semanticArchDesignFingerprint(design: ArchDesign): string {
    const semanticDesign: ArchDesign = {
        ...design,
        export: design.export.language ? { language: design.export.language } : {},
        presentation: {},
    };
    return `ad-v1-${fnv1a64(serializeArchDesign(semanticDesign))}`;
}
