import { describe, it, expect } from "vitest";
import { isHelperEvent } from "../src/helper-protocol.js";

describe("isHelperEvent type predicate", () => {
    it("accepts ready", () => {
        expect(isHelperEvent({
            event: "ready", arch: "x86_64", t2: true,
            cpuCores: [], fans: [],
        })).toBe(true);
    });

    it("accepts reading", () => {
        expect(isHelperEvent({
            event: "reading", ts: 1, cpu: {}, fans: [],
        })).toBe(true);
    });

    it("accepts unsupported", () => {
        expect(isHelperEvent({ event: "unsupported", reason: "x" })).toBe(true);
    });

    it("accepts error", () => {
        expect(isHelperEvent({ event: "error", message: "x" })).toBe(true);
    });

    it("rejects unknown event names", () => {
        expect(isHelperEvent({ event: "spam" })).toBe(false);
        expect(isHelperEvent({ event: "" })).toBe(false);
    });

    it("rejects non-objects", () => {
        expect(isHelperEvent(null)).toBe(false);
        expect(isHelperEvent(undefined)).toBe(false);
        expect(isHelperEvent(42)).toBe(false);
        expect(isHelperEvent("ready")).toBe(false);
        expect(isHelperEvent([])).toBe(false);
    });

    it("rejects objects missing the event discriminator", () => {
        expect(isHelperEvent({})).toBe(false);
        expect(isHelperEvent({ ts: 1 })).toBe(false);
    });

    it("rejects a ready event missing required fields", () => {
        expect(isHelperEvent({ event: "ready" })).toBe(false);
        // Missing cpuCores
        expect(isHelperEvent({ event: "ready", arch: "x86_64", t2: true, fans: [] })).toBe(false);
        // arch as number
        expect(isHelperEvent({ event: "ready", arch: 1, t2: true, cpuCores: [], fans: [] })).toBe(false);
    });

    it("rejects a reading event with wrong-typed required fields", () => {
        // ts must be number
        expect(isHelperEvent({ event: "reading", ts: "1", cpu: {}, fans: [] })).toBe(false);
        // cpu must be object (this is the malformed case that previously
        // could crash hub.extractMetric)
        expect(isHelperEvent({ event: "reading", ts: 1, cpu: "not an object", fans: [] })).toBe(false);
        // fans must be array
        expect(isHelperEvent({ event: "reading", ts: 1, cpu: {}, fans: "not an array" })).toBe(false);
    });

    it("rejects an unsupported event without reason", () => {
        expect(isHelperEvent({ event: "unsupported" })).toBe(false);
        expect(isHelperEvent({ event: "unsupported", reason: 42 })).toBe(false);
    });

    it("parses a real ready-event line emitted by the Swift helper", () => {
        // Real line captured from the helper on the test hardware.
        const line = '{"arch":"x86_64","cpuCores":[{"index":0,"key":"TC0c"}],"cpuPackageKey":"TC0P","event":"ready","fans":[{"index":0,"max":2700,"min":1200}],"gpuSensor":"TG0D","t2":true}';
        const parsed = JSON.parse(line);
        expect(isHelperEvent(parsed)).toBe(true);
        expect(parsed.event).toBe("ready");
    });

    it("parses a real reading-event line", () => {
        const line = '{"cpu":{"TC0c":53,"TC1c":53},"cpuAvg":53,"cpuPackage":45.3125,"event":"reading","fans":[{"i":0,"rpm":1201}],"gpu":51,"ts":1779295157}';
        const parsed = JSON.parse(line);
        expect(isHelperEvent(parsed)).toBe(true);
        if (parsed.event === "reading") {
            expect(parsed.cpu.TC0c).toBe(53);
            expect(parsed.fans[0].rpm).toBe(1201);
            // Swift omits nil optionals — the field is genuinely absent, not null
            expect("cpuPackage" in parsed).toBe(true);
        }
    });

    it("parses a real reading line with ambient/ram/ssd fields", () => {
        // Real line captured from the test hardware after v1.2 sensors added.
        const line = '{"ambient":12.6875,"cpu":{"TC0c":53},"cpuAvg":53,"cpuPackage":43.0625,"event":"reading","fans":[{"i":0,"rpm":1204}],"gpu":45,"ram":37.625,"ssd":37.05078125,"ts":1779307678}';
        const parsed = JSON.parse(line);
        expect(isHelperEvent(parsed)).toBe(true);
        if (parsed.event === "reading") {
            expect(parsed.ambient).toBeCloseTo(12.6875, 4);
            expect(parsed.ram).toBeCloseTo(37.625, 3);
            expect(parsed.ssd).toBeCloseTo(37.05, 1);
        }
    });

    it("accepts a reading line where the new fields are absent (older helpers)", () => {
        // A helper that doesn't emit ambient/ram/ssd still produces a
        // valid event; isHelperEvent must accept it.
        const line = '{"cpu":{"TC0c":53},"event":"reading","fans":[{"i":0,"rpm":1201}],"ts":1}';
        const parsed = JSON.parse(line);
        expect(isHelperEvent(parsed)).toBe(true);
    });
});
