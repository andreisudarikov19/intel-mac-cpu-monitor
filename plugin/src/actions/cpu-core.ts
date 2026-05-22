import streamDeck, {
    action,
    SingletonAction,
    type WillAppearEvent,
    type WillDisappearEvent,
    type DidReceiveSettingsEvent,
    type SendToPluginEvent,
    type KeyDownEvent,
    type KeyUpEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { hub, type ViewMode } from "../hub.js";
import { handleKeyDown, handleKeyUp, extractSampleOverride } from "./toggle-view.js";

type Settings = {
    /** Selected core index from the Property Inspector.
     *  Comes back as a string from sdpi-select (the `value` attribute is
     *  always a string); pickCoreIndex coerces. */
    coreIndex?: number | string;
    /** Last user-chosen temperature unit; mirrored into global settings. */
    tempUnit?: "C" | "F";
    /** Current view mode for this key. Toggled by key press. */
    viewMode?: ViewMode;
    sampleCount?: number;
    sampleScope?: "global" | "tile";
};

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.cpu-core" })
export class CPUCoreTempAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        const idx = pickCoreIndex(ev.payload.settings.coreIndex);
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "cpuCore", coreIndex: idx },
            ev.payload.settings.viewMode ?? "graph",
        extractSampleOverride(ev.payload.settings),
        );
    }

    override onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> | void {
        hub.unsubscribe(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> | void {
        const idx = pickCoreIndex(ev.payload.settings.coreIndex);
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "cpuCore", coreIndex: idx },
            ev.payload.settings.viewMode ?? "graph",
        extractSampleOverride(ev.payload.settings),
        );
        applyUnitFromSettings(ev.payload.settings);
    }

    override onKeyDown(ev: KeyDownEvent<Settings>): void {
        handleKeyDown(ev);
    }

    override onKeyUp(ev: KeyUpEvent<Settings>): void {
        handleKeyUp(ev);
    }

    override onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> | void {
        if (isDataSourceRequest(ev.payload, "getCores")) {
            const items = (hub.catalog?.cpuCores ?? []).map((c) => ({
                value: String(c.index),
                label: `Core ${c.index}`,
            }));
            streamDeck.ui.sendToPropertyInspector({
                event: "getCores",
                items: items.length > 0
                    ? items
                    : [{ value: "", label: "No CPU cores detected on this Mac", disabled: true }],
            });
        }
    }
}

function pickCoreIndex(stored: number | string | undefined): number {
    if (typeof stored === "number" && Number.isInteger(stored)) return stored;
    if (typeof stored === "string" && stored.length > 0) {
        const n = parseInt(stored, 10);
        if (Number.isInteger(n)) return n;
    }
    return hub.catalog?.cpuCores[0]?.index ?? 0;
}

function applyUnitFromSettings(s: Settings): void {
    if (s.tempUnit === "C" || s.tempUnit === "F") {
        hub.setGlobalSettings({ tempUnit: s.tempUnit });
    }
}

function isDataSourceRequest(payload: unknown, eventName: string): boolean {
    return (
        typeof payload === "object" &&
        payload !== null &&
        "event" in payload &&
        (payload as { event: unknown }).event === eventName
    );
}
