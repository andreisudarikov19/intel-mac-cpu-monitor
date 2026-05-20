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
    fanIndex?: number;
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
        );
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

function pickFanIndex(stored: number | undefined): number {
    if (typeof stored === "number") return stored;
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
