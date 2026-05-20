// Shared keyDown handler: toggles the per-key viewMode between "graph"
// and "value", persists the new value in action settings, and updates the
// hub so the next render reflects it.

import type { KeyDownEvent } from "@elgato/streamdeck";
import { hub, type ViewMode } from "../hub.js";

type SettingsWithViewMode = {
    viewMode?: ViewMode;
};

export async function toggleView<S extends SettingsWithViewMode>(
    ev: KeyDownEvent<S>,
): Promise<void> {
    const next: ViewMode = ev.payload.settings.viewMode === "value" ? "graph" : "value";
    await ev.action.setSettings({ ...ev.payload.settings, viewMode: next });
    hub.setViewMode(ev.action.id, next);
}
