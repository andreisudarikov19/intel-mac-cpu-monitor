import { describe, it, expect } from "vitest";
import { renderSVG, type RenderInput } from "../src/render.js";
import { Hub, formatBytesPerSec, formatBytesPerSecCompact } from "../src/hub.js";
import { RAM_USAGE_PROFILE, DISK_IO_PROFILE, bandFor, TEXT_COLOR } from "../src/thresholds.js";

describe("v1.4 metrics — RAM usage profile", () => {
    it("classifies common RAM-usage scenarios into the right bands", () => {
        const p = RAM_USAGE_PROFILE;
        expect(bandFor(15, p)).toBe("cool");      // light idle
        expect(bandFor(50, p)).toBe("cool");      // boundary
        expect(bandFor(60, p)).toBe("warm");      // normal heavy use
        expect(bandFor(80, p)).toBe("hot");       // approaching swap
        expect(bandFor(95, p)).toBe("critical");  // macOS compressing
    });
});

describe("v1.5 — Disk I/O profile (recalibrated for green visibility)", () => {
    it("classifies common I/O rates with at least one cool band", () => {
        const p = DISK_IO_PROFILE;
        expect(bandFor(0, p)).toBe("cool");                    // idle
        expect(bandFor(50_000_000, p)).toBe("cool");           // 50 MB/s = light
        expect(bandFor(200_000_000, p)).toBe("cool");          // 200 MB/s = boundary
        expect(bandFor(300_000_000, p)).toBe("warm");          // 300 MB/s = active
        expect(bandFor(500_000_000, p)).toBe("warm");          // 500 MB/s = boundary
        expect(bandFor(700_000_000, p)).toBe("hot");           // 700 MB/s = heavy
        expect(bandFor(800_000_000, p)).toBe("hot");           // 800 MB/s = boundary
        expect(bandFor(900_000_000, p)).toBe("critical");      // 900 MB/s = saturating
        expect(bandFor(2_000_000_000, p)).toBe("critical");    // 2 GB/s = clamped, critical
    });

    it("range is 0–1 GB/s (covers common saturation; > 1 GB/s shows as critical/full)", () => {
        expect(DISK_IO_PROFILE.range.min).toBe(0);
        expect(DISK_IO_PROFILE.range.max).toBe(1_000_000_000);
    });

    it("segment 0's top edge (111 MB/s) lies inside the cool band (regression for v1.4 bug)", () => {
        // Step = 1 GB / 9 ≈ 111 MB/s. If coolMax < 111 MB/s, segment 0
        // would be classified as warm and the meter loses its green zone.
        const step = DISK_IO_PROFILE.range.max / 9;
        expect(bandFor(step, DISK_IO_PROFILE)).toBe("cool");
    });
});

describe("formatBytesPerSec", () => {
    it("uses KB/s below 1 MB/s", () => {
        expect(formatBytesPerSec(0)).toBe("0 KB/s");
        expect(formatBytesPerSec(512_000)).toMatch(/KB\/s$/);    // ~500 KB
    });

    it("uses MB/s between 1 MB and 1 GB", () => {
        expect(formatBytesPerSec(10_000_000)).toBe("10.0 MB/s");
        expect(formatBytesPerSec(500_000_000)).toBe("500.0 MB/s");
    });

    it("uses GB/s at or above 1 GB", () => {
        expect(formatBytesPerSec(1_500_000_000)).toBe("1.5 GB/s");
        expect(formatBytesPerSec(3_000_000_000)).toBe("3.0 GB/s");
    });
});

describe("v1.4 metrics — multi-line slide rendering", () => {
    const base: RenderInput = {
        label: "UPTIME",
        valueText: "",
        band: "cool",
        noData: false,
        samples: [],
        range: { min: 0, max: 1 },
        viewMode: "value",
        slideLines: ["1 week", "2 days", "3 hours"],
        slideAccent: "#8e8e93",
    };

    it("renders all three lines verbatim inside the SVG", () => {
        const svg = renderSVG(base);
        expect(svg).toContain(">1 week<");
        expect(svg).toContain(">2 days<");
        expect(svg).toContain(">3 hours<");
    });

    it("uses the slideAccent color for the frame stroke", () => {
        const svg = renderSVG(base);
        expect(svg).toMatch(/<rect[^/]*stroke="#8e8e93"/i);
    });

    it("does not render a single-value text block when slideLines is set", () => {
        const svg = renderSVG(base);
        // A normal single-value slide would have font-size="32" — absent here.
        expect(svg).not.toMatch(/font-size="32"/);
    });

    it("renders all lines in TEXT_COLOR (white), not the accent", () => {
        const svg = renderSVG(base);
        // Three text elements should fill with TEXT_COLOR for the lines.
        const matches = svg.match(new RegExp(`fill="${TEXT_COLOR}"`, "g")) ?? [];
        // Header (#ebebf5) + 3 lines = 4 occurrences minimum.
        expect(matches.length).toBeGreaterThanOrEqual(4);
    });

    it("falls back to single-value rendering when slideLines is absent", () => {
        const single: RenderInput = { ...base, slideLines: undefined, valueText: "100 W" };
        const svg = renderSVG(single);
        // Single-value rendering uses fs=32 for the big number.
        expect(svg).toContain('font-size="32"');
        expect(svg).toContain(">100 W<");
    });
});

