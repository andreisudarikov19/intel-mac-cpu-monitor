// Fixed-capacity ring buffer of (number|null) samples for sparkline rendering.
// null entries are gaps (the renderer skips them).

export class History {
    private buf: (number | null)[];
    private head: number = 0;
    private _length: number = 0;
    private _capacity: number;

    constructor(capacity: number) {
        if (capacity <= 0) throw new Error("History capacity must be positive");
        this._capacity = capacity;
        this.buf = new Array(capacity).fill(null);
    }

    get capacity(): number {
        return this._capacity;
    }

    /** Resize the ring buffer. Preserves the most recent samples that fit
     *  in the new capacity. Shrinking drops oldest samples; growing keeps
     *  all existing and leaves room for future samples. */
    resize(newCapacity: number): void {
        if (newCapacity <= 0) throw new Error("History capacity must be positive");
        if (newCapacity === this._capacity) return;

        // Materialize the current samples in chronological order, then
        // truncate from the front (drop oldest) if shrinking past length.
        const all = this.toArray();
        const keep = all.length > newCapacity ? all.slice(all.length - newCapacity) : all;

        this._capacity = newCapacity;
        this.buf = new Array(newCapacity).fill(null);
        this._length = keep.length;
        this.head = keep.length % newCapacity;   // next write position
        for (let i = 0; i < keep.length; i++) {
            this.buf[i] = keep[i]!;
        }
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
