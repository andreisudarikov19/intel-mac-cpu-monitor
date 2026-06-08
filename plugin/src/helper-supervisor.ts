// Spawns and supervises the Swift smcreader helper binary.
//
// Responsibilities:
//   - Spawn the helper from bin/mac/smcreader inside the .sdPlugin bundle
//   - Parse JSON Lines from stdout
//   - Emit typed callbacks for ready / reading / unsupported / error events
//   - Detect stuck/dead helpers (no reading for N seconds) and respawn with
//     exponential backoff
//   - Clean shutdown on plugin exit

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from "node:fs";
import {
    isHelperEvent,
    type HelperEvent,
    type ReadingEvent,
    type ReadyEvent,
} from "./helper-protocol.js";

export type SupervisorCallbacks = {
    onReady: (e: ReadyEvent) => void;
    onReading: (e: ReadingEvent) => void;
    onUnsupported: (reason: string) => void;
    onError: (message: string) => void;
    /** Called when no reading has arrived within staleAfterMs. */
    onStale: () => void;
    /** Called whenever helper subprocess exits, before any restart attempt. */
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
    /** Called when restart attempts are happening. */
    onRestart?: (attempt: number, delayMs: number) => void;
    /** Called when a malformed JSON line is dropped. */
    onParseError?: (line: string, err: unknown) => void;
};

export type SupervisorOptions = {
    /** Absolute path to the smcreader binary. */
    binaryPath: string;
    /** Max ms between readings (after first ready) before onStale fires.
     *  Default 5000. */
    staleAfterMs?: number;
    /** Max ms from spawn to FIRST ready event before onStale fires.
     *  Default 15000. Larger because cold start includes Swift binary
     *  startup, T2 detection via system_profiler, and IOKit catalog probe. */
    initialReadyTimeoutMs?: number;
    /** Backoff base (ms) for restart attempts. Default 1000. */
    backoffBaseMs?: number;
    /** Backoff cap (ms). Default 30000. */
    backoffMaxMs?: number;
    /** Mirror the helper's stderr to this file (append mode). Stream Deck's
     *  own plugin log doesn't surface our streamDeck.logger.error lines, so
     *  we keep an independent file we control. Default: derived from
     *  binaryPath as <sdPlugin>/logs/helper.log. */
    stderrLogPath?: string;
    /** Rotate the stderr log when it grows past this many bytes
     *  (single rotation, previous content moved to <path>.1). Default 5 MB. */
    stderrLogMaxBytes?: number;
};

export class HelperSupervisor {
    private child: ChildProcess | null = null;
    private rl: ReadlineInterface | null = null;
    private restartAttempts = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private staleTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private unsupported = false;
    /** True once we've seen the first ready/reading for the current spawn. */
    private seenFirstEvent = false;
    /** Append stream to the helper-stderr mirror file; one per spawn. */
    private stderrLog: WriteStream | null = null;

    constructor(
        private readonly opts: SupervisorOptions,
        private readonly cb: SupervisorCallbacks,
    ) {}

    start(): void {
        this.stopped = false;
        this.spawn();
    }

