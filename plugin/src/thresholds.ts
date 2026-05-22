// Color thresholds for temperatures and fan speeds.
// Spec: discrete threshold-based colors. Up to five bands — "cold" only
// applies to ambient air; all other sensor types use cool→critical.

export type Band = "cold" | "cool" | "warm" | "hot" | "critical";

// Palette inspired by iPhone StandBy / "Color" clock faces — warmer and
// more saturated than macOS dark-mode system colors. Tuned for at-a-glance
// readability from across a room (Stream Deck keys are 19 mm tall).

// All bands derived from a single HSL anchor — S = 79%, L = 58% —
// rotating hue around the color wheel. Keeping S/L constant makes the
// palette feel like a coherent family rather than five arbitrary picks.

export const COLORS: Record<Band, string> = {
    cold: "#3FBEE9",        // H 195° — cool cyan (ambient air only)
    cool: "#42E84A",        // H 123° — vivid pure green
    warm: "#E8DA42",        // H  55° — lemon yellow
    hot: "#E88E42",         // H  28° — warm tangerine
    critical: "#E84258",    // H   2° — coral-red
};

/** "No data" header color — uses the `hot` tangerine. */
export const NO_DATA_COLOR = "#E88E42";

/** Primary label color in macOS dark mode (NSColor.labelColor / .light). */
export const TEXT_COLOR = "#ebebf5";

/** macOS secondarySystemBackground in dark mode. Slightly lifted off pure
 *  black so the key looks intentional next to other dark UI surfaces. */
export const BG_COLOR = "#1c1c1e";

/** Dark foreground for use on top of a band-color background (the "value"
 *  view mode). Contrast vs each band tested AAA except critical (AA). */
export const DARK_ON_BAND_COLOR = "#1c1c1e";

/** Y-axis fixed range for CPU/GPU temperature actions, in °C. Kept for
 *  backwards compatibility — the new TEMP_PROFILES map supersedes it. */
export const TEMP_RANGE = { min: 30, max: 100 } as const;

/** Per-sensor-type Y-axis range plus the three band thresholds.
 *  Different sensors have very different normal/hot/critical bands:
 *  ambient air idles around 20-25 °C; CPU at 50 °C is just fine; SSDs
 *  throttle around 70 °C. One-size thresholds would make most graphs
 *  visually flat. */
/** A numeric metric's display range plus band thresholds. Used for both
 *  temperature and power readings — structurally identical, semantically
 *  the same job (classify a number into a colored band). */
export type MetricProfile = {
    range: { min: number; max: number };
    /** Optional. Only set on profiles where "cold" is meaningful (ambient
     *  air can reasonably read below this; CPU/GPU/RAM/SSD cannot). */
    coldMax?: number;    // ≤ this → cold band (cyan)
    coolMax: number;     // ≤ this → cool band
    warmMax: number;     // ≤ this → warm band
    hotMax: number;      // ≤ this → hot band; above → critical
};

/** Backwards-compat alias — old code references `TempProfile`. */
export type TempProfile = MetricProfile;

// Ambient uses the same 0–100°C range as CPU/GPU so a 13°C ambient and a
// 49°C CPU reading produce *visually distinct* line heights — the Y-axis
// finally means the same thing across all temperature actions. The
// trade-off is that ambient never fills the graph as high as CPU; that's
// honest, since ambient really IS the lowest-reading sensor.
export const TEMP_PROFILES = {
    cpu:         { range: { min: 30, max: 100 },                coolMax: 60, warmMax: 80, hotMax: 95 },
    gpu:         { range: { min: 30, max: 100 },                coolMax: 60, warmMax: 80, hotMax: 95 },
    ambient:     { range: { min:  0, max: 100 }, coldMax: 20,   coolMax: 30, warmMax: 50, hotMax: 70 },
    ram:         { range: { min: 20, max:  90 },                coolMax: 50, warmMax: 65, hotMax: 80 },
    ssd:         { range: { min: 20, max:  90 },                coolMax: 50, warmMax: 65, hotMax: 80 },
    // Chipset (PCH/Northbridge) runs hot on Intel Macs — 60-80 °C idle is
    // normal; throttle territory around 95 °C.
    chipset:     { range: { min: 30, max: 100 },                coolMax: 65, warmMax: 80, hotMax: 95 },
    // Wi-Fi card: typically 30-50 °C idle, can hit 60+ under load.
    wifi:        { range: { min: 20, max:  90 },                coolMax: 45, warmMax: 60, hotMax: 75 },
    // Thunderbolt controller: similar envelope to Wi-Fi but tolerates a
    // little more heat under sustained bandwidth.
    thunderbolt: { range: { min: 20, max:  90 },                coolMax: 50, warmMax: 65, hotMax: 80 },
} as const satisfies Record<string, MetricProfile>;

/** Power profiles (watts). Ranges and bands tuned to actual Intel Mac
 *  TDPs (researched per model). The reference "peak" for the meter's
 *  full-scale fill is the 10-core iMac 27" (125 W TDP, ~170 W boost) for
 *  CPU, and the iMac 27" 2020 high-end Radeon Pro 5700 XT (130 W TDP)
 *  for GPU. Lower-TDP Macs (laptops, Mac mini) fill less of the meter at
 *  full load, which is honest — they really do consume less. */
