// Pure-function decoders for SMC byte payloads.
// Extracted so they can be unit-tested without an IOKit connection.
//
// Sources:
//   - Fanny/SMC (MIT, © 2019 Daniel Storm): UTF-8 key encoding, fpe2/FLT fan
//     formats, single-byte Celsius decode.
//   - exelban/stats (GPL-3.0): SP78 fixed-point temperature decode and the
//     dataType discriminator names used by AppleSMC (sp78, ui8, flt, fpe2).

import Foundation

enum Decoders {
    /// Encode a 4-character ASCII key (e.g. "TC1C") as the big-endian UInt32
    /// AppleSMC expects. Returns nil for any other length.
    static func smcKey(from key: String) -> UInt32? {
        guard key.count == 4 else { return nil }
        return key.utf8.reduce(UInt32(0)) { acc, byte in
            (acc << 8) | UInt32(byte)
        }
    }

    /// Decode a 4-character AppleSMC dataType (UInt32 from keyInfo.dataType)
    /// back into its ASCII string form like "sp78" or "ui8 " (note: SMC
    /// dataType names are right-padded with spaces to 4 chars).
    static func dataTypeString(_ raw: UInt32) -> String {
        var v = raw.bigEndian
        return withUnsafeBytes(of: &v) { buf in
            String(bytes: buf, encoding: .ascii) ?? ""
        }
    }

    // MARK: - Temperature decoders

    /// SP78 = signed 7.8 fixed-point. 2 bytes: integer.fraction/256.
    /// Used by most modern T2 Mac temperature sensors.
    /// Source: exelban/stats SMC/smc.swift getValue() SP78 branch.
    static func decodeSP78(b0: UInt8, b1: UInt8) -> Double {
        let signed = Int16(bitPattern: (UInt16(b0) << 8) | UInt16(b1))
        return Double(signed) / 256.0
    }

    /// Legacy single-byte Celsius decode (Fanny). The 0x7F mask drops the
    /// high bit which some SMC firmwares set as a status flag.
    static func decodeUI8(b0: UInt8) -> Double {
        return Double(b0 & 0x7F)
    }

    /// Dispatch by dataType for temperature sensors. Takes all 4 leading
    /// bytes so the FLT branch (4-byte float) can decode correctly.
    /// Returns nil for non-finite results (NaN/Inf) so the reading event
    /// drops that sensor for the tick rather than crashing the JSONEncoder.
    static func decodeTemperature(b0: UInt8, b1: UInt8, b2: UInt8, b3: UInt8, dataType: String) -> Double? {
        let raw: Double
        switch dataType {
        case "sp78":
            raw = decodeSP78(b0: b0, b1: b1)
        case let t where t.hasPrefix("ui8"):
            raw = decodeUI8(b0: b0)
        case "flt ":
            // Some Macs use FLT for some temperatures (rare but exists).
            let f = decodeFltAsFloat(b0: b0, b1: b1, b2: b2, b3: b3)
            if f.isNaN || f.isInfinite { return nil }
            raw = Double(f)
        default:
            // Fall back to the lowest-common-denominator decode. Better than
            // dropping the reading entirely; calibration may be slightly off.
            raw = decodeUI8(b0: b0)
        }
        if raw.isNaN || raw.isInfinite { return nil }
        return raw
    }

    // MARK: - Power decoders

    /// Decode a power reading (watts) by dataType. Most modern Intel-Mac
    /// power keys use FLT (4-byte IEEE float). Returns nil for non-finite
    /// results.
    static func decodePower(b0: UInt8, b1: UInt8, b2: UInt8, b3: UInt8, dataType: String) -> Double? {
        let raw: Double
        switch dataType {
        case "flt ":
            let f = decodeFltAsFloat(b0: b0, b1: b1, b2: b2, b3: b3)
            if f.isNaN || f.isInfinite { return nil }
            raw = Double(f)
        case "sp78":
            raw = decodeSP78(b0: b0, b1: b1)
        case let t where t.hasPrefix("ui8"):
            raw = decodeUI8(b0: b0)
        default:
            // Last-resort fallback — calibration may be off but better
            // than dropping the reading entirely.
            raw = decodeUI8(b0: b0)
        }
        if raw.isNaN || raw.isInfinite { return nil }
        return raw
    }

    // MARK: - Fan decoders

    /// Decode a fan RPM value in legacy "fpe2" format (pre-T2 Intel Macs).
    /// Layout: (b0 << 6) | (b1 >> 2). Source: SMC+Fans.swift in Fanny/SMC.
    static func fanRPMfpe2(b0: UInt8, b1: UInt8) -> Int {
        return (Int(b0) << 6) + (Int(b1) >> 2)
    }

    /// Decode a fan RPM value in IEEE-754 little-endian Float ("FLT") format
    /// (T2 Macs). Source: SMC+Fans.swift in Fanny/SMC.
    static func fanRPMflt(b0: UInt8, b1: UInt8, b2: UInt8, b3: UInt8) -> Int {
        let f = decodeFltAsFloat(b0: b0, b1: b1, b2: b2, b3: b3)
        if f.isNaN || f.isInfinite { return 0 }
        return Int(f)
    }

    /// Internal: little-endian 4-byte IEEE Float decode.
    static func decodeFltAsFloat(b0: UInt8, b1: UInt8, b2: UInt8, b3: UInt8) -> Float {
        var value: Float = 0
        let bytes: [UInt8] = [b0, b1, b2, b3]
        withUnsafeMutablePointer(to: &value) { ptr in
            ptr.withMemoryRebound(to: UInt8.self, capacity: 4) { dst in
                bytes.withUnsafeBufferPointer { src in
                    dst.update(from: src.baseAddress!, count: 4)
                }
            }
        }
        return value
    }
}
