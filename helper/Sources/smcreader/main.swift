// Entry point for the smcreader helper binary.
//
// Lifecycle:
//   1. Detect Apple Silicon. If so, emit one `unsupported` event and exit 0.
//   2. Open AppleSMC via IOKit. If that fails, emit one `error` event and exit 1.
//   3. Probe the sensor catalogue (which CPU cores, GPU sensor, fans exist).
//      Emit one `ready` event with the catalogue.
//   4. Every 1s, read every sensor in the catalogue and emit one `reading`
//      event with all values. Continue until SIGTERM/SIGINT.

import Foundation

/// Mutable counter accessed only from the serial timer queue, so no locking
/// is required. Class (not struct) so the timer closure captures by reference.
final class FailureCounter {
    private var count: Int = 0
    func increment() -> Int { count += 1; return count }
    func reset() { count = 0 }
}

func emit<T: Encodable>(_ value: T) {
    guard let line = encodeOneLine(value) else { return }
    print(line)
    fflush(stdout)
}

// 1. Apple Silicon check
if Device.isAppleSilicon {
    emit(UnsupportedEvent(
        reason: "Apple Silicon (arm64) detected. This plugin reads Intel-only SMC keys."
    ))
    exit(0)
}

// 2. Open SMC
let smc: SMC
do {
    smc = try SMC()
} catch {
    emit(ErrorEvent(message: "Failed to open AppleSMC: \(error)"))
    exit(1)
}

// 3. Probe catalogue
let t2 = Device.isT2
let catalog = CatalogProbe.probe(reader: smc, t2: t2)

