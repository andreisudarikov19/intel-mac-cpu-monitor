# Changelog

All notable changes to the Intel Mac Hardware Monitor plugin. Each entry describes the **resulting state** of that version — features as shipped, not the development journey. Append new versions to the top.

**Release checklist** when closing out a version:
1. Bump `Version` in `dev.andreisudarikov.intel-mac-monitor.sdPlugin/manifest.json` to match. Stream Deck manifests use 4-component `{major}.{minor}.{patch}.{build}` — so v1.3 → `1.3.0.0`, v1.3.1 → `1.3.1.0`. This is what users see in the Stream Deck UI's plugin info panel.
2. Append the new version's release notes to the top of this file.
3. Run `npm run build && streamdeck restart dev.andreisudarikov.intel-mac-monitor` so the UI picks up the new version string.

---

## v1.5.3 (2026-06-09)

Bug-fix release. v1.5.2 fixed the short-sleep case but failed after a 10-hour overnight sleep on the reference iMac 27": the three package-level sensors (TG0D, TM0P, TA0P) didn't come back even though the helper had respawned correctly on the wake notification. Diagnostic evidence (a fresh `smcreader` spawned in parallel ~2 hours after wake sees all three sensors live) showed the SMC had recovered — but our helper's catalog was frozen as of the immediately-post-wake probe, which captured the SMC mid-recovery.

### Root cause
- `kIOMessageSystemHasPoweredOn` fires when the system has powered on, not when every SMC sensor has finished its own warmup. On long sleeps, some package sensors take minutes to come back after that point. The helper's catalog probe at startup ran in that window and dropped the keys that hadn't recovered yet.
- A process probes once and never re-probes, so missed sensors stayed missed for the lifetime of that helper — until the next wake or manual restart.

### Fixed
- **Periodic catalog rescan.** The helper now re-runs `CatalogProbe.probe` on a timer. Cadence: **every 5 s for the first 5 minutes** after spawn (handles late-recovering sensors after wake), then **every 60 s** steady-state. Each rescan is merged into the current catalog *additively* — a slot we already have is never downgraded; a slot we were missing gets filled in. When the merge upgrades any slot, the helper emits a fresh `ready` event and the plugin adopts the new catalog.
- **Temperature-probe diagnostic dump.** Parallel to the existing `power-probe`: every temp candidate key (per-core CPU, package, GPU, ambient, RAM, SSD, chipset, Wi-Fi, Thunderbolt) is logged with its dataType + raw bytes + decoded value. Emitted at startup AND after every rescan, tagged `temp-probe (startup)` / `temp-probe (rescan)`. Surfaces exactly which keys responded and how at every moment.

### Technical
- `SensorCatalog.mergedAdditive(with:)` — new extension method on `Catalog.swift`. Returns `(catalog, upgraded)` where `upgraded` is true iff a previously-missing slot was filled. `cpuCores` / `fans` arrays use longest-wins.
- `Sensors.allKnownTempKeysForDiagnostics` — flat list (cpuCoreCandidates × 16 + every temp preference list).
- `main.swift`: `catalog` is `var` again so the rescan can swap. Adaptive `DispatchSourceTimer` on the same `timerQueue` as the reading timer (serial; no concurrent mutation). Helper logs a one-line `rescan upgrade: …` summary describing every slot that was filled (e.g. `rescan upgrade: gpu=TG0D, ram=TM0P, air=TA0P`).
- Plugin side unchanged — the hub's existing `onReady` handler already replaces its catalog and clears histories on each fresh ready event, so rescan upgrades flow through end-to-end without code changes.

### Behavioural note
- When a rescan upgrades the catalog, all subscribed histories clear (the existing `onReady` semantic, dating from v1.0). On a typical post-wake recovery, this is a single clear within ~10 s of wake and is essentially invisible. If the SMC brings sensors back staggered across multiple rescans, the user will see graphs reset for each upgrade event. Acceptable for v1.5.3; per-slot selective clearing is a future polish.

### Testing notes
- 5 new merge tests cover identical-no-op, upgrade-adds-missing, never-downgrade, more-cores-wins, both-have-same-slot-prefers-self. Total: 91 Swift + 127 TypeScript = **218** (up from 213).
- The long-wake case can't be reliably reproduced without a real sleep/wake cycle longer than the SMC's package-sensor warmup window. The mechanism (rescan → merge → ready) is unit-tested; final confirmation comes from a real overnight sleep.

---

## v1.5.2 (2026-06-08)

Bug-fix release. Real-hardware sleep/wake testing confirmed that v1.5.1's in-process recovery (recycle `io_connect_t` + re-probe catalog after a tick-gap heuristic) still left RAM temp, GPU temp, and ambient air temp persistently "No data" after waking from sleep. Replaces the heuristic with the canonical IOKit power-management notification and switches recovery from in-process reset to a clean helper respawn — the path that the manual-restart workaround proved actually works. Also adds an independent helper-stderr log file because Stream Deck's own plugin log never surfaced our recovery-diagnostic lines.

### Root cause (revised from v1.5.1)
- v1.5.1's catalog re-probe ran ~5–25 s after wake, gated by a tick-gap heuristic. On the reference iMac 27" 10-core, the package SMC keys (`TG0D`, `TM0P`, `TA0P`) do not come back within that window — they need longer. The retry budget (4 × 5 s) expired before they recovered, and the helper then stayed bound to a catalog without those entries until restart.
- A fresh helper process (manual Stream Deck restart) recovers reliably because by the time the user notices and restarts, the SMC has finished re-initialising on its own. The fix is to *trigger a fresh process at the right moment*, not to reset in place.

