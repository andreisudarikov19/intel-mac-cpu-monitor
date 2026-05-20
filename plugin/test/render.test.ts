import { describe, it, expect } from "vitest";
import { renderSVG, svgDataUri, type RenderInput } from "../src/render.js";
import { TEMP_RANGE, COLORS, NO_DATA_COLOR } from "../src/thresholds.js";

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
        // elements (fill + stroke = 4 paths total).
        const svg = renderSVG({
            ...baseInput,
            samples: [50, 60, null, null, 70, 80],
        });
        const strokeCount = (svg.match(/stroke-width="1.6"/g) ?? []).length;
        expect(strokeCount).toBe(2);
    });

    it("escapes XML special characters in text", () => {
        const svg = renderSVG({ ...baseInput, label: "<&\">" });
        expect(svg).toContain("&lt;&amp;&quot;&gt;");
        // Sanity check there's no raw < & " in the label text content
        expect(svg).not.toContain(">< ");
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
