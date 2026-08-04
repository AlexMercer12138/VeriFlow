export type ParsePriority = 'interactive' | 'background';

export class ParserRequestQueue<
    T extends { requestId: string; priority: ParsePriority }
> {
    private readonly interactive: T[] = [];
    private readonly background: T[] = [];

    enqueue(request: T): void {
        this.queueFor(request.priority).push(request);
    }

    cancel(requestId: string): boolean {
        return this.removeFrom(this.interactive, requestId)
            || this.removeFrom(this.background, requestId);
    }

    takeNext(): T | undefined {
        return this.interactive.shift() ?? this.background.shift();
    }

    clear(): T[] {
        const cleared = [...this.interactive, ...this.background];
        this.interactive.length = 0;
        this.background.length = 0;
        return cleared;
    }

    get size(): number {
        return this.interactive.length + this.background.length;
    }

    private queueFor(priority: ParsePriority): T[] {
        return priority === 'interactive' ? this.interactive : this.background;
    }

    private removeFrom(queue: T[], requestId: string): boolean {
        const index = queue.findIndex(request => request.requestId === requestId);
        if (index < 0) {
            return false;
        }
        queue.splice(index, 1);
        return true;
    }
}