### Fixed
- **IOKit-driven wake recovery.** New `PowerNotifier` (`Sources/smcreader/PowerNotifier.swift`) calls `IORegisterForSystemPower` on a dedicated CFRunLoop thread. On `kIOMessageSystemHasPoweredOn` it signals the helper to exit cleanly; the plugin's existing supervisor respawns with a fresh `io_connect_t` and a fresh catalog probe. Sleep messages (`kIOMessageCanSystemSleep` / `kIOMessageSystemWillSleep`) are immediately acked via `IOAllowPowerChange` so we never block the system going to sleep.
- **Helper-stderr mirror log.** The supervisor now also appends raw helper stderr to `<sdPlugin>/logs/helper.log` (rotates once at 5 MB to `.1`). Stream Deck's main log only contains TRACE-Connection traffic, so the v1.5.1 `wake detected` / `wake re-probe` lines were invisible to us when diagnosing. The mirror file survives plugin restarts and is the source of truth for what the helper saw on every spawn.

### Removed
- `SMC.reset()`, `TickGapTracker`, `expectedCatalog`, and the wake re-probe retry loop in `main.swift` — all superseded by `PowerNotifier` + supervisor-driven respawn.
- `SensorCatalog.isMissingSensorsFrom(_:)` — only consumer was the v1.5.1 retry loop; gone with it. 6 associated tests removed.

### Technical
- `main.swift`: `catalog` is back to `let` (no in-process mutation); timer body only emits readings.
- `helper-supervisor.ts`: new private `openStderrLog()` / `closeStderrLog()`. Log path defaults to `dirname(binary)/../../logs/helper.log`, overridable via `stderrLogPath`. Failures (disk full, perms) silently disable the mirror — diagnostics aren't worth crashing the plugin over.
- IOKit power-message constants (`kIOMessage*`) are not bridged into the Swift IOKit overlay; declared locally with stable ABI values (`0xE0000270` / `…0x280` / `…0x300`).

### Testing notes
- The IOKit wake path can't be exercised without a real sleep/wake cycle. The respawn path itself is covered by the existing supervisor tests (which exercise child exits and verify the restart counter resets on a healthy spawn).
- 86 Swift + 127 TypeScript = **213 total** (down from 219 with the 6 removed comparison tests).

---

## v1.5.1 (2026-05-28)

Bug-fix release. The sleep/wake "No data" problem from v1.2.3 was not fully fixed — RAM temp, GPU temp, and ambient air temp still went persistently stale after waking from sleep. Root cause was deeper than v1.2.3 addressed.

### Root cause
- v1.2.3 recycled the SMC `io_connect_t` ~1 s after wake but **kept the same catalog** — so the helper stayed bound to the exact sensor keys (`TG0D`, `TM0P`, `TA0P`) that had gone stale through sleep. A fresh process (manual Stream Deck restart) recovers because it **re-runs the catalog probe**, reading every candidate key and binding onto whichever works. That re-probe — not the connection reset — is the real fix.
- The reset also likely fired too early: package/proximity sensors need a moment to re-initialize after wake.
- The `failureCounter` only forces a respawn on **total** read failure. Partial staleness (3 sensors nil, CPU cores + fans fine) was invisible to it, so the bad state persisted indefinitely.

### Fixed
- **On wake, re-run the full catalog probe** (not just reset the connection). Sequence: detect the >10 s tick gap → keep reading + emitting whatever still works (so the supervisor's 5 s stale-watch stays satisfied) → after a 5 s settle, reset the connection AND re-probe → emit a fresh `ready` event. This reproduces the known-good fresh-process recovery without a process restart.
- **Bounded retry**: if the re-probe still misses a sensor that existed at startup, retry the reset + re-probe (up to 4 more times, 5 s apart). Self-healing regardless of how long a given Mac's SMC takes to bring sensors back.

### Technical
- `main.swift`: `catalog` is now `var` and reassigned by the wake re-probe. Extracted `makeReadyEvent(_:)` (used at startup and after each re-probe). Snapshots the startup catalog as `expectedCatalog` to drive the retry decision.
- `SensorCatalog.isMissingSensorsFrom(_:)` — new extension in `Catalog.swift` (testable): true if any sensor slot populated at startup is absent in a re-probed catalog. Never flags sensors that were absent at startup.
- The wake path keeps the disk-I/O baseline reset from v1.4.0.

### Testing notes
- The recovery **mechanism** is verified: a SIGSTOP/SIGCONT pause (which produces the same >10 s tick gap as sleep) triggers the wake detection, settle, reset, re-probe, and fresh `ready` emission. However SIGSTOP does not make the SMC sensors actually go stale — only a real sleep/wake cycle does — so final confirmation that the staleness is *resolved* requires testing on hardware across a real sleep.
- 92 Swift + 127 TypeScript = **219 total** (up from 213). New: 6 `isMissingSensorsFrom` comparison tests (identical / dropped GPU / dropped RAM+ambient / fewer cores / extra sensors / sensor-absent-at-startup).

---

## v1.5.0 (2026-05-20)

Meter recalibration. Two known visual bugs in the v1.4 meters made them less informative than they should be — both stem from band thresholds being anchored to the wrong scale.

### Fixed
- **Fan meter showed yellow at idle.** Bands were 30/70/100 % of the fan's *max* RPM, but Intel Mac fans idle well above 30 % of max (the 27" iMac's fan idles at 1200 RPM, which is 44 % of its 2700 max — already in the "warm" band). At idle the meter showed 4 lit segments, of which the upper 2 were yellow.

  v1.5 anchors bands to the fan's **usable range** (`min..max`) so idle reads as 0 % effort and the meter is empty when the fan is at its floor. Spikes above the floor fill the meter from the bottom up. Bands: ≤ 40 % cool, ≤ 70 % warm, ≤ 90 % hot, > 90 % critical.

  Range start moved from 0 to `minRPM` — the 0..min portion of the scale was dead space (fans never spin there) and is no longer rendered.

