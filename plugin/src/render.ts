// Render a 144x144 SVG key image for any of the four actions.
//
// Layout (matches the two-row split spec):
//   y =   0..28   header: label (or "No data" in orange when stale)
//   y =  28..72   big value, e.g. "62°C" or "2100"
//   y =  72..144  filled-area + line sparkline
//
// Returned as a data: URI suitable for Stream Deck's setImage command.

import { BG_COLOR, COLORS, NO_DATA_COLOR, TEXT_COLOR, type Band } from "./thresholds.js";

export type RenderInput = {
    /** Short label shown in the header (e.g., "CPU", "GPU", "FAN1"). */
    label: string;
    /** Formatted value text (e.g., "62°C", "2100"). Empty string when stale. */
    valueText: string;
    /**
     * Color band for value + graph. If `noData` is true, this is ignored and
     * the header uses NO_DATA_COLOR.
     */
    band: Band;
    /** True when latest sample is missing — header reads "No data" in orange. */
    noData: boolean;
    /** Sparkline samples (null = gap), chronological. */
    samples: (number | null)[];
    /** Fixed Y-axis range for the graph. */
    range: { min: number; max: number };
};

const W = 144;
const H = 144;
// Header baseline. Was 20 (font-size 16). Raised to 28 to fit a 22 px
// header without clipping at the top edge of the key.
const HEADER_BASELINE_Y = 28;
const HEADER_Y = 36;          // bottom of the header zone (for spacing math)
const VALUE_Y = 72;
const GRAPH_Y = 72;
const GRAPH_H = H - GRAPH_Y;

/** Escape characters that have special meaning in XML attribute values. */
function xmlEscape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Build the sparkline as one `<path>` per contiguous run of non-null samples. */
function buildSparkline(
    samples: (number | null)[],
    range: { min: number; max: number },
    color: string,
): string {
    const n = samples.length;
    if (n === 0) return "";

    const xStep = n > 1 ? W / (n - 1) : W;
    const yFor = (v: number): number => {
        const clamped = Math.max(range.min, Math.min(range.max, v));
        const norm = (clamped - range.min) / (range.max - range.min);
        return GRAPH_Y + (1 - norm) * GRAPH_H;
    };

    // Group contiguous non-null runs.
    const runs: { startIdx: number; pts: { x: number; y: number }[] }[] = [];
    let cur: typeof runs[number] | null = null;
    for (let i = 0; i < n; i++) {
        const s = samples[i];
        if (s === null || s === undefined) {
            cur = null;
            continue;
        }
        const point = { x: i * xStep, y: yFor(s) };
        if (cur === null) {
            cur = { startIdx: i, pts: [point] };
            runs.push(cur);
        } else {
            cur.pts.push(point);
        }
    }

    const parts: string[] = [];
    const baselineY = GRAPH_Y + GRAPH_H;

    for (const run of runs) {
        if (run.pts.length === 0) continue;
        const first = run.pts[0]!;
        const last = run.pts[run.pts.length - 1]!;

        // Fill: closed path baseline -> first sample -> ... -> last sample -> baseline
        let fillD = `M${first.x.toFixed(2)},${baselineY.toFixed(2)} L${first.x.toFixed(2)},${first.y.toFixed(2)}`;
        for (let i = 1; i < run.pts.length; i++) {
            fillD += ` L${run.pts[i]!.x.toFixed(2)},${run.pts[i]!.y.toFixed(2)}`;
        }
        fillD += ` L${last.x.toFixed(2)},${baselineY.toFixed(2)} Z`;
        parts.push(
            `<path d="${fillD}" fill="${color}" fill-opacity="0.35" stroke="none"/>`
        );

        // Stroke: line through the samples
        let strokeD = `M${first.x.toFixed(2)},${first.y.toFixed(2)}`;
        for (let i = 1; i < run.pts.length; i++) {
            strokeD += ` L${run.pts[i]!.x.toFixed(2)},${run.pts[i]!.y.toFixed(2)}`;
        }
        parts.push(
            `<path d="${strokeD}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
        );
    }
    return parts.join("");
}

export function renderSVG(input: RenderInput): string {
    const headerColor = input.noData ? NO_DATA_COLOR : TEXT_COLOR;
    const headerText = input.noData ? "No data" : input.label;
    const valueColor = input.noData ? NO_DATA_COLOR : COLORS[input.band];
    const graphColor = input.noData ? NO_DATA_COLOR : COLORS[input.band];

    const sparkline = buildSparkline(input.samples, input.range, graphColor);

    // Header 22 px / weight 700 — chosen for legibility at typical
    // Stream Deck key viewing distances (~40 cm to a 19 mm key).
    // Value 34 px / weight 700 — unchanged.
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
            `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG_COLOR}"/>` +
            `<text x="${W / 2}" y="${HEADER_BASELINE_Y}" text-anchor="middle" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="22" font-weight="700" ` +
                `fill="${headerColor}">${xmlEscape(headerText)}</text>` +
            `<text x="${W / 2}" y="${VALUE_Y - 12}" text-anchor="middle" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" ` +
                `fill="${valueColor}">${xmlEscape(input.valueText)}</text>` +
            sparkline +
        `</svg>`;
    return svg;
}

/** Wrap an SVG string as a data: URI for Stream Deck's setImage command. */
export function svgDataUri(svg: string): string {
    // base64 is the safest encoding for arbitrary SVG payloads.
    const b64 = Buffer.from(svg, "utf8").toString("base64");
    return `data:image/svg+xml;base64,${b64}`;
}
