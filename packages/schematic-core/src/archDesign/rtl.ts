import type { ArchDesignModuleDefinition } from './definitions';
import { semanticArchDesignFingerprint } from './fingerprint';
import {
    ARCH_DESIGN_SCHEMA_VERSION,
    type ArchDesign,
    type ArchDesignLanguage,
} from './model';
import type { ArchDesignDiagnostic } from './parser';

export type ArchDesignRtlExportOptions = Readonly<{
    language?: ArchDesignLanguage;
    sourcePath?: string;
}>;

export type ArchDesignRtlMarker = Readonly<{
    schemaVersion: number;
    fingerprint: string;
    language: ArchDesignLanguage;
}>;

export type ArchDesignRtlExportResult =
    | Readonly<{
        status: 'generated';
        language: ArchDesignLanguage;
        extension: '.v' | '.sv';
        fingerprint: string;
        marker: string;
        text: string;
    }>
    | Readonly<{
        status: 'invalid';
        diagnostics: readonly ArchDesignDiagnostic[];
    }>;

const GENERATED_MARKER = /^\/\/ vik-veriflow:generated arch-design schema=(\d+) fingerprint=(ad-v1-[0-9a-f]{16}) language=(verilog|systemverilog)(?:\r?\n|$)/;

export function parseArchDesignRtlMarker(text: string): ArchDesignRtlMarker | undefined {
    const match = GENERATED_MARKER.exec(text);
    if (!match) return undefined;
    return Object.freeze({
        schemaVersion: Number(match[1]),
        fingerprint: match[2],
        language: match[3] as ArchDesignLanguage,
    });
}

export function exportArchDesignRtl(
    design: ArchDesign,
    _definitions: readonly ArchDesignModuleDefinition[],
    options: ArchDesignRtlExportOptions = {}
): ArchDesignRtlExportResult {
    const language = options.language ?? design.export.language ?? 'verilog';
    const fingerprint = semanticArchDesignFingerprint({
        ...design,
        export: { ...design.export, language },
    });
    const marker = [
        '// vik-veriflow:generated arch-design',
        `schema=${ARCH_DESIGN_SCHEMA_VERSION}`,
        `fingerprint=${fingerprint}`,
        `language=${language}`,
    ].join(' ');
    const sourcePath = options.sourcePath ?? '<memory>';
    const text = [
        marker,
        `// vik-veriflow:source ${JSON.stringify(sourcePath)}`,
        '',
        `module ${design.module};`,
        'endmodule',
        '',
    ].join('\n');
    return Object.freeze({
        status: 'generated',
        language,
        extension: language === 'verilog' ? '.v' : '.sv',
        fingerprint,
        marker,
        text,
    });
}
