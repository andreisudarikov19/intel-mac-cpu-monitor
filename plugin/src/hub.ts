// Central event hub that:
//   - Owns the helper supervisor
//   - Tracks the catalog (which sensors exist) from the ready event
//   - Maintains a per-(context, metric) ring buffer history
//   - Pushes rendered SVGs to actions on every tick

import streamDeck from "@elgato/streamdeck";
import {
    HelperSupervisor,
    defaultHelperPath,
    type SupervisorCallbacks,
} from "./helper-supervisor.js";
import type {
    ReadingEvent,
    ReadyEvent,
} from "./helper-protocol.js";
import { History } from "./history.js";
import { renderSVG, svgDataUri, type RenderInput } from "./render.js";
import {
    cToF,
    fanBand,
    TEMP_PROFILES,
    POWER_PROFILES,
    RAM_USAGE_PROFILE,
    DISK_IO_PROFILE,
    bandFor,
    type Band,
    type MetricProfile,
} from "./thresholds.js";
import * as os from "node:os";

/** Bounds and default for the user-facing sample-count slider (v1.3+).
 *  Range chosen to avoid the v1.1-era "hair vs goosebumps" trap:
 *  under 15 looks chunky and noisy, over 60 the line goes too thin. */
export const SAMPLE_COUNT_MIN = 15;
export const SAMPLE_COUNT_MAX = 60;
export const SAMPLE_COUNT_STEP = 5;
export const SAMPLE_COUNT_DEFAULT = 30;

/** Buffer size = visible × 1.5 (rounded up). Per v1.3 spec — keeps a bit
 *  of recent-but-offscreen history in reserve for future "zoom out". */
export function bufferSizeFor(visible: number): number {
    return Math.ceil(visible * 1.5);
}

/** Format a bytes/sec value with adaptive units for compact key display.
 *  Threshold cutoffs match human intuition: under 1 MB/s use KB,
 *  between 1 MB/s and 1 GB/s use MB, above use GB. Integer values
 *  in KB / single decimal in MB / GB. */
export function formatBytesPerSec(bps: number): string {
    if (bps < 1_000_000) {
        return `${Math.round(bps / 1024)} KB/s`;
    }
    if (bps < 1_000_000_000) {
        return `${(bps / 1_000_000).toFixed(1)} MB/s`;
    }
    return `${(bps / 1_000_000_000).toFixed(1)} GB/s`;
}

/** Ultra-compact byte-rate formatter for dual-meter column footers
 *  (each ≤ 52 px wide). Drops the "/s" and uses a single letter for
 *  the unit. `12 MB/s` → `12M`, `1.5 GB/s` → `1.5G`, `512 KB/s` →
 *  `512K`. Sub-KB values report as `0K`. */
export function formatBytesPerSecCompact(bps: number): string {
    if (bps < 1024) return "0K";
    if (bps < 1_000_000) {
        return `${Math.round(bps / 1024)}K`;
    }
    if (bps < 1_000_000_000) {
        const mb = bps / 1_000_000;
        return mb >= 10 ? `${Math.round(mb)}M` : `${mb.toFixed(1)}M`;
    }
    return `${(bps / 1_000_000_000).toFixed(1)}G`;
}

/** Clamp + step-snap a sample-count value to the slider's permitted set. */
export function clampSampleCount(n: number | undefined | null): number {
    if (typeof n !== "number" || !Number.isFinite(n)) return SAMPLE_COUNT_DEFAULT;
    const stepped = Math.round(n / SAMPLE_COUNT_STEP) * SAMPLE_COUNT_STEP;
    return Math.max(SAMPLE_COUNT_MIN, Math.min(SAMPLE_COUNT_MAX, stepped));
}

/** Visual mode for a single key.
 *  - "graph": default — header + value + sparkline (current behavior)
 *  - "value": header + value in a band-colored frame (toggled by tap on
 *    temperature actions)
 *  - "meter": 80s VU-meter column (toggled by tap on power actions) */
export type ViewMode = "graph" | "value" | "meter";

