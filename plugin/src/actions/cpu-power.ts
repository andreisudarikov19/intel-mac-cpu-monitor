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

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.cpu-power" })
export class CPUPowerAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "cpuPower" },
            ev.payload.settings.viewMode ?? "graph",
        extractSampleOverride(ev.payload.settings),
        );
    }

    override onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> | void {
        hub.unsubscribe(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> | void {
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "cpuPower" },
            ev.payload.settings.viewMode ?? "graph",
        extractSampleOverride(ev.payload.settings),
        );
    }

    /** Power actions toggle between graph and the boombox VU meter view. */
    override onKeyDown(ev: KeyDownEvent<Settings>): void {
        handleKeyDown(ev);
    }

    override onKeyUp(ev: KeyUpEvent<Settings>): void {
        handleKeyUp(ev);
    }
}
