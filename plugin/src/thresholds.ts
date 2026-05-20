// Color thresholds for temperatures and fan speeds.
// Spec: discrete threshold-based colors, four bands per metric type.

export type Band = "cool" | "warm" | "hot" | "critical";

// Palette inspired by iPhone StandBy / "Color" clock faces — warmer and
// more saturated than macOS dark-mode system colors. Tuned for at-a-glance
// readability from across a room (Stream Deck keys are 19 mm tall).

// All four bands derived from a single HSL anchor — S = 79%, L = 58% —
// rotating hue around the color wheel. Keeping S/L constant makes the
// palette feel like a coherent family rather than four arbitrary picks.
// Cool green hue matches the "Stream Deck monitor" aesthetic Andrei
// referenced.

export const COLORS: Record<Band, string> = {
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

/** Y-axis fixed range for temperature actions, in °C. */
export const TEMP_RANGE = { min: 30, max: 100 } as const;

/** Classify a temperature reading (°C) into a color band. */
export function tempBand(celsius: number): Band {
    if (celsius <= 60) return "cool";
    if (celsius <= 80) return "warm";
    if (celsius <= 95) return "hot";
    return "critical";
}

/**
 * Classify a fan RPM into a color band, scaled by the fan's max RPM.
 * Spec: ≤30% green, ≤70% yellow, ≤100% orange, >100% red.
 */
export function fanBand(rpm: number, maxRPM: number): Band {
    if (maxRPM <= 0) return "cool";
    const pct = rpm / maxRPM;
    if (pct <= 0.30) return "cool";
    if (pct <= 0.70) return "warm";
    if (pct <= 1.0)  return "hot";
    return "critical";
}

/** Celsius ↔ Fahrenheit conversion. */
export function cToF(c: number): number {
    return c * 1.8 + 32;
}
