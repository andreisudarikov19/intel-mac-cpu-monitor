import streamDeck, {
    action,
    SingletonAction,
    type WillAppearEvent,
    type WillDisappearEvent,
    type DidReceiveSettingsEvent,
    type SendToPluginEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { hub } from "../hub.js";

type Settings = {
    /** Selected core index from the Property Inspector. */
    coreIndex?: number;
    /** Last user-chosen temperature unit; mirrored into global settings. */
    tempUnit?: "C" | "F";
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
        );
        applyUnitFromSettings(ev.payload.settings);
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

function pickCoreIndex(stored: number | undefined): number {
    if (typeof stored === "number") return stored;
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
