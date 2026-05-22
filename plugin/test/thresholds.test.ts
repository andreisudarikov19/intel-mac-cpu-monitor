import { describe, it, expect } from "vitest";
import {
    tempBand,
    tempBandFor,
    bandFor,
    fanBand,
    fanProfileFor,
    cToF,
    COLORS,
    TEMP_RANGE,
    TEMP_PROFILES,
    POWER_PROFILES,
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

describe("fan bands (v1.5 — usable range)", () => {
    // Reference iMac 27" fan: min 1200, max 2700 → usable 1500.
    // Band cutoffs at 40 / 70 / 90 % of usable above min:
    //   coolMax = 1200 + 600 = 1800
    //   warmMax = 1200 + 1050 = 2250
    //   hotMax  = 1200 + 1350 = 2550
    it("idle (= min RPM) is cool — fixes v1.4 'yellow at idle' bug", () => {
        expect(fanBand(1200, 1200, 2700)).toBe("cool");
    });

    it("≤ 40% above min is cool", () => {
        expect(fanBand(1500, 1200, 2700)).toBe("cool");   // 20% above min
        expect(fanBand(1800, 1200, 2700)).toBe("cool");   // exactly 40%
    });

    it("40%..70% above min is warm", () => {
        expect(fanBand(1801, 1200, 2700)).toBe("warm");
        expect(fanBand(2250, 1200, 2700)).toBe("warm");   // exactly 70%
    });

    it("70%..90% above min is hot", () => {
        expect(fanBand(2251, 1200, 2700)).toBe("hot");
        expect(fanBand(2550, 1200, 2700)).toBe("hot");    // exactly 90%
    });

    it("> 90% above min is critical (fan close to or beyond rated max)", () => {
        expect(fanBand(2551, 1200, 2700)).toBe("critical");
        expect(fanBand(2700, 1200, 2700)).toBe("critical");
        expect(fanBand(3000, 1200, 2700)).toBe("critical");    // beyond rated max
    });

    it("treats zero/negative usable range defensively", () => {
        // A miscatalogued fan with min >= max must not blow up
        expect(fanBand(1000, 1500, 1500)).toBe("cool");
        expect(fanBand(1000, 2000, 1000)).toBe("cool");
    });
});

describe("fanProfileFor (v1.5)", () => {
    it("builds a per-fan profile with range = (min, max) and 40/70/90 thresholds", () => {
        const p = fanProfileFor(1200, 2700);
        expect(p.range.min).toBe(1200);
        expect(p.range.max).toBe(2700);
        expect(p.coolMax).toBeCloseTo(1800);
        expect(p.warmMax).toBeCloseTo(2250);
        expect(p.hotMax).toBeCloseTo(2550);
    });

    it("clamps degenerate min ≥ max to a 1-RPM usable range (no division by zero)", () => {
        const p = fanProfileFor(2000, 2000);
        expect(p.range.max).toBe(2000);
        // coolMax just above min — degenerate but doesn't crash
        expect(p.coolMax).toBeGreaterThan(p.range.min);
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
        expect(COLORS.cold).toMatch(/^#[0-9a-f]{6}$/i);
        expect(COLORS.cool).toMatch(/^#[0-9a-f]{6}$/i);
        expect(COLORS.warm).toMatch(/^#[0-9a-f]{6}$/i);
        expect(COLORS.hot).toMatch(/^#[0-9a-f]{6}$/i);
        expect(COLORS.critical).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it("legacy TEMP_RANGE matches CPU profile (30–100°C)", () => {
        expect(TEMP_RANGE).toEqual({ min: 30, max: 100 });
        expect(TEMP_PROFILES.cpu.range).toEqual({ min: 30, max: 100 });
    });
});

describe("per-sensor temperature profiles", () => {
    // Each sensor type has its own band thresholds tuned to that sensor's
    // typical operating range. The renderer's Y-axis uses each profile's
    // range so the graph is meaningfully filled at idle.

    it("ambient: includes a 'cold' band below 20°C", () => {
        const p = TEMP_PROFILES.ambient;
        // 13°C (our test hardware's actual ambient reading) must be cold.
        expect(tempBandFor(13, p)).toBe("cold");
        // 0°C and 19°C also cold.
        expect(tempBandFor(0, p)).toBe("cold");
        expect(tempBandFor(19, p)).toBe("cold");
        // 20°C is still cold (≤ coldMax).
        expect(tempBandFor(20, p)).toBe("cold");
        // 20.1°C tips into cool.
        expect(tempBandFor(20.1, p)).toBe("cool");
    });

    it("ambient: cool/warm/hot/critical thresholds on a 0–100°C range", () => {
        const p = TEMP_PROFILES.ambient;
        // Typical room (22°C) → cool
        expect(tempBandFor(22, p)).toBe("cool");
        // Comfortable upper bound (30°C) → cool
        expect(tempBandFor(30, p)).toBe("cool");
        // Hot day / sun-warmed intake (40°C) → warm
        expect(tempBandFor(40, p)).toBe("warm");
        // Definitely too warm (60°C) → hot
        expect(tempBandFor(60, p)).toBe("hot");
        // Failure territory (80°C) → critical
        expect(tempBandFor(80, p)).toBe("critical");
    });

    it("ambient: range is 0–100°C to match CPU/GPU height semantics", () => {
        // Cross-sensor visual comparability: same line height = same
        // fraction of range across every temp action.
        expect(TEMP_PROFILES.ambient.range).toEqual({ min: 0, max: 100 });
    });

    it("non-ambient profiles never enter the cold band", () => {
        // CPU/GPU/RAM/SSD/chipset/wifi/tbolt have no coldMax, so even
        // -50°C (nonsensical for an Intel Mac) reads as "cool", not "cold".
        expect(tempBandFor(-50, TEMP_PROFILES.cpu)).toBe("cool");
        expect(tempBandFor(-50, TEMP_PROFILES.gpu)).toBe("cool");
        expect(tempBandFor(-50, TEMP_PROFILES.ram)).toBe("cool");
        expect(tempBandFor(-50, TEMP_PROFILES.ssd)).toBe("cool");
        expect(tempBandFor(-50, TEMP_PROFILES.chipset)).toBe("cool");
        expect(tempBandFor(-50, TEMP_PROFILES.wifi)).toBe("cool");
        expect(tempBandFor(-50, TEMP_PROFILES.thunderbolt)).toBe("cool");
    });

    it("chipset/wifi/thunderbolt profiles have sensible bands", () => {
        // Chipset runs hot — 65°C still cool, 90°C hot.
        expect(tempBandFor(65, TEMP_PROFILES.chipset)).toBe("cool");
        expect(tempBandFor(85, TEMP_PROFILES.chipset)).toBe("hot");
        // Wi-Fi: 45°C cool, 70°C hot.
        expect(tempBandFor(45, TEMP_PROFILES.wifi)).toBe("cool");
        expect(tempBandFor(70, TEMP_PROFILES.wifi)).toBe("hot");
        // Thunderbolt: 50°C cool, 75°C hot.
        expect(tempBandFor(50, TEMP_PROFILES.thunderbolt)).toBe("cool");
        expect(tempBandFor(75, TEMP_PROFILES.thunderbolt)).toBe("hot");
    });

    it("ram: idle RAM (~38°C) stays cool; throttle territory (~75°C) is hot+", () => {
        const p = TEMP_PROFILES.ram;
        expect(tempBandFor(38, p)).toBe("cool");
        expect(tempBandFor(75, p)).toBe("hot");
        expect(tempBandFor(85, p)).toBe("critical");
    });

    it("ssd: same thresholds as RAM (similar thermal envelope)", () => {
        expect(TEMP_PROFILES.ssd).toEqual(TEMP_PROFILES.ram);
    });

    it("cpu profile matches the legacy tempBand exactly", () => {
        // The legacy tempBand function must remain a CPU-profile alias so
        // older call sites don't drift.
        for (const c of [30, 60, 60.1, 80, 80.1, 95, 95.1, 110]) {
            expect(tempBand(c)).toBe(tempBandFor(c, TEMP_PROFILES.cpu));
        }
    });
});

describe("power profiles", () => {
    // CPU thresholds tuned against actual Intel Mac TDPs: laptops 15–45 W,
    // iMac 21.5"/Mac mini 65 W, iMac 27" 6/8-core 95 W, iMac 27" 10-core
    // 125 W (the reference machine for "full-scale" on the meter).

    it("CPU power: 10W laptop idle cool, 45W laptop full warm, 95W iMac hot, 110W boost critical", () => {
        const p = POWER_PROFILES.cpu;
        expect(bandFor(10, p)).toBe("cool");       // any laptop idle
        expect(bandFor(40, p)).toBe("cool");       // 13" MBP TDP
        expect(bandFor(45, p)).toBe("warm");       // 16" MBP TDP
        expect(bandFor(95, p)).toBe("hot");        // iMac 27" 8-core TDP
        expect(bandFor(110, p)).toBe("critical");  // sustained boost on 10-core
    });

    it("CPU power: range fits the 10-core iMac so its peak boost fills the meter", () => {
        // 125 W TDP, ~170 W peak boost. Range max = 125 means peak boost
        // overflows into "critical" rather than running off-screen.
        expect(POWER_PROFILES.cpu.range.max).toBe(125);
    });

    it("GPU power: 5W idle cool, 50W warm, 120W hot, 140W critical", () => {
        const p = POWER_PROFILES.gpu;
        expect(bandFor(5, p)).toBe("cool");        // integrated GPU idle
        expect(bandFor(25, p)).toBe("cool");       // integrated GPU full
        expect(bandFor(50, p)).toBe("warm");       // moderate discrete load
        expect(bandFor(120, p)).toBe("hot");       // heavy discrete load
        expect(bandFor(140, p)).toBe("critical");  // above 130W TDP threshold
    });

    it("GPU power: range fits Radeon Pro 5700 XT (the high-end iMac 27\" 2020)", () => {
        expect(POWER_PROFILES.gpu.range.max).toBe(150);
        expect(POWER_PROFILES.gpu.hotMax).toBe(130);  // = 5700 XT TDP
    });

    it("power profiles never enter the cold band (only ambient air does)", () => {
        // 0 W reads as cool, never cold.
        expect(bandFor(0, POWER_PROFILES.cpu)).toBe("cool");
        expect(bandFor(0, POWER_PROFILES.gpu)).toBe("cool");
    });
});