export type GlobalSettings = {
    /** "C" or "F". Default "C". */
    tempUnit?: "C" | "F";
    /** Plugin-wide default for graph sample count. Applies to every key
     *  whose own settings don't specify a `sampleCount` override.
     *  Defaults to SAMPLE_COUNT_DEFAULT when unset. */
    defaultSampleCount?: number;
};

export type Subscriber = {
    /** Stable Stream Deck context id for this key. */
    contextId: string;
    /** Push a rendered key image to this context. */
    setImage: (dataUri: string) => Promise<void>;
};

/** Per-instance subscription details — what each visible key wants to display. */
type SubscriptionKind =
    | { kind: "cpuCore"; coreIndex: number }
    | { kind: "cpu" }
    | { kind: "gpu" }
    | { kind: "ambient" }
    | { kind: "ram" }
    | { kind: "ssd" }
    | { kind: "chipset" }
    | { kind: "wifi" }
    | { kind: "thunderbolt" }
    | { kind: "cpuPower" }
    | { kind: "gpuPower" }
    | { kind: "ramUsage" }
    | { kind: "diskIO" }
    | { kind: "uptime" }
    | { kind: "fan"; fanIndex: number };

type Subscription = {
    subscriber: Subscriber;
    kind: SubscriptionKind;
    history: History;
    /** Second history buffer for dual-stream metrics (currently only
     *  disk I/O: history = read bytes/sec, historyB = write bytes/sec).
     *  Resized in lockstep with `history` by `applyVisibleChange`. */
    historyB: History | null;
    viewMode: ViewMode;
    /** Per-tile override. `undefined` means "follow plugin default". */
    sampleCountOverride: number | undefined;
    /** Effective number of samples to render on the graph (the result of
     *  applying override / global default / hard default precedence).
     *  Cached here so we can detect changes and resize the buffer. */
    visible: number;
};

/** Returns true if a subscription kind needs a second history buffer
 *  (i.e., is a dual-stream metric). Currently only diskIO. */
function isDualStream(kind: SubscriptionKind): boolean {
    return kind.kind === "diskIO";
}

export class Hub {
    private supervisor: HelperSupervisor | null = null;
    private ready: ReadyEvent | null = null;
    private unsupportedReason: string | null = null;
    private subscriptions = new Map<string, Subscription>();
    private globalSettings: GlobalSettings = { tempUnit: "C" };

    /** Spawn the helper (idempotent). */
    start(binaryPath: string = defaultHelperPath()): void {
        if (this.supervisor) return;
        const cb: SupervisorCallbacks = {
            onReady: (ev) => this.onReady(ev),
            onReading: (ev) => this.onReading(ev),
            onUnsupported: (r) => this.onUnsupported(r),
            onError: (m) => streamDeck.logger.error(`helper: ${m}`),
            onStale: () => this.onStale(),
            onExit: (code, signal) =>
                streamDeck.logger.warn(`helper exited (code=${code}, signal=${signal})`),
            onRestart: (attempt, delayMs) =>
                streamDeck.logger.info(`helper restart attempt ${attempt} in ${delayMs}ms`),
            onParseError: (line, err) =>
                streamDeck.logger.warn(`helper parse error: ${String(err)} line=${line.slice(0, 120)}`),
        };
        this.supervisor = new HelperSupervisor({ binaryPath }, cb);
        this.supervisor.start();
    }

    stop(): void {
        if (this.supervisor) {
            this.supervisor.stop();
            this.supervisor = null;
        }
    }

    /** Most recent ready snapshot, or null until first ready. */
    get catalog(): ReadyEvent | null {
        return this.ready;
    }

    get isUnsupported(): boolean {
        return this.unsupportedReason !== null;
    }

    setGlobalSettings(s: GlobalSettings): void {
        const prevDefault = this.globalSettings.defaultSampleCount ?? SAMPLE_COUNT_DEFAULT;
        this.globalSettings = { ...this.globalSettings, ...s };
        const newDefault = this.globalSettings.defaultSampleCount ?? SAMPLE_COUNT_DEFAULT;

        // If the plugin-wide default changed, re-evaluate every subscription
        // that's using the default (no per-tile override). Resize their
        // history buffers and re-render.
        const defaultChanged = prevDefault !== newDefault;

        for (const sub of this.subscriptions.values()) {
            if (defaultChanged && sub.sampleCountOverride === undefined) {
                this.applyVisibleChange(sub, newDefault);
            }
            this.renderAndPush(sub).catch((e) => streamDeck.logger.error(String(e)));
        }
    }

