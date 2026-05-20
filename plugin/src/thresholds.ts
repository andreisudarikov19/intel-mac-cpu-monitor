// Color thresholds for temperatures and fan speeds.
// Spec: discrete threshold-based colors, four bands per metric type.

export type Band = "cool" | "warm" | "hot" | "critical";

// Palette is macOS dark-mode system colors — what AppKit/UIKit's "system"
// dynamic colors resolve to in dark appearance. This makes the key images
// look at-home next to native macOS UI elements.

export const COLORS: Record<Band, string> = {
    cool: "#30d158",        // System Green (dark)
    warm: "#ffd60a",        // System Yellow (dark)
    hot: "#ff9f0a",         // System Orange (dark)
    critical: "#ff453a",    // System Red (dark)
};

/** "No data" header color — reuses System Orange so it reads as an alert
 *  without being scary like System Red. */
export const NO_DATA_COLOR = "#ff9f0a";

/** Primary label color in macOS dark mode (NSColor.labelColor / .light). */
export const TEXT_COLOR = "#ebebf5";

/** macOS secondarySystemBackground in dark mode. Slightly lifted off pure
 *  black so the key looks intentional next to other dark UI surfaces. */
export const BG_COLOR = "#1c1c1e";

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