    /** Stop the helper and prevent any further restarts. */
    stop(): void {
        this.stopped = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.staleTimer) {
            clearTimeout(this.staleTimer);
            this.staleTimer = null;
        }
        if (this.rl) {
            try { this.rl.close(); } catch { /* ignore */ }
            this.rl = null;
        }
        if (this.child && this.child.exitCode === null) {
            try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
        }
    }

    private spawn(): void {
        if (this.stopped) return;
        this.seenFirstEvent = false;
        this.unsupported = false;
        this.openStderrLog();

        try {
            this.child = spawn(this.opts.binaryPath, [], {
                stdio: ["ignore", "pipe", "pipe"],
                // Detached false so the child dies with our process group.
                detached: false,
            });
        } catch (err) {
            this.cb.onError(`Failed to spawn smcreader: ${String(err)}`);
            this.scheduleRestart();
            return;
        }

        const child = this.child;
        if (!child.stdout || !child.stderr) {
            this.cb.onError("smcreader spawned without stdio pipes");
            try { child.kill("SIGTERM"); } catch { /* ignore */ }
            this.scheduleRestart();
            return;
        }
        // readline on stdout splits on \n. Each helper output line is one
        // JSON object (we asserted no embedded newlines in the helper).
        this.rl = createInterface({ input: child.stdout });
        this.rl.on("line", (line) => this.onLine(line));

        // Capture stderr: mirror raw bytes to our file (so wake/recovery
        // diagnostics survive across plugin restarts) AND forward to the
        // SDK logger for live debugging.
        child.stderr.on("data", (chunk: Buffer) => {
            if (this.stderrLog) this.stderrLog.write(chunk);
            const text = chunk.toString("utf8").trim();
            if (text.length > 0) {
                this.cb.onError(`smcreader stderr: ${text}`);
            }
        });

        child.on("exit", (code, signal) => {
            if (this.cb.onExit) this.cb.onExit(code, signal);
            if (this.staleTimer) {
                clearTimeout(this.staleTimer);
                this.staleTimer = null;
            }
            this.closeStderrLog();
            // Apple Silicon path: helper said "unsupported" and exited 0.
            // Do not restart — there is no way to make it work.
            if (this.unsupported) return;
            if (!this.stopped) this.scheduleRestart();
        });

        // Initialize the stale-watch on spawn. If the first ready/reading
        // doesn't arrive within the timeout the helper is considered stuck.
        this.armStaleTimer();
    }

    private onLine(line: string): void {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let value: unknown;
        try {
            value = JSON.parse(trimmed);
        } catch (err) {
            if (this.cb.onParseError) this.cb.onParseError(trimmed, err);
            return;
        }
        if (!isHelperEvent(value)) {
            if (this.cb.onParseError) this.cb.onParseError(trimmed, new Error("not a helper event"));
            return;
        }
        this.dispatch(value);
    }

    private dispatch(ev: HelperEvent): void {
        switch (ev.event) {
            case "ready":
                this.restartAttempts = 0; // healthy spawn cycle
                this.seenFirstEvent = true;
                this.armStaleTimer();
                this.cb.onReady(ev);
                return;
            case "reading":
                this.seenFirstEvent = true;
                this.armStaleTimer();
                this.cb.onReading(ev);
                return;
            case "unsupported":
                this.unsupported = true;
                // Clear stale timer — terminal state, no more events expected.
                if (this.staleTimer) {
                    clearTimeout(this.staleTimer);
                    this.staleTimer = null;
                }
                this.cb.onUnsupported(ev.reason);
                return;
            case "error":
                this.cb.onError(ev.message);
                return;
        }
    }

    private armStaleTimer(): void {
        if (this.staleTimer) clearTimeout(this.staleTimer);
        // Use a longer timeout before the first ready arrives (cold start
        // can take a while). Once we've seen any event, fall back to the
        // tight steady-state timeout so a hang is detected quickly.
        const after = this.seenFirstEvent
            ? (this.opts.staleAfterMs ?? 5000)
            : (this.opts.initialReadyTimeoutMs ?? 15000);
        this.staleTimer = setTimeout(() => {
            this.cb.onStale();
            // Kill the helper so the exit handler triggers a restart.
            if (this.child && this.child.exitCode === null) {
                try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
            }
        }, after);
    }

    private openStderrLog(): void {
        const path = this.opts.stderrLogPath ?? defaultHelperStderrLogPath(this.opts.binaryPath);
        const maxBytes = this.opts.stderrLogMaxBytes ?? 5 * 1024 * 1024;
        try {
            mkdirSync(dirname(path), { recursive: true });
            try {
                const st = statSync(path);
                if (st.size > maxBytes) {
                    renameSync(path, `${path}.1`);
                }
            } catch {
                // File doesn't exist yet; nothing to rotate.
            }
            const stream = createWriteStream(path, { flags: "a" });
            stream.on("error", () => {
                // Disk full, permissions, etc. — don't crash the plugin
                // over a diagnostic log. Drop the stream so subsequent
                // writes are no-ops.
                this.stderrLog = null;
            });
            this.stderrLog = stream;
            stream.write(`\n--- helper spawn @ ${new Date().toISOString()} ---\n`);
        } catch {
            this.stderrLog = null;
        }
    }

    private closeStderrLog(): void {
        if (this.stderrLog) {
            try { this.stderrLog.end(); } catch { /* ignore */ }
            this.stderrLog = null;
        }
    }

    private scheduleRestart(): void {
        if (this.stopped) return;
        const base = this.opts.backoffBaseMs ?? 1000;
        const max = this.opts.backoffMaxMs ?? 30000;
        // Exponential backoff: base, 2x, 4x, ... capped at max.
        const delay = Math.min(max, base * 2 ** this.restartAttempts);
        this.restartAttempts++;
        if (this.cb.onRestart) this.cb.onRestart(this.restartAttempts, delay);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.spawn();
        }, delay);
    }
}

/** Resolve the helper binary path relative to THIS bundled file. The plugin
 *  is bundled to `<sdPlugin>/bin/plugin.js`, so the helper lives next to it
 *  at `<sdPlugin>/bin/mac/smcreader`. Anchoring to import.meta.url means we
 *  don't trust process.cwd(), which a future Stream Deck change could move. */
export function defaultHelperPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, "mac", "smcreader");
}

/** Default location for the helper-stderr mirror file:
 *  `<sdPlugin>/logs/helper.log`. */
export function defaultHelperStderrLogPath(binaryPath: string): string {
    // binaryPath: <sdPlugin>/bin/mac/smcreader → <sdPlugin>/logs/helper.log
    return resolve(dirname(binaryPath), "..", "..", "logs", "helper.log");
}