    /** Compute the effective visible-sample count for a subscription:
     *  per-tile override → plugin default → hard default. */
    private effectiveVisible(override: number | undefined): number {
        if (override !== undefined) return clampSampleCount(override);
        return clampSampleCount(this.globalSettings.defaultSampleCount);
    }

    /** Resize a subscription's history buffer to match a new visible count.
     *  Preserves the most recent samples that fit in the new buffer.
     *  For dual-stream subscriptions, resizes both buffers together. */
    private applyVisibleChange(sub: Subscription, newVisible: number): void {
        if (newVisible === sub.visible) return;
        sub.visible = newVisible;
        const cap = bufferSizeFor(newVisible);
        sub.history.resize(cap);
        sub.historyB?.resize(cap);
    }

    getGlobalSettings(): GlobalSettings {
        return { ...this.globalSettings };
    }

    /** Subscribe a key to receive renders. Replaces any prior subscription
     *  for the same contextId. If the new subscription has the same kind as
     *  the existing one, history is preserved (no flicker on settings save).
     */
    subscribe(
        subscriber: Subscriber,
        kind: SubscriptionKind,
        viewMode: ViewMode = "graph",
        sampleCountOverride: number | undefined = undefined,
    ): void {
        const existing = this.subscriptions.get(subscriber.contextId);
        const visible = this.effectiveVisible(sampleCountOverride);

        if (existing && subscriptionKindsEqual(existing.kind, kind)) {
            // Same metric/sensor — refresh the subscriber reference and
            // view mode, keep history. Resize buffer iff visible count
            // actually changed.
            existing.subscriber = subscriber;
            existing.viewMode = viewMode;
            existing.sampleCountOverride = sampleCountOverride;
            this.applyVisibleChange(existing, visible);
            this.renderAndPush(existing).catch((e) => streamDeck.logger.error(String(e)));
            return;
        }
        const cap = bufferSizeFor(visible);
        const sub: Subscription = {
            subscriber,
            kind,
            history: new History(cap),
            historyB: isDualStream(kind) ? new History(cap) : null,
            viewMode,
            sampleCountOverride,
            visible,
        };
        this.subscriptions.set(subscriber.contextId, sub);
        // Render current state immediately (likely "No data" until first reading).
        this.renderAndPush(sub).catch((e) => streamDeck.logger.error(String(e)));
    }

    /** Returns the current effective visible-sample count for a context,
     *  or undefined if no subscription exists. Primarily a hook for
     *  tests to verify sample-count transitions; safe to call from
     *  production code too. */
    getVisibleSampleCount(contextId: string): number | undefined {
        return this.subscriptions.get(contextId)?.visible;
    }

    /** Returns the current history buffer capacity for a context, or
     *  undefined if no subscription. Lets tests verify the buffer
     *  resizes correctly when override changes. */
    getBufferCapacity(contextId: string): number | undefined {
        return this.subscriptions.get(contextId)?.history.capacity;
    }

    /** Update only the view mode of an existing subscription, preserving
     *  history. Used by the onKeyDown toggle. No-op if context isn't
     *  subscribed (e.g. key was just removed). */
    setViewMode(contextId: string, mode: ViewMode): void {
        const sub = this.subscriptions.get(contextId);
        if (!sub) return;
        sub.viewMode = mode;
        this.renderAndPush(sub).catch((e) => streamDeck.logger.error(String(e)));
    }

    unsubscribe(contextId: string): void {
        this.subscriptions.delete(contextId);
    }

    // MARK: - Helper event handlers

