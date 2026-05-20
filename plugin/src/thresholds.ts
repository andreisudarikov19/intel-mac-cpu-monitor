// Color thresholds for temperatures and fan speeds.
// Spec: discrete threshold-based colors, four bands per metric type.

export type Band = "cool" | "warm" | "hot" | "critical";

export const COLORS: Record<Band, string> = {
    cool: "#22c55e",        // green-500
    warm: "#eab308",        // yellow-500
    hot: "#f97316",         // orange-500
    critical: "#ef4444",    // red-500
};

/** Color for the special "no data" header state (orange-amber). */
export const NO_DATA_COLOR = "#f59e0b";

/** Light neutral for text on a dark background. */
export const TEXT_COLOR = "#e5e7eb";       // gray-200

/** Dark background for the key. */
export const BG_COLOR = "#0b0b0c";

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
