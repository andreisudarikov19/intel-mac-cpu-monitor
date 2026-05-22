// Shared key-press handlers used by every action.
//
// Gesture mapping (uniform across all sensor types):
//   - Short tap  → toggle graph ↔ value (the framed slide view)
//   - Long press → toggle graph ↔ meter (the VU column)
//
// Long-press threshold is 600 ms. Implementation: on keyDown we arm a
// timer; if keyUp arrives before it fires, we treat it as a short tap.
// If the timer fires first, the long-press action triggers and the
// subsequent keyUp is suppressed.

import type { KeyDownEvent, KeyUpEvent } from "@elgato/streamdeck";
import { hub, type ViewMode } from "../hub.js";

const LONG_PRESS_MS = 600;

type SettingsWithViewMode = {
    viewMode?: ViewMode;
};

/** Extract the effective per-tile sample-count override from settings.
 *  Returns the override (a number) when `sampleScope === "tile"`,
 *  otherwise undefined (= follow the plugin-wide default).
 *
 *  Lives here so every action can pass `extractSampleOverride(settings)`
 *  to `hub.subscribe` without duplicating the scope check. */
export function extractSampleOverride(
    settings: { sampleScope?: string; sampleCount?: number },
): number | undefined {
    return settings.sampleScope === "tile" ? settings.sampleCount : undefined;
}

type PressRecord = {
    timer: NodeJS.Timeout;
    longTriggered: boolean;
};

/** Per-key (per action context) press state. Shared across all action
 *  classes because contextIds are globally unique. */
const pressState = new Map<string, PressRecord>();

/** Toggle helper: pick the next viewMode based on whether the current
 *  one matches the "alt" target. */
function nextMode(current: ViewMode | undefined, alt: ViewMode): ViewMode {
    return current === alt ? "graph" : alt;
}

async function applyMode<S extends SettingsWithViewMode>(
    ev: KeyDownEvent<S> | KeyUpEvent<S>,
    next: ViewMode,
): Promise<void> {
    await ev.action.setSettings({ ...ev.payload.settings, viewMode: next });
    hub.setViewMode(ev.action.id, next);
}

export function handleKeyDown<S extends SettingsWithViewMode>(ev: KeyDownEvent<S>): void {
    const id = ev.action.id;
    // If a previous press was somehow still pending, clear it.
    const prior = pressState.get(id);
    if (prior) clearTimeout(prior.timer);

    const record: PressRecord = {
        longTriggered: false,
        timer: setTimeout(() => {
            record.longTriggered = true;
            const next = nextMode(ev.payload.settings.viewMode, "meter");
            applyMode(ev, next).catch(() => { /* logger handles errors */ });
        }, LONG_PRESS_MS),
    };
    pressState.set(id, record);
}

export function handleKeyUp<S extends SettingsWithViewMode>(ev: KeyUpEvent<S>): void {
    const id = ev.action.id;
    const record = pressState.get(id);
    if (!record) return;
    clearTimeout(record.timer);
    pressState.delete(id);

    if (record.longTriggered) return;  // long press already fired

    // Short tap: toggle graph ↔ value
    const next = nextMode(ev.payload.settings.viewMode, "value");
    applyMode(ev, next).catch(() => { /* logger handles errors */ });
}