- **Disk I/O meter had no green zone.** Profile was `0–3 GB/s` with `coolMax = 10 MB/s`. With 9 meter segments, the top of segment 0 was at 333 MB/s — way past the 10 MB/s cool boundary, so every segment from 0 up was classified as hot or critical. The meter was permanently orange-and-red even at idle.

  v1.5 shrinks the range to **0–1 GB/s** (covers common saturation; > 1 GB/s reads as "critical, full meter") and widens cool to **≤ 200 MB/s**. New bands: cool ≤ 200 MB/s, warm ≤ 500 MB/s, hot ≤ 800 MB/s, critical > 800 MB/s. Distribution across 9 segments is now 1 cool / 3 warm / 3 hot / 2 critical — the meter shows meaningful color at typical activity levels.

  Trade-off accepted: peak NVMe transfers (e.g. 2–3 GB/s on PCIe 4.0) clip at the top of the meter as "saturating". Worth it for the visibility of common operations.

### Reference data used for fan calibration
| Mac | Fan min RPM | Fan max RPM |
|---|---|---|
| MacBook Pro 13" | ~1300 | ~6000 |
| MacBook Pro 16" | ~1300 | ~5500 |
| iMac 21.5" / Mac mini | ~1200 | ~2700 |
| **iMac 27" (reference machine)** | **1200** | **2700** |
| iMac Pro | ~1200 | ~2500 |
| Mac Pro Intel | ~800 | ~2500 |

### Technical
- `fanBand(rpm, maxRPM)` → `fanBand(rpm, minRPM, maxRPM)`. Internal function; no callers outside the plugin.
- New `fanProfileFor(min, max)` exported from `thresholds.ts` — builds a per-fan `MetricProfile` for the hub's `fanInput`. Range starts at `min` so the meter and graph both anchor at the floor.
- Hub's `fanInput` now extracts both `min` and `max` from the helper's ready event and passes them through.
- Pure-data change; no helper or wire-protocol changes.

### Tests
- 86 Swift + 127 TypeScript = **213 total** (up from 208). New coverage: per-band assertions for the new fan classifier across idle / quarter-load / midpoint / heavy / max ranges; explicit regression for "segment 0 must be cool" on disk I/O; range-bounds test on disk profile.

---

## v1.4.1 (2026-05-20)

UX polish on the v1.4.0 additions: uptime gets a left-aligned layout, and Disk I/O is now genuinely dual-stream (read + write rendered as separate visual elements in every view mode).

### Changed
- **Uptime slide is now left-aligned.** Header "UPTIME" and the three duration lines all start at x=26 (text-anchor="start") for a data-sheet look instead of a centered banner. By extension every multi-line slide uses left-alignment — the next text-rich metric (load average / battery state) will inherit the same treatment.

### Added — Disk I/O dual-stream
The Disk I/O action now tracks **read and write as independent streams** in every view mode:

- **Graph view**: two sparklines drawn together. Read uses the band color of the peak stream; write uses cyan `#3FBEE9` (the v1.1 "cold" color) for visual contrast. The big value text shows combined bytes/sec; the per-tick color tracks the more active stream.
- **Slide view**: two left-aligned lines: `↓ 12.0 MB/s` (read in) and `↑ 1.5 MB/s` (write out). Down-arrow = data flowing into memory; up-arrow = data flowing out to disk.
- **Meter view**: two columns side-by-side (each 52 px wide, 12 px gap, 14 px outer margins). Both columns share the same band gradient (bottom green → top red); each lights up independently based on its own value. Compact footer under each column: `12M` (read) and `1.5M` (write) using the new ultra-compact formatter that drops "/s" and uses single-letter units (K/M/G).

### Technical
- **Subscription** type gains optional `historyB: History` for two-stream metrics. Resized in lockstep with `history` by `applyVisibleChange`.
- **Hub** special-cases `diskIO` in `onReading`/`onStale`: read goes to `history`, write to `historyB`. Other metrics unchanged.
- **RenderInput** gains optional `samplesB`, `rawValueB`, `valueTextB`, `streamBColor` for any future two-stream metric.
- **renderMeter** refactored to loop over a list of column specs — single-column path (1 entry) and dual-column path (2 entries) share the same rendering code.
- New `formatBytesPerSecCompact(bps)` utility for column footers (`12M` vs full `12 MB/s`).

### Tests
- 86 Swift + 122 TypeScript = **208 total** (up from 199). New coverage: compact byte formatter, dual-stream graph rendering (both stream colors present), dual-meter column placement (x=14 and x=78), dual-slide left-alignment regression test for uptime.

---

## v1.4.0 (2026-05-20)

Three new non-SMC metrics, plus a multi-line slide capability that generalizes the slide view for future text-rich actions.

### Added — 3 new actions
| Action | UUID suffix | Data source | View modes |
|---|---|---|---|
| **RAM Usage** | `.ram-usage` | `host_statistics64` (active + wired + compressed) | graph / slide / meter |
| **Disk I/O** | `.disk-io` | IOKit `IOBlockStorageDriver` (sum of all drives, delta sampled) | graph / slide / meter |
| **Uptime** | `.uptime` | Node `os.uptime()` | **slide only** (3-line custom layout) |

### RAM Usage details
- Formula matches Activity Monitor's "Memory Used": `(active + wired + compressed) × pageSize / totalPhysical`.
- Profile: range 0–100 %, bands at 50 / 75 / 90 (cool → critical). Bands tuned so the visual hits "warm" when memory pressure starts to matter and "critical" once macOS is actively compressing/swapping.
- Value text: `47%`.

### Disk I/O details
- **Combined throughput** (read + write summed). Per-stream split would use two separate actions; deferred.
- Helper does per-tick **delta sampling** of cumulative byte counters across every `IOBlockStorageDriver` instance. First tick after start reports 0 (no baseline); subsequent ticks report bytes/sec.
- Sleep/wake recovery: when the helper resets its SMC connection (see v1.2.3), it also resets the disk-I/O baseline to avoid a single huge spike on the first post-wake tick.
- Profile: range 0–3 GB/s (covers PCIe 3.0 NVMe ceiling), bands at 10 MB/s / 100 MB/s / 1 GB/s.
- Adaptive units in displayed text: `KB/s` below 1 MB/s, `MB/s` to 1 GB/s, `GB/s` above.

