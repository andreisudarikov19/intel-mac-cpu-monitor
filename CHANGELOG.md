# Changelog

All notable changes to the Intel Mac Hardware Monitor plugin. Each entry
describes the **resulting state** of that version — features as shipped,
not the development journey. Append new versions to the top.

**Release checklist** when closing out a version:
1. Bump `Version` in `dev.andreisudarikov.intel-mac-monitor.sdPlugin/manifest.json`
   to match. Stream Deck manifests use 4-component `{major}.{minor}.{patch}.{build}`
   — so v1.3 → `1.3.0.0`, v1.3.1 → `1.3.1.0`. This is what users see in
   the Stream Deck UI's plugin info panel.
2. Append the new version's release notes to the top of this file.
3. Run `npm run build && streamdeck restart dev.andreisudarikov.intel-mac-monitor`
   so the UI picks up the new version string.

---

## v1.2.3 (2026-05-20)

Bug-fix release. Fixes a "ghost no-data" state that affected the CPU
package, ambient air, and RAM keys after the Mac woke from sleep —
those sensors would persistently show "No data" until the user
restarted Stream Deck.

### Fixed
- **Stale AppleSMC connection after sleep/wake**: certain
  package-level SMC keys (`TCAD` / `TC0F` / `TA0P` / `Ts0S` and
  friends) silently stopped returning data after the system slept,
  even though the helper kept polling. Per-core CPU, GPU, fans, and
  SSD were unaffected because their reads go through different
  internal routing. The helper now detects long pauses between timer
  ticks (>10 s gap = process was paused) and recycles its IOKit
  AppleSMC connection in place via a new `SMC.reset()` method. First
  tick after wake shows live data again.

### How the detection works
- Helper's timer is supposed to fire every 1 s. A gap >10 s between
  consecutive ticks means the process was paused — sleep/wake,
  SIGSTOP, debugger attach, anything. Cheap to check (one timestamp
  comparison per tick); false positives are harmless (a redundant SMC
  reset costs ~µs of kernel work).
- If `SMC.reset()` itself fails (rare — would require AppleSMC kext to
  have unloaded), the helper exits and the plugin supervisor respawns
  it — the existing fallback path.

### Added
- `SMC.reset()` — close current `io_connect_t`, reopen via
  `IOServiceOpen`. Shared init logic factored into private
  `openConnection()`.
- Stderr log line `smc: reset after Ns gap (likely sleep/wake)` so
  the plugin log shows when the recovery fired.

### Notes
- No new SMC keys, no new actions, no UI changes. Pure runtime
  reliability fix.
- Tests unchanged.

---

## v1.2.2 (2026-05-20)

Release-hygiene fix. The manifest's `Version` field had been stuck at
the v0.1 placeholder since day one, so the Stream Deck UI's plugin-info
panel was lying about which version users had installed. This release
makes the manifest version the source of truth and codifies bumping it
as part of every future close-out.

### Fixed
- **`manifest.json` Version**: `0.1.0.0` → `1.2.2.0`. From here on, the
  manifest version tracks the shipping version 1:1
  (`{major}.{minor}.{patch}.0` — the fourth component is reserved for
  rebuild numbers within a patch).

### Changed
- **Plugin description** (visible in Stream Deck UI) rewritten from
  the v1.0-era "Live CPU temperature, GPU temperature, and fan speed
  graphs…" to one that reflects the v1.2 feature set (thermals + fans
  + power; tap for slide, long-press for VU meter).

### Added
- **Release checklist** at the top of `CHANGELOG.md` — three steps to
  follow on every version close-out (bump manifest, append release
  notes, rebuild + restart). Catches the v0.1 drift class of bug.

### Notes
- No code changes; manifest + docs only. Tests unchanged at **86 Swift
  + 81 TypeScript = 167**.

---

## v1.2.1 (2026-05-20)