// 3a. Power-probe diagnostic dump. Walks every known power SMC key and
// reports key + dataType + decoded value on stderr. Stream Deck captures
// stderr into the plugin log (at ERROR level — noise but useful for
// "why does CPU power look wrong" troubleshooting). Triggered once per
// helper start; cheap (one SMC read per known power key).
func logDiag(_ msg: String) {
    if let data = (msg + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}
logDiag("=== power-probe ===")
for key in Sensors.allKnownPowerKeysForDiagnostics {
    if let r = smc.read(key: key) {
        let decoded = Decoders.decodePower(
            b0: r.bytes.0, b1: r.bytes.1, b2: r.bytes.2, b3: r.bytes.3,
            dataType: r.dataType
        )
        let valueStr = decoded.map { String(format: "%.3f W", $0) } ?? "nil"
        let bytes = String(format: "%02X %02X %02X %02X",
            r.bytes.0, r.bytes.1, r.bytes.2, r.bytes.3)
        logDiag("  \(key)  dataType=\"\(r.dataType)\"  bytes=\(bytes)  decoded=\(valueStr)")
    } else {
        logDiag("  \(key)  (absent)")
    }
}
logDiag("=== end power-probe ===")

// Build a ReadyEvent from a catalog. Called at startup and again after
// every successful wake re-probe so the plugin rebuilds its view of which
// sensors exist (a re-probe may resolve a sensor onto a different SMC key).
func makeReadyEvent(_ catalog: SensorCatalog) -> ReadyEvent {
    return ReadyEvent(
        arch: "x86_64",
        t2: catalog.t2,
        cpuCores: catalog.cpuCores.map {
            CPUCoreInfo(index: $0.coreIndex ?? -1, key: $0.key)
        },
        cpuPackageKey: catalog.cpuPackage?.key,
        gpuSensor: catalog.gpu?.key,
        ambientSensor: catalog.ambient?.key,
        ramSensor: catalog.ram?.key,
        ssdSensor: catalog.ssd?.key,
        chipsetSensor: catalog.chipset?.key,
        wifiSensor: catalog.wifi?.key,
        thunderboltSensor: catalog.thunderbolt?.key,
        cpuPowerSensor: catalog.cpuPower?.key,
        gpuPowerSensor: catalog.gpuPower?.key,
        fans: catalog.fans.map { FanInfo(index: $0.index, min: $0.min, max: $0.max) }
    )
}

emit(makeReadyEvent(catalog))

// 4. Periodic readings.
let shutdown = DispatchSemaphore(value: 0)
let timerQueue = DispatchQueue(label: "smcreader.timer")
let timer = DispatchSource.makeTimerSource(queue: timerQueue)
timer.schedule(deadline: .now() + .milliseconds(1000), repeating: .seconds(1))

// Give-up tracking: if the catalog has sensors but every per-tick read
// returns nil for many consecutive ticks, the SMC connection has gone bad
// (or the kernel module disappeared). Exit so the supervisor restarts us.
let consecutiveFailuresThreshold = 10
let failureCounter = FailureCounter()

// Wake recovery: subscribe to IOKit system-power notifications and exit
// cleanly on kIOMessageSystemHasPoweredOn so the plugin's supervisor
// respawns us with a fresh SMC connection + fresh catalog probe. v1.5.1's
// in-process recycle didn't reliably recover the package-level sensors
// (RAM/GPU/ambient); a fresh process always does. The kernel fires the
// powered-on message after the AppleSMC driver has re-initialised, so the
// new process arrives at the right moment.
let powerNotifier = PowerNotifier(onWake: {
    logDiag("power: kIOMessageSystemHasPoweredOn — exiting for supervisor respawn")
    shutdown.signal()
})
powerNotifier.start()

// Disk-I/O rate sampler: tracks previous cumulative counters across
// ticks so we can report bytes/sec each second.
let diskIORate = SystemStats.DiskIORate()

timer.setEventHandler { [smc] in
    let ts = Int64(Date().timeIntervalSince1970)

    var cpu: [String: Double] = [:]
    for entry in catalog.cpuCores {
        if let c = CatalogProbe.readTemp(reader: smc, entry: entry) {
            cpu[entry.key] = c
        }
    }
    let cpuAvg: Double? = cpu.isEmpty
        ? nil
        : cpu.values.reduce(0, +) / Double(cpu.count)

    var cpuPackage: Double? = nil
    if let entry = catalog.cpuPackage {
        cpuPackage = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var gpu: Double? = nil
    if let entry = catalog.gpu {
        gpu = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var ambient: Double? = nil
    if let entry = catalog.ambient {
        ambient = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var ram: Double? = nil
    if let entry = catalog.ram {
        ram = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var ssd: Double? = nil
    if let entry = catalog.ssd {
        ssd = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var chipset: Double? = nil
    if let entry = catalog.chipset {
        chipset = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var wifi: Double? = nil
    if let entry = catalog.wifi {
        wifi = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var thunderbolt: Double? = nil
    if let entry = catalog.thunderbolt {
        thunderbolt = CatalogProbe.readTemp(reader: smc, entry: entry)
    }

    var cpuPower: Double? = nil
    if let entry = catalog.cpuPower {
        cpuPower = CatalogProbe.readPower(reader: smc, entry: entry)
    }

    var gpuPower: Double? = nil
    if let entry = catalog.gpuPower {
        gpuPower = CatalogProbe.readPower(reader: smc, entry: entry)
    }

    let fans: [FanReading] = catalog.fans.map { fan in
        FanReading(i: fan.index, rpm: CatalogProbe.readFanRPM(reader: smc, fan: fan))
    }

    // Non-SMC sources: RAM usage % via host_statistics64, disk I/O rates
    // via IOBlockStorageDriver delta sampling. Independent of the SMC
    // catalog — these are emitted every tick.
    let ramUsagePercent = SystemStats.ramUsagePercent()
    let (readBps, writeBps) = diskIORate.tick()

    // Did anything return a value this tick?
    let anyTemp = cpuAvg != nil || cpuPackage != nil || gpu != nil
        || ambient != nil || ram != nil || ssd != nil
        || chipset != nil || wifi != nil || thunderbolt != nil
    let anyPower = cpuPower != nil || gpuPower != nil
    let anyFan = fans.contains(where: { $0.rpm != nil })
    let catalogHasAnything =
        !catalog.cpuCores.isEmpty ||
        catalog.cpuPackage != nil ||
        catalog.gpu != nil ||
        catalog.ambient != nil ||
        catalog.ram != nil ||
        catalog.ssd != nil ||
        catalog.chipset != nil ||
        catalog.wifi != nil ||
        catalog.thunderbolt != nil ||
        catalog.cpuPower != nil ||
        catalog.gpuPower != nil ||
        !catalog.fans.isEmpty
    if catalogHasAnything && !anyTemp && !anyPower && !anyFan {
        let n = failureCounter.increment()
        if n >= consecutiveFailuresThreshold {
            emit(ErrorEvent(
                message: "All SMC reads failed for \(n) consecutive ticks; exiting so supervisor can restart."
            ))
            shutdown.signal()
            return
        }
    } else {
        failureCounter.reset()
    }

    emit(ReadingEvent(
        ts: ts,
        cpu: cpu,
        cpuAvg: cpuAvg,
        cpuPackage: cpuPackage,
        gpu: gpu,
        ambient: ambient,
        ram: ram,
        ssd: ssd,
        chipset: chipset,
        wifi: wifi,
        thunderbolt: thunderbolt,
        cpuPower: cpuPower,
        gpuPower: gpuPower,
        ramUsagePercent: ramUsagePercent,
        diskReadBytesPerSec: readBps,
        diskWriteBytesPerSec: writeBps,
        fans: fans
    ))
}
timer.resume()

// Signal handling: SIGTERM, SIGINT, SIGPIPE all trigger orderly shutdown.
let sigQueue = DispatchQueue(label: "smcreader.signals")
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: sigQueue)
let sigint  = DispatchSource.makeSignalSource(signal: SIGINT,  queue: sigQueue)
let sigpipe = DispatchSource.makeSignalSource(signal: SIGPIPE, queue: sigQueue)
sigterm.setEventHandler { shutdown.signal() }
sigint.setEventHandler  { shutdown.signal() }
sigpipe.setEventHandler { shutdown.signal() }
sigterm.resume()
sigint.resume()
sigpipe.resume()
signal(SIGTERM, SIG_IGN)
signal(SIGINT,  SIG_IGN)
signal(SIGPIPE, SIG_IGN)

shutdown.wait()
timer.cancel()
exit(0)
