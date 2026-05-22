# Intel Mac Hardware Monitor

A [Stream Deck](https://www.elgato.com/stream-deck) plugin that puts live hardware sensors on your keys — temperatures, fan speeds, power draw, RAM usage, disk I/O, and system uptime.

**Intel Macs only.** Reads the System Management Controller (SMC) via IOKit the same way [Fanny](https://github.com/DanielStormApps/Fanny) does, plus additional SMC keys covering modern T2 Macs and non-SMC system metrics via `host_statistics64` and IOKit block-storage drivers. Apple Silicon (M1/M2/…) exposes a completely different sensor topology that this plugin doesn't attempt to support.

## What's on a key

Each key is a 144 × 144 image that updates once per second. There are three view modes:

- **Graph** (default): label + current value on top, a sparkline of recent history filling the bottom, color-coded by band.
- **Slide**: dark card with a thick band-colored frame around the whole key; label and value inside. Reached by a short tap.
- **Meter**: 9-bar vertical VU column, color gradient from cool at the bottom to critical at the top, segments light up as the value rises. Reached by a long press.

The graph's sample window is user-configurable per tile (15–60 seconds at 1 sample/sec) and as a plugin-wide default.

### Gestures

- **Short tap** (< 600 ms): toggle between graph and slide.
- **Long press** (≥ 600 ms): toggle between graph and meter.
- Both gestures persist per-tile across Stream Deck restarts.
- A few actions are slide-only (Uptime) — for them, the gestures are no-ops.

### Color bands

| Band | Color | Use |
|---|---|---|
| cold | cyan | ambient air below 20 °C |
| cool | green | normal operation |
| warm | yellow | moderate load |
| hot | orange | heavy load |
| critical | red | approaching thermal / power / utilization limits |

When a sensor stops reporting (helper goes silent, SMC key returns null), the header switches to "No data" in alert orange and the sparkline shows gaps until data resumes.

## Actions

Sensors are dynamically detected at startup; actions whose underlying SMC keys aren't present on your Mac will still appear in the Stream Deck UI but won't render data.

### CPU

| Action | Source | PI controls |
|---|---|---|
| **CPU Core Temp** | per-core SMC keys (probed across 16 indices each casing) | core picker (auto-detected), °C/°F, sample window |
| **CPU Temp** | mean of detected per-core sensors, falling back through a chain of package keys (`TCAD` → `TC0F` → `TC0D` → `TC0E` → `TC0H` → `TCXC` → `TC0P`) | °C/°F, sample window |
| **CPU Power** | RAPL-equivalent package power in watts (`PCPR` and fallbacks) | sample window |

### GPU

| Action | Source | PI controls |
|---|---|---|
| **GPU Temp** | `TG0D` / `TCGC` / `TG0H` / `TG0P` in preference order | °C/°F, sample window |
| **GPU Power** | discrete GPU package power in watts (`PG0C` and fallbacks) | sample window |

### Memory

| Action | Source | PI controls |
|---|---|---|
| **RAM Temp** | memory-module sensors (`Ts0S` / `TM0P` / `Tm0P` / `TMA0` / `TMB0`) | °C/°F, sample window |
| **RAM Usage** | Activity Monitor's "Memory Used" % via `host_statistics64` (active + wired + compressed pages / total) | sample window |

### Storage

| Action | Source | PI controls |
|---|---|---|
| **SSD Temp** | drive thermal sensors (`TH0A` / `TH0B` / `TH0C` / `TH0F` / `TH0x` / `TH1A`) | °C/°F, sample window |
| **Disk I/O** | read + write bytes/sec across every block-storage driver, rendered as two independent streams in every view mode | sample window |

### Other thermals

| Action | Source | PI controls |
|---|---|---|
| **Air Temp** | intake air (`TA0P` / `TA1P` / `TaLP` / `TaRF`) | °C/°F, sample window |
| **Chipset Temp** | Northbridge / PCH (`TN0D` / `TN0H` / `TN0P` / `Tp0P`) | °C/°F, sample window |
| **Wi-Fi Temp** | Airport card (`TW0P`) | °C/°F, sample window |
| **Thunderbolt Temp** | Thunderbolt controller (`TI0P` / `TI1P` / `TTLD` / `TTRD`) | °C/°F, sample window |

### System

| Action | Source | PI controls |
|---|---|---|
| **Fan Speed** | per-fan RPM (`F{i}Ac`), bands anchored against each fan's reported `F{i}Mn`/`F{i}Mx` usable range | fan picker (auto-detected), sample window |
| **Uptime** | Node `os.uptime()` since system boot, rendered as weeks / days / hours | (none — slide-only view) |

The °C/°F preference and the plugin-default sample window are stored globally and shared across all temperature keys.

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
│   │  host_statistics64, disk I/O    │          │
│   │  swift build → bin/mac/smcreader│          │
│   └─────────────────────────────────┘          │
└────────────────────────────────────────────────┘
```

The helper is a separate Swift binary so the SMC code can stay in pure Swift (ported from Fanny) without dragging native Node modules into the JS build. The Node plugin owns the WebSocket connection to Stream Deck and the SVG rendering; the helper samples sensors at 1 Hz and pushes JSON.

The helper handles sleep/wake transitions itself: when a long pause between timer ticks is detected (> 10 s), it recycles its AppleSMC `io_connect_t` and resets the disk-I/O baseline. Without this, package-level SMC keys silently go stale through sleep and would persistently show "No data".

## Building from source

You need:

- macOS 13 or newer on an **Intel** Mac
- Xcode (for `swift test`; Command Line Tools alone won't run Swift Testing)
- Node.js 20 or newer
- Stream Deck 6.9 or newer

```bash
# One-shot build (helper + plugin):
npm run build

# Run the test suite (Swift + TypeScript):
npm run test
```

The build copies the Swift binary into the `.sdPlugin` bundle and the rolled-up `plugin.js` next to it, so the bundle directory is the artifact you ship.

## Installing locally

1. Build (`npm run build`).
2. Open `dev.andreisudarikov.intel-mac-monitor.sdPlugin/` in Finder.
3. Quit Stream Deck.
4. Copy the entire `.sdPlugin/` folder into `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`.
5. Relaunch Stream Deck.

The actions appear in the action list under **Intel Mac Hardware Monitor**. Drag any onto a key.

### Gatekeeper note

The helper binary in `bin/mac/smcreader` is not codesigned. If you download the `.streamDeckPlugin` from a GitHub release, macOS will quarantine the helper and Stream Deck will silently fail to launch it. Clear the quarantine attribute once:

```bash
xattr -dr com.apple.quarantine \
  ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/dev.andreisudarikov.intel-mac-monitor.sdPlugin
```

(Not needed if you built locally with `npm run build`.)

## Hardware notes

- The catalog probe happens once at helper startup. If your sensors aren't detected, restart Stream Deck.
- Per-core SMC keys appear under two casings on different Macs (`TC1C` vs `TC1c`). The probe tries both.
- CPU temperature prefers the per-core average; on Macs without per-core sensors it falls back through the package-key chain. CPU power prefers `PCPR` (Intel RAPL-equivalent total) and falls back through `PCTR` / `PCPT` / `PCPC` / `PCAM` / `PC0R` / `PC0C`.
- Fan RPMs decode in either `flt ` (4-byte float, T2 Macs) or `fpe2` (older Intel Macs). The helper trusts the dataType AppleSMC reports rather than guessing from T2 status. Fan bands are anchored to each fan's reported `min..max` range so idle reads as 0 % effort, not warm.
- After a sleep/wake transition the helper detects the long pause and recycles its AppleSMC connection — some package-level sensors (CPU package, ambient air, RAM, SSD) silently go stale through sleep and only return data after `IOServiceOpen` is called again.
- Disk I/O is sampled per-tick as the delta of cumulative IOKit counters. The first tick after helper start (or after a sleep/wake reset) reports 0 because there's no baseline yet.
- A diagnostic dump of every known power SMC key is written to stderr at every helper start. If CPU/GPU power reads as zero on a new Mac model, grep the plugin log for `power-probe` and compare against `sudo powermetrics --samplers cpu_power -n 1 -i 1000`.
- Apple Silicon detection short-circuits the helper at startup and renders "Intel only" on every key.

## Repository layout

```
helper/                              Swift SMC reader
  Sources/smcreader/                 (SMC.swift, Decoders.swift, SystemStats.swift, …)
  Tests/smcreaderTests/              (Swift Testing framework)

plugin/                              Node/TS Stream Deck plugin
  src/                               (actions/, helper-supervisor.ts, hub.ts, render.ts, …)
  test/                              (vitest)

dev.andreisudarikov.intel-mac-monitor.sdPlugin/
  manifest.json
  bin/plugin.js                      (built by rolldown)
  bin/mac/smcreader                  (built by swift)
  imgs/                              (SVG icons)
  ui/                                (Property Inspector HTML)

docs/releases/                       per-version release notes
CHANGELOG.md                         canonical version history
```

## Credits

SMC access logic ported and adapted from [DanielStormApps/Fanny](https://github.com/DanielStormApps/Fanny) and its SMC submodule (MIT). Additional SMC key knowledge from [exelban/stats](https://github.com/exelban/stats) (GPL-3.0; no code copied, only documented key names and decoder formulas).

UI inspired by the [Native Hardware Monitor](https://marketplace.elgato.com/product/native-hardware-monitor-18bf02e3-2efe-4fb3-9563-849a302ee68a) plugin.

## License

MIT (see LICENSE).
