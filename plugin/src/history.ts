// Fixed-capacity ring buffer of (number|null) samples for sparkline rendering.
// null entries are gaps (the renderer skips them).

export class History {
    private buf: (number | null)[];
    private head: number = 0;
    private _length: number = 0;

    constructor(public readonly capacity: number) {
        if (capacity <= 0) throw new Error("History capacity must be positive");
        this.buf = new Array(capacity).fill(null);
    }

    /** Append a sample. If at capacity, the oldest sample is dropped. */
    push(value: number | null): void {
        this.buf[this.head] = value;
        this.head = (this.head + 1) % this.capacity;
        if (this._length < this.capacity) this._length++;
    }

    /** Number of samples held (0..capacity). */
    get length(): number {
        return this._length;
    }

    /**
     * Samples in chronological order (oldest first). Always returns a fresh
     * array of `length` elements. Empty if no samples yet.
     */
    toArray(): (number | null)[] {
        const out: (number | null)[] = new Array(this._length);
        // Oldest entry is at (head - length) mod capacity.
        const start = (this.head - this._length + this.capacity) % this.capacity;
        for (let i = 0; i < this._length; i++) {
            out[i] = this.buf[(start + i) % this.capacity]!;
        }
        return out;
    }

    /** Most recent non-null sample, or null if none. */
    latest(): number | null {
        if (this._length === 0) return null;
        const idx = (this.head - 1 + this.capacity) % this.capacity;
        return this.buf[idx]!;
    }

    /** Reset to empty. Used when the helper restarts with a new catalog. */
    clear(): void {
        this.buf.fill(null);
        this.head = 0;
        this._length = 0;
    }
}