### Uptime details
- **Slide-only**: no graph, no meter. Tap and long-press are both no-ops; gesture handlers do nothing.
- Custom 3-line layout: `{W} weeks` / `{D} days` / `{H} hours`, largest unit on top. Always shows three lines (zeros included) for visual consistency across the day.
- Frame color: macOS systemGray `#8E8E93` — off the band palette so the eye reads it as "informational, not state-dependent".
- Pluralization: `1 week` vs `2 weeks` (etc.) done properly.
- No helper involvement — `os.uptime()` is available in pure Node.
- No PI controls beyond an informational message.

### Multi-line slide capability (generalization)
- `RenderInput` gained two optional fields:
  - `slideLines: string[]` — when set + viewMode === "value", render these stacked vertically. Header is automatically pushed up and smaller to make room.
  - `slideAccent: string` — override the band color for the frame stroke. Used by uptime's grey frame; available for any future off-band slide.
- Layout in multi-line mode: header y=40 fs=20; lines at y=72/96/120 fs=22 each, all in white (`TEXT_COLOR`).
- Single-line slide behaviour (the v1.2 default) is unchanged.

### Helper additions
- New file `Sources/smcreader/SystemStats.swift` — non-SMC system metrics. Two callables: `ramUsagePercent()` (via `host_statistics64`) and `DiskIORate.tick()` (stateful, returns bytes/sec deltas across every block storage driver).
- New optional fields on `ReadingEvent`: `ramUsagePercent`, `diskReadBytesPerSec`, `diskWriteBytesPerSec`.
- Sleep/wake reset (`SMC.reset()` path) now also resets the disk-I/O baseline so the first post-wake tick doesn't report a multi-hour worth of writes as one second of bandwidth.

### Plugin additions
- `formatBytesPerSec(bps)` utility — adaptive KB/MB/GB formatting.
- `RAM_USAGE_PROFILE`, `DISK_IO_PROFILE` in `thresholds.ts`.
- 3 new `SubscriptionKind` variants: `ramUsage`, `diskIO`, `uptime`.
- 3 new action classes with their PI HTMLs and icon SVGs.

### Tests
- 86 Swift + 113 TypeScript = **199 total** (up from 188). New coverage: profile classification, adaptive byte formatter, multi-line slide rendering, slide-accent override, hub subscription wiring.

