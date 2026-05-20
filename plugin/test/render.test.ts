import { describe, it, expect } from "vitest";
import { renderSVG, svgDataUri, type RenderInput } from "../src/render.js";
import {
    TEMP_RANGE,
    COLORS,
    NO_DATA_COLOR,
    BG_COLOR,
    TEXT_COLOR,
} from "../src/thresholds.js";

const baseInput: RenderInput = {
    label: "CPU",
    valueText: "62°C",
    band: "warm",
    noData: false,
    samples: [50, 55, 60, 62, 64, 65, 66, 67, 68, 62],
    range: TEMP_RANGE,
};

describe("renderSVG", () => {
    it("returns an SVG element with 144x144 viewBox", () => {
        const svg = renderSVG(baseInput);
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg.endsWith("</svg>")).toBe(true);
        expect(svg).toMatch(/viewBox="0 0 144 144"/);
    });

    it("includes the label and value text", () => {
        const svg = renderSVG(baseInput);
        expect(svg).toContain(">CPU<");
        expect(svg).toContain(">62°C<");
    });

    it("uses the band color for value text and the sparkline", () => {
        const svg = renderSVG({ ...baseInput, band: "hot" });
        expect(svg).toContain(COLORS.hot);
    });

    it("in noData mode, header reads 'No data' in orange", () => {
        const svg = renderSVG({ ...baseInput, noData: true, valueText: "" });
        expect(svg).toContain(">No data<");
        expect(svg).toContain(NO_DATA_COLOR);
    });

    it("renders no sparkline path with an empty samples array", () => {
        const svg = renderSVG({ ...baseInput, samples: [] });
        // No <path ... d="...> tag should appear when there are no samples.
        expect(svg).not.toMatch(/<path/);
    });

    it("breaks the sparkline at null gaps (multiple stroke paths)", () => {
        // Two runs: [50, 60] and [70, 80]. We expect two <path> stroke
        // elements (fill + stroke = 4 paths total). Match any stroke-width
        // so cosmetic tweaks to thickness don't break this test.
        const svg = renderSVG({
            ...baseInput,
            samples: [50, 60, null, null, 70, 80],
        });
        const strokeCount = (svg.match(/stroke-width="[\d.]+"/g) ?? []).length;
        expect(strokeCount).toBe(2);
    });

    it("escapes XML special characters in text", () => {
        const svg = renderSVG({ ...baseInput, label: "<&\">" });
        expect(svg).toContain("&lt;&amp;&quot;&gt;");
        // Sanity check there's no raw < & " in the label text content
        expect(svg).not.toContain(">< ");
    });

    it("renders only the most recent 30 samples even if more are passed", () => {
        // The hub passes its full 45-sample buffer; the renderer should
        // show only the trailing 30. Verify by passing 45 samples where
        // the older 15 are at 50°C and the newest 30 are at 75°C — the
        // first visible point's y must match 75°C, not 50°C.
        const samples = [
            ...Array(15).fill(50),
            ...Array(30).fill(75),
        ];
        const svg = renderSVG({ ...baseInput, samples });
        // Match the sparkline stroke path (identified by stroke-width,
        // which only stroke paths carry) and grab its first M coords.
        // y(75°C) ≈ 62 + (1 - 45/70) * 82 ≈ 91.28.
        const strokePathMatch = svg.match(/<path d="M([\d.]+),([\d.]+)[^"]*"\s+fill="none"[^/]*stroke-width=/);
        expect(strokePathMatch).not.toBeNull();
        const firstY = parseFloat(strokePathMatch![2]!);
        expect(Math.abs(firstY - 91.28)).toBeLessThan(1);
    });

    it("clips sample values outside the range to the bounds", () => {
        // Range is 30-100. A value of 200 should be clamped to 100 (top of
        // graph) and -50 should be clamped to 30 (bottom). The renderer
        // must not crash or emit a non-finite coordinate.
        const svg = renderSVG({
            ...baseInput,
            samples: [-50, 200, 65],
            range: TEMP_RANGE,
        });
        expect(svg).not.toMatch(/NaN/);
        expect(svg).not.toMatch(/Infinity/);
    });
});

