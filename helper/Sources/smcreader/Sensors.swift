// SMC sensor key catalogue for Intel Macs.
//
// Primary source: Fanny/SMC's Sensor.swift (MIT, © 2019 Daniel Storm) —
//   https://github.com/DanielStormApps/SMC/blob/master/smc/SMC/Sensor.swift
// Supplementary source for keys Fanny missed on T2/modern Intel Macs:
//   exelban/stats (GPL-3.0) — Modules/Sensors/list.swift treats TC%c/TC%C as
//   per-core templates and documents TCAD (CPU package), TC0E (CPU diode
//   virtual), etc.

import Foundation

enum Sensors {
    /// Candidate per-core CPU temperature keys, one slot per core index.
    /// Fanny uses uppercase `TC{i}C`; modern T2 Intel Macs sometimes expose
    /// only the lowercase `TC{i}c` variant. We try both and take whichever
    /// returns a non-zero reading. Index range 0..8 covers all Intel Mac
    /// configurations (the existence of TC0* alongside TC1*..TC8* varies by
    /// SoC generation).
    static func cpuCoreCandidates(index: Int) -> [String] {
        ["TC\(index)C", "TC\(index)c"]
    }

    /// Indices to probe for per-core CPU temperature. Covers 0..15 to handle
    /// Intel Macs with up to 16 cores (the iMac Pro tops out at 18 but uses
    /// different sensor naming; for mainstream Intel Macs, 16 is more than
    /// enough headroom). Sensors that don't exist on the host are silently
    /// dropped at probe time.
    static let cpuCoreIndices: [Int] = Array(0...15)

    /// Package/die-level CPU temperature candidates in preference order:
    /// package → filtered die → diode → diode virtual → heatsink → PECI →
    /// proximity. Used when no per-core sensors are available (typical on
    /// T2 Macs which only expose a package reading).
    ///
    /// TCAD source: exelban/stats list.swift ("CPU package").
    /// Other keys source: Fanny/SMC Sensor.swift.
    static let cpuPackageKeysInPreferenceOrder: [String] = [
        "TCAD", "TC0F", "TC0D", "TC0E", "TC0H", "TCXC", "TC0P",
    ]

    /// GPU temperature sensor keys, in preference order (diode → PECI →
    /// heatsink → proximity). Source: Sensor.GPU in Fanny/SMC.
    static let gpuKeysInPreferenceOrder: [String] = [
        "TG0D", "TCGC", "TG0H", "TG0P",
    ]

    /// Ambient air (intake) temperature keys, in preference order.
    /// Source: exelban/stats uses TA%P template (TA0P, TA1P). Some Intel
    /// MacBook Pros expose lowercase `TaLP` (left passive) and `TaRF`
    /// (right fan) — included as fallbacks.
    static let ambientKeysInPreferenceOrder: [String] = [
        "TA0P", "TA1P", "TaLP", "TaRF",
    ]

    /// Memory (RAM) temperature keys, in preference order. Intel-Mac
    /// specific — most iMacs expose `Ts0S` (slot 0 sense); Mac Pros use
    /// `TMA0`/`TMB0` for module bank A/B; some expose `TM0P` (proximity)
    /// or fall through to `Tm0P` (mainboard, often near memory).
    static let ramKeysInPreferenceOrder: [String] = [
        "Ts0S", "TM0P", "Tm0P", "TMA0", "TMB0",
    ]

    /// Storage (SSD/HDD) temperature keys, in preference order.
    /// Source: exelban/stats uses TH%A/TH%B/TH%C templates; legacy Intel
    /// Macs sometimes expose `TH0F` or `TH0x`. We probe sensor A first as
    /// it's the most common location for the primary drive.
    static let ssdKeysInPreferenceOrder: [String] = [
        "TH0A", "TH0B", "TH0C", "TH0F", "TH0x", "TH1A",
    ]

    /// Chipset (Northbridge / PCH) temperature keys, in preference order.
    /// Source: exelban/stats names these `Northbridge`. Most accurate is
    /// the diode (`TN0D`); we fall back through heatsink, proximity, and
    /// finally the nearby powerboard sensor.
    static let chipsetKeysInPreferenceOrder: [String] = [
        "TN0D", "TN0H", "TN0P", "Tp0P",
    ]

    /// Wi-Fi card temperature keys. Source: exelban/stats — `TW0P` is the
    /// "Airport" proximity sensor (all Macs that expose Wi-Fi temp use it).
    static let wifiKeysInPreferenceOrder: [String] = [
        "TW0P",
    ]

    /// Thunderbolt controller temperature keys, in preference order.
    /// Source: exelban/stats uses TI%P template (TI0P, TI1P); MacBook Pros
    /// with two TB controllers also expose `TTLD`/`TTRD` (left/right diode).
    static let thunderboltKeysInPreferenceOrder: [String] = [
        "TI0P", "TI1P", "TTLD", "TTRD",
    ]

    /// CPU power (watts) keys, in preference order.
    /// Source: exelban/stats — PCPC is "CPU Package", PCPT is "CPU Package
    /// total", PCTR is "CPU Total". PC0C is per-core power; PCAM is the
    /// IMON (current monitor) reading.
    static let cpuPowerKeysInPreferenceOrder: [String] = [
        "PCPC", "PCPT", "PCTR", "PC0C", "PCAM",
    ]

    /// GPU power (watts) keys, in preference order.
    /// Source: exelban/stats — PG0C is the discrete GPU; PCGC and PCPG
    /// are the integrated Intel GPU (different naming across generations).
    static let gpuPowerKeysInPreferenceOrder: [String] = [
        "PG0C", "PCGC", "PCPG", "PG0R", "PCGM",
    ]

    /// Number-of-fans key. Source: SMC+Fans.swift in Fanny/SMC.
    static let fanCountKey = "FNum"

    /// Per-fan keys generated by index. Source: SMC+Fans.swift in Fanny/SMC.
    static func fanCurrentRPMKey(index: Int) -> String { "F\(index)Ac" }
    static func fanMinimumRPMKey(index: Int) -> String { "F\(index)Mn" }
    static func fanMaximumRPMKey(index: Int) -> String { "F\(index)Mx" }
    static func fanTargetRPMKey(index: Int)  -> String { "F\(index)Tg" }
}
