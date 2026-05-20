import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HelperSupervisor, type SupervisorCallbacks } from "../src/helper-supervisor.js";

const FAKE_HELPER = resolve(
    fileURLToPath(import.meta.url),
    "..",
    "fixtures",
    "fake-helper.mjs",
);

// The supervisor accepts only one binaryPath (no extra argv), so we wrap
// the fake helper in a per-mode shim script that hard-codes the mode.
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function shimFor(mode: string): string {
    const dir = mkdtempSync(join(tmpdir(), "smcreader-shim-"));
    const sh = join(dir, "smcreader");
    writeFileSync(sh, `#!/bin/sh\nexec node ${JSON.stringify(FAKE_HELPER)} ${mode}\n`);
    chmodSync(sh, 0o755);
    return sh;
}

function makeSupervisorForMode(
    mode: string,
    cb: Partial<SupervisorCallbacks> = {},
    overrides: { staleAfterMs?: number; initialReadyTimeoutMs?: number; backoffBaseMs?: number; backoffMaxMs?: number } = {},
): HelperSupervisor {
    return new HelperSupervisor(
        {
            binaryPath: shimFor(mode),
            staleAfterMs: overrides.staleAfterMs ?? 5000,
            initialReadyTimeoutMs: overrides.initialReadyTimeoutMs ?? 5000,
            backoffBaseMs: overrides.backoffBaseMs ?? 50,
            backoffMaxMs: overrides.backoffMaxMs ?? 200,
        },
        {
            onReady: cb.onReady ?? (() => {}),
            onReading: cb.onReading ?? (() => {}),
            onUnsupported: cb.onUnsupported ?? (() => {}),
            onError: cb.onError ?? (() => {}),
            onStale: cb.onStale ?? (() => {}),
            onExit: cb.onExit,
            onRestart: cb.onRestart,
            onParseError: cb.onParseError,
        },
    );
}

describe("HelperSupervisor", () => {
    it("forwards ready and subsequent reading events", async () => {
        const onReady = vi.fn();
        const onReading = vi.fn();
        const sup = makeSupervisorForMode("ready-then-readings", { onReady, onReading });
        sup.start();
        // Node startup through a shell shim takes ~200-300ms; give the
        // helper enough time to spawn and emit ready + 3 readings.
        await new Promise((r) => setTimeout(r, 800));
        sup.stop();
        expect(onReady).toHaveBeenCalledTimes(1);
        expect(onReady.mock.calls[0]![0]).toMatchObject({
            event: "ready",
            arch: "x86_64",
            t2: true,
        });
        expect(onReading.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("delivers the unsupported event and does not restart", async () => {
        const onUnsupported = vi.fn();
        const onRestart = vi.fn();
        const sup = makeSupervisorForMode("unsupported", { onUnsupported, onRestart });
        sup.start();
        await new Promise((r) => setTimeout(r, 800));
        sup.stop();
        expect(onUnsupported).toHaveBeenCalledTimes(1);
        expect(onUnsupported.mock.calls[0]![0]).toBe("Test reason");
        expect(onRestart).not.toHaveBeenCalled();
    });

    it("restarts on crash and resets the attempt counter on a healthy spawn", async () => {
        const onReady = vi.fn();
        const onRestart = vi.fn();
        const sup = makeSupervisorForMode(
            "ready-then-crash",
            { onReady, onRestart },
            { backoffBaseMs: 50, backoffMaxMs: 100 },
        );
        sup.start();
        // Wait long enough for at least 2 spawn cycles
        await new Promise((r) => setTimeout(r, 600));
        sup.stop();
        expect(onReady.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(onRestart.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("drops malformed JSON lines via onParseError and keeps going", async () => {
        const onParseError = vi.fn();
        const onReady = vi.fn();
        const sup = makeSupervisorForMode("garbage-then-ready", { onParseError, onReady });
        sup.start();
        await new Promise((r) => setTimeout(r, 800));
        sup.stop();
        expect(onParseError).toHaveBeenCalled();
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it("fires onStale and respawns when readings stop arriving", async () => {
        const onStale = vi.fn();
        const onRestart = vi.fn();
        const sup = makeSupervisorForMode(
            "silent",
            { onStale, onRestart },
            {
                staleAfterMs: 120,
                initialReadyTimeoutMs: 120,  // override cold-start timeout too
                backoffBaseMs: 30,
                backoffMaxMs: 60,
            },
        );
        sup.start();
        await new Promise((r) => setTimeout(r, 400));
        sup.stop();
        expect(onStale.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(onRestart.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it("stop() prevents further restarts", async () => {
        const onRestart = vi.fn();
        const sup = makeSupervisorForMode(
            "ready-then-crash",
            { onRestart },
            { backoffBaseMs: 50 },
        );
        sup.start();
        // Stop immediately so we can verify no restart happens.
        sup.stop();
        await new Promise((r) => setTimeout(r, 300));
        expect(onRestart).not.toHaveBeenCalled();
    });
});
