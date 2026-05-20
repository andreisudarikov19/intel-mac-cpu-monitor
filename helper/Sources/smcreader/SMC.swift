// AppleSMC IOKit connection wrapper.
// Adapted from Fanny/SMC's SMC.swift (MIT, © 2019 Daniel Storm).
// Differences from upstream: open() throws instead of fatalError-ing, and
// reads return the dataType too so callers can dispatch decoding.

import Foundation
import IOKit

/// A read-only interface over the SMC. Lets us mock SMC access in tests.
protocol SMCReading {
    /// Returns (raw bytes, dataType as 4-char SMC string) for a given key,
    /// or nil if the key is absent / read failed.
    func read(key: String) -> (bytes: SMCBytes, dataType: String)?
}

extension SMCReading {
    /// Convenience: just the byte tuple, for callers that don't care about
    /// dataType. Returns nil if the key fails.
    func bytes(key: String) -> SMCBytes? {
        return read(key: key)?.bytes
    }
}

enum SMCError: Error, CustomStringConvertible {
    case noService
    case openFailed(kern_return_t)

    var description: String {
        switch self {
        case .noService: return "AppleSMC IOService not found"
        case .openFailed(let kr): return "IOServiceOpen failed (kern_return=\(kr))"
        }
    }
}

final class SMC: SMCReading {
    private var connection: io_connect_t = 0

    init() throws {
        // kIOMasterPortDefault is deprecated as of macOS 12; passing 0 selects
        // the default master port and is the documented contract.
        let service = IOServiceGetMatchingService(0, IOServiceMatching("AppleSMC"))
        guard service != 0 else { throw SMCError.noService }
        defer { IOObjectRelease(service) }

        var conn: io_connect_t = 0
        let kr = IOServiceOpen(service, mach_task_self_, 0, &conn)
        guard kr == kIOReturnSuccess else { throw SMCError.openFailed(kr) }
        self.connection = conn
    }

    deinit {
        if connection != 0 {
            IOServiceClose(connection)
        }
    }

    func read(key: String) -> (bytes: SMCBytes, dataType: String)? {
        guard let smcKey = Decoders.smcKey(from: key) else { return nil }
        guard let info = keyInfo(smcKey: smcKey), info.dataSize > 0 else { return nil }
        guard let bytes = readBytes(smcKey: smcKey, dataSize: info.dataSize) else { return nil }
        let dataType = Decoders.dataTypeString(info.dataType)
        return (bytes, dataType)
    }

    // MARK: - Private

    private struct KeyInfo {
        let dataSize: UInt32
        let dataType: UInt32
    }

    private func keyInfo(smcKey: UInt32) -> KeyInfo? {
        var input = SMCStructure()
        var output = SMCStructure()
        let inputSize = MemoryLayout<SMCStructure>.stride
        var outputSize = MemoryLayout<SMCStructure>.stride

        input.key = smcKey
        input.data8 = SMCStructure.Selector.kSMCGetKeyInfo.rawValue

        let kr = IOConnectCallStructMethod(
            connection,
            UInt32(SMCStructure.Selector.kSMCHandleYPCEvent.rawValue),
            &input, inputSize,
            &output, &outputSize
        )
        guard kr == kIOReturnSuccess, output.result == SMCStructure.Result.kSMCSuccess.rawValue else {
            return nil
        }
        return KeyInfo(dataSize: output.keyInfo.dataSize, dataType: output.keyInfo.dataType)
    }

    private func readBytes(smcKey: UInt32, dataSize: UInt32) -> SMCBytes? {
        var input = SMCStructure()
        var output = SMCStructure()
        let inputSize = MemoryLayout<SMCStructure>.stride
        var outputSize = MemoryLayout<SMCStructure>.stride

        input.key = smcKey
        input.keyInfo.dataSize = dataSize
        input.data8 = SMCStructure.Selector.kSMCReadKey.rawValue

        let kr = IOConnectCallStructMethod(
            connection,
            UInt32(SMCStructure.Selector.kSMCHandleYPCEvent.rawValue),
            &input, inputSize,
            &output, &outputSize
        )
        guard kr == kIOReturnSuccess, output.result == SMCStructure.Result.kSMCSuccess.rawValue else {
            return nil
        }
        return output.bytes
    }
}
