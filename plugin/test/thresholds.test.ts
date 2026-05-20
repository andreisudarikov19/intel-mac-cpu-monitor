import { describe, it, expect } from "vitest";
import {
    tempBand,
    fanBand,
    cToF,
    COLORS,
    TEMP_RANGE,
} from "../src/thresholds.js";

describe("temperature bands", () => {
    it("classifies ≤60°C as cool", () => {
        expect(tempBand(30)).toBe("cool");
        expect(tempBand(59.9)).toBe("cool");
        expect(tempBand(60)).toBe("cool");
    });

    it("classifies 60.x..80°C as warm", () => {
        expect(tempBand(60.1)).toBe("warm");
        expect(tempBand(70)).toBe("warm");
        expect(tempBand(80)).toBe("warm");
    });

    it("classifies 80.x..95°C as hot", () => {
        expect(tempBand(80.1)).toBe("hot");
        expect(tempBand(90)).toBe("hot");
        expect(tempBand(95)).toBe("hot");
    });

    it("classifies >95°C as critical", () => {
        expect(tempBand(95.1)).toBe("critical");
        expect(tempBand(100)).toBe("critical");
        expect(tempBand(150)).toBe("critical");  // implausible but must not crash
    });

    it("handles negative input as cool (sanity)", () => {
        expect(tempBand(-5)).toBe("cool");
    });
});

describe("fan bands", () => {
    it("classifies ≤30% max as cool", () => {
        expect(fanBand(0, 6000)).toBe("cool");
        expect(fanBand(1800, 6000)).toBe("cool");        // exactly 30%
    });

    it("classifies 30%..70% as warm", () => {
        expect(fanBand(1801, 6000)).toBe("warm");
        expect(fanBand(4200, 6000)).toBe("warm");        // exactly 70%
    });

    it("classifies 70%..100% as hot", () => {
        expect(fanBand(4201, 6000)).toBe("hot");
        expect(fanBand(6000, 6000)).toBe("hot");
    });

    it("classifies >100% as critical (fan running above its declared max)", () => {
        expect(fanBand(6001, 6000)).toBe("critical");
    });

    it("treats zero/negative max defensively", () => {
        // A miscatalogued fan with max=0 must not blow up
        expect(fanBand(1000, 0)).toBe("cool");
        expect(fanBand(1000, -1)).toBe("cool");
    });
});

describe("unit conversion", () => {
    it("c -> F is correct", () => {
        expect(cToF(0)).toBe(32);
        expect(cToF(100)).toBe(212);
        expect(cToF(-40)).toBe(-40);
        expect(cToF(45.3125)).toBeCloseTo(113.5625, 4);
    });
});

describe("constants", () => {
    it("color palette is complete", () => {
        // Every band must have a color or the renderer crashes.
        expect(COLORS.cool).toMatch(/^#[0-9a-f]{6}$/i);
        expect(COLORS.warm).toMatch(/^#[0-9a-f]{6}$/i);
        expect(COLORS.hot).toMatch(/^#[0-9a-f]{6}$/i);
        expect(COLORS.critical).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it("TEMP_RANGE matches spec (30–100°C)", () => {
        expect(TEMP_RANGE).toEqual({ min: 30, max: 100 });
    });
});