### Out of scope (deferred)
- **Wi-Fi** additions (power draw doesn't exist as an SMC key; RSSI has different banding semantics — punted for v1.5+).
- **Process count / load average** — wasn't explicitly confirmed in the v1.4 scope discussion. Easy add later.
- **Apple Silicon** — the new non-SMC sources (host_statistics64, IOBlockStorageDriver, os.uptime) all work on AS, but the helper still refuses on AS at startup for consistency with the SMC-based actions. Selective AS support is a v1.5 conversation.

---

## v1.3.3 (2026-05-20)

Bug-fix release. Two issues reported against v1.3.2:

### Fixed
- **PI slider didn't hide when switching back to "Plugin default"** after having been set to "This key only". Root cause: sdpi-components' value- change DOM events fire inconsistently when the dropdown returns to its initial option — sometimes `valueChanged` fires, sometimes not, and `change` is similarly unreliable. Replaced the event-listener approach with a 5 Hz `setInterval` poll on the dropdown's `value` property. Polling is cheap (the PI window is only open while user is configuring a key) and bulletproof against whatever sdpi-components decides to emit.

### Verified (no code change, regression test added)
- **Visible sample count and buffer capacity revert to the plugin default (30 / 45)** when a per-tile override is cleared via the scope dropdown. Path: `extractSampleOverride` returns `undefined` → `Hub.subscribe` computes `effectiveVisible(undefined)` → 30 → `applyVisibleChange` resizes buffer from 90 to 45. Added 5 direct tests against the Hub (`test/hub-sample-count.test.ts`) covering: default-when-no-override, override-applied, override-cleared-reverts, plugin-default-change- propagates, out-of-range-override-clamps. All pass.

### Added
- `Hub.getVisibleSampleCount(contextId)` and `Hub.getBufferCapacity(contextId)` — public accessors, intended primarily for tests. Both return undefined when the context isn't subscribed.

### Tests
- 86 Swift + 102 TypeScript = **188 total** (up from 183).

---

## v1.3.2 (2026-05-20)

PI label cleanup. The per-tile slider was labeled `Samples (this key)` — a remnant from the v1.3.0 design where two sliders coexisted and needed disambiguating. Since v1.3.1 only ever shows one slider, the parenthetical is redundant.

### Changed
- PI label `Samples (this key)` → `Samples` across all 12 action PIs.

### Tests
- No code changes; **183 tests unchanged**.

---

## v1.3.1 (2026-05-20)

UI consistency polish on top of v1.3.0. In "Plugin default" mode the slider is now hidden entirely — only when the user picks "This key only" does a slider appear (bound to the per-tile override). The previous design exposed the global-default slider in every PI in "Plugin default" mode, which let the user accidentally adjust the plugin-wide value while they thought they were only configuring one tile.

### Changed
- Removed the global-default slider (`globalsetting="defaultSampleCount"`) from every PI. The plugin-wide default now stays at the hard-coded `SAMPLE_COUNT_DEFAULT` (30) unless we add a different UI for it.
- Simplified each PI's visibility-toggle JS — it now only manages the single per-tile slider.

### Known limit
- No UI to change the plugin-wide default value. If the v1.3 default of 30 isn't right for a user's preference, they can switch a tile to "This key only" and set their preferred value per tile, but other tiles won't follow. A "Set as plugin default" button next to the per-tile slider would close this gap if needed.

### Tests
- No code changes outside PI HTMLs; **183 tests unchanged**.

---

## v1.3.0 (2026-05-20)

User-facing configurability for the graph's sample window. Previously hard-coded to "30 samples / 30 s of history"; now users pick the value themselves, either globally for the plugin or per-tile as an override.

### Added
- **Sample-count slider** in every PI: range 15–60, step 5 (= 15 s to 60 s of visible history at 1 Hz).
- **Scope dropdown** per PI — "Plugin default (all keys)" vs "This key only". Default is "Plugin default" so the slider's value applies globally; switching to "This key only" treats the slider as an override that shadows the global default just for this key.
- **Dynamic buffer resize**: under the hood, each subscription's history ring buffer is sized at `ceil(visible × 1.5)` so we keep ~50% extra samples in reserve for any future "zoom out" feature. Default 30 → buffer 45; max 60 → buffer 90; min 15 → buffer 23.

### Changed
- `History` ring buffer now has a `resize(newCapacity)` method that **preserves the most recent samples that fit**. Shrinking drops oldest; growing keeps everything in place and continues from there on subsequent pushes. No "moment of no data" when the user tweaks the slider.
- `Hub.subscribe` takes a 4th optional argument `sampleCountOverride`; the hub resolves the effective visible count via per-tile override → plugin default → hard default precedence.
- Renderer accepts a `visibleSamples` field on `RenderInput`; the hard-coded `VISIBLE_SAMPLES = 30` constant is gone.
- Plugin description (Stream Deck UI) gains a hint that the new feature exists.

### Technical
- New `GlobalSettings.defaultSampleCount` (number, optional).
- New per-action `Settings.sampleCount` (number, optional, used iff `sampleScope === "tile"`).
- New per-action `Settings.sampleScope` ("global" | "tile", optional; treated as "global" when unset — back-compat for existing tiles).
- New helper `extractSampleOverride(settings)` in `actions/toggle-view.ts` — keeps the 12 action classes free of scope-check boilerplate.
- New `clampSampleCount(n)` + `bufferSizeFor(visible)` utilities exported from `hub.ts`.

### Migration
- Existing tiles inherit the plugin default 30, matching v1.2.x behavior exactly. No visible change for any user who doesn't open a PI.
- Plugin global settings persist across restarts; per-tile overrides persist per key as part of action settings.

### Tests
- 86 Swift + 97 TypeScript = **183 total**. New coverage: `History.resize` (5 scenarios), `clampSampleCount` (5 scenarios), `bufferSizeFor`, `extractSampleOverride`.

---

## v1.2.3 (2026-05-20)

Bug-fix release. Fixes a "ghost no-data" state that affected the CPU package, ambient air, and RAM keys after the Mac woke from sleep — those sensors would persistently show "No data" until the user restarted Stream Deck.

### Fixed
- **Stale AppleSMC connection after sleep/wake**: certain package-level SMC keys (`TCAD` / `TC0F` / `TA0P` / `Ts0S` and friends) silently stopped returning data after the system slept, even though the helper kept polling. Per-core CPU, GPU, fans, and SSD were unaffected because their reads go through different internal routing. The helper now detects long pauses between timer ticks (>10 s gap = process was paused) and recycles its IOKit AppleSMC connection in place via a new `SMC.reset()` method. First tick after wake shows live data again.

### How the detection works
- Helper's timer is supposed to fire every 1 s. A gap >10 s between consecutive ticks means the process was paused — sleep/wake, SIGSTOP, debugger attach, anything. Cheap to check (one timestamp comparison per tick); false positives are harmless (a redundant SMC reset costs ~µs of kernel work).
- If `SMC.reset()` itself fails (rare — would require AppleSMC kext to have unloaded), the helper exits and the plugin supervisor respawns it — the existing fallback path.

### Added
- `SMC.reset()` — close current `io_connect_t`, reopen via `IOServiceOpen`. Shared init logic factored into private `openConnection()`.
- Stderr log line `smc: reset after Ns gap (likely sleep/wake)` so the plugin log shows when the recovery fired.

### Notes
- No new SMC keys, no new actions, no UI changes. Pure runtime reliability fix.
- Tests unchanged.

---

## v1.2.2 (2026-05-20)

Release-hygiene fix. The manifest's `Version` field had been stuck at the v0.1 placeholder since day one, so the Stream Deck UI's plugin-info panel was lying about which version users had installed. This release makes the manifest version the source of truth and codifies bumping it as part of every future close-out.

### Fixed
- **`manifest.json` Version**: `0.1.0.0` → `1.2.2.0`. From here on, the manifest version tracks the shipping version 1:1 (`{major}.{minor}.{patch}.0` — the fourth component is reserved for rebuild numbers within a patch).

### Changed
- **Plugin description** (visible in Stream Deck UI) rewritten from the v1.0-era "Live CPU temperature, GPU temperature, and fan speed graphs…" to one that reflects the v1.2 feature set (thermals + fans + power; tap for slide, long-press for VU meter).

### Added
- **Release checklist** at the top of `CHANGELOG.md` — three steps to follow on every version close-out (bump manifest, append release notes, rebuild + restart). Catches the v0.1 drift class of bug.

### Notes
- No code changes; manifest + docs only. Tests unchanged at **86 Swift + 81 TypeScript = 167**.

---

## v1.2.1 (2026-05-20)

Bug-fix release. CPU power readings on Intel iMacs were bogusly low because the helper's catalog probe was picking SMC key `PCPT`, whose dataType is `spa5` (a signed 10.5 fixed-point format we didn't decode), and the decoder fell through to byte-0-as-UI8 — yielding ~4 W regardless of actual draw.

