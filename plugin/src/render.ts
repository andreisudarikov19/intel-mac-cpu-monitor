// Render a 144x144 SVG key image for any of the four actions.
//
// Layout (matches the two-row split spec):
//   y =   0..28   header: label (or "No data" in orange when stale)
//   y =  28..72   big value, e.g. "62°C" or "2100"
//   y =  72..144  filled-area + line sparkline
//
// Returned as a data: URI suitable for Stream Deck's setImage command.

import { BG_COLOR, COLORS, NO_DATA_COLOR, TEXT_COLOR, bandFor, type Band, type MetricProfile } from "./thresholds.js";

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
    viewMode?: "graph" | "value" | "meter";
    /** Raw numeric value (for meter view only — meter needs the unformatted
     *  number to compute lit-segment count). */
    rawValue?: number | null;
    /** Profile (used by meter to derive per-segment colors). */
    profile?: MetricProfile;
    /** Number of trailing samples to render in the sparkline. The hub
     *  passes its current buffer here. Defaults to 30 when omitted (for
     *  test inputs that don't care). */
    visibleSamples?: number;
    /** Multi-line slide content. When set + viewMode === "value", the
     *  slide view stacks these lines vertically inside the frame
     *  instead of rendering a single big value. Used for uptime and
     *  any future "show three numbers" metric. */
    slideLines?: string[];
    /** Override the band color used for the slide frame + value text.
     *  Used for off-band slides (uptime uses neutral grey). When
     *  omitted, falls back to COLORS[band]. */
    slideAccent?: string;
    /** Dual-stream support (currently used by disk I/O). When set, the
     *  graph view draws a second sparkline; the meter view draws a
     *  second column; the slide view uses `slideLines` (already
     *  multi-line capable).
     *
     *  Convention: `samples` / `rawValue` = primary stream (read);
     *  `samplesB` / `rawValueB` = secondary stream (write). */
    samplesB?: (number | null)[];
    rawValueB?: number | null;
    /** Formatted text for the secondary stream's value label (meter
     *  column footer, slide line, etc.). */
    valueTextB?: string;
    /** Color for the secondary stream's line/fill/column. When omitted,
     *  the renderer picks a sensible contrast color. */
    streamBColor?: string;
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

// Default number of trailing samples to render when input.visibleSamples
// is not provided (test-only path; the hub always passes its current
// value as of v1.3).
const DEFAULT_VISIBLE_SAMPLES = 30;

/** Escape characters that have special meaning in XML attribute values. */
function xmlEscape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Build the sparkline as one `<path>` per contiguous run of non-null samples.
 *  Renders only the most recent `visibleSamples` of whatever was passed
 *  in — the buffer may hold more (the reserve window for future zoom-out). */
function buildSparkline(
    samples: (number | null)[],
    range: { min: number; max: number },
    color: string,
    visibleSamples: number,
): string {
    const visible = samples.length > visibleSamples
        ? samples.slice(-visibleSamples)
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
    if (input.viewMode === "meter") {
        return renderMeter(input);
    }
    return renderWithGraph(input);
}

/** Default view: header + value + sparkline on neutral dark bg. */
function renderWithGraph(input: RenderInput): string {
    const headerColor = input.noData ? NO_DATA_COLOR : TEXT_COLOR;
    const headerText = input.noData ? "No data" : input.label;
    const valueColor = input.noData ? NO_DATA_COLOR : COLORS[input.band];
    const graphColor = input.noData ? NO_DATA_COLOR : COLORS[input.band];

    const sparkline = buildSparkline(
        input.samples,
        input.range,
        graphColor,
        input.visibleSamples ?? DEFAULT_VISIBLE_SAMPLES,
    );
    // Second sparkline drawn on top of the first when this is a
    // dual-stream metric (e.g. disk I/O write). Uses a contrasting
    // color so the two streams don't bleed together visually.
    const sparklineB = input.samplesB
        ? buildSparkline(
            input.samplesB,
            input.range,
            input.streamBColor ?? COLORS.cold,   // cyan default
            input.visibleSamples ?? DEFAULT_VISIBLE_SAMPLES,
        )
        : "";

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
            sparklineB +
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
    // slideAccent overrides the band color — used by off-band slides
    // (e.g. uptime with a neutral grey frame).
    const accent = input.noData
        ? NO_DATA_COLOR
        : (input.slideAccent ?? COLORS[input.band]);
    const headerColor = input.noData ? NO_DATA_COLOR : TEXT_COLOR;
    const headerText = input.noData ? "No data" : input.label;
    const multiline = !input.noData && input.slideLines && input.slideLines.length > 0;

    // Layout (144x144):
    //   frame  x=9, y=9, 126x126, rx=14, stroke 7.5 — concentric with
    //          Stream Deck's ~23 px bezel curve
    //   single-line case:  header y=58 fs=26; value y=104 fs=32
    //   multi-line case:   header y=40 fs=20; three lines y=72/96/120 fs=22

    let valueBlock = "";
    let headerY = 58;
    let headerFontSize = 26;

    if (multiline) {
        // Header pushed up to make room for stacked lines below. All
        // text is left-aligned at x=26 — looks more like a data sheet
        // and less like a centered banner. (x=26 keeps text clear of
        // the frame's inner stroke edge at ~12.75 with comfortable
        // padding.)
        headerY = 40;
        headerFontSize = 20;
        const LEFT_X = 26;
        const lineYs = [72, 96, 120];
        const lines = input.slideLines!;
        valueBlock = lines.slice(0, lineYs.length).map((line, i) =>
            `<text x="${LEFT_X}" y="${lineYs[i]}" text-anchor="start" ` +
            `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="22" font-weight="700" ` +
            `fill="${TEXT_COLOR}">${xmlEscape(line)}</text>`,
        ).join("");
    } else if (!input.noData) {
        valueBlock = `<text x="${W / 2}" y="104" text-anchor="middle" ` +
              `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="32" font-weight="700" ` +
              `fill="${accent}">${xmlEscape(input.valueText)}</text>`;
    }

    // In multi-line mode every line is left-aligned (data-sheet feel);
    // in single-value mode the header stays centered above the big number.
    const headerX = multiline ? 26 : W / 2;
    const headerAnchor = multiline ? "start" : "middle";

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
            `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG_COLOR}"/>` +
            `<rect x="9" y="9" width="126" height="126" rx="14" ` +
                `fill="none" stroke="${accent}" stroke-width="7.5"/>` +
            `<text x="${headerX}" y="${headerY}" text-anchor="${headerAnchor}" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="${headerFontSize}" font-weight="700" ` +
                `fill="${headerColor}">${xmlEscape(headerText)}</text>` +
            valueBlock +
        `</svg>`;
    return svg;
}