export const POWER_PROFILES = {
    cpu: { range: { min: 0, max: 125 }, coolMax: 40, warmMax: 70, hotMax: 100 },
    gpu: { range: { min: 0, max: 150 }, coolMax: 25, warmMax: 70, hotMax: 130 },
} as const satisfies Record<string, MetricProfile>;

/** RAM usage profile. Activity Monitor's "Memory Used" is already
 *  pre-computed by the helper to a 0–100% scale. Bands tuned for the
 *  glanceable "is my Mac starting to swap?" question — cool below
 *  50%, hot when we're approaching 90%. Above 90% macOS will be
 *  actively compressing/swapping. */
export const RAM_USAGE_PROFILE: MetricProfile = {
    range: { min: 0, max: 100 },
    coolMax: 50,
    warmMax: 75,
    hotMax: 90,
};

/** Disk I/O profile (per-stream bytes/sec; each of read & write is
 *  classified independently in the dual-stream meter).
 *
 *  Range tuned to typical Mac usage rather than PCIe theoretical max:
 *  modern NVMe can technically hit 3 GB/s, but virtually no real
 *  workload sustains anywhere close. Capping the range at 1 GB/s
 *  means common operations (compile, file copy) get visible meter
 *  movement; saturating transfers > 1 GB/s correctly read as
 *  "critical, full meter" rather than getting lost in the 0–3 GB/s
 *  void.
 *
 *  Bands tuned so segment 0 (top = 111 MB/s) lands inside the cool
 *  zone — fixes the v1.4 "no green segments" complaint where
 *  everything past idle showed orange/red.
 *
 *  Values are in BYTES/sec; display formatting (MB/s, GB/s, KB/s)
 *  is done in the hub. */
export const DISK_IO_PROFILE: MetricProfile = {
    range: { min: 0, max: 1_000_000_000 },     // 1 GB/s = common saturation point
    coolMax:    200_000_000,                    // 200 MB/s — moderate sustained I/O
    warmMax:    500_000_000,                    // 500 MB/s — heavy transfer
    hotMax:     800_000_000,                    // 800 MB/s — near saturation
};

/** Classify a numeric reading into a color band using a profile.
 *  Profiles without `coldMax` skip the cold check. */
export function bandFor(value: number, profile: MetricProfile): Band {
    if (profile.coldMax !== undefined && value <= profile.coldMax) return "cold";
    if (value <= profile.coolMax) return "cool";
    if (value <= profile.warmMax) return "warm";
    if (value <= profile.hotMax) return "hot";
    return "critical";
}

/** Backwards-compat alias — old code references `tempBandFor`. */
export const tempBandFor = bandFor;

/** Legacy band classifier for CPU/GPU temperature. Retained so older call
 *  sites still type-check; new code should use `bandFor` directly. */
export function tempBand(celsius: number): Band {
    return bandFor(celsius, TEMP_PROFILES.cpu);
}

/**
 * Classify a fan RPM into a color band, scaled by the fan's *usable
 * range* — `min..max` rather than `0..max`. The "ratio" is how far
 * above the minimum the fan is spinning, as a fraction of the spinup
 * room it has.
 *
 * Pre-v1.5 this took only `maxRPM` and bands were 30/70/100 % of max.
 * That misclassified Intel Mac fans whose idle floor (e.g. 1200 RPM
 * on the 27" iMac) sits well above the original "cool" threshold —
 * the meter showed yellow at idle. v1.5 anchors bands to the usable
 * range so idle reads as cool and approaching max reads as critical.
 *
 * Thresholds: ≤ 40 % cool, ≤ 70 % warm, ≤ 90 % hot, > 90 % critical.
 */
export function fanBand(rpm: number, minRPM: number, maxRPM: number): Band {
    const usable = maxRPM - minRPM;
    if (usable <= 0) return "cool";
    const ratio = (rpm - minRPM) / usable;
    if (ratio <= 0.40) return "cool";
    if (ratio <= 0.70) return "warm";
    if (ratio <= 0.90) return "hot";
    return "critical";
}

/**
 * Build a per-fan MetricProfile from its reported min/max RPM.
 * Used by the hub for graph (Y-axis) and meter (segment colors).
 * Range starts at minRPM so the meter shows 0 lit segments at idle
 * and fills as the fan spins up — the "spike against the minimum"
 * the v1.5 calibration targets.
 */
export function fanProfileFor(minRPM: number, maxRPM: number): MetricProfile {
    const usable = Math.max(1, maxRPM - minRPM);
    return {
        range: { min: minRPM, max: maxRPM },
        coolMax: minRPM + usable * 0.40,
        warmMax: minRPM + usable * 0.70,
        hotMax:  minRPM + usable * 0.90,
    };
}

/** Celsius ↔ Fahrenheit conversion. */
export function cToF(c: number): number {
    return c * 1.8 + 32;
}