    private onReady(ev: ReadyEvent): void {
        this.ready = ev;
        this.unsupportedReason = null;
        // Helper restarts may yield a different catalog. Clear histories so
        // we don't carry stale samples from the previous generation.
        for (const sub of this.subscriptions.values()) {
            sub.history.clear();
        }
        streamDeck.logger.info(
            `helper ready: cores=${ev.cpuCores.length} package=${ev.cpuPackageKey ?? "none"} ` +
            `gpu=${ev.gpuSensor ?? "none"} ambient=${ev.ambientSensor ?? "none"} ` +
            `ram=${ev.ramSensor ?? "none"} ssd=${ev.ssdSensor ?? "none"} ` +
            `chipset=${ev.chipsetSensor ?? "none"} wifi=${ev.wifiSensor ?? "none"} ` +
            `tbolt=${ev.thunderboltSensor ?? "none"} ` +
            `cpuW=${ev.cpuPowerSensor ?? "none"} gpuW=${ev.gpuPowerSensor ?? "none"} ` +
            `fans=${ev.fans.length} t2=${ev.t2}`
        );
    }

    private onReading(ev: ReadingEvent): void {
        for (const sub of this.subscriptions.values()) {
            if (sub.kind.kind === "diskIO") {
                // Dual-stream: history holds read bytes/sec, historyB
                // holds write bytes/sec.
                const r = typeof ev.diskReadBytesPerSec === "number" && Number.isFinite(ev.diskReadBytesPerSec)
                    ? ev.diskReadBytesPerSec : null;
                const w = typeof ev.diskWriteBytesPerSec === "number" && Number.isFinite(ev.diskWriteBytesPerSec)
                    ? ev.diskWriteBytesPerSec : null;
                sub.history.push(r);
                sub.historyB?.push(w);
            } else {
                const value = this.extractMetric(sub.kind, ev);
                sub.history.push(value);
            }
            this.renderAndPush(sub).catch((e) => streamDeck.logger.error(String(e)));
        }
    }

    private onUnsupported(reason: string): void {
        this.unsupportedReason = reason;
        this.ready = null;
        streamDeck.logger.warn(`helper unsupported: ${reason}`);
        // Render the "Intel only" message on every visible key.
        for (const sub of this.subscriptions.values()) {
            this.renderUnsupported(sub).catch((e) => streamDeck.logger.error(String(e)));
        }
    }

    private onStale(): void {
        // Inject a gap into every history so the renderer shows "No data".
        for (const sub of this.subscriptions.values()) {
            sub.history.push(null);
            sub.historyB?.push(null);
            this.renderAndPush(sub).catch((e) => streamDeck.logger.error(String(e)));
        }
    }

    // MARK: - Metric extraction