Bug-fix release. CPU power readings on Intel iMacs were bogusly low
because the helper's catalog probe was picking SMC key `PCPT`, whose
dataType is `spa5` (a signed 10.5 fixed-point format we didn't decode),
and the decoder fell through to byte-0-as-UI8 — yielding ~4 W
regardless of actual draw.

### Fixed
- **CPU power picks `PCPR` first** instead of `PCPC`/`PCPT`. PCPR =
  "CPU Package total (SMC)" — the RAPL-equivalent, matches reality
  (~8 W idle / 50 W moderate load / 125 W full TDP on a 10-core iMac).
- **Wrong `PCPT` decode** — was decoding as UI8 (returned `bytes[0]`
  as integer watts) because the dispatch fell through to the default
  case. Now decoded correctly as `spa5`.
- **`decodePower` no longer falls back to UI8** for unknown dataTypes.
  For power readings, byte-0-as-watts has no physical meaning, so a
  nil return (which makes the catalog skip the key) is safer than a
  wrong number.

### Added
- **`Decoders.decodeSPFixedPoint(b0, b1, dataType)`** — generic decoder
  for the SMC SP-family fixed-point (`sp78`, `sp87`, `spa5`, etc.).
  Pattern: dataType is `spXY` where X = integer bits, Y = fractional
  bits (both hex, totaling 15 to fit a signed Int16). Value =
  `signed_int16(b0, b1) / 2^Y`.
- **Power-probe diagnostic dump** — at every helper start, the helper
  writes one stderr line per known power SMC key (`PCPR`, `PCTR`,
  `PCPT`, `PCPC`, `PCAM`, `PC0R`, `PC0C`, `PC0G`, `PCEC`, `PC1C`,
  `PC2C`, `PC3C`, `PG0C`, `PCGC`, `PCPG`, `PG0R`, `PG1R`, `PCGM`,
  `PSTR`, `PDTR`, `PZ0F`) showing key, dataType, raw bytes, and
  decoded value. Captured by the plugin's stderr logger at ERROR level
  (noisy at one line per spawn, but invaluable when CPU/GPU power
  reads as zero on a new Mac model — go to the plugin log, grep
  `power-probe`, compare with `sudo powermetrics --samplers cpu_power
  -n 1 -i 1000`).

### Changed
- **CPU power preference order**: `PCPR` → `PCTR` → `PCPT` → `PCPC` →
  `PCAM` → `PC0R` → `PC0C` (was `PCPC` → `PCPT` → `PCTR` → `PC0C` →
  `PCAM`). PCPR is the canonical Intel RAPL-equivalent total.
- **GPU power preference order**: added `PG1R` between `PG0R` and
  `PCGM`. No semantic change on hardware where `PG0C` works.

### Tests
- New: 5 Swift tests covering `decodeSPFixedPoint` (including `spa5`),
  `decodePower` returning nil for unknown dataTypes, and updated
  catalog assertions for the PCPR-first order.
- Total: **86 Swift + 81 TypeScript = 167** (was 162).

### Notes for future debugging
- If a different Intel Mac shows wrong CPU/GPU power, restart the
  plugin, then grep `dev.andreisudarikov.intel-mac-monitor.sdPlugin
  /logs/*.log` for `power-probe`. The dump shows all candidate keys'
  values — pick the one matching `sudo powermetrics`, add it to the
  preference list in `helper/Sources/smcreader/Sensors.swift`.

---

## v1.0 (2026-05-20)

Initial release. Stream Deck plugin for Intel Macs showing live CPU
temperatures, GPU temperature, and fan speed.

### Identity & distribution
- **UUID**: `dev.andreisudarikov.intel-mac-monitor`
- **Min macOS**: 13 (Ventura)
- **Min Stream Deck app**: 6.9
- **Node runtime**: 20 (manifest-declared; bundled by Stream Deck)
- **Distribution**: GitHub releases, sideload-only (Marketplace deferred)
- **Helper binary**: unsigned in v1.0; manual Gatekeeper clearance via
  `xattr -dr com.apple.quarantine` documented in README

### Architecture
- **Plugin process**: Node/TypeScript using `@elgato/streamdeck` v2 SDK;
  spawned by Stream Deck app; talks WebSocket to it
- **Helper process**: Swift binary (`smcreader`) spawned by plugin via
  `child_process`; reads SMC via IOKit `AppleSMC`; streams JSON Lines
  over stdout
- **Helper owns the cadence**: 1 Hz `DispatchSourceTimer`, full-payload
  push every tick
- **Helper supervisor in plugin**: spawn-on-start; auto-restart on exit
  with exponential backoff (cap 30 s); stale-watch (kills + respawns if
  no reading received within 5 s); detects Apple Silicon and emits
  `unsupported` event
- **Wire protocol** (one JSON object per line on stdout):
  - `ready` — one-time, contains arch, T2 status, detected sensor
    catalogue
  - `reading` — per tick, contains all sensor values
  - `unsupported` — emitted once on Apple Silicon, helper exits 0
  - `error` — emitted on IOKit/SMC failures, helper exits 1
- **Catalog probe**: helper reads each candidate SMC key once at
  startup; keeps only those that return >1.0 °C; resolves dataType
  (sp78 / ui8 / flt) per sensor so per-tick reads decode correctly

### Actions (4)
| Action | UUID suffix | Sensor source | PI controls |
|---|---|---|---|
| CPU Core Temp | `.cpu-core` | `TC{i}C` / `TC{i}c` per-core, i=0..15 | Core picker (dynamic, populated by helper) + °C/°F |
| CPU Temp | `.cpu` | Mean of detected per-core sensors; falls back to `TCAD` → `TC0F` → `TC0D` → `TC0E` → `TC0H` → `TCXC` → `TC0P` package keys | °C/°F |
| GPU Temp | `.gpu` | `TG0D` → `TCGC` → `TG0H` → `TG0P` preference order | °C/°F |
| Fan Speed | `.fan` | `FNum` for count; `F{i}Ac/Mn/Mx` per fan | Fan picker (dynamic) |

### Visualization (one view mode: graph)
- **144 × 144 canvas**, dark background `#1c1c1e`
- **Top half**: label ("CPU", "GPU", "FAN1", "CORE5", …) + value
  ("62°C", "2100") on one line
- **Bottom half**: filled-area + line sparkline with ~30 % opacity area
  fill, 1.6 px stroke
- **Y-axis**: fixed range per metric (temps 30–100 °C; fans 0 to that
  fan's reported max RPM)
- **History**: 60-sample ring buffer, 60-second visible window, 1
  sample/sec
- **Color bands** (4): thresholds applied to value to color both the
  text and the sparkline
  - Temps: ≤ 60 °C cool, ≤ 80 warm, ≤ 95 hot, > 95 critical
  - Fans: ≤ 30 % max cool, ≤ 70 % warm, ≤ 100 % hot, > 100 % critical
- **Palette**: macOS dark-mode system colors —
  `#30D158` / `#FFD60A` / `#FF9F0A` / `#FF453A`
- **Stale data handling**: missing samples render as **gaps** in the
  graph; the header switches to "No data" in orange when latest sample
  is null
- **Warm-up**: graph fills left-to-right as samples accumulate
- **Apple Silicon fallback**: every key renders "Intel only" badge;
  helper does not start

### Sensor probe (SMC keys)
- **Per-core CPU temp**: `TC0C..TC8C` AND `TC0c..TC8c` (both casings;
  whichever returns data)
- **CPU package fallback**: `TCAD` → `TC0F` → `TC0D` → `TC0E` → `TC0H`
  → `TCXC` → `TC0P`
- **GPU**: `TG0D` → `TCGC` → `TG0H` → `TG0P`
- **Fans**: `FNum` (count), `F{i}Ac` (current RPM), `F{i}Mn`/`F{i}Mx`
  /`F{i}Tg` (min/max/target). Decoder selected by SMC dataType per
  fan: `flt ` (T2 era, 4-byte float) or `fpe2` (legacy,
  `(b0<<6)+(b1>>2)`)
- **Temperatures decode via dataType dispatch** — `sp78` (2-byte signed
  7.8 fixed-point, modern norm), `ui8` (legacy single-byte Celsius),
  `flt ` (IEEE float). NaN/Inf → nil
- **CPU package decode bugfix vs Fanny**: original Fanny code uses
  byte0-only for all temps; v1.0 dispatches by dataType which produces
  correct readings on modern T2 Macs (Fanny would report e.g. 91 °C for
  what's actually 45.3 °C)

### Repo / project structure (locked in v1.0)
```
intel-mac-cpu-monitor/
├─ helper/                      Swift (SwiftPM, swift-tools-version 5.9)
│  ├─ Package.swift
│  ├─ Sources/smcreader/
│  │  ├─ SMC.swift, SMCStructure.swift  (IOKit connection, struct layout)
│  │  ├─ Decoders.swift                  (pure decoders: SP78, UI8, FLT, fpe2, key encoding)
│  │  ├─ Sensors.swift                   (SMC key catalogue)
│  │  ├─ Device.swift                    (T2 + Apple Silicon detection)
│  │  ├─ Catalog.swift                   (startup probe)
│  │  ├─ Protocol.swift                  (Codable wire types)
│  │  └─ main.swift                      (lifecycle, timer, signal handling)
│  └─ Tests/smcreaderTests/              (Swift Testing — `import Testing`)
├─ plugin/                      Node/TS
│  ├─ package.json, tsconfig.json, rolldown.config.ts
│  ├─ src/
│  │  ├─ plugin.ts                       (entry, action registration, global settings)
│  │  ├─ helper-protocol.ts              (TS mirror of Swift wire types)
│  │  ├─ helper-supervisor.ts            (child process lifecycle)
│  │  ├─ history.ts                      (ring buffer)
│  │  ├─ thresholds.ts                   (colors, bands, ranges, unit conversion)
│  │  ├─ render.ts                       (SVG → data URI)
│  │  ├─ hub.ts                          (central event dispatch)
│  │  └─ actions/                        (one file per action class)
│  └─ test/                              (vitest)
└─ dev.andreisudarikov.intel-mac-monitor.sdPlugin/
   ├─ manifest.json
   ├─ bin/plugin.js                      (built by rolldown)
   ├─ bin/mac/smcreader                  (built by swift)
   ├─ imgs/                              (SVG icons + plugin PNG)
   └─ ui/                                (Property Inspector HTML + bundled sdpi-components.js)
```

### Build & dev
- **Top-level scripts**: `npm run build` (builds helper + plugin +
  copies binary into bundle), `npm run test`, `npm run clean`
- **Helper build**: `swift build -c release` → binary copied to
  `bin/mac/smcreader`
- **Plugin build**: `rolldown` bundles to `bin/plugin.js`
- **Sideload via `@elgato/cli`**: `streamdeck link`,
  `streamdeck restart dev.andreisudarikov.intel-mac-monitor`,
  `streamdeck validate`
- **Tests**: 53 Swift (Swift Testing — requires
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`) + 50
  TypeScript (vitest) = **103 total**

### Other v1.0 details
- `sdpi-components.js` bundled locally in `ui/` (CDN-loaded version was
  blocked by Stream Deck's PI webview CSP)
- `<sdpi-select>` returns its value as a string; actions coerce via
  `pickCoreIndex` / `pickFanIndex`
- `DisableCaching: true` on each action so SVG updates take immediate
  effect after settings changes
- Plugin auto-detects sensor catalogue at startup, surfaces only
  existing sensors in PI dropdowns
- "First sensor auto-selected" — newly-dropped keys pick the first
  available sensor without user interaction

---

## v1.1 (2026-05-20)

UI/UX polish + a second view mode toggled by key press. No new sensor
types.

### New: "slide" view mode
- **Toggled by key press**: tap any temp/fan key to flip between graph
  view and slide view; persists per-key in settings
- **Layout**: dark background with a **thick band-colored frame around
  the entire key**, header (white) inside the frame, value
  (band-colored) inside, no graph
- **Frame geometry**:
  - rounded rectangle inset 9 px from canvas edge, size 126 × 126
  - corner radius `rx=14` — concentric with Stream Deck's bezel curve
    (measured ~23 px radius on Stream Deck XL)
  - stroke width 7.5 px
- **"No data" handling**: frame stays present (tinted orange), value
  text dropped, header reads "No data"

### Palette overhaul
- **Switched from macOS dark-mode system colors to an iPhone StandBy /
  "Color" clock-face inspired vibrant warm palette**
- Derived from a single HSL anchor (S = 79 %, L = 58 %), hue rotated
  around the wheel — all bands feel like siblings:
  - `cold` `#3FBEE9` — H 195°, cool cyan (ambient air only)
  - `cool` `#42E84A` — H 123°, vivid pure green
  - `warm` `#E8DA42` — H 55°, lemon yellow
  - `hot` `#E88E42` — H 28°, warm tangerine
  - `critical` `#E84258` — H 2°, coral-red
- `NO_DATA_COLOR` → `#E88E42` (matches `hot`)
- `TEXT_COLOR` → `#ebebf5` (macOS labelColor dark)
- `BG_COLOR` → `#1c1c1e` (macOS secondarySystemBackground dark)

### New: "cold" band
- 5th color band, applies **only to ambient air profile**; threshold
  ≤ 20 °C
- Other profiles have no `coldMax` — never enter "cold" even at
  unrealistic low readings

### Per-sensor `MetricProfile`
- New type: `{ range, coldMax?, coolMax, warmMax, hotMax }` — Y-axis
  range AND band thresholds per sensor
- CPU/GPU profile: range 30–100 °C, thresholds 60/80/95 (unchanged from
  v1.0)
- Other profiles introduced for v1.2 sensors (see below)

### Graph view refinements
- Header font 16 px → **26 px** (matched slide view) with weight 700
- Header gains 7 px top margin (caps no longer kiss the canvas edge)
- Sparkline stroke 1.6 px → **4.5 px** (clearly visible, not anemic)
- Graph zone height 72 px → **82 px** (~58 % of canvas instead of 50 %)
- Layout zones: header y=0..26, value y=26..62, graph y=62..144

### History tuning
- Buffer 60 → **45** samples (45-second ring buffer)
- Visible window 60 → **30** samples (30 s shown on graph)
- Result: 5 px/sample at 144 px canvas width — each tick is a distinct
  mark instead of a hair
- Extra 15 samples sit in reserve for any future "zoom-out" feature

### Wider per-core probe
- Probe range extended from `TC0C..TC8C` (9 keys) to `TC0..TC15` (16
  each casing) — picks up `TC9c` on 10-core CPUs like the iMac 27" i9

### Other v1.1 details
- Header label "CORE`{i}`" uses the actual core index from the helper's
  catalog
- Value mode toggle persists across Stream Deck restarts (per-key
  setting)
- On helper restart with a changed catalog, histories are cleared
- Test totals: **53 Swift + 58 TypeScript = 111**

---

## v1.2 (2026-05-20)

Expanded sensor coverage + a third view mode + unified press gestures.

### 8 new actions

| Action | UUID suffix | SMC keys (in preference order) |
|---|---|---|
| **Air Temp** | `.air` | `TA0P` → `TA1P` → `TaLP` → `TaRF` |
| **RAM Temp** | `.ram` | `Ts0S` → `TM0P` → `Tm0P` → `TMA0` → `TMB0` |
| **SSD Temp** | `.ssd` | `TH0A` → `TH0B` → `TH0C` → `TH0F` → `TH0x` → `TH1A` |
| **Chipset Temp** | `.chipset` | `TN0D` → `TN0H` → `TN0P` → `Tp0P` |
| **Wi-Fi Temp** | `.wifi` | `TW0P` |
| **Thunderbolt Temp** | `.thunderbolt` | `TI0P` → `TI1P` → `TTLD` → `TTRD` |
| **CPU Power** | `.cpu-power` | `PCPC` → `PCPT` → `PCTR` → `PC0C` → `PCAM` |
| **GPU Power** | `.gpu-power` | `PG0C` → `PCGC` → `PCPG` → `PG0R` → `PCGM` |

Each new action has its own catalog probe + per-tick read + manifest
entry + PI HTML + icon SVGs.

### `TempProfile` → `MetricProfile`
- Type renamed (alias `TempProfile` retained for backwards compat)
- Now covers both temperature and power readings — same shape, same
  `bandFor()` classifier
- Backwards-compat aliases retained: `tempBandFor === bandFor`,
  `tempBand(c)` legacy entry point

### Final tuned profiles (TEMP_PROFILES + POWER_PROFILES)

Temperature profiles (°C):
| Profile | range | cold ≤ | cool ≤ | warm ≤ | hot ≤ | critical > |
|---|---|---|---|---|---|---|
| `cpu` | 30–100 | — | 60 | 80 | 95 | 95 |
| `gpu` | 30–100 | — | 60 | 80 | 95 | 95 |
| `ambient` | 0–100 | **20** | 30 | 50 | 70 | 70 |
| `ram` | 20–90 | — | 50 | 65 | 80 | 80 |
| `ssd` | 20–90 | — | 50 | 65 | 80 | 80 |
| `chipset` | 30–100 | — | 65 | 80 | 95 | 95 |
| `wifi` | 20–90 | — | 45 | 60 | 75 | 75 |
| `thunderbolt` | 20–90 | — | 50 | 65 | 80 | 80 |

Power profiles (W) — tuned against actual Intel Mac TDPs (laptops
15–45 W, Mac mini/21.5" iMac 65 W, iMac 27" 6/8-core 95 W, iMac 27"
10-core **125 W** (= reference for full-scale), Mac Pro/iMac Pro Xeon
140–200 W+):
| Profile | range | cool ≤ | warm ≤ | hot ≤ | critical > |
|---|---|---|---|---|---|
| `cpu` (power) | 0–125 | 40 | 70 | 100 | 100 |
| `gpu` (power) | 0–150 | 25 | 70 | 130 | 130 |

### New: "meter" view mode (80s VU column)
- **Layout**: 9 chunky horizontal bars stacked vertically, ~8.4 px tall
  × 116 px wide each, 2 px gap; `rx=2` for soft polish
- Column area: x=14..130 (14 px margins each side), y=32..124
- **Per-segment color** is fixed by position (each segment's "top"
  value is band-classified) — bottom segments cool, top segments
  critical. As value rises, more segments AND warmer colors light up.
- **Lit** = full opacity; **unlit** = 0.18 opacity (the skeleton always
  shows what the meter *could* light)
- Header at top (white, 20 px); wattage label below column
  (band-colored, 14 px)
- Works on **every** sensor type — temperature profiles produce
  thermometer-style meters; fan profile produces a percentage-of-max
  meter; power produces a wattage meter
- "No data" mode: header shows alert orange, segments all dim, no
  value text

### New gesture model (uniform across all actions)
- **Short tap** (release < 600 ms): toggle **graph ↔ slide**
- **Long press** (hold ≥ 600 ms): toggle **graph ↔ meter**
- Gestures are independent: a key in slide view can be long-pressed to
  meter; a key in meter view can be long-pressed back to graph
- Implementation: `handleKeyDown` arms a 600 ms timer on `keyDown`;
  `handleKeyUp` cancels it (short tap) or notices it already fired
  (long press already triggered)
- Press state shared module-level across all action classes (keyed by
  stream-deck context id, which is globally unique)

### Power decoding
- New `Decoders.decodePower(b0..b3, dataType)` — dispatches by
  dataType:
  - `flt ` (4-byte IEEE float) — most modern Intel Mac power keys
  - `sp78` (2-byte signed 7.8 fixed-point)
  - `ui8` and unknown — fallback to single-byte decode
- NaN/Inf → nil
- Catalog probe `tryPowerSensor` accepts any non-negative finite value
  below 1 kW (some integrated GPUs idle at exactly 0 W; >1 kW
  indicates decode error)

### Wire protocol additions (helper → plugin)
`ReadyEvent` gains: `ambientSensor`, `ramSensor`, `ssdSensor`,
`chipsetSensor`, `wifiSensor`, `thunderboltSensor`, `cpuPowerSensor`,
`gpuPowerSensor` (all optional strings)

`ReadingEvent` gains: `ambient`, `ram`, `ssd`, `chipset`, `wifi`,
`thunderbolt`, `cpuPower`, `gpuPower` (all optional numbers)

### Hub additions
- New `SubscriptionKind` variants: `"ambient"`, `"ram"`, `"ssd"`,
  `"chipset"`, `"wifi"`, `"thunderbolt"`, `"cpuPower"`, `"gpuPower"`
- New `powerInput(...)` builder alongside `tempInput`/`fanInput`
- `tempInput`/`fanInput` extended to pass `rawValue` and `profile`
  (required for meter rendering)
- Wattage formatted as `"5.0W"` (one decimal) below 10 W, `"45W"`
  (whole watt) above

### Other v1.2 details
- 8 new manifest action entries, 8 new PI HTML files (units toggle for
  temps; informational for power actions which have no per-key
  settings)
- 16 new icon SVGs (icon + key for each of the 8 actions)
- All views (graph / slide / meter) live in `render.ts` as separate
  render functions dispatched by `viewMode` field on `RenderInput`
- Test totals: **81 Swift + 81 TypeScript = 162**

---

## Cumulative current state (post-v1.2.3)

| | Count |
|---|---|
| Total actions in plugin | **12** |
| View modes per action | **3** (graph / slide / meter) |
| Distinct sensor profiles | **10** (8 temperature + 2 power) |
| Color bands | **5** (cold / cool / warm / hot / critical) |
| Total tests | **167** (86 Swift + 81 TS) |
| Helper sample rate | 1 Hz |
| History buffer | 45 samples |
| Visible graph window | 30 samples |
| Stream Deck min version | 6.9 |
| macOS min version | 13 |

### Open scope (deferred)
- Code signing + Apple notarization of the helper binary (currently
  unsigned; users clear quarantine manually)
- Marketplace submission (currently GitHub sideload only)
- Memory pressure / CPU usage % / disk free space / Wi-Fi RSSI /
  battery (% + cycle count) — non-SMC metrics not yet implemented
- Per-key custom thresholds (currently hard-coded in profiles)
- Animation on band transitions or critical-band pulse (intentionally
  rejected for v1.x — feels gimmicky at this rendering rate)

### Files that capture v1.2 state for resuming work
- `plugin/src/thresholds.ts` — all profiles + colors + classifier
- `plugin/src/hub.ts` — central event dispatch, all `SubscriptionKind`
  variants, all input builders
- `plugin/src/render.ts` — all three view-mode renderers
  (`renderWithGraph` / `renderValueOnly` / `renderMeter`)
- `plugin/src/actions/toggle-view.ts` — gesture model (short tap /
  long press)
- `helper/Sources/smcreader/Sensors.swift` — every SMC key candidate
  list
- `helper/Sources/smcreader/Catalog.swift` — probe logic for both temp
  and power sensors
