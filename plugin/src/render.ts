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
    /** View mode. Defaults to "graph". */
    viewMode?: "graph" | "value";
};

const W = 144;
const H = 144;
// Layout zones (graph mode). Baselines shifted down 2–4 px from initial
// v1.1 layout to give the header a visible top margin (caps now start at
// y=7 instead of y=3).
//
//   y=  0..26   header zone   (baseline 26 — 7 px above caps to top edge)
//   y= 26..62   value zone    (baseline 56)
//   y= 62..144  graph zone    (82 px tall — still 14% taller than original)
const HEADER_BASELINE_Y = 26;
const VALUE_BASELINE_Y = 56;
const GRAPH_Y = 62;
const GRAPH_H = H - GRAPH_Y;

// Number of trailing samples to render in the sparkline. The hub keeps a
// 45-sample buffer (45 s of history) but the graph displays only the most
// recent 30. With the 144 px canvas, that yields ~5 px/sample — each tick
// is a clearly distinct mark instead of a hairline. The leftover 15
// samples stay in the buffer for any future "zoomed-out view" feature.
const VISIBLE_SAMPLES = 30;

/** Escape characters that have special meaning in XML attribute values. */
function xmlEscape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Build the sparkline as one `<path>` per contiguous run of non-null samples.
 *  Renders only the most recent VISIBLE_SAMPLES (49) of whatever was passed
 *  in — the buffer may hold more (e.g. 60 s of history). */
function buildSparkline(
    samples: (number | null)[],
    range: { min: number; max: number },
    color: string,
): string {
    const visible = samples.length > VISIBLE_SAMPLES
        ? samples.slice(-VISIBLE_SAMPLES)
        : samples;
    const n = visible.length;
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
        const s = visible[i];
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
            `<path d="${strokeD}" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`
        );
    }
    return parts.join("");
}

export function renderSVG(input: RenderInput): string {
    if (input.viewMode === "value") {
        return renderValueOnly(input);
    }
    return renderWithGraph(input);
}

/** Default view: header + value + sparkline on neutral dark bg. */
function renderWithGraph(input: RenderInput): string {
    const headerColor = input.noData ? NO_DATA_COLOR : TEXT_COLOR;
    const headerText = input.noData ? "No data" : input.label;
    const valueColor = input.noData ? NO_DATA_COLOR : COLORS[input.band];
    const graphColor = input.noData ? NO_DATA_COLOR : COLORS[input.band];

    const sparkline = buildSparkline(input.samples, input.range, graphColor);

    // Header 26 px / weight 700 — matches value-mode header size for
    // visual consistency. Value 34 px / weight 700 — unchanged.
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
            `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG_COLOR}"/>` +
            `<text x="${W / 2}" y="${HEADER_BASELINE_Y}" text-anchor="middle" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="26" font-weight="700" ` +
                `fill="${headerColor}">${xmlEscape(headerText)}</text>` +
            `<text x="${W / 2}" y="${VALUE_BASELINE_Y}" text-anchor="middle" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="34" font-weight="700" ` +
                `fill="${valueColor}">${xmlEscape(input.valueText)}</text>` +
            sparkline +
        `</svg>`;
    return svg;
}

/**
 * "Value" view: dark background, with a sharp-cornered band-colored frame
 * around the entire key. Header (white) and value (band color) live inside
 * the frame. Toggled on by a key press.
 *
 * noData mode: keep the frame (it's the key's "alive in value mode"
 * indicator) but tinted orange; drop the value text.
 */
function renderValueOnly(input: RenderInput): string {
    const accent = input.noData ? NO_DATA_COLOR : COLORS[input.band];
    const headerColor = input.noData ? NO_DATA_COLOR : TEXT_COLOR;
    const headerText = input.noData ? "No data" : input.label;

    // Layout (144x144):
    //   frame  x=9, y=9, 126x126, rx=14, stroke 7.5
    //          → frame's corner curve is concentric with Stream Deck's key
    //            bezel (measured visually at ~23 px radius). Both curves
    //            share center (23, 23) so the frame parallels the bezel
    //            arc, sitting 5.25 px inside it everywhere.
    //   header baseline y=58, font-size 26  (caps ~y=36..58)
    //   value  baseline y=104, font-size 32 (caps ~y=76..104)
    const value = input.noData
        ? ""
        : `<text x="${W / 2}" y="104" text-anchor="middle" ` +
              `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="32" font-weight="700" ` +
              `fill="${accent}">${xmlEscape(input.valueText)}</text>`;

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
            `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG_COLOR}"/>` +
            `<rect x="9" y="9" width="126" height="126" rx="14" ` +
                `fill="none" stroke="${accent}" stroke-width="7.5"/>` +
            `<text x="${W / 2}" y="58" text-anchor="middle" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="26" font-weight="700" ` +
                `fill="${headerColor}">${xmlEscape(headerText)}</text>` +
            value +
        `</svg>`;
    return svg;
}

/** Wrap an SVG string as a data: URI for Stream Deck's setImage command. */
export function svgDataUri(svg: string): string {
    // base64 is the safest encoding for arbitrary SVG payloads.
    const b64 = Buffer.from(svg, "utf8").toString("base64");
    return `data:image/svg+xml;base64,${b64}`;
}