    private extractMetric(kind: SubscriptionKind, ev: ReadingEvent): number | null {
        // Belt-and-braces: isHelperEvent already verified ev.cpu is an
        // object and ev.fans is an array, but it does not validate the
        // element types. Treat each field cautiously.
        switch (kind.kind) {
            case "cpuCore": {
                if (!this.ready) return null;
                const core = this.ready.cpuCores.find((c) => c.index === kind.coreIndex);
                if (!core) return null;
                const v = (ev.cpu as Record<string, unknown>)[core.key];
                return typeof v === "number" && Number.isFinite(v) ? v : null;
            }
            case "cpu": {
                if (typeof ev.cpuAvg === "number" && Number.isFinite(ev.cpuAvg)) return ev.cpuAvg;
                if (typeof ev.cpuPackage === "number" && Number.isFinite(ev.cpuPackage)) return ev.cpuPackage;
                return null;
            }
            case "gpu":
                return typeof ev.gpu === "number" && Number.isFinite(ev.gpu) ? ev.gpu : null;
            case "ambient":
                return typeof ev.ambient === "number" && Number.isFinite(ev.ambient) ? ev.ambient : null;
            case "ram":
                return typeof ev.ram === "number" && Number.isFinite(ev.ram) ? ev.ram : null;
            case "ssd":
                return typeof ev.ssd === "number" && Number.isFinite(ev.ssd) ? ev.ssd : null;
            case "chipset":
                return typeof ev.chipset === "number" && Number.isFinite(ev.chipset) ? ev.chipset : null;
            case "wifi":
                return typeof ev.wifi === "number" && Number.isFinite(ev.wifi) ? ev.wifi : null;
            case "thunderbolt":
                return typeof ev.thunderbolt === "number" && Number.isFinite(ev.thunderbolt) ? ev.thunderbolt : null;
            case "cpuPower":
                return typeof ev.cpuPower === "number" && Number.isFinite(ev.cpuPower) ? ev.cpuPower : null;
            case "gpuPower":
                return typeof ev.gpuPower === "number" && Number.isFinite(ev.gpuPower) ? ev.gpuPower : null;
            case "ramUsage":
                return typeof ev.ramUsagePercent === "number" && Number.isFinite(ev.ramUsagePercent)
                    ? ev.ramUsagePercent : null;
            case "diskIO": {
                // Combined throughput = read + write bytes/sec.
                const r = typeof ev.diskReadBytesPerSec === "number" && Number.isFinite(ev.diskReadBytesPerSec)
                    ? ev.diskReadBytesPerSec : 0;
                const w = typeof ev.diskWriteBytesPerSec === "number" && Number.isFinite(ev.diskWriteBytesPerSec)
                    ? ev.diskWriteBytesPerSec : 0;
                // Treat (0,0) as nodata only on the very first reading
                // (helper sends 0 before it has a baseline). After that,
                // an honest 0 is meaningful — "no disk activity".
                if (r === 0 && w === 0 && ev.diskReadBytesPerSec === undefined) return null;
                return r + w;
            }
            case "uptime":
                // Not pulled from the helper event — Node knows uptime
                // directly. Returning a constant non-null keeps the
                // subscription "not no-data" so the slide renders.
                return os.uptime();
            case "fan": {
                const f = ev.fans.find(
                    (x) => x && typeof x === "object" && (x as { i?: unknown }).i === kind.fanIndex,
                );
                if (!f) return null;
                const rpm = (f as { rpm?: unknown }).rpm;
                return typeof rpm === "number" && Number.isFinite(rpm) ? rpm : null;
            }
        }
    }

    // MARK: - Rendering

    private async renderAndPush(sub: Subscription): Promise<void> {
        if (this.isUnsupported) {
            await this.renderUnsupported(sub);
            return;
        }
        const input = this.buildRenderInput(sub);
        const svg = renderSVG(input);
        await sub.subscriber.setImage(svgDataUri(svg));
    }

    private async renderUnsupported(sub: Subscription): Promise<void> {
        // We reuse the renderer with a "no data" treatment that says
        // "Intel only" in the header. The "No data" code path in renderSVG
        // expects noData=true; for the unsupported case we override the
        // header text via a small wrapper, but keep within the same shape.
        const svg = renderSVG({
            label: "Intel only",
            valueText: "—",
            band: "cool",
            noData: true,
            samples: [],
            range: TEMP_PROFILES.cpu.range,
            visibleSamples: SAMPLE_COUNT_DEFAULT,
        });
        await sub.subscriber.setImage(svgDataUri(svg));
    }

    private buildRenderInput(sub: Subscription): RenderInput {
        const latest = sub.history.latest();
        const noData = latest === null;

        switch (sub.kind.kind) {
            case "cpuCore": {
                const label = `CORE${sub.kind.coreIndex}`;
                return this.tempInput(label, latest, sub, noData, TEMP_PROFILES.cpu);
            }
            case "cpu":
                return this.tempInput("CPU", latest, sub, noData, TEMP_PROFILES.cpu);
            case "gpu":
                return this.tempInput("GPU", latest, sub, noData, TEMP_PROFILES.gpu);
            case "ambient":
                return this.tempInput("AIR", latest, sub, noData, TEMP_PROFILES.ambient);
            case "ram":
                return this.tempInput("RAM", latest, sub, noData, TEMP_PROFILES.ram);
            case "ssd":
                return this.tempInput("SSD", latest, sub, noData, TEMP_PROFILES.ssd);
            case "chipset":
                return this.tempInput("CHIP", latest, sub, noData, TEMP_PROFILES.chipset);
            case "wifi":
                return this.tempInput("WIFI", latest, sub, noData, TEMP_PROFILES.wifi);
            case "thunderbolt":
                return this.tempInput("TBOLT", latest, sub, noData, TEMP_PROFILES.thunderbolt);
            case "cpuPower":
                return this.powerInput("CPU", latest, sub, noData, POWER_PROFILES.cpu);
            case "gpuPower":
                return this.powerInput("GPU", latest, sub, noData, POWER_PROFILES.gpu);
            case "ramUsage":
                return this.ramUsageInput(latest, sub, noData);
            case "diskIO":
                return this.diskIOInput(latest, sub, noData);
            case "uptime":
                return this.uptimeInput(sub);
            case "fan": {
                const label = (this.ready && this.ready.fans.length > 1)
                    ? `FAN${sub.kind.fanIndex + 1}`
                    : "FAN";
                return this.fanInput(label, latest, sub, noData);
            }
        }
    }