describe("renderSVG value-only view", () => {
    const valueInput: RenderInput = {
        ...baseInput,
        viewMode: "value",
    };

    it("uses the same dark background as graph mode", () => {
        const svg = renderSVG({ ...valueInput, band: "warm" });
        // First <rect> is the background fill — must be BG_COLOR, NOT the
        // band color (that was the old design; we now wear the band color
        // only as text + pill stroke).
        const bgRectMatch = svg.match(/<rect[^/]*fill="(#[0-9A-Fa-f]{6,8})"/);
        expect(bgRectMatch).not.toBeNull();
        expect(bgRectMatch![1]!.toLowerCase()).toBe(BG_COLOR.toLowerCase());
    });

    it("renders the value in the band color and the header in white", () => {
        const svg = renderSVG({ ...valueInput, band: "hot" });
        // Header stays neutral white — only the readout (and pill stroke
        // tested separately) carries the band color.
        expect(svg).toContain(`fill="${TEXT_COLOR}"`);
        // Value text uses the band color.
        const bandFillCount = (svg.match(new RegExp(`fill="${COLORS.hot}"`, "g")) ?? []).length;
        expect(bandFillCount).toBeGreaterThanOrEqual(1);
    });

    it("draws a band-colored frame around the whole key (slight rounding, thick stroke)", () => {
        const svg = renderSVG({ ...valueInput, band: "cool" });
        // The frame is a stroked <rect> with a small rx for soft corners,
        // fill none, stroke in the band color.
        const frameMatch = svg.match(
            /<rect[^/]*fill="none"[^/]*stroke="([^"]+)"[^/]*stroke-width="(\d+(?:\.\d+)?)"/,
        );
        expect(frameMatch).not.toBeNull();
        expect(frameMatch![1]!.toLowerCase()).toBe(COLORS.cool.toLowerCase());
        // Frame must be visibly thick (>= 4 px).
        expect(parseFloat(frameMatch![2]!)).toBeGreaterThanOrEqual(4);
        // Frame must carry a modest rx — "slight rounding" tuned to follow
        // the bezel curve, but well below the full-pill threshold (which
        // would be ~63 for a 126 px wide rect).
        const frameRect = svg.match(/<rect[^/]*fill="none"[^/]*\/>/)![0];
        const rxMatch = frameRect.match(/rx="(\d+(?:\.\d+)?)"/);
        expect(rxMatch).not.toBeNull();
        expect(parseFloat(rxMatch![1]!)).toBeLessThanOrEqual(20);
    });

    it("omits the sparkline entirely (no graph paths)", () => {
        const svg = renderSVG({
            ...valueInput,
            samples: [40, 50, 60, 70, 80],
        });
        expect(svg).not.toMatch(/<path/);
    });

    it("in noData mode, keeps the frame (tinted orange) and drops the value", () => {
        const svg = renderSVG({ ...valueInput, noData: true, valueText: "" });
        expect(svg).toContain(`fill="${BG_COLOR}"`);
        expect(svg).toContain(">No data<");
        expect(svg).toContain(NO_DATA_COLOR);
        // Frame is still present (it's the key's "alive in value mode"
        // indicator), now tinted with the alert color.
        expect(svg).toMatch(
            new RegExp(`<rect[^/]*fill="none"[^/]*stroke="${NO_DATA_COLOR}"`),
        );
    });

    it("uses the same header size in graph and value modes", () => {
        const graphSvg = renderSVG({ ...baseInput, viewMode: "graph" });
        const valueSvg = renderSVG({ ...baseInput, viewMode: "value" });
        // Both modes share a 26 px header for visual consistency.
        expect(graphSvg).toContain('font-size="26"');
        expect(valueSvg).toContain('font-size="26"');
        // Value text: graph 34 px, value mode 32 px (sits inside the pill).
        expect(graphSvg).toContain('font-size="34"');
        expect(valueSvg).toContain('font-size="32"');
    });

    it("default viewMode is graph (when omitted)", () => {
        const svg = renderSVG({ ...baseInput });
        expect(svg).toContain('font-size="26"');  // graph header size
        expect(svg).toMatch(/<path/);              // has sparkline
    });
});

describe("svgDataUri", () => {
    it("produces a data: URI with the svg+xml MIME and base64 payload", () => {
        const uri = svgDataUri("<svg/>");
        expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
        const b64 = uri.slice("data:image/svg+xml;base64,".length);
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        expect(decoded).toBe("<svg/>");
    });

    it("round-trips unicode safely", () => {
        const svg = "<svg>°C ☀ 中</svg>";
        const decoded = Buffer.from(
            svgDataUri(svg).split(",")[1]!,
            "base64",
        ).toString("utf8");
        expect(decoded).toBe(svg);
    });
});
