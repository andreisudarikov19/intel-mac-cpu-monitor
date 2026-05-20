// JSON protocol emitted on stdout, one object per line (JSON Lines).
// The consumer (Node plugin) splits on newline and parses each line.

import Foundation

struct ReadyEvent: Encodable {
    let event: String = "ready"
    let arch: String                   // "x86_64"
    let t2: Bool                       // true if Apple T2 chip present (affects fan decode)
    let cpuCores: [CPUCoreInfo]        // empty if this Mac has no per-core sensors
    let cpuPackageKey: String?         // SMC key chosen as package fallback (or nil)
    let gpuSensor: String?             // SMC key chosen for GPU (or nil)
    let ambientSensor: String?         // SMC key chosen for ambient/intake air
    let ramSensor: String?             // SMC key chosen for memory temperature
    let ssdSensor: String?             // SMC key chosen for storage temperature
    let chipsetSensor: String?         // SMC key chosen for chipset/PCH temperature
    let wifiSensor: String?            // SMC key chosen for Wi-Fi card temperature
    let thunderboltSensor: String?     // SMC key chosen for Thunderbolt controller
    let cpuPowerSensor: String?        // SMC key chosen for CPU power draw (W)
    let gpuPowerSensor: String?        // SMC key chosen for GPU power draw (W)
    let fans: [FanInfo]
}

struct CPUCoreInfo: Encodable {
    let index: Int                     // 0-based core index
    let key: String                    // resolved SMC key (TC{i}C or TC{i}c)
}

struct FanInfo: Encodable {
    let index: Int
    let min: Int?
    let max: Int?
}

struct ReadingEvent: Encodable {
    let event: String = "reading"
    let ts: Int64                      // Unix timestamp in seconds
    let cpu: [String: Double]          // SMC key → °C, only sensors in catalog
    let cpuAvg: Double?                // mean of cpu values (nil if no cores)
    let cpuPackage: Double?            // package sensor reading (nil if not in catalog)
    let gpu: Double?                   // °C from chosen GPU sensor (nil if no GPU)
    let ambient: Double?               // °C from chosen ambient/intake sensor
    let ram: Double?                   // °C from chosen RAM sensor
    let ssd: Double?                   // °C from chosen SSD sensor
    let chipset: Double?               // °C from chosen chipset sensor
    let wifi: Double?                  // °C from chosen Wi-Fi sensor
    let thunderbolt: Double?           // °C from chosen Thunderbolt sensor
    let cpuPower: Double?              // watts from chosen CPU power sensor
    let gpuPower: Double?              // watts from chosen GPU power sensor
    let fans: [FanReading]
}

struct FanReading: Encodable {
    let i: Int                          // fan index
    let rpm: Int?                       // nil if read failed this tick
}

struct UnsupportedEvent: Encodable {
    let event: String = "unsupported"
    let reason: String
}

struct ErrorEvent: Encodable {
    let event: String = "error"
    let message: String
}

/// Serialise an Encodable to a single-line JSON string.
func encodeOneLine<T: Encodable>(_ value: T) -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value),
          let s = String(data: data, encoding: .utf8) else { return nil }
    // JSONEncoder never emits raw newlines, but defend in depth.
    return s.replacingOccurrences(of: "\n", with: " ")
}
