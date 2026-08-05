export type SchematicBuildSnapshot<TDocument> = {
    generation: number;
    document: TDocument;
    moduleKey: string;
};

export function isCurrentSchematicRefresh(
    generation: number,
    currentGeneration: number,
    disposed: boolean,
    cancelled: boolean
): boolean {
    return generation === currentGeneration && !disposed && !cancelled;
}

export class SchematicBuildGeneration<TDocument> {
    private generation = 0;

    begin(document: TDocument, moduleKey: string): SchematicBuildSnapshot<TDocument> {
        return {
            generation: ++this.generation,
            document,
            moduleKey,
        };
    }

    isCurrent(
        snapshot: SchematicBuildSnapshot<TDocument>,
        document: TDocument | undefined,
        moduleKey: string | undefined
    ): boolean {
        return snapshot.generation === this.generation
            && snapshot.document === document
            && snapshot.moduleKey === moduleKey;
    }

    invalidate(): void {
        this.generation++;
    }
}
