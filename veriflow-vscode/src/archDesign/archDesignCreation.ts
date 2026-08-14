import { createEmptyArchDesignText } from '@veriflow/schematic-core/arch-design';

export type ArchDesignModuleValidator = (value: string) => string | undefined;

export type ArchDesignCreationServices<Resource> = Readonly<{
    requestModule(
        validate: ArchDesignModuleValidator
    ): PromiseLike<string | undefined>;
    requestTarget(module: string): PromiseLike<Resource | undefined>;
    writeFile(target: Resource, text: string): PromiseLike<void>;
    openEditor(target: Resource): PromiseLike<void>;
    reportError(message: string): PromiseLike<void>;
}>;

export function validateArchDesignModule(value: string): string | undefined {
    try {
        createEmptyArchDesignText(value);
        return undefined;
    } catch {
        return 'Enter a valid Verilog module name';
    }
}

export async function createArchDesign<Resource>(
    services: ArchDesignCreationServices<Resource>
): Promise<Resource | undefined> {
    const module = await services.requestModule(validateArchDesignModule);
    if (module === undefined) return undefined;

    const text = createEmptyArchDesignText(module);
    const target = await services.requestTarget(module);
    if (target === undefined) return undefined;

    try {
        await services.writeFile(target, text);
        await services.openEditor(target);
        return target;
    } catch (error) {
        await services.reportError(
            error instanceof Error ? error.message : String(error)
        );
        return undefined;
    }
}