### Fixed
- **CPU power picks `PCPR` first** instead of `PCPC`/`PCPT`. PCPR = "CPU Package total (SMC)" — the RAPL-equivalent, matches reality (~8 W idle / 50 W moderate load / 125 W full TDP on a 10-core iMac).
- **Wrong `PCPT` decode** — was decoding as UI8 (returned `bytes[0]` as integer watts) because the dispatch fell through to the default case. Now decoded correctly as `spa5`.
- **`decodePower` no longer falls back to UI8** for unknown dataTypes. For power readings, byte-0-as-watts has no physical meaning, so a nil return (which makes the catalog skip the key) is safer than a wrong number.

### Added
- **`Decoders.decodeSPFixedPoint(b0, b1, dataType)`** — generic decoder for the SMC SP-family fixed-point (`sp78`, `sp87`, `spa5`, etc.). Pattern: dataType is `spXY` where X = integer bits, Y = fractional bits (both hex, totaling 15 to fit a signed Int16). Value = `signed_int16(b0, b1) / 2^Y`.
- **Power-probe diagnostic dump** — at every helper start, the helper writes one stderr line per known power SMC key (`PCPR`, `PCTR`, `PCPT`, `PCPC`, `PCAM`, `PC0R`, `PC0C`, `PC0G`, `PCEC`, `PC1C`, `PC2C`, `PC3C`, `PG0C`, `PCGC`, `PCPG`, `PG0R`, `PG1R`, `PCGM`, `PSTR`, `PDTR`, `PZ0F`) showing key, dataType, raw bytes, and decoded value. Captured by the plugin's stderr logger at ERROR level (noisy at one line per spawn, but invaluable when CPU/GPU power reads as zero on a new Mac model — go to the plugin log, grep `power-probe`, compare with `sudo powermetrics --samplers cpu_power -n 1 -i 1000`).

### Changed
- **CPU power preference order**: `PCPR` → `PCTR` → `PCPT` → `PCPC` → `PCAM` → `PC0R` → `PC0C` (was `PCPC` → `PCPT` → `PCTR` → `PC0C` → `PCAM`). PCPR is the canonical Intel RAPL-equivalent total.
- **GPU power preference order**: added `PG1R` between `PG0R` and `PCGM`. No semantic change on hardware where `PG0C` works.

### Tests
- New: 5 Swift tests covering `decodeSPFixedPoint` (including `spa5`), `decodePower` returning nil for unknown dataTypes, and updated catalog assertions for the PCPR-first order.
- Total: **86 Swift + 81 TypeScript = 167** (was 162).

### Notes for future debugging
- If a different Intel Mac shows wrong CPU/GPU power, restart the plugin, then grep `dev.andreisudarikov.intel-mac-monitor.sdPlugin /logs/*.log` for `power-probe`. The dump shows all candidate keys' values — pick the one matching `sudo powermetrics`, add it to the preference list in `helper/Sources/smcreader/Sensors.swift`.

---

## v1.0 (2026-05-20)

Initial release. Stream Deck plugin for Intel Macs showing live CPU temperatures, GPU temperature, and fan speed.

### Identity & distribution
- **UUID**: `dev.andreisudarikov.intel-mac-monitor`
- **Min macOS**: 13 (Ventura)
- **Min Stream Deck app**: 6.9
- **Node runtime**: 20 (manifest-declared; bundled by Stream Deck)
- **Distribution**: GitHub releases, sideload-only (Marketplace deferred)
- **Helper binary**: unsigned in v1.0; manual Gatekeeper clearance via `xattr -dr com.apple.quarantine` documented in README

### Architecture
- **Plugin process**: Node/TypeScript using `@elgato/streamdeck` v2 SDK; spawned by Stream Deck app; talks WebSocket to it
- **Helper process**: Swift binary (`smcreader`) spawned by plugin via `child_process`; reads SMC via IOKit `AppleSMC`; streams JSON Lines over stdout
- **Helper owns the cadence**: 1 Hz `DispatchSourceTimer`, full-payload push every tick
- **Helper supervisor in plugin**: spawn-on-start; auto-restart on exit with exponential backoff (cap 30 s); stale-watch (kills + respawns if no reading received within 5 s); detects Apple Silicon and emits `unsupported` event
- **Wire protocol** (one JSON object per line on stdout):
  - `ready` — one-time, contains arch, T2 status, detected sensor catalogue
  - `reading` — per tick, contains all sensor values
  - `unsupported` — emitted once on Apple Silicon, helper exits 0
  - `error` — emitted on IOKit/SMC failures, helper exits 1
- **Catalog probe**: helper reads each candidate SMC key once at startup; keeps only those that return >1.0 °C; resolves dataType (sp78 / ui8 / flt) per sensor so per-tick reads decode correctly

### Actions (4)
| Action | UUID suffix | Sensor source | PI controls |
|---|---|---|---|
| CPU Core Temp | `.cpu-core` | `TC{i}C` / `TC{i}c` per-core, i=0..15 | Core picker (dynamic, populated by helper) + °C/°F |
| CPU Temp | `.cpu` | Mean of detected per-core sensors; falls back to `TCAD` → `TC0F` → `TC0D` → `TC0E` → `TC0H` → `TCXC` → `TC0P` package keys | °C/°F |
| GPU Temp | `.gpu` | `TG0D` → `TCGC` → `TG0H` → `TG0P` preference order | °C/°F |
| Fan Speed | `.fan` | `FNum` for count; `F{i}Ac/Mn/Mx` per fan | Fan picker (dynamic) |

