// Non-SMC system statistics: RAM usage (host_statistics64) and disk I/O
// (IOBlockStorageDriver cumulative counters). Both APIs work on Intel
// and Apple Silicon Macs; we still gate the helper as Intel-only at the
// process level for v1.4, but these modules don't depend on Intel-only
// hardware.

import Darwin
import Foundation
import IOKit

enum SystemStats {
    // MARK: - RAM

    /// Total physical memory (bytes). Cached after first call — it never
    /// changes for a running OS.
    static let totalMemoryBytes: UInt64 = {
        var size: UInt64 = 0
        var sz = MemoryLayout<UInt64>.size
        sysctlbyname("hw.memsize", &size, &sz, nil, 0)
        return size
    }()

    /// VM page size for the current architecture (4 KB on Intel,
    /// 16 KB on Apple Silicon). Cached.
    static let pageSize: UInt64 = {
        return UInt64(vm_kernel_page_size)
    }()

    /// Compute current RAM usage as a percentage of physical memory.
    /// Definition matches Activity Monitor's "Memory Used":
    ///   used = (active + wired + compressed) * pageSize
    ///   percent = used / total * 100
    /// Returns nil if the host_statistics64 call fails.
    static func ramUsagePercent() -> Double? {
        var info = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride
        )
        let result = withUnsafeMutablePointer(to: &info) { infoPtr -> kern_return_t in
            infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { ptr in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, ptr, &count)
            }
        }
        guard result == KERN_SUCCESS, totalMemoryBytes > 0 else { return nil }

        // active = pages currently mapped and recently referenced
        // wire_count = pages locked in memory (kernel, IOKit, etc.)
        // compressor_page_count = pages held in the compressor
        let active = UInt64(info.active_count)
        let wired = UInt64(info.wire_count)
        let compressed = UInt64(info.compressor_page_count)
        let used = (active + wired + compressed) * pageSize
        return Double(used) / Double(totalMemoryBytes) * 100.0
    }

    // MARK: - Disk I/O

    /// Cumulative bytes read/written across every IOBlockStorageDriver
    /// instance visible in the IO registry. Returns counters that
    /// monotonically increase since system boot — the caller diffs them
    /// against the previous tick to derive bytes/sec.
    static func diskIOCounters() -> (read: UInt64, write: UInt64) {
        var iter: io_iterator_t = 0
        let matching = IOServiceMatching("IOBlockStorageDriver")
        guard IOServiceGetMatchingServices(0, matching, &iter) == KERN_SUCCESS else {
            return (0, 0)
        }
        defer { IOObjectRelease(iter) }

        var totalRead: UInt64 = 0
        var totalWrite: UInt64 = 0

        while true {
            let service = IOIteratorNext(iter)
            if service == 0 { break }
            defer { IOObjectRelease(service) }

            var props: Unmanaged<CFMutableDictionary>?
            let kr = IORegistryEntryCreateCFProperties(service, &props, kCFAllocatorDefault, 0)
            guard kr == KERN_SUCCESS, let cf = props?.takeRetainedValue() else { continue }

            guard let dict = cf as? [String: Any],
                  let stats = dict["Statistics"] as? [String: Any] else { continue }

            // Activity Monitor uses these exact keys. The values come back
            // as NSNumber; we round-trip through UInt64.
            if let r = stats["Bytes (Read)"] as? NSNumber {
                totalRead += r.uint64Value
            }
            if let w = stats["Bytes (Write)"] as? NSNumber {
                totalWrite += w.uint64Value
            }
        }

        return (totalRead, totalWrite)
    }

    /// Stateful disk-I/O rate sampler. Keeps the previous tick's
    /// counters so it can return bytes/sec on each `tick()` call.
    final class DiskIORate {
        private var lastRead: UInt64? = nil
        private var lastWrite: UInt64? = nil
        private var lastTimestamp: TimeInterval? = nil

        /// Sample now. Returns (readBytesPerSec, writeBytesPerSec) using
        /// the elapsed wall-clock time since the previous sample. First
        /// call after startup (or after a sleep/wake reset) returns
        /// (0, 0) — no baseline to diff against yet.
        func tick() -> (readBps: Double, writeBps: Double) {
            let (r, w) = SystemStats.diskIOCounters()
            let now = Date().timeIntervalSince1970

            defer {
                lastRead = r
                lastWrite = w
                lastTimestamp = now
            }

            guard let pr = lastRead, let pw = lastWrite, let pt = lastTimestamp else {
                return (0, 0)
            }
            let dt = max(0.001, now - pt)
            // Defend against counter rollback (sleep/wake recycle of
            // IORegistry, or a 64-bit wraparound after ~600 years of
            // continuous writes).
            let dr = r >= pr ? r - pr : 0
            let dw = w >= pw ? w - pw : 0
            return (Double(dr) / dt, Double(dw) / dt)
        }

        /// Reset the baseline. Call after a known long pause (sleep/wake)
        /// to avoid a single huge spike on the next sample.
        func resetBaseline() {
            lastRead = nil
            lastWrite = nil
            lastTimestamp = nil
        }
    }
}
