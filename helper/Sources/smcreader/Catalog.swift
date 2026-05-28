// Startup probe: figure out which sensors actually return data on this Mac,
// and which dataType each one uses (so per-tick reads can decode correctly).

import Foundation

struct SensorCatalog {
    let cpuCores: [SensorEntry]
    let cpuPackage: SensorEntry?
    let gpu: SensorEntry?
    let ambient: SensorEntry?
    let ram: SensorEntry?
    let ssd: SensorEntry?
    let chipset: SensorEntry?
    let wifi: SensorEntry?
    let thunderbolt: SensorEntry?
    let cpuPower: SensorEntry?
    let gpuPower: SensorEntry?
    let fans: [FanCatalogEntry]
    let t2: Bool
}

struct SensorEntry {
    let key: String          // SMC key string
    let dataType: String     // resolved dataType ("sp78", "ui8 ", etc.)
    let coreIndex: Int?      // populated for per-core CPU entries
}

extension SensorCatalog {
    /// True if `self` is missing any sensor slot that `expected` had
    /// populated — i.e. a sensor that worked at startup has dropped out of
    /// this (re-probed) catalog. Drives the post-wake re-probe retry loop:
    /// the helper keeps re-probing until every startup sensor is back (or
    /// the retry budget is exhausted). Never reports sensors that were
    /// absent at startup as "missing".
    func isMissingSensorsFrom(_ expected: SensorCatalog) -> Bool {
        if expected.cpuPackage != nil && cpuPackage == nil { return true }
        if expected.gpu != nil && gpu == nil { return true }
        if expected.ambient != nil && ambient == nil { return true }
        if expected.ram != nil && ram == nil { return true }
        if expected.ssd != nil && ssd == nil { return true }
        if expected.chipset != nil && chipset == nil { return true }
        if expected.wifi != nil && wifi == nil { return true }
        if expected.thunderbolt != nil && thunderbolt == nil { return true }
        if expected.cpuPower != nil && cpuPower == nil { return true }
        if expected.gpuPower != nil && gpuPower == nil { return true }
        if cpuCores.count < expected.cpuCores.count { return true }
        if fans.count < expected.fans.count { return true }
        return false
    }
}

struct FanCatalogEntry {
    let index: Int
    let min: Int?
    let max: Int?
    let dataType: String     // "flt " or "fpe2" depending on the host
}

