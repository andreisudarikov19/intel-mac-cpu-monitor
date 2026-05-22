import { describe, it, expect } from "vitest";
import {
    SAMPLE_COUNT_MIN,
    SAMPLE_COUNT_MAX,
    SAMPLE_COUNT_STEP,
    SAMPLE_COUNT_DEFAULT,
    bufferSizeFor,
    clampSampleCount,
} from "../src/hub.js";
import { extractSampleOverride } from "../src/actions/toggle-view.js";

describe("sample-count helpers", () => {
    describe("clampSampleCount", () => {
        it("returns the default for undefined/null/NaN/Infinity", () => {
            expect(clampSampleCount(undefined)).toBe(SAMPLE_COUNT_DEFAULT);
            expect(clampSampleCount(null)).toBe(SAMPLE_COUNT_DEFAULT);
            expect(clampSampleCount(NaN)).toBe(SAMPLE_COUNT_DEFAULT);
            expect(clampSampleCount(Infinity)).toBe(SAMPLE_COUNT_DEFAULT);
        });

        it("clamps below MIN up to MIN", () => {
            expect(clampSampleCount(5)).toBe(SAMPLE_COUNT_MIN);
            expect(clampSampleCount(-100)).toBe(SAMPLE_COUNT_MIN);
        });

        it("clamps above MAX down to MAX", () => {
            expect(clampSampleCount(99)).toBe(SAMPLE_COUNT_MAX);
            expect(clampSampleCount(1000)).toBe(SAMPLE_COUNT_MAX);
        });

        it("snaps to the nearest STEP within range", () => {
            // STEP = 5, so 32 → 30, 33 → 35, 27 → 25, 28 → 30
            expect(clampSampleCount(32)).toBe(30);
            expect(clampSampleCount(33)).toBe(35);
            expect(clampSampleCount(27)).toBe(25);
            expect(clampSampleCount(28)).toBe(30);
            // Exact step values pass through
            expect(clampSampleCount(45)).toBe(45);
        });

        it("constants are self-consistent", () => {
            expect(SAMPLE_COUNT_MIN).toBeLessThan(SAMPLE_COUNT_MAX);
            expect(SAMPLE_COUNT_DEFAULT).toBeGreaterThanOrEqual(SAMPLE_COUNT_MIN);
            expect(SAMPLE_COUNT_DEFAULT).toBeLessThanOrEqual(SAMPLE_COUNT_MAX);
            // Default lands on a STEP boundary
            expect(SAMPLE_COUNT_DEFAULT % SAMPLE_COUNT_STEP).toBe(0);
        });
    });

    describe("bufferSizeFor", () => {
        it("returns visible * 1.5 (rounded up)", () => {
            expect(bufferSizeFor(10)).toBe(15);
            expect(bufferSizeFor(20)).toBe(30);
            expect(bufferSizeFor(30)).toBe(45);
            expect(bufferSizeFor(45)).toBe(68);   // ceil(67.5)
            expect(bufferSizeFor(60)).toBe(90);
        });

        it("never returns less than visible", () => {
            // Sanity: the buffer must hold at least the visible window.
            for (let v = 1; v <= 100; v++) {
                expect(bufferSizeFor(v)).toBeGreaterThanOrEqual(v);
            }
        });
    });

    describe("extractSampleOverride", () => {
        it("returns undefined when scope is global or unset", () => {
            expect(extractSampleOverride({})).toBeUndefined();
            expect(extractSampleOverride({ sampleScope: "global" })).toBeUndefined();
            expect(extractSampleOverride({ sampleScope: "global", sampleCount: 45 })).toBeUndefined();
        });

        it("returns the per-tile value when scope is tile", () => {
            expect(extractSampleOverride({ sampleScope: "tile", sampleCount: 45 })).toBe(45);
        });

        it("returns undefined when scope is tile but no sampleCount is set", () => {
            expect(extractSampleOverride({ sampleScope: "tile" })).toBeUndefined();
        });
    });
});
