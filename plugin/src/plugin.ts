// Plugin entry point. Registers the four actions, restores global settings,
// spawns the Swift helper, and connects to the Stream Deck WebSocket.

import streamDeck from "@elgato/streamdeck";
import { CPUCoreTempAction } from "./actions/cpu-core.js";
import { CPUTempAction } from "./actions/cpu.js";
import { GPUTempAction } from "./actions/gpu.js";
import { FanSpeedAction } from "./actions/fan.js";
import { AirTempAction } from "./actions/air.js";
import { RAMTempAction } from "./actions/ram.js";
import { SSDTempAction } from "./actions/ssd.js";
import { ChipsetTempAction } from "./actions/chipset.js";
import { WiFiTempAction } from "./actions/wifi.js";
import { ThunderboltTempAction } from "./actions/thunderbolt.js";
import { CPUPowerAction } from "./actions/cpu-power.js";
import { GPUPowerAction } from "./actions/gpu-power.js";
import { hub, type GlobalSettings } from "./hub.js";

streamDeck.logger.setLevel("trace");

streamDeck.actions.registerAction(new CPUCoreTempAction());
streamDeck.actions.registerAction(new CPUTempAction());
streamDeck.actions.registerAction(new GPUTempAction());
streamDeck.actions.registerAction(new FanSpeedAction());
streamDeck.actions.registerAction(new AirTempAction());
streamDeck.actions.registerAction(new RAMTempAction());
streamDeck.actions.registerAction(new SSDTempAction());
streamDeck.actions.registerAction(new ChipsetTempAction());
streamDeck.actions.registerAction(new WiFiTempAction());
streamDeck.actions.registerAction(new ThunderboltTempAction());
streamDeck.actions.registerAction(new CPUPowerAction());
streamDeck.actions.registerAction(new GPUPowerAction());

// Restore the user's preferred temperature unit from persistent global
// settings before the first reading lands.
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
    const s = ev.settings ?? {};
    if (s.tempUnit === "C" || s.tempUnit === "F") {
        hub.setGlobalSettings({ tempUnit: s.tempUnit });
    }
});
streamDeck.settings
    .getGlobalSettings<GlobalSettings>()
    .then((s) => {
        if (s.tempUnit === "C" || s.tempUnit === "F") {
            hub.setGlobalSettings({ tempUnit: s.tempUnit });
        }
    })
    .catch((err) => streamDeck.logger.warn(`getGlobalSettings failed: ${err}`));

// Persist global settings whenever the in-memory copy changes (currently
// triggered only by PI write-throughs in action.onDidReceiveSettings).
// Wrap setGlobalSettings on the hub so it also writes through to the SDK.
const origSet = hub.setGlobalSettings.bind(hub);
hub.setGlobalSettings = (s: GlobalSettings) => {
    origSet(s);
    streamDeck.settings
        .setGlobalSettings<GlobalSettings>(hub.getGlobalSettings())
        .catch((err) => streamDeck.logger.warn(`setGlobalSettings failed: ${err}`));
};

// Spawn the Swift helper. The Stream Deck app launches the plugin with cwd
// set to the .sdPlugin folder, so the helper resolves to bin/mac/smcreader.
hub.start();

streamDeck.connect();

// Clean shutdown on SIGTERM (graceful) and on process exit.
const cleanup = () => {
    try { hub.stop(); } catch { /* ignore */ }
};
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);
