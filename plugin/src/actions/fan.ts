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
    /** sdpi-select returns its `value` as a string; pickFanIndex coerces. */
    fanIndex?: number | string;
    viewMode?: ViewMode;
    sampleCount?: number;
    sampleScope?: "global" | "tile";
};

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.fan" })
export class FanSpeedAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        const idx = pickFanIndex(ev.payload.settings.fanIndex);
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "fan", fanIndex: idx },
            ev.payload.settings.viewMode ?? "graph",
        extractSampleOverride(ev.payload.settings),
        );
    }

    override onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> | void {
        hub.unsubscribe(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> | void {
        const idx = pickFanIndex(ev.payload.settings.fanIndex);
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "fan", fanIndex: idx },
            ev.payload.settings.viewMode ?? "graph",
        extractSampleOverride(ev.payload.settings),
        );
    }

    override onKeyDown(ev: KeyDownEvent<Settings>): void {
        handleKeyDown(ev);
    }

    override onKeyUp(ev: KeyUpEvent<Settings>): void {
        handleKeyUp(ev);
    }

    override onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> | void {
        if (isDataSourceRequest(ev.payload, "getFans")) {
            const items = (hub.catalog?.fans ?? []).map((f) => {
                const range =
                    f.min !== undefined && f.max !== undefined
                        ? ` (${f.min}–${f.max} rpm)`
                        : "";
                return { value: String(f.index), label: `Fan ${f.index + 1}${range}` };
            });
            streamDeck.ui.sendToPropertyInspector({
                event: "getFans",
                items: items.length > 0
                    ? items
                    : [{ value: "", label: "No fans detected on this Mac", disabled: true }],
            });
        }
    }
}

function pickFanIndex(stored: number | string | undefined): number {
    if (typeof stored === "number" && Number.isInteger(stored)) return stored;
    if (typeof stored === "string" && stored.length > 0) {
        const n = parseInt(stored, 10);
        if (Number.isInteger(n)) return n;
    }
    return hub.catalog?.fans[0]?.index ?? 0;
}

function isDataSourceRequest(payload: unknown, eventName: string): boolean {
    return (
        typeof payload === "object" &&
        payload !== null &&
        "event" in payload &&
        (payload as { event: unknown }).event === eventName
    );
}
