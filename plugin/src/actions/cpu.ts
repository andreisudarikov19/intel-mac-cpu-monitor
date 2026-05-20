import {
    action,
    SingletonAction,
    type WillAppearEvent,
    type WillDisappearEvent,
    type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";
import { hub } from "../hub.js";

type Settings = {
    tempUnit?: "C" | "F";
};

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.cpu" })
export class CPUTempAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "cpu" },
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
    }
}