    private tempInput(
        label: string,
        latest: number | null,
        sub: Subscription,
        noData: boolean,
        profile: MetricProfile,
    ): RenderInput {
        const unitF = this.globalSettings.tempUnit === "F";
        let valueText = "";
        let band: Band = "cool";
        if (!noData && latest !== null) {
            const shown = unitF ? cToF(latest) : latest;
            valueText = `${Math.round(shown)}°${unitF ? "F" : "C"}`;
            // Banding is always done in Celsius regardless of display unit.
            band = bandFor(latest, profile);
        }
        return {
            label,
            valueText,
            band,
            noData,
            samples: sub.history.toArray(),
            range: profile.range,
            viewMode: sub.viewMode,
            rawValue: latest,
            profile,
            visibleSamples: sub.visible,
        };
    }

    private powerInput(
        label: string,
        latest: number | null,
        sub: Subscription,
        noData: boolean,
        profile: MetricProfile,
    ): RenderInput {
        let valueText = "";
        let band: Band = "cool";
        if (!noData && latest !== null) {
            // Format with one decimal place for low values (<10W) to show
            // fractional precision; whole-watt for higher values.
            valueText = latest < 10
                ? `${latest.toFixed(1)}W`
                : `${Math.round(latest)}W`;
            band = bandFor(latest, profile);
        }
        return {
            label,
            valueText,
            band,
            noData,
            samples: sub.history.toArray(),
            range: profile.range,
            viewMode: sub.viewMode,
            rawValue: latest,
            profile,
            visibleSamples: sub.visible,
        };
    }

    private ramUsageInput(latest: number | null, sub: Subscription, noData: boolean): RenderInput {
        let valueText = "";
        let band: Band = "cool";
        if (!noData && latest !== null) {
            valueText = `${Math.round(latest)}%`;
            band = bandFor(latest, RAM_USAGE_PROFILE);
        }
        return {
            label: "RAM",
            valueText,
            band,
            noData,
            samples: sub.history.toArray(),
            range: RAM_USAGE_PROFILE.range,
            viewMode: sub.viewMode,
            rawValue: latest,
            profile: RAM_USAGE_PROFILE,
            visibleSamples: sub.visible,
        };
    }

    private diskIOInput(_combinedLatest: number | null, sub: Subscription, noData: boolean): RenderInput {
        // Dual-stream: history = read bytes/sec, historyB = write bytes/sec.
        const read = sub.history.latest();
        const write = sub.historyB?.latest() ?? null;

        // "Latest" for band/noData decisions uses the BIGGER of the two —
        // whichever stream is more active drives the color cue.
        const peak = Math.max(read ?? 0, write ?? 0);
        const band: Band = bandFor(peak, DISK_IO_PROFILE);

        // Slide view: two lines with ↓ (read in) and ↑ (write out).
        // formatBytesPerSecCompact keeps each line short enough to fit
        // when the slide is left-aligned.
        const slideLines = noData ? undefined : [
            `↓ ${read != null ? formatBytesPerSec(read) : "—"}`,
            `↑ ${write != null ? formatBytesPerSec(write) : "—"}`,
        ];

        // Meter view: compact unit-tag values under each column
        // (full "12.0 MB/s" is too wide for a 52 px column footer).
        const meterReadText = read != null ? formatBytesPerSecCompact(read) : "";
        const meterWriteText = write != null ? formatBytesPerSecCompact(write) : "";

        return {
            label: "DISK",
            // Graph view's single bottom text shows the combined sum so
            // the per-tick header label remains glanceable. For dual-
            // stream slide and meter, valueText / valueTextB are used
            // separately below.
            valueText: noData || read === null && write === null
                ? ""
                : sub.viewMode === "meter" ? meterReadText
                : formatBytesPerSec((read ?? 0) + (write ?? 0)),
            valueTextB: sub.viewMode === "meter" ? meterWriteText : undefined,
            band,
            noData,
            samples: sub.history.toArray(),
            samplesB: sub.historyB ? sub.historyB.toArray() : undefined,
            range: DISK_IO_PROFILE.range,
            viewMode: sub.viewMode,
            rawValue: read,
            rawValueB: write,
            profile: DISK_IO_PROFILE,
            visibleSamples: sub.visible,
            slideLines,
            streamBColor: "#3FBEE9",   // cold cyan — distinct from read's band color
        };
    }

