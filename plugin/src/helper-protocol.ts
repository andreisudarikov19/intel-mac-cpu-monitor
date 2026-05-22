// Mirrors the JSON wire protocol emitted by the Swift smcreader helper.
// Source of truth: helper/Sources/smcreader/Protocol.swift.
//
// Important: Swift's JSONEncoder OMITS nil optionals (it does NOT write
// `null`). All nullable fields here are typed `T | undefined` accordingly,
// and the parser must treat missing keys as "no value".

export type ReadyEvent = {
    event: "ready";
    arch: string;                       // "x86_64"
    t2: boolean;
    cpuCores: CPUCoreInfo[];
    cpuPackageKey?: string;
    gpuSensor?: string;
    ambientSensor?: string;
    ramSensor?: string;
    ssdSensor?: string;
    chipsetSensor?: string;
    wifiSensor?: string;
    thunderboltSensor?: string;
    cpuPowerSensor?: string;
    gpuPowerSensor?: string;
    fans: FanInfo[];
};

export type CPUCoreInfo = {
    index: number;
    key: string;
};

export type FanInfo = {
    index: number;
    min?: number;
    max?: number;
};

export type ReadingEvent = {
    event: "reading";
    ts: number;
    cpu: Record<string, number>;
    cpuAvg?: number;
    cpuPackage?: number;
    gpu?: number;
    ambient?: number;
    ram?: number;
    ssd?: number;
    chipset?: number;
    wifi?: number;
    thunderbolt?: number;
    cpuPower?: number;
    gpuPower?: number;
    /** RAM usage % (Activity Monitor-style). 0–100. */
    ramUsagePercent?: number;
    /** Disk read rate, bytes/sec, summed across every block driver.
     *  0 on the first tick (no baseline) and after sleep/wake reset. */
    diskReadBytesPerSec?: number;
    /** Disk write rate, bytes/sec. Same caveat. */
    diskWriteBytesPerSec?: number;
    fans: FanReading[];
};

export type FanReading = {
    i: number;
    rpm?: number;
};

export type UnsupportedEvent = {
    event: "unsupported";
    reason: string;
};

export type ErrorEvent = {
    event: "error";
    message: string;
};

export type HelperEvent =
    | ReadyEvent
    | ReadingEvent
    | UnsupportedEvent
    | ErrorEvent;

/** Type predicate that narrows an unknown parsed JSON value to HelperEvent.
 *  Validates the discriminator AND the shape of each event variant so a
 *  malformed helper output can't crash downstream consumers. */
export function isHelperEvent(v: unknown): v is HelperEvent {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    switch (o.event) {
        case "ready":
            return (
                typeof o.arch === "string" &&
                typeof o.t2 === "boolean" &&
                Array.isArray(o.cpuCores) &&
                Array.isArray(o.fans)
            );
        case "reading":
            return (
                typeof o.ts === "number" &&
                typeof o.cpu === "object" && o.cpu !== null && !Array.isArray(o.cpu) &&
                Array.isArray(o.fans)
            );
        case "unsupported":
            return typeof o.reason === "string";
        case "error":
            return typeof o.message === "string";
        default:
            return false;
    }
}
