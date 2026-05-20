import { describe, it, expect } from "vitest";
import { History } from "../src/history.js";

describe("History ring buffer", () => {
    it("starts empty", () => {
        const h = new History(60);
        expect(h.length).toBe(0);
        expect(h.toArray()).toEqual([]);
        expect(h.latest()).toBeNull();
    });

    it("rejects non-positive capacity", () => {
        expect(() => new History(0)).toThrow();
        expect(() => new History(-1)).toThrow();
    });

    it("accumulates samples below capacity in chronological order", () => {
        const h = new History(5);
        h.push(10);
        h.push(20);
        h.push(30);
        expect(h.length).toBe(3);
        expect(h.toArray()).toEqual([10, 20, 30]);
        expect(h.latest()).toBe(30);
    });

    it("rotates correctly once capacity is reached", () => {
        const h = new History(3);
        h.push(1);
        h.push(2);
        h.push(3);
        h.push(4);  // evicts 1
        expect(h.length).toBe(3);
        expect(h.toArray()).toEqual([2, 3, 4]);
        h.push(5);  // evicts 2
        expect(h.toArray()).toEqual([3, 4, 5]);
        expect(h.latest()).toBe(5);
    });

    it("preserves null gaps for stale data", () => {
        // The plugin pushes null when the helper goes silent. The renderer
        // must see those gaps so it can draw discontinuous segments.
        const h = new History(5);
        h.push(40);
        h.push(null);
        h.push(42);
        expect(h.toArray()).toEqual([40, null, 42]);
        expect(h.latest()).toBe(42);
    });

    it("returns null from latest() when only nulls are pushed", () => {
        const h = new History(3);
        h.push(null);
        h.push(null);
        expect(h.latest()).toBeNull();
    });

    it("toArray returns a fresh copy on each call", () => {
        const h = new History(3);
        h.push(1);
        h.push(2);
        const a = h.toArray();
        const b = h.toArray();
        expect(a).toEqual(b);
        expect(a).not.toBe(b);
        a.push(999);
        expect(h.toArray()).toEqual([1, 2]);
    });

    it("clear() resets to empty", () => {
        const h = new History(3);
        h.push(1);
        h.push(2);
        h.clear();
        expect(h.length).toBe(0);
        expect(h.toArray()).toEqual([]);
        expect(h.latest()).toBeNull();
        // And subsequent pushes work normally afterwards
        h.push(99);
        expect(h.toArray()).toEqual([99]);
    });

    it("survives a heavy rotation pattern (regression for ring math)", () => {
        // Catch off-by-one errors in the modular arithmetic by pushing
        // many more than capacity and verifying the trailing window is
        // exactly correct.
        const cap = 60;
        const h = new History(cap);
        for (let i = 0; i < 1000; i++) h.push(i);
        const out = h.toArray();
        expect(out).toHaveLength(cap);
        expect(out[0]).toBe(940);
        expect(out[cap - 1]).toBe(999);
    });
});