enum CatalogProbe {
    /// Walk every candidate sensor key once. CPU cores, package, and the GPU
    /// sensor are retained only if they decode to >1.0°C — the same threshold
    /// Fanny uses to distinguish "present" from "wired but always zero".
    static func probe(reader: SMCReading, t2: Bool) -> SensorCatalog {
        var cores: [SensorEntry] = []
        for i in Sensors.cpuCoreIndices {
            for candidate in Sensors.cpuCoreCandidates(index: i) {
                if let entry = tryTempSensor(reader: reader, key: candidate, coreIndex: i) {
                    cores.append(entry)
                    break
                }
            }
        }

        var packageEntry: SensorEntry? = nil
        for key in Sensors.cpuPackageKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                packageEntry = entry
                break
            }
        }

        var gpuEntry: SensorEntry? = nil
        for key in Sensors.gpuKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                gpuEntry = entry
                break
            }
        }

        var ambientEntry: SensorEntry? = nil
        for key in Sensors.ambientKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                ambientEntry = entry
                break
            }
        }

        var ramEntry: SensorEntry? = nil
        for key in Sensors.ramKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                ramEntry = entry
                break
            }
        }

        var ssdEntry: SensorEntry? = nil
        for key in Sensors.ssdKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                ssdEntry = entry
                break
            }
        }

        var chipsetEntry: SensorEntry? = nil
        for key in Sensors.chipsetKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                chipsetEntry = entry
                break
            }
        }

        var wifiEntry: SensorEntry? = nil
        for key in Sensors.wifiKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                wifiEntry = entry
                break
            }
        }

        var thunderboltEntry: SensorEntry? = nil
        for key in Sensors.thunderboltKeysInPreferenceOrder {
            if let entry = tryTempSensor(reader: reader, key: key, coreIndex: nil) {
                thunderboltEntry = entry
                break
            }
        }

        var cpuPowerEntry: SensorEntry? = nil
        for key in Sensors.cpuPowerKeysInPreferenceOrder {
            if let entry = tryPowerSensor(reader: reader, key: key) {
                cpuPowerEntry = entry
                break
            }
        }

        var gpuPowerEntry: SensorEntry? = nil
        for key in Sensors.gpuPowerKeysInPreferenceOrder {
            if let entry = tryPowerSensor(reader: reader, key: key) {
                gpuPowerEntry = entry
                break
            }
        }

        var fans: [FanCatalogEntry] = []
        if let countResult = reader.read(key: Sensors.fanCountKey) {
            let count = Int(countResult.bytes.0)
            if count >= 0 && count <= 8 {
                for i in 0..<count {
                    let minRead = reader.read(key: Sensors.fanMinimumRPMKey(index: i))
                    let maxRead = reader.read(key: Sensors.fanMaximumRPMKey(index: i))
                    if minRead == nil && maxRead == nil { continue }
                    // Trust the actual dataType returned by AppleSMC rather
                    // than guessing from T2 status. Some pre-T2 Macs may use
                    // FLT and vice versa.
                    let dt = (minRead?.dataType ?? maxRead?.dataType ?? (t2 ? "flt " : "fpe2"))
                    let minRPM = minRead.flatMap { decodeFanBytes($0.bytes, dataType: dt) }
                    let maxRPM = maxRead.flatMap { decodeFanBytes($0.bytes, dataType: dt) }
                    fans.append(FanCatalogEntry(index: i, min: minRPM, max: maxRPM, dataType: dt))
                }
            }
        }

        return SensorCatalog(
            cpuCores: cores,
            cpuPackage: packageEntry,
            gpu: gpuEntry,
            ambient: ambientEntry,
            ram: ramEntry,
            ssd: ssdEntry,
            chipset: chipsetEntry,
            wifi: wifiEntry,
            thunderbolt: thunderboltEntry,
            cpuPower: cpuPowerEntry,
            gpuPower: gpuPowerEntry,
            fans: fans,
            t2: t2
        )
    }

    /// Try a power SMC key. Returns a populated SensorEntry only if the
    /// key exists AND decodes to a sensible non-negative wattage. We do
    /// NOT require >0 because some integrated GPUs idle at exactly 0 W.
    static func tryPowerSensor(reader: SMCReading, key: String) -> SensorEntry? {
        guard let r = reader.read(key: key) else { return nil }
        guard let w = Decoders.decodePower(
            b0: r.bytes.0, b1: r.bytes.1, b2: r.bytes.2, b3: r.bytes.3,
            dataType: r.dataType
        ) else { return nil }
        // Defensive: reject implausibly large values (>1 kW would
        // indicate a decode error, not a real Mac power reading).
        if w >= 0 && w < 1000 {
            return SensorEntry(key: key, dataType: r.dataType, coreIndex: nil)
        }
        return nil
    }

    /// Read and decode current power (watts) from a catalogued power entry.
    static func readPower(reader: SMCReading, entry: SensorEntry) -> Double? {
        guard let r = reader.read(key: entry.key) else { return nil }
        return Decoders.decodePower(
            b0: r.bytes.0, b1: r.bytes.1, b2: r.bytes.2, b3: r.bytes.3,
            dataType: r.dataType
        )
    }

    /// Try a temperature SMC key. Returns a populated SensorEntry only if the
    /// key exists AND decodes to a plausible (>1°C) reading.
    static func tryTempSensor(reader: SMCReading, key: String, coreIndex: Int?) -> SensorEntry? {
        guard let r = reader.read(key: key) else { return nil }
        guard let c = Decoders.decodeTemperature(
            b0: r.bytes.0, b1: r.bytes.1, b2: r.bytes.2, b3: r.bytes.3,
            dataType: r.dataType
        ) else { return nil }
        if c > 1.0 {
            return SensorEntry(key: key, dataType: r.dataType, coreIndex: coreIndex)
        }
        return nil
    }

    /// Read and decode a current temperature from an already-catalogued entry.
    static func readTemp(reader: SMCReading, entry: SensorEntry) -> Double? {
        guard let r = reader.read(key: entry.key) else { return nil }
        return Decoders.decodeTemperature(
            b0: r.bytes.0, b1: r.bytes.1, b2: r.bytes.2, b3: r.bytes.3,
            dataType: r.dataType
        )
    }

    /// Read the current RPM of a catalogued fan.
    static func readFanRPM(reader: SMCReading, fan: FanCatalogEntry) -> Int? {
        guard let r = reader.read(key: Sensors.fanCurrentRPMKey(index: fan.index)) else { return nil }
        return decodeFanBytes(r.bytes, dataType: fan.dataType)
    }

    private static func decodeFanBytes(_ b: SMCBytes, dataType: String) -> Int {
        switch dataType {
        case "flt ":
            return Decoders.fanRPMflt(b0: b.0, b1: b.1, b2: b.2, b3: b.3)
        case "fpe2":
            return Decoders.fanRPMfpe2(b0: b.0, b1: b.1)
        default:
            // Fall back to fpe2 (the older format) if dataType is unknown.
            return Decoders.fanRPMfpe2(b0: b.0, b1: b.1)
        }
    }
}
