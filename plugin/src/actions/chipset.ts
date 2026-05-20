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
import { handleKeyDown, handleKeyUp } from "./toggle-view.js";

type Settings = {
    tempUnit?: "C" | "F";
    viewMode?: ViewMode;
};

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.chipset" })
export class ChipsetTempAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "chipset" },
            ev.payload.settings.viewMode ?? "graph",
        );
    }

    override onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> | void {
        hub.unsubscribe(ev.action.id);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> | void {
        const s = ev.payload.settings;
        if (s.tempUnit === "C" || s.tempUnit === "F") {
            hub.setGlobalSettings({ tempUnit: s.tempUnit });
        }
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "chipset" },
            s.viewMode ?? "graph",
        );
    }

    override onKeyDown(ev: KeyDownEvent<Settings>): void {
        handleKeyDown(ev);
    }

    override onKeyUp(ev: KeyUpEvent<Settings>): void {
        handleKeyUp(ev);
    }
}
