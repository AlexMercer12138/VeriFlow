export type ArchDesignCommandServices<Resource> = Readonly<{
    isResource(value: unknown): value is Resource;
    openEditor(resource: Resource): PromiseLike<void>;
    validate(resource?: Resource): PromiseLike<void>;
    exportRtl(resource?: Resource): PromiseLike<void>;
}>;

export type ArchDesignCommandHandlers = Readonly<{
    open(value?: unknown): Promise<void>;
    validate(value?: unknown): Promise<void>;
    exportRtl(value?: unknown): Promise<void>;
}>;

function commandResource<Resource>(
    value: unknown,
    isResource: (candidate: unknown) => candidate is Resource
): Resource | undefined {
    if (isResource(value)) return value;
    if (value === null || typeof value !== 'object') return undefined;
    const resource = (value as { resourceUri?: unknown }).resourceUri;
    return isResource(resource) ? resource : undefined;
}

export function createArchDesignCommandHandlers<Resource>(
    services: ArchDesignCommandServices<Resource>
): ArchDesignCommandHandlers {
    const resource = (value: unknown): Resource | undefined =>
        commandResource(value, services.isResource);
    const run = async (
        value: unknown,
        action: (target?: Resource) => PromiseLike<void>
    ): Promise<void> => {
        const target = resource(value);
        if (target) await services.openEditor(target);
        await action(target);
    };

    return Object.freeze({
        async open(value?: unknown): Promise<void> {
            const target = resource(value);
            if (target) await services.openEditor(target);
        },
        validate: value => run(value, services.validate),
        exportRtl: value => run(value, services.exportRtl),
    });
}
