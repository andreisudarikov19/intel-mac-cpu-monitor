// Startup probe: figure out which sensors actually return data on this Mac,
// and which dataType each one uses (so per-tick reads can decode correctly).

import Foundation

struct SensorCatalog {
    let cpuCores: [SensorEntry]
    let cpuPackage: SensorEntry?
    let gpu: SensorEntry?
    let fans: [FanCatalogEntry]
    let t2: Bool
}

struct SensorEntry {
    let key: String          // SMC key string
    let dataType: String     // resolved dataType ("sp78", "ui8 ", etc.)
    let coreIndex: Int?      // populated for per-core CPU entries
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
            fans: fans,
            t2: t2
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
