import Testing
@testable import smcreader

@Suite("Decoders")
struct DecodersTests {

    // MARK: - smcKey

    @Test func smcKey_4CharKey_encodesAsBigEndianUTF8() {
        // "TC0c" = T(0x54) C(0x43) 0(0x30) c(0x63) → 0x54433063
        #expect(Decoders.smcKey(from: "TC0c") == 0x54433063)
    }

    @Test func smcKey_Fnum_matchesFannyEncoding() {
        // "FNum" = F(0x46) N(0x4E) u(0x75) m(0x6D)
        #expect(Decoders.smcKey(from: "FNum") == 0x464E756D)
    }

    @Test func smcKey_LengthNot4_returnsNil() {
        #expect(Decoders.smcKey(from: "") == nil)
        #expect(Decoders.smcKey(from: "TC1") == nil)
        #expect(Decoders.smcKey(from: "TC0CC") == nil)
    }

    // MARK: - dataTypeString

    @Test func dataTypeString_sp78() {
        // "sp78" = 0x73 0x70 0x37 0x38, big-endian UInt32
        #expect(Decoders.dataTypeString(0x73703738) == "sp78")
    }

    @Test func dataTypeString_ui8WithTrailingSpace() {
        #expect(Decoders.dataTypeString(0x75693820) == "ui8 ")
    }

    @Test func dataTypeString_fltWithTrailingSpace() {
        #expect(Decoders.dataTypeString(0x666C7420) == "flt ")
    }

    // MARK: - decodeSP78

    @Test func decodeSP78_PositiveInteger() {
        // 0x32 0x00 = 50.0
        #expect(abs(Decoders.decodeSP78(b0: 0x32, b1: 0x00) - 50.0) < 0.001)
    }

    @Test func decodeSP78_PositiveFractional() {
        // 0x2D 0x50 = (45 * 256 + 80) / 256 = 45.3125
        #expect(abs(Decoders.decodeSP78(b0: 0x2D, b1: 0x50) - 45.3125) < 0.0001)
    }

    @Test func decodeSP78_Negative() {
        // 0xFF 0x80 = signed Int16 -128, /256 = -0.5
        #expect(abs(Decoders.decodeSP78(b0: 0xFF, b1: 0x80) - (-0.5)) < 0.0001)
    }

    @Test func decodeSP78_Zero() {
        #expect(Decoders.decodeSP78(b0: 0, b1: 0) == 0.0)
    }

    // MARK: - decodeUI8

    @Test func decodeUI8_PositiveValueBelowMask() {
        #expect(Decoders.decodeUI8(b0: 53) == 53.0)
    }

    @Test func decodeUI8_HighBitMaskedOff() {
        // 0xFF & 0x7F = 127
        #expect(Decoders.decodeUI8(b0: 0xFF) == 127.0)
    }

    // MARK: - decodeTemperature dispatch

    @Test func decodeTemperature_DispatchesSP78() {
        let v = Decoders.decodeTemperature(b0: 0x2D, b1: 0x50, b2: 0, b3: 0, dataType: "sp78")
        #expect(v != nil)
        #expect(abs(v! - 45.3125) < 0.0001)
    }

    @Test func decodeTemperature_DispatchesUI8() {
        let v = Decoders.decodeTemperature(b0: 53, b1: 0, b2: 0, b3: 0, dataType: "ui8 ")
        #expect(v == 53.0)
    }

    @Test func decodeTemperature_UnknownTypeFallsBackToUI8() {
        // Unknown dataType falls back to UI8 (better than dropping)
        let v = Decoders.decodeTemperature(b0: 50, b1: 0, b2: 0, b3: 0, dataType: "????")
        #expect(v == 50.0)
    }

    @Test func decodeTemperature_FLT_RealValue() {
        // 45.5 as IEEE 754 little-endian float = 0x00 0x00 0x36 0x42
        let v = Decoders.decodeTemperature(b0: 0x00, b1: 0x00, b2: 0x36, b3: 0x42, dataType: "flt ")
        #expect(v != nil)
        #expect(abs(v! - 45.5) < 0.0001)
    }

    @Test func decodeTemperature_FLT_NaN_ReturnsNil() {
        // NaN payload: would otherwise cause JSONEncoder to throw and drop
        // the entire reading event. We return nil so the per-sensor value
        // is omitted and the rest of the tick still gets sent.
        let v = Decoders.decodeTemperature(b0: 0xFF, b1: 0xFF, b2: 0xFF, b3: 0x7F, dataType: "flt ")
        #expect(v == nil)
    }

    @Test func decodeTemperature_FLT_Infinity_ReturnsNil() {
        let v = Decoders.decodeTemperature(b0: 0x00, b1: 0x00, b2: 0x80, b3: 0x7F, dataType: "flt ")
        #expect(v == nil)
    }

    // MARK: - SP78 edge cases (review LOW #9)

    @Test func decodeSP78_MinimumNegative() {
        // 0x80 0x00 = Int16.min = -32768, divided by 256 = -128.0
        #expect(abs(Decoders.decodeSP78(b0: 0x80, b1: 0x00) - (-128.0)) < 0.001)
    }

    @Test func decodeSP78_SmallNegative() {
        // 0xFF 0xFF = -1, divided by 256 = -0.00390625
        #expect(abs(Decoders.decodeSP78(b0: 0xFF, b1: 0xFF) - (-0.00390625)) < 0.00001)
    }

    // MARK: - fanRPMfpe2

    @Test func fanRPMfpe2_KnownValue() {
        // (b0 << 6) + (b1 >> 2); b0=0x10, b1=0x80 => 1024 + 32 = 1056
        #expect(Decoders.fanRPMfpe2(b0: 0x10, b1: 0x80) == 1056)
    }

    @Test func fanRPMfpe2_Zero() {
        #expect(Decoders.fanRPMfpe2(b0: 0, b1: 0) == 0)
    }

    @Test func fanRPMfpe2_MaxByte0() {
        #expect(Decoders.fanRPMfpe2(b0: 0xFF, b1: 0) == 16320)
    }

    // MARK: - fanRPMflt

    @Test func fanRPMflt_2100rpm() {
        // 2100.0 little-endian IEEE float: 0x00 0x40 0x03 0x45
        #expect(Decoders.fanRPMflt(b0: 0x00, b1: 0x40, b2: 0x03, b3: 0x45) == 2100)
    }

    @Test func fanRPMflt_Zero() {
        #expect(Decoders.fanRPMflt(b0: 0, b1: 0, b2: 0, b3: 0) == 0)
    }

    @Test func fanRPMflt_NaN_returnsZero() {
        // NaN payload (one canonical form)
        #expect(Decoders.fanRPMflt(b0: 0xFF, b1: 0xFF, b2: 0xFF, b3: 0x7F) == 0)
    }

    @Test func fanRPMflt_Infinity_returnsZero() {
        #expect(Decoders.fanRPMflt(b0: 0x00, b1: 0x00, b2: 0x80, b3: 0x7F) == 0)
    }
}
