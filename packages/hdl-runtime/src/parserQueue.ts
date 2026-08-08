export type ParsePriority = 'interactive' | 'background';

class RequestLane<T extends { requestId: string }> {
    private items: Array<T | undefined> = [];
    private head = 0;
    private queued = 0;

    enqueue(request: T): void {
        this.items.push(request);
        this.queued++;
    }

    cancel(requestId: string): boolean {
        for (let index = this.head; index < this.items.length; index++) {
            if (this.items[index]?.requestId === requestId) {
                this.items[index] = undefined;
                this.queued--;
                this.compact();
                return true;
            }
        }
        return false;
    }

    takeNext(): T | undefined {
        while (this.head < this.items.length) {
            const request = this.items[this.head];
            this.items[this.head] = undefined;
            this.head++;
            if (request) {
                this.queued--;
                this.compact();
                return request;
            }
        }
        this.compact();
        return undefined;
    }

    clear(): T[] {
        const cleared: T[] = [];
        for (let index = this.head; index < this.items.length; index++) {
            const request = this.items[index];
            if (request) {
                cleared.push(request);
            }
        }
        this.items = [];
        this.head = 0;
        this.queued = 0;
        return cleared;
    }

    get size(): number {
        return this.queued;
    }

    private compact(): void {
        if (this.queued === 0) {
            this.items = [];
            this.head = 0;
        } else if (this.head >= 1_024 && this.head * 2 >= this.items.length) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }
    }
}

export class ParserRequestQueue<
    T extends { requestId: string; priority: ParsePriority }
> {
    private readonly interactive = new RequestLane<T>();
    private readonly background = new RequestLane<T>();

    enqueue(request: T): void {
        this.queueFor(request.priority).enqueue(request);
    }

    cancel(requestId: string): boolean {
        return this.interactive.cancel(requestId)
            || this.background.cancel(requestId);
    }

    takeNext(): T | undefined {
        return this.interactive.takeNext() ?? this.background.takeNext();
    }

    clear(): T[] {
        return [...this.interactive.clear(), ...this.background.clear()];
    }

    get size(): number {
        return this.interactive.size + this.background.size;
    }

    private queueFor(priority: ParsePriority): RequestLane<T> {
        return priority === 'interactive' ? this.interactive : this.background;
    }
}
