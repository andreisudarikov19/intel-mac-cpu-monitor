# Intel Mac Hardware Monitor

A [Stream Deck](https://www.elgato.com/stream-deck) plugin that shows live CPU temperature, GPU temperature, and fan speed graphs on your keys.

**Intel Macs only.** Reads the System Management Controller (SMC) via IOKit the same way [Fanny](https://github.com/DanielStormApps/Fanny) does, plus a few additional SMC keys that modern T2 Macs require. Apple Silicon (M1/M2/…) exposes a completely different sensor topology that this plugin doesn't attempt to support.

## What's on a key

Each key is a 144 × 144 image with:

- A small label in the header (`CPU`, `GPU`, `FAN`, `CORE0`, …)
- A large current value (`62°C`, `2100`, …)
- A 60-second sparkline of recent history, color-coded by band: green ≤ 60 °C, yellow ≤ 80, orange ≤ 95, red > 95

If the helper goes quiet (no readings for 5 s after first ready, 15 s on cold start), the header switches to `No data` in orange and the sparkline shows gaps until data resumes.

## Actions

| Action | What it shows | Per-key settings |
|---|---|---|
| **CPU Core Temp** | Temperature of a specific core | core selector (auto-detected) |
| **CPU Temp** | Average across detected per-core sensors, falling back to a package sensor | °C / °F |
| **GPU Temp** | First available of `TG0D` → `TCGC` → `TG0H` → `TG0P` | °C / °F |
| **Fan Speed** | Current RPM of a specific fan | fan selector (auto-detected) |

The °C/°F preference is plugin-wide (shared by all temperature keys).

## Architecture

```
┌─ Stream Deck app ──────────────────────────────┐
│                                                │
│   WebSocket                                    │
│       │                                        │
│   ┌───┴─────────── plugin/ ──────────┐         │
│   │  Node/TypeScript                 │         │
│   │  @elgato/streamdeck SDK          │         │
│   │  rolldown → bin/plugin.js        │         │
│   └────┬─────────────────────────────┘         │
│        │ JSON Lines over stdout                │
│   ┌────┴─────────── helper/ ────────┐          │
│   │  Swift / SwiftPM                │          │
│   │  IOKit AppleSMC reader          │          │
│   │  swift build → bin/mac/smcreader│          │
│   └─────────────────────────────────┘          │
└────────────────────────────────────────────────┘
```

The helper is a separate Swift binary so the SMC code can stay in pure Swift (ported from Fanny) without dragging native Node modules into the JS build. The Node plugin owns the WebSocket connection to Stream Deck and the SVG rendering; the helper just samples sensors at 1 Hz and pushes JSON.

## Building from source

You need:

- macOS 13 or newer on an **Intel** Mac
- Xcode (for `swift test`; Command Line Tools alone won't run XCTest/Testing)
- Node.js 20 or newer
- Stream Deck 6.9 or newer

```bash
# One-shot build (helper + plugin):
npm run build

# Run all tests (53 Swift + 50 TS):
npm run test
```

The build copies the Swift binary into the `.sdPlugin` bundle and the rolled-up `plugin.js` next to it, so the bundle directory is the artifact you ship.

## Installing locally

1. Build (`npm run build`).
2. Open `dev.andreisudarikov.intel-mac-monitor.sdPlugin/` in Finder.
3. Quit Stream Deck.
4. Copy the entire `.sdPlugin/` folder into `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`.
5. Relaunch Stream Deck.

The four actions appear in the action list as **CPU Core Temp**, **CPU Temp**, **GPU Temp**, and **Fan Speed**. Drag any of them onto a key.

### Gatekeeper note

The helper binary in `bin/mac/smcreader` is not codesigned in this v1 build. If you download the `.streamDeckPlugin` from a GitHub release, macOS will quarantine the helper and Stream Deck will silently fail to launch it. Clear the quarantine attribute once:

```bash
xattr -dr com.apple.quarantine \
  ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/dev.andreisudarikov.intel-mac-monitor.sdPlugin
```

(Not needed if you built locally with `npm run build`.)

## Hardware notes

- The catalog probe happens once at helper startup. If your sensors aren't detected, restart Stream Deck.
- Per-core SMC keys appear under two casings on different Macs (`TC1C` vs `TC1c`). The probe tries both.
- The CPU Temp action prefers the per-core average; on T2 Macs that don't expose per-core sensors, it falls back to the first working sensor from `TCAD`, `TC0F`, `TC0D`, `TC0E`, `TC0H`, `TCXC`, `TC0P`.
- Fan RPMs decode in either `flt ` (4-byte float, T2 Macs) or `fpe2` (older Intel Macs). The helper trusts the dataType AppleSMC reports rather than guessing from T2 status.
- Apple Silicon detection short-circuits the helper at startup and renders "Intel only" on every key.

## Layout

```
helper/                              Swift SMC reader
  Sources/smcreader/                 (SMC.swift, Decoders.swift, …)
  Tests/smcreaderTests/              (Swift Testing framework)

plugin/                              Node/TS Stream Deck plugin
  src/                               (actions/, helper-supervisor.ts, hub.ts, …)
  test/                              (vitest)

dev.andreisudarikov.intel-mac-monitor.sdPlugin/
  manifest.json
  bin/plugin.js                      (built by rolldown)
  bin/mac/smcreader                  (built by swift)
  imgs/                              (SVG icons)
  ui/                                (Property Inspector HTML)
```

## Credits

SMC access logic ported and adapted from [DanielStormApps/Fanny](https://github.com/DanielStormApps/Fanny) and its SMC submodule (MIT). Additional SMC key knowledge from [exelban/stats](https://github.com/exelban/stats) (GPL-3.0; no code copied, only documented key names and decoder formulas).

UI inspired by the [Native Hardware Monitor](https://marketplace.elgato.com/product/native-hardware-monitor-18bf02e3-2efe-4fb3-9563-849a302ee68a) plugin.

## License

MIT (see LICENSE).
