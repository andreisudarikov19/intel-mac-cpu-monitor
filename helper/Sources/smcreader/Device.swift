// Hardware/arch detection.
// T2 detection logic ported from Fanny/SMC's Device.swift (MIT, © 2019 Daniel Storm).

import Foundation

enum Device {
    /// True if the host CPU is Apple Silicon (arm64). Used to refuse to run
    /// since Fanny's SMC keys are Intel-only. The shell-out is acceptable
    /// because it happens once at startup.
    static var isAppleSilicon: Bool = {
        return sysctlBoolean("hw.optional.arm64")
    }()

    /// True if the host is an Intel Mac with an Apple T2 Security Chip.
    /// T2 Macs report fan RPM in IEEE Float (FLT) format; older Intel Macs
    /// use the fpe2 byte layout. Logic ported from Fanny/SMC's Device.swift.
    static var isT2: Bool = {
        let task = Process()
        let pipe = Pipe()
        task.launchPath = "/usr/sbin/system_profiler"
        task.arguments = ["SPiBridgeDataType"]
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
        } catch {
            return false
        }
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        return output.contains("Apple T2 Security Chip")
    }()

    private static func sysctlBoolean(_ name: String) -> Bool {
        var size: size_t = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return false }
        var value: Int32 = 0
        var valueSize = MemoryLayout<Int32>.size
        guard sysctlbyname(name, &value, &valueSize, nil, 0) == 0 else { return false }
        return value != 0
    }
}
