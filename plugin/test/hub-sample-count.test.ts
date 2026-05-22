import { describe, it, expect, beforeEach } from "vitest";
import { Hub, SAMPLE_COUNT_DEFAULT, bufferSizeFor } from "../src/hub.js";

/**
 * Integration tests for the user-facing v1.3 sample-count behavior.
 * Verifies the override → no-override transition that the user
 * specifically asked to validate after the v1.3.2 UI regression.
 *
 * Does NOT start the helper supervisor — just exercises Hub's subscribe
 * lifecycle directly, which is the unit of behavior we care about.
 */

describe("Hub sample-count override transitions", () => {
    let hub: Hub;
    const ctx = "test-context";
    const subscriber = {
        contextId: ctx,
        // No-op image push; we're testing subscription state, not rendering.
        setImage: () => Promise.resolve(),
    };

    beforeEach(() => {
        hub = new Hub();
    });

    it("uses the plugin default when no override is given", () => {
        hub.subscribe(subscriber, { kind: "cpu" });
        expect(hub.getVisibleSampleCount(ctx)).toBe(SAMPLE_COUNT_DEFAULT);
        expect(hub.getBufferCapacity(ctx)).toBe(bufferSizeFor(SAMPLE_COUNT_DEFAULT));
    });

    it("uses the override when given", () => {
        hub.subscribe(subscriber, { kind: "cpu" }, "graph", 60);
        expect(hub.getVisibleSampleCount(ctx)).toBe(60);
        expect(hub.getBufferCapacity(ctx)).toBe(bufferSizeFor(60));
    });

    it("REVERTS to the plugin default when a previously-set override is cleared (user-reported bug 2)", () => {
        // Setup: subscribe with an override of 60 (the "This key only" case)
        hub.subscribe(subscriber, { kind: "cpu" }, "graph", 60);
        expect(hub.getVisibleSampleCount(ctx)).toBe(60);
        expect(hub.getBufferCapacity(ctx)).toBe(bufferSizeFor(60));   // 90

        // User flips PI scope back to "Plugin default" — extractSampleOverride
        // returns undefined; onDidReceiveSettings calls hub.subscribe with
        // undefined as the override.
        hub.subscribe(subscriber, { kind: "cpu" }, "graph", undefined);

        // The subscription's effective visible count must snap back to the
        // plugin default (30), and the buffer must resize accordingly.
        expect(hub.getVisibleSampleCount(ctx)).toBe(SAMPLE_COUNT_DEFAULT);
        expect(hub.getBufferCapacity(ctx)).toBe(bufferSizeFor(SAMPLE_COUNT_DEFAULT));   // 45
    });

    it("changing the plugin default also updates subscriptions that follow it", () => {
        // Two subscriptions: one with override 50, one without.
        const ctxA = "ctx-a", ctxB = "ctx-b";
        hub.subscribe(
            { contextId: ctxA, setImage: () => Promise.resolve() },
            { kind: "cpu" }, "graph", 50,
        );
        hub.subscribe(
            { contextId: ctxB, setImage: () => Promise.resolve() },
            { kind: "gpu" }, "graph", undefined,
        );
        expect(hub.getVisibleSampleCount(ctxA)).toBe(50);
        expect(hub.getVisibleSampleCount(ctxB)).toBe(SAMPLE_COUNT_DEFAULT);

        // Plugin default changes to 45 globally.
        hub.setGlobalSettings({ defaultSampleCount: 45 });

        // ctxA (overridden) should stay at 50; ctxB (follows default) should
        // move to 45.
        expect(hub.getVisibleSampleCount(ctxA)).toBe(50);
        expect(hub.getVisibleSampleCount(ctxB)).toBe(45);
    });

    it("override clamps + snaps invalid values to the slider's permitted set", () => {
        // Hand the hub a value that's outside the slider's range (e.g.
        // some old setting carried over from a hypothetical earlier
        // version). The hub should clamp it.
        hub.subscribe(subscriber, { kind: "cpu" }, "graph", 999);
        expect(hub.getVisibleSampleCount(ctx)).toBeLessThanOrEqual(60);
        // And below the min:
        hub.subscribe(subscriber, { kind: "cpu" }, "graph", 1);
        expect(hub.getVisibleSampleCount(ctx)).toBeGreaterThanOrEqual(15);
    });
});