describe("v1.4.1 — compact byte formatter (dual-meter column footers)", () => {
    it("uses 0K for sub-KB", () => {
        expect(formatBytesPerSecCompact(0)).toBe("0K");
        expect(formatBytesPerSecCompact(500)).toBe("0K");
    });
    it("uses Nk for KB-range", () => {
        expect(formatBytesPerSecCompact(50_000)).toMatch(/^\d+K$/);
        expect(formatBytesPerSecCompact(900_000)).toMatch(/^\d+K$/);
    });
    it("uses NM (int) for >=10 MB, N.NM for <10 MB", () => {
        expect(formatBytesPerSecCompact(50_000_000)).toBe("50M");
        expect(formatBytesPerSecCompact(3_500_000)).toBe("3.5M");
    });
    it("uses N.NG for GB-range", () => {
        expect(formatBytesPerSecCompact(1_500_000_000)).toBe("1.5G");
    });
});

describe("v1.4.1 — dual-stream rendering", () => {
    const baseDual: RenderInput = {
        label: "DISK",
        valueText: "12 MB/s",
        valueTextB: "1.5M",
        band: "warm",
        noData: false,
        samples: [10_000_000, 12_000_000, 8_000_000],
        samplesB: [500_000, 1_500_000, 2_000_000],
        range: { min: 0, max: 3_000_000_000 },
        rawValue: 8_000_000,
        rawValueB: 2_000_000,
        streamBColor: "#3FBEE9",
    };

    it("graph view draws two sparklines (read + write) in different colors", () => {
        const svg = renderSVG({ ...baseDual, viewMode: "graph" });
        // Expect both the band color and the streamBColor to appear in
        // the sparkline strokes.
        expect(svg).toContain("#3FBEE9");          // write line — cyan
        // Should have more than one stroked path (one per stream + fill paths)
        const strokeCount = (svg.match(/stroke-width="[\d.]+"/g) ?? []).length;
        expect(strokeCount).toBeGreaterThanOrEqual(2);
    });

    it("meter view splits into two columns with independent fill levels", () => {
        const svg = renderSVG({ ...baseDual, viewMode: "meter" });
        // Each column draws 9 segments → 18 total rect segments (plus 1 bg rect).
        const fillOpacityCount = (svg.match(/fill-opacity="/g) ?? []).length;
        expect(fillOpacityCount).toBe(18);
        // Both footers present in the output.
        expect(svg).toContain(">12 MB/s<");
        expect(svg).toContain(">1.5M<");
    });

    it("meter columns render side-by-side (different x positions)", () => {
        const svg = renderSVG({ ...baseDual, viewMode: "meter" });
        // First rect at x=14 (left column), and there should also be
        // rects at x=78 (right column).
        expect(svg).toMatch(/<rect x="14"[^/]*fill-opacity/);
        expect(svg).toMatch(/<rect x="78"[^/]*fill-opacity/);
    });

    it("slide view renders the read/write lines from slideLines", () => {
        const svg = renderSVG({
            ...baseDual,
            viewMode: "value",
            slideLines: ["↓ 8.0 MB/s", "↑ 2.0 MB/s"],
        });
        expect(svg).toContain("↓ 8.0 MB/s");
        expect(svg).toContain("↑ 2.0 MB/s");
        // Multi-line slides are left-aligned at x=26.
        expect(svg).toMatch(/<text x="26"[^/]*text-anchor="start"/);
    });

    it("uptime slide is left-aligned (regression for v1.4.1 ask)", () => {
        const svg = renderSVG({
            label: "UPTIME",
            valueText: "",
            band: "cool",
            noData: false,
            samples: [],
            range: { min: 0, max: 1 },
            viewMode: "value",
            slideLines: ["1 week", "2 days", "3 hours"],
            slideAccent: "#8e8e93",
        });
        // No text-anchor="middle" on the value lines (header is left
        // too in multi-line mode).
        expect(svg).toMatch(/<text x="26"[^/]*text-anchor="start"[^>]*>1 week</);
        expect(svg).toMatch(/<text x="26"[^/]*text-anchor="start"[^>]*>2 days</);
        expect(svg).toMatch(/<text x="26"[^/]*text-anchor="start"[^>]*>3 hours</);
    });
});

describe("v1.4 metrics — hub subscriptions", () => {
    it("subscribes to ramUsage / diskIO / uptime without throwing", () => {
        const hub = new Hub();
        const subscriber = (id: string) => ({
            contextId: id,
            setImage: () => Promise.resolve(),
        });
        hub.subscribe(subscriber("r"), { kind: "ramUsage" });
        hub.subscribe(subscriber("d"), { kind: "diskIO" });
        hub.subscribe(subscriber("u"), { kind: "uptime" });
        expect(hub.getVisibleSampleCount("r")).toBeGreaterThan(0);
        expect(hub.getVisibleSampleCount("d")).toBeGreaterThan(0);
        // Uptime gets a subscription too (history is unused but it's there).
        expect(hub.getVisibleSampleCount("u")).toBeGreaterThan(0);
    });
});
