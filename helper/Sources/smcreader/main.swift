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
emit(ReadyEvent(
    arch: "x86_64",
    t2: catalog.t2,
    cpuCores: catalog.cpuCores.map {
        CPUCoreInfo(index: $0.coreIndex ?? -1, key: $0.key)
    },
    cpuPackageKey: catalog.cpuPackage?.key,
    gpuSensor: catalog.gpu?.key,
    fans: catalog.fans.map { FanInfo(index: $0.index, min: $0.min, max: $0.max) }
))

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

timer.setEventHandler { [smc, catalog] in
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

    let fans: [FanReading] = catalog.fans.map { fan in
        FanReading(i: fan.index, rpm: CatalogProbe.readFanRPM(reader: smc, fan: fan))
    }

    // Did anything return a value this tick?
    let anyTemp = cpuAvg != nil || cpuPackage != nil || gpu != nil
    let anyFan = fans.contains(where: { $0.rpm != nil })
    let catalogHasAnything =
        !catalog.cpuCores.isEmpty ||
        catalog.cpuPackage != nil ||
        catalog.gpu != nil ||
        !catalog.fans.isEmpty
    if catalogHasAnything && !anyTemp && !anyFan {
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
