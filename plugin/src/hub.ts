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
    bandFor,
    type Band,
    type MetricProfile,
} from "./thresholds.js";

// 45-sample ring buffer (= 45 s at 1 Hz). The graph only renders the most
// recent 30 (see render.ts VISIBLE_SAMPLES); the extra 15 sit in reserve
// for any future zoom-out / longer-window feature.
const HISTORY_SIZE = 45;

/** Visual mode for a single key.
 *  - "graph": default — header + value + sparkline (current behavior)
 *  - "value": header + value in a band-colored frame (toggled by tap on
 *    temperature actions)
 *  - "meter": 80s VU-meter column (toggled by tap on power actions) */
export type ViewMode = "graph" | "value" | "meter";

export type GlobalSettings = {
    /** "C" or "F". Default "C". */
    tempUnit?: "C" | "F";
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
    | { kind: "fan"; fanIndex: number };

type Subscription = {
    subscriber: Subscriber;
    kind: SubscriptionKind;
    history: History;
    viewMode: ViewMode;
};

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
        this.globalSettings = { ...this.globalSettings, ...s };
        // Re-render everything immediately so unit changes appear without delay.
        for (const sub of this.subscriptions.values()) {
            this.renderAndPush(sub).catch((e) => streamDeck.logger.error(String(e)));
        }
    }

    getGlobalSettings(): GlobalSettings {
        return { ...this.globalSettings };
    }

    /** Subscribe a key to receive renders. Replaces any prior subscription
     *  for the same contextId. If the new subscription has the same kind as
     *  the existing one, history is preserved (no flicker on settings save).
     */
    subscribe(subscriber: Subscriber, kind: SubscriptionKind, viewMode: ViewMode = "graph"): void {
        const existing = this.subscriptions.get(subscriber.contextId);
        if (existing && subscriptionKindsEqual(existing.kind, kind)) {
            // Same metric/sensor — refresh the subscriber reference and
            // view mode, keep history.
            existing.subscriber = subscriber;
            existing.viewMode = viewMode;
            this.renderAndPush(existing).catch((e) => streamDeck.logger.error(String(e)));
            return;
        }
        const sub: Subscription = {
            subscriber,
            kind,
            history: new History(HISTORY_SIZE),
            viewMode,
        };
        this.subscriptions.set(subscriber.contextId, sub);
        // Render current state immediately (likely "No data" until first reading).
        this.renderAndPush(sub).catch((e) => streamDeck.logger.error(String(e)));
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
            const value = this.extractMetric(sub.kind, ev);
            sub.history.push(value);
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
            return true;
        case "cpuCore":
            return a.coreIndex === (b as { coreIndex: number }).coreIndex;
        case "fan":
            return a.fanIndex === (b as { fanIndex: number }).fanIndex;
    }
}

// One Hub instance per plugin process.
export const hub = new Hub();
