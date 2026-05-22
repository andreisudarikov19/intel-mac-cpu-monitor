import {
    action,
    SingletonAction,
    type WillAppearEvent,
    type WillDisappearEvent,
    type KeyDownEvent,
    type KeyUpEvent,
} from "@elgato/streamdeck";
import { hub } from "../hub.js";

/**
 * Uptime is special: slide-only (no graph or meter), no toggle gesture,
 * no sample-count knob. The hub's uptime case ignores `viewMode` and
 * always renders the custom multi-line slide (weeks / days / hours) with
 * a neutral grey frame.
 */
type Settings = Record<string, never>;

@action({ UUID: "dev.andreisudarikov.intel-mac-monitor.uptime" })
export class UptimeAction extends SingletonAction<Settings> {
    override onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> | void {
        hub.subscribe(
            {
                contextId: ev.action.id,
                setImage: (uri) => ev.action.setImage(uri).then(() => undefined),
            },
            { kind: "uptime" },
            // viewMode locked to "value" — the hub's uptime case ignores
            // this but we set it for consistency in case future code
            // checks subscription state.
            "value",
            undefined,
        );
    }

    override onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> | void {
        hub.unsubscribe(ev.action.id);
    }

    /** Press gestures intentionally do nothing: uptime has no
     *  alternative view to toggle to. */
    override onKeyDown(_ev: KeyDownEvent<Settings>): void { /* no-op */ }
    override onKeyUp(_ev: KeyUpEvent<Settings>): void { /* no-op */ }
}
