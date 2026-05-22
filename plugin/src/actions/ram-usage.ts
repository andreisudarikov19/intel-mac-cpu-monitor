import {
    action,
    SingletonAction,
    type WillAppearEvent,
    type WillDisappearEvent,
    type DidReceiveSettingsEvent,
    type KeyDownEvent,
    type KeyUpEvent,
} from "@elgato/streamdeck";
import { hub, type ViewMode } from "../hub.js";
import { handleKeyDown, handleKeyUp, extractSampleOverride } from "./toggle-view.js";

type Settings = {
    viewMode?: ViewMode;
    sampleCount?: number;
    sampleScope?: "global" | "tile";
};

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.ram-usage" })
export class RAMUsageAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "ramUsage" },
            ev.payload.settings.viewMode ?? "graph",
            extractSampleOverride(ev.payload.settings),
        );
    }

    override onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> | void {
        hub.unsubscribe(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> | void {
        const s = ev.payload.settings;
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "ramUsage" },
            s.viewMode ?? "graph",
            extractSampleOverride(s),
        );
    }

    override onKeyDown(ev: KeyDownEvent<Settings>): void {
        handleKeyDown(ev);
    }

    override onKeyUp(ev: KeyUpEvent<Settings>): void {
        handleKeyUp(ev);
    }
}