### Visualization (one view mode: graph)
- **144 × 144 canvas**, dark background `#1c1c1e`
- **Top half**: label ("CPU", "GPU", "FAN1", "CORE5", …) + value ("62°C", "2100") on one line
- **Bottom half**: filled-area + line sparkline with ~30 % opacity area fill, 1.6 px stroke
- **Y-axis**: fixed range per metric (temps 30–100 °C; fans 0 to that fan's reported max RPM)
- **History**: 60-sample ring buffer, 60-second visible window, 1 sample/sec
- **Color bands** (4): thresholds applied to value to color both the text and the sparkline
  - Temps: ≤ 60 °C cool, ≤ 80 warm, ≤ 95 hot, > 95 critical
  - Fans: ≤ 30 % max cool, ≤ 70 % warm, ≤ 100 % hot, > 100 % critical
- **Palette**: macOS dark-mode system colors — `#30D158` / `#FFD60A` / `#FF9F0A` / `#FF453A`
- **Stale data handling**: missing samples render as **gaps** in the graph; the header switches to "No data" in orange when latest sample is null
- **Warm-up**: graph fills left-to-right as samples accumulate
- **Apple Silicon fallback**: every key renders "Intel only" badge; helper does not start

### Sensor probe (SMC keys)
- **Per-core CPU temp**: `TC0C..TC8C` AND `TC0c..TC8c` (both casings; whichever returns data)
- **CPU package fallback**: `TCAD` → `TC0F` → `TC0D` → `TC0E` → `TC0H` → `TCXC` → `TC0P`
- **GPU**: `TG0D` → `TCGC` → `TG0H` → `TG0P`
- **Fans**: `FNum` (count), `F{i}Ac` (current RPM), `F{i}Mn`/`F{i}Mx` /`F{i}Tg` (min/max/target). Decoder selected by SMC dataType per fan: `flt ` (T2 era, 4-byte float) or `fpe2` (legacy, `(b0<<6)+(b1>>2)`)
- **Temperatures decode via dataType dispatch** — `sp78` (2-byte signed 7.8 fixed-point, modern norm), `ui8` (legacy single-byte Celsius), `flt ` (IEEE float). NaN/Inf → nil
- **CPU package decode bugfix vs Fanny**: original Fanny code uses byte0-only for all temps; v1.0 dispatches by dataType which produces correct readings on modern T2 Macs (Fanny would report e.g. 91 °C for what's actually 45.3 °C)

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
- **Top-level scripts**: `npm run build` (builds helper + plugin + copies binary into bundle), `npm run test`, `npm run clean`
- **Helper build**: `swift build -c release` → binary copied to `bin/mac/smcreader`
- **Plugin build**: `rolldown` bundles to `bin/plugin.js`
- **Sideload via `@elgato/cli`**: `streamdeck link`, `streamdeck restart dev.andreisudarikov.intel-mac-monitor`, `streamdeck validate`
- **Tests**: 53 Swift (Swift Testing — requires `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`) + 50 TypeScript (vitest) = **103 total**

### Other v1.0 details
- `sdpi-components.js` bundled locally in `ui/` (CDN-loaded version was blocked by Stream Deck's PI webview CSP)
- `<sdpi-select>` returns its value as a string; actions coerce via `pickCoreIndex` / `pickFanIndex`
- `DisableCaching: true` on each action so SVG updates take immediate effect after settings changes
- Plugin auto-detects sensor catalogue at startup, surfaces only existing sensors in PI dropdowns
- "First sensor auto-selected" — newly-dropped keys pick the first available sensor without user interaction

---

## v1.1 (2026-05-20)

UI/UX polish + a second view mode toggled by key press. No new sensor types.

### New: "slide" view mode
- **Toggled by key press**: tap any temp/fan key to flip between graph view and slide view; persists per-key in settings
- **Layout**: dark background with a **thick band-colored frame around the entire key**, header (white) inside the frame, value (band-colored) inside, no graph
- **Frame geometry**:
  - rounded rectangle inset 9 px from canvas edge, size 126 × 126
  - corner radius `rx=14` — concentric with Stream Deck's bezel curve (measured ~23 px radius on Stream Deck XL)
  - stroke width 7.5 px
- **"No data" handling**: frame stays present (tinted orange), value text dropped, header reads "No data"

### Palette overhaul
- **Switched from macOS dark-mode system colors to an iPhone StandBy / "Color" clock-face inspired vibrant warm palette**
- Derived from a single HSL anchor (S = 79 %, L = 58 %), hue rotated around the wheel — all bands feel like siblings:
  - `cold` `#3FBEE9` — H 195°, cool cyan (ambient air only)
  - `cool` `#42E84A` — H 123°, vivid pure green
  - `warm` `#E8DA42` — H 55°, lemon yellow
  - `hot` `#E88E42` — H 28°, warm tangerine
  - `critical` `#E84258` — H 2°, coral-red
- `NO_DATA_COLOR` → `#E88E42` (matches `hot`)
- `TEXT_COLOR` → `#ebebf5` (macOS labelColor dark)
- `BG_COLOR` → `#1c1c1e` (macOS secondarySystemBackground dark)

### New: "cold" band
- 5th color band, applies **only to ambient air profile**; threshold ≤ 20 °C
- Other profiles have no `coldMax` — never enter "cold" even at unrealistic low readings

### Per-sensor `MetricProfile`
- New type: `{ range, coldMax?, coolMax, warmMax, hotMax }` — Y-axis range AND band thresholds per sensor
- CPU/GPU profile: range 30–100 °C, thresholds 60/80/95 (unchanged from v1.0)
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
- Result: 5 px/sample at 144 px canvas width — each tick is a distinct mark instead of a hair
- Extra 15 samples sit in reserve for any future "zoom-out" feature

### Wider per-core probe
- Probe range extended from `TC0C..TC8C` (9 keys) to `TC0..TC15` (16 each casing) — picks up `TC9c` on 10-core CPUs like the iMac 27" i9

### Other v1.1 details
- Header label "CORE`{i}`" uses the actual core index from the helper's catalog
- Value mode toggle persists across Stream Deck restarts (per-key setting)
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

Each new action has its own catalog probe + per-tick read + manifest entry + PI HTML + icon SVGs.

### `TempProfile` → `MetricProfile`
- Type renamed (alias `TempProfile` retained for backwards compat)
- Now covers both temperature and power readings — same shape, same `bandFor()` classifier
- Backwards-compat aliases retained: `tempBandFor === bandFor`, `tempBand(c)` legacy entry point

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

Power profiles (W) — tuned against actual Intel Mac TDPs (laptops 15–45 W, Mac mini/21.5" iMac 65 W, iMac 27" 6/8-core 95 W, iMac 27" 10-core **125 W** (= reference for full-scale), Mac Pro/iMac Pro Xeon 140–200 W+):
| Profile | range | cool ≤ | warm ≤ | hot ≤ | critical > |
|---|---|---|---|---|---|
| `cpu` (power) | 0–125 | 40 | 70 | 100 | 100 |
| `gpu` (power) | 0–150 | 25 | 70 | 130 | 130 |

### New: "meter" view mode (80s VU column)
- **Layout**: 9 chunky horizontal bars stacked vertically, ~8.4 px tall × 116 px wide each, 2 px gap; `rx=2` for soft polish
- Column area: x=14..130 (14 px margins each side), y=32..124
- **Per-segment color** is fixed by position (each segment's "top" value is band-classified) — bottom segments cool, top segments critical. As value rises, more segments AND warmer colors light up.
- **Lit** = full opacity; **unlit** = 0.18 opacity (the skeleton always shows what the meter *could* light)
- Header at top (white, 20 px); wattage label below column (band-colored, 14 px)
- Works on **every** sensor type — temperature profiles produce thermometer-style meters; fan profile produces a percentage-of-max meter; power produces a wattage meter
- "No data" mode: header shows alert orange, segments all dim, no value text

### New gesture model (uniform across all actions)
- **Short tap** (release < 600 ms): toggle **graph ↔ slide**
- **Long press** (hold ≥ 600 ms): toggle **graph ↔ meter**
- Gestures are independent: a key in slide view can be long-pressed to meter; a key in meter view can be long-pressed back to graph
- Implementation: `handleKeyDown` arms a 600 ms timer on `keyDown`; `handleKeyUp` cancels it (short tap) or notices it already fired (long press already triggered)
- Press state shared module-level across all action classes (keyed by stream-deck context id, which is globally unique)

### Power decoding
- New `Decoders.decodePower(b0..b3, dataType)` — dispatches by dataType:
  - `flt ` (4-byte IEEE float) — most modern Intel Mac power keys
  - `sp78` (2-byte signed 7.8 fixed-point)
  - `ui8` and unknown — fallback to single-byte decode
- NaN/Inf → nil
- Catalog probe `tryPowerSensor` accepts any non-negative finite value below 1 kW (some integrated GPUs idle at exactly 0 W; >1 kW indicates decode error)

### Wire protocol additions (helper → plugin)
`ReadyEvent` gains: `ambientSensor`, `ramSensor`, `ssdSensor`, `chipsetSensor`, `wifiSensor`, `thunderboltSensor`, `cpuPowerSensor`, `gpuPowerSensor` (all optional strings)

`ReadingEvent` gains: `ambient`, `ram`, `ssd`, `chipset`, `wifi`, `thunderbolt`, `cpuPower`, `gpuPower` (all optional numbers)

### Hub additions
- New `SubscriptionKind` variants: `"ambient"`, `"ram"`, `"ssd"`, `"chipset"`, `"wifi"`, `"thunderbolt"`, `"cpuPower"`, `"gpuPower"`
- New `powerInput(...)` builder alongside `tempInput`/`fanInput`
- `tempInput`/`fanInput` extended to pass `rawValue` and `profile` (required for meter rendering)
- Wattage formatted as `"5.0W"` (one decimal) below 10 W, `"45W"` (whole watt) above

### Other v1.2 details
- 8 new manifest action entries, 8 new PI HTML files (units toggle for temps; informational for power actions which have no per-key settings)
- 16 new icon SVGs (icon + key for each of the 8 actions)
- All views (graph / slide / meter) live in `render.ts` as separate render functions dispatched by `viewMode` field on `RenderInput`
- Test totals: **81 Swift + 81 TypeScript = 162**

---

## Cumulative current state (post-v1.5.1)

| | Count |
|---|---|
| Total actions in plugin | **15** |
| View modes per action | **3** (graph / slide / meter); Uptime is slide-only |
| Distinct metric profiles | **12** (8 temperature + 2 power + RAM% + disk I/O) + per-fan dynamic |
| Color bands | **5** (cold / cool / warm / hot / critical) |
| Total tests | **219** (92 Swift + 127 TS) |
| Helper sample rate | 1 Hz |
| Visible graph window | user-configurable 15–60 samples (default 30); buffer = ceil(visible × 1.5) |
| Stream Deck min version | 6.9 |
| macOS min version | 13 |

### Open scope (deferred)
- Code signing + Apple notarization of the helper binary (currently unsigned; users clear quarantine manually)
- Marketplace submission (currently GitHub sideload only)
- Memory pressure / CPU usage % / disk free space / Wi-Fi RSSI / battery (% + cycle count) — non-SMC metrics not yet implemented
- Per-key custom thresholds (currently hard-coded in profiles)
- Animation on band transitions or critical-band pulse (intentionally rejected for v1.x — feels gimmicky at this rendering rate)

### Files that capture v1.2 state for resuming work
- `plugin/src/thresholds.ts` — all profiles + colors + classifier
- `plugin/src/hub.ts` — central event dispatch, all `SubscriptionKind` variants, all input builders
- `plugin/src/render.ts` — all three view-mode renderers (`renderWithGraph` / `renderValueOnly` / `renderMeter`)
- `plugin/src/actions/toggle-view.ts` — gesture model (short tap / long press)
- `helper/Sources/smcreader/Sensors.swift` — every SMC key candidate list
- `helper/Sources/smcreader/Catalog.swift` — probe logic for both temp and power sensors
