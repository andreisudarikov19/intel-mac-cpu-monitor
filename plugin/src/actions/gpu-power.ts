import {
    action,
    SingletonAction,
    type WillAppearEvent,
    type WillDisappearEvent,
    type DidReceiveSettingsEvent,
    type KeyDownEvent,
} from "@elgato/streamdeck";
import { hub, type ViewMode } from "../hub.js";
import { toggleView } from "./toggle-view.js";

type Settings = {
    viewMode?: ViewMode;
};

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.gpu-power" })
export class GPUPowerAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "gpuPower" },
            ev.payload.settings.viewMode ?? "graph",
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
            { kind: "gpuPower" },
            ev.payload.settings.viewMode ?? "graph",
        );
    }

    override onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
        return toggleView(ev, "meter");
    }
}