    private uptimeInput(sub: Subscription): RenderInput {
        // Uptime is slide-only; build the 3-line breakdown directly.
        // `os.uptime()` returns seconds since system boot.
        const totalSec = Math.max(0, Math.floor(os.uptime()));
        const weeks = Math.floor(totalSec / (7 * 86400));
        const afterWeeks = totalSec - weeks * 7 * 86400;
        const days = Math.floor(afterWeeks / 86400);
        const afterDays = afterWeeks - days * 86400;
        const hours = Math.floor(afterDays / 3600);
        const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w + "s"}`;
        return {
            label: "UPTIME",
            valueText: "",
            band: "cool",        // unused; slideAccent overrides
            noData: false,
            samples: [],
            range: { min: 0, max: 1 },
            viewMode: "value",   // locked to slide
            rawValue: null,
            visibleSamples: sub.visible,
            slideLines: [
                plural(weeks, "week"),
                plural(days, "day"),
                plural(hours, "hour"),
            ],
            slideAccent: "#8E8E93",     // macOS systemGray (dark) — neutral, off-band
        };
    }

    private fanInput(label: string, latest: number | null, sub: Subscription, noData: boolean): RenderInput {
        // Y-axis range: 0 to this fan's max RPM (or 6000 fallback).
        let max = 6000;
        if (this.ready && sub.kind.kind === "fan") {
            const fanIndex = sub.kind.fanIndex;
            const fan = this.ready.fans.find((x) => x.index === fanIndex);
            if (fan && fan.max && fan.max > 0) max = fan.max;
        }
        let valueText = "";
        let band: Band = "cool";
        if (!noData && latest !== null) {
            valueText = `${Math.round(latest)}`;
            band = fanBand(latest, max);
        }
        // Percentage-based profile so long-press meter view works for
        // fans too — bands at 30 / 70 / 100 % of max RPM mirror fanBand.
        const fanProfile: MetricProfile = {
            range: { min: 0, max },
            coolMax: max * 0.3,
            warmMax: max * 0.7,
            hotMax: max,
        };
        return {
            label,
            valueText,
            band,
            noData,
            samples: sub.history.toArray(),
            range: fanProfile.range,
            viewMode: sub.viewMode,
            rawValue: latest,
            profile: fanProfile,
            visibleSamples: sub.visible,
        };
    }
}

/** Structural equality for SubscriptionKind values. */
function subscriptionKindsEqual(a: SubscriptionKind, b: SubscriptionKind): boolean {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
        case "cpu":
        case "gpu":
        case "ambient":
        case "ram":
        case "ssd":
        case "chipset":
        case "wifi":
        case "thunderbolt":
        case "cpuPower":
        case "gpuPower":
        case "ramUsage":
        case "diskIO":
        case "uptime":
            return true;
        case "cpuCore":
            return a.coreIndex === (b as { coreIndex: number }).coreIndex;
        case "fan":
            return a.fanIndex === (b as { fanIndex: number }).fanIndex;
    }
}

// One Hub instance per plugin process.
export const hub = new Hub();