/**
 * "Meter" view: 80s boombox-style VU column. 12 stacked segments centred
 * horizontally; each segment's color is fixed by its position in the
 * column (bottom green → top red), so as the value rises more segments
 * AND warmer colors light up. Segments below the current value are at
 * full opacity; above are dim "unlit" outlines.
 *
 * Requires `rawValue` (numeric watts/whatever) and `profile` (thresholds)
 * on the input. Used by power actions on key press; toggle-back returns
 * to graph view.
 */
function renderMeter(input: RenderInput): string {
    const SEGMENTS = 9;
    const GAP = 2;
    const COL_TOP = 32;
    const COL_BOTTOM = 124;
    const COL_H = COL_BOTTOM - COL_TOP;
    const SEG_H = (COL_H - (SEGMENTS - 1) * GAP) / SEGMENTS;

    const headerColor = input.noData ? NO_DATA_COLOR : TEXT_COLOR;
    const headerText = input.noData ? "No data" : input.label;

    // Single or dual column? Dual when this is a two-stream metric
    // (disk I/O read+write). Both columns share the same band gradient;
    // they just light up independently.
    const dual = input.rawValueB !== undefined || input.samplesB !== undefined;
    const columns: { x: number; w: number; rawValue: number | null; valueText: string }[] = dual
        ? [
              // 14 px margin · 52 col · 12 px gap · 52 col · 14 px margin = 144
              { x: 14, w: 52, rawValue: input.rawValue ?? null, valueText: input.valueText },
              { x: 78, w: 52, rawValue: input.rawValueB ?? null, valueText: input.valueTextB ?? "" },
          ]
        : [{ x: 14, w: 116, rawValue: input.rawValue ?? null, valueText: input.valueText }];

    const profile = input.profile;
    const segmentRects: string[] = [];
    const valueTexts: string[] = [];

    for (const col of columns) {
        // numLit for this specific column's value
        let numLit = 0;
        if (!input.noData && col.rawValue != null && col.rawValue >= input.range.min) {
            const norm = (col.rawValue - input.range.min) / (input.range.max - input.range.min);
            numLit = Math.max(0, Math.min(SEGMENTS, Math.round(norm * SEGMENTS)));
        }

        // Per-segment color: classify each segment's top-edge value via
        // the profile, so both columns share the same band gradient.
        for (let i = 0; i < SEGMENTS; i++) {
            const y = COL_BOTTOM - (i + 1) * SEG_H - i * GAP;
            let color: string;
            if (profile) {
                const segValue = input.range.min
                    + ((i + 1) / SEGMENTS) * (input.range.max - input.range.min);
                color = COLORS[bandFor(segValue, profile)];
            } else {
                const pos = i / SEGMENTS;
                const band: Band = pos < 0.5 ? "cool" : pos < 0.75 ? "warm" : pos < 0.92 ? "hot" : "critical";
                color = COLORS[band];
            }
            const opacity = i < numLit ? "1" : "0.18";
            segmentRects.push(
                `<rect x="${col.x}" y="${y.toFixed(2)}" width="${col.w}" height="${SEG_H.toFixed(2)}" ` +
                `rx="2" fill="${color}" fill-opacity="${opacity}"/>`,
            );
        }

        // Value text below this column, colored by its own current band.
        if (!input.noData && col.rawValue != null && col.valueText) {
            const valColor = profile
                ? COLORS[bandFor(col.rawValue, profile)]
                : COLORS[input.band];
            const textX = col.x + col.w / 2;
            valueTexts.push(
                `<text x="${textX}" y="140" text-anchor="middle" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="14" font-weight="700" ` +
                `fill="${valColor}">${xmlEscape(col.valueText)}</text>`,
            );
        }
    }

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
            `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG_COLOR}"/>` +
            `<text x="${W / 2}" y="22" text-anchor="middle" ` +
                `font-family="-apple-system,Helvetica Neue,Helvetica,Arial,sans-serif" font-size="20" font-weight="700" ` +
                `fill="${headerColor}">${xmlEscape(headerText)}</text>` +
            segmentRects.join("") +
            valueTexts.join("") +
        `</svg>`;
    return svg;
}

/** Wrap an SVG string as a data: URI for Stream Deck's setImage command. */
export function svgDataUri(svg: string): string {
    // base64 is the safest encoding for arbitrary SVG payloads.
    const b64 = Buffer.from(svg, "utf8").toString("base64");
    return `data:image/svg+xml;base64,${b64}`;
}
