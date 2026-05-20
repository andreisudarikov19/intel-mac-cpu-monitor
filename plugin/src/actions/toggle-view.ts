// Shared keyDown handler: toggles the per-key viewMode between "graph"
// and an "alt" mode (default: "value"; power actions pass "meter"),
// persists the new value in action settings, and updates the hub so the
// next render reflects it.

import type { KeyDownEvent } from "@elgato/streamdeck";
import { hub, type ViewMode } from "../hub.js";

type SettingsWithViewMode = {
    viewMode?: ViewMode;
};

export async function toggleView<S extends SettingsWithViewMode>(
    ev: KeyDownEvent<S>,
    altMode: ViewMode = "value",
): Promise<void> {
    const current = ev.payload.settings.viewMode;
    const next: ViewMode = current === altMode ? "graph" : altMode;
    await ev.action.setSettings({ ...ev.payload.settings, viewMode: next });
    hub.setViewMode(ev.action.id, next);
}
