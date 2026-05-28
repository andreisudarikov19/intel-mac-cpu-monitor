import Testing
@testable import smcreader

/// Mock SMC: returns canned (bytes, dataType) for keys we set up, nil
/// otherwise. Lets us drive the Catalog probe without IOKit.
final class MockSMC: SMCReading {
    var fixtures: [String: (SMCBytes, String)] = [:]

    func setTemp(key: String, celsius: Double, dataType: String = "sp78") {
        switch dataType {
        case "sp78":
            let v = Int16((celsius * 256).rounded())
            let u = UInt16(bitPattern: v)
            let b0 = UInt8(u >> 8)
            let b1 = UInt8(u & 0xFF)
            fixtures[key] = (zeroedBytesWith(b0: b0, b1: b1), "sp78")
        case "ui8 ":
            fixtures[key] = (zeroedBytesWith(b0: UInt8(celsius)), "ui8 ")
        default:
            fatalError("unsupported test dataType \(dataType)")
        }
    }

    func setRawByte(key: String, b0: UInt8, dataType: String = "ui8 ") {
        fixtures[key] = (zeroedBytesWith(b0: b0), dataType)
    }

    func setFltFan(key: String, rpm: Float) {
        var v = rpm
        var bytes = (UInt8(0), UInt8(0), UInt8(0), UInt8(0))
        withUnsafeBytes(of: &v) { buf in
            bytes = (buf[0], buf[1], buf[2], buf[3])
        }
        fixtures[key] = (
            zeroedBytesWith(b0: bytes.0, b1: bytes.1, b2: bytes.2, b3: bytes.3),
            "flt "
        )
    }

    func setFpe2Fan(key: String, rpm: Int) {
        let b0 = UInt8(rpm >> 6)
        let b1 = UInt8((rpm & 0x3F) << 2)
        fixtures[key] = (zeroedBytesWith(b0: b0, b1: b1), "fpe2")
    }

    func setPower(key: String, watts: Float) {
        // Power keys typically use FLT format on Intel Macs.
        var v = watts
        var bytes = (UInt8(0), UInt8(0), UInt8(0), UInt8(0))
        withUnsafeBytes(of: &v) { buf in
            bytes = (buf[0], buf[1], buf[2], buf[3])
        }
        fixtures[key] = (
            zeroedBytesWith(b0: bytes.0, b1: bytes.1, b2: bytes.2, b3: bytes.3),
            "flt "
        )
    }

    func read(key: String) -> (bytes: SMCBytes, dataType: String)? {
        return fixtures[key]
    }

    private func zeroedBytesWith(b0: UInt8 = 0, b1: UInt8 = 0, b2: UInt8 = 0, b3: UInt8 = 0) -> SMCBytes {
        return (b0, b1, b2, b3, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0,
                0, 0, 0, 0, 0, 0, 0, 0)
    }
}

@Suite("Catalog probe")
struct CatalogTests {

    @Test func probe_AllPerCoreLowercase_AreDetected() {
        let smc = MockSMC()
        for i in 0...8 { smc.setTemp(key: "TC\(i)c", celsius: 50 + Double(i)) }
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuCores.count == 9)
        #expect(cat.cpuCores.map(\.key) == [
            "TC0c", "TC1c", "TC2c", "TC3c", "TC4c", "TC5c", "TC6c", "TC7c", "TC8c"
        ])
        #expect(cat.cpuCores.first?.coreIndex == 0)
    }

    @Test func probe_UppercaseOnlyMac_IsDetected() {
        let smc = MockSMC()
        for i in 1...4 { smc.setTemp(key: "TC\(i)C", celsius: 45, dataType: "ui8 ") }
        let cat = CatalogProbe.probe(reader: smc, t2: false)
        #expect(cat.cpuCores.count == 4)
        #expect(cat.cpuCores.map(\.key) == ["TC1C", "TC2C", "TC3C", "TC4C"])
    }

    @Test func probe_BothCases_PrefersUppercase() {
        let smc = MockSMC()
        smc.setTemp(key: "TC0C", celsius: 40)
        smc.setTemp(key: "TC0c", celsius: 50)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuCores.first?.key == "TC0C")
    }

    @Test func probe_ZeroOrBelowOneCelsius_IsRejected() {
        // Sensors reporting always-zero or near-zero (broken/uninstalled)
        // must not enter the catalogue. Threshold is >1.0°C (Fanny rule).
        let smc = MockSMC()
        smc.setTemp(key: "TC0c", celsius: 0)
        smc.setTemp(key: "TC1c", celsius: 0.5)
        smc.setTemp(key: "TC2c", celsius: 1.01)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuCores.map(\.key) == ["TC2c"])
    }

    @Test func probe_NoCores_FallsBackToPackage() {
        // The T2 case our test hardware demonstrated: no per-core, but a
        // package sensor exists.
        let smc = MockSMC()
        smc.setTemp(key: "TC0F", celsius: 55, dataType: "sp78")
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuCores.isEmpty)
        #expect(cat.cpuPackage?.key == "TC0F")
    }

    @Test func probe_PackagePreferenceOrder() {
        let smc = MockSMC()
        smc.setTemp(key: "TCAD", celsius: 50)
        smc.setTemp(key: "TC0F", celsius: 50)
        smc.setTemp(key: "TC0D", celsius: 50)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuPackage?.key == "TCAD")
    }

    @Test func probe_PackageSkipsBadKeys() {
        // Regression test for the bug we hit on real hardware: a key that
        // exists but decodes to <=1°C must be skipped, not selected.
        let smc = MockSMC()
        smc.setTemp(key: "TCAD", celsius: 0)
        smc.setTemp(key: "TC0F", celsius: 0.5)
        smc.setTemp(key: "TC0D", celsius: 48)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuPackage?.key == "TC0D")
    }

    @Test func probe_GPUSensorPreference() {
        let smc = MockSMC()
        smc.setTemp(key: "TG0D", celsius: 47)
        smc.setTemp(key: "TCGC", celsius: 47)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.gpu?.key == "TG0D")
    }

    @Test func probe_AmbientSensor_DetectedAndPreferenceOrdered() {
        let smc = MockSMC()
        // TA1P "exists" but TA0P also exists — prefer TA0P.
        smc.setTemp(key: "TA0P", celsius: 22)
        smc.setTemp(key: "TA1P", celsius: 22)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.ambient?.key == "TA0P")
    }

    @Test func probe_AmbientSensor_AbsentWhenNoKey() {
        let smc = MockSMC()
        // No ambient keys at all
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.ambient == nil)
    }

    @Test func probe_RAMSensor_FallsBackThroughOrder() {
        let smc = MockSMC()
        // First-choice Ts0S missing; TM0P should be picked next.
        smc.setTemp(key: "TM0P", celsius: 37)
        smc.setTemp(key: "Tm0P", celsius: 35)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.ram?.key == "TM0P")
    }

    @Test func probe_SSDSensor_PrefersTH0A() {
        let smc = MockSMC()
        smc.setTemp(key: "TH0A", celsius: 38)
        smc.setTemp(key: "TH0F", celsius: 38)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.ssd?.key == "TH0A")
    }

    @Test func probe_SSDSensor_FallsBackToTH0FOnLegacyMacs() {
        // Legacy Intel Macs only exposed TH0F. Verify the fallback works.
        let smc = MockSMC()
        smc.setTemp(key: "TH0F", celsius: 38)
        let cat = CatalogProbe.probe(reader: smc, t2: false)
        #expect(cat.ssd?.key == "TH0F")
    }

    @Test func probe_ChipsetSensor_PrefersDiode() {
        let smc = MockSMC()
        smc.setTemp(key: "TN0D", celsius: 65)
        smc.setTemp(key: "TN0H", celsius: 60)
        smc.setTemp(key: "TN0P", celsius: 58)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.chipset?.key == "TN0D")
    }

    @Test func probe_ChipsetSensor_FallsBackThroughOrder() {
        // No diode/heatsink, only Tp0P (last resort) — should still be found.
        let smc = MockSMC()
        smc.setTemp(key: "Tp0P", celsius: 55)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.chipset?.key == "Tp0P")
    }

    @Test func probe_WiFiSensor_TW0P() {
        let smc = MockSMC()
        smc.setTemp(key: "TW0P", celsius: 42)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.wifi?.key == "TW0P")
    }

    @Test func probe_ThunderboltSensor_PrefersFirstController() {
        let smc = MockSMC()
        smc.setTemp(key: "TI0P", celsius: 48)
        smc.setTemp(key: "TI1P", celsius: 45)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.thunderbolt?.key == "TI0P")
    }

    @Test func probe_ThunderboltSensor_MacBookProDualController() {
        // MacBook Pros with two TB controllers expose left/right diodes.
        let smc = MockSMC()
        smc.setTemp(key: "TTLD", celsius: 46)
        smc.setTemp(key: "TTRD", celsius: 48)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        // TI0P not present → falls through to TTLD (left diode).
        #expect(cat.thunderbolt?.key == "TTLD")
    }

    @Test func probe_CPUPower_PCPRFirst() {
        // PCPR is the most accurate "CPU Package total" on Intel Macs
        // (matches Intel RAPL counter). Verified on hardware in v1.2.1.
        let smc = MockSMC()
        smc.setPower(key: "PCPR", watts: 50.0)
        smc.setPower(key: "PCPT", watts: 32.0)
        smc.setPower(key: "PCPC", watts: 15.5)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuPower?.key == "PCPR")
    }

    @Test func probe_CPUPower_FallsBackToTotal() {
        // PCPR missing; PCTR should be the next pick.
        let smc = MockSMC()
        smc.setPower(key: "PCTR", watts: 50.0)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuPower?.key == "PCTR")
    }

    @Test func probe_GPUPower_PrefersDiscrete() {
        let smc = MockSMC()
        smc.setPower(key: "PG0C", watts: 25.0)
        smc.setPower(key: "PCGC", watts: 5.0)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.gpuPower?.key == "PG0C")
    }

    @Test func probe_GPUPower_FallsBackToIntegrated() {
        // No discrete; only Intel integrated graphics.
        let smc = MockSMC()
        smc.setPower(key: "PCGC", watts: 4.5)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.gpuPower?.key == "PCGC")
    }

    @Test func probe_Power_AcceptsZeroAtIdle() {
        // Integrated GPUs can legitimately read 0 W when idle. The probe
        // must accept that (no >0 filter, just non-negative finite).
        let smc = MockSMC()
        smc.setPower(key: "PCGC", watts: 0.0)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.gpuPower?.key == "PCGC")
    }

    @Test func probe_Power_RejectsImplausiblyHigh() {
        // A bogus decode that yields 9999 W must NOT be admitted.
        let smc = MockSMC()
        smc.setPower(key: "PCPC", watts: 9999.0)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.cpuPower == nil)
    }

    @Test func readPower_DecodesCurrentValue() {
        let smc = MockSMC()
        smc.setPower(key: "PCPC", watts: 12.5)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        let w = CatalogProbe.readPower(reader: smc, entry: cat.cpuPower!)
        #expect(w != nil)
        #expect(abs(w! - 12.5) < 0.001)
    }

    @Test func probe_FanCount_HonoursSanityBound() {
        // FNum reporting 99 is garbage from a misread; must be ignored.
        let smc = MockSMC()
        smc.setRawByte(key: "FNum", b0: 99)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.fans.isEmpty)
    }

    @Test func probe_TwoFans_T2DataType() {
        let smc = MockSMC()
        smc.setRawByte(key: "FNum", b0: 2)
        smc.setFltFan(key: "F0Mn", rpm: 1300)
        smc.setFltFan(key: "F0Mx", rpm: 6200)
        smc.setFltFan(key: "F1Mn", rpm: 1300)
        smc.setFltFan(key: "F1Mx", rpm: 6200)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.fans.count == 2)
        #expect(cat.fans[0].min == 1300)
        #expect(cat.fans[0].max == 6200)
        #expect(cat.fans[0].dataType == "flt ")
    }

    @Test func probe_FanWithOnlyMin_isIncluded() {
        let smc = MockSMC()
        smc.setRawByte(key: "FNum", b0: 1)
        smc.setFltFan(key: "F0Mn", rpm: 1200)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        #expect(cat.fans.count == 1)
        #expect(cat.fans[0].min == 1200)
        #expect(cat.fans[0].max == nil)
    }

    @Test func readTemp_DecodesUsingCatalogedDataType() {
        // The probe caches dataType so per-tick reads decode correctly even
        // for SP78 keys whose byte0 alone would mislead.
        let smc = MockSMC()
        smc.setTemp(key: "TC0c", celsius: 45.3125, dataType: "sp78")
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        let entry = cat.cpuCores.first!
        let reading = CatalogProbe.readTemp(reader: smc, entry: entry)
        #expect(reading != nil)
        #expect(abs(reading! - 45.3125) < 0.001)
    }

    @Test func readFanRPM_FltFan() {
        let smc = MockSMC()
        smc.setRawByte(key: "FNum", b0: 1)
        smc.setFltFan(key: "F0Mn", rpm: 1200)
        smc.setFltFan(key: "F0Mx", rpm: 2700)
        smc.setFltFan(key: "F0Ac", rpm: 1845)
        let cat = CatalogProbe.probe(reader: smc, t2: true)
        let rpm = CatalogProbe.readFanRPM(reader: smc, fan: cat.fans[0])
        #expect(rpm == 1845)
    }

    @Test func readFanRPM_Fpe2Fan() {
        let smc = MockSMC()
        smc.setRawByte(key: "FNum", b0: 1)
        smc.setFpe2Fan(key: "F0Mn", rpm: 1200)
        smc.setFpe2Fan(key: "F0Mx", rpm: 2700)
        smc.setFpe2Fan(key: "F0Ac", rpm: 1844) // fpe2 has 4-RPM granularity at high values
        let cat = CatalogProbe.probe(reader: smc, t2: false)
        let rpm = CatalogProbe.readFanRPM(reader: smc, fan: cat.fans[0])
        #expect(rpm != nil)
        #expect(abs(rpm! - 1844) <= 1)
    }

    // MARK: - Wake re-probe comparison (v1.5.1)

    /// Build a representative "full" catalog: per-core CPU, GPU, RAM,
    /// ambient, SSD, one fan.
    private func fullFixtures() -> MockSMC {
        let smc = MockSMC()
        for i in 0...3 { smc.setTemp(key: "TC\(i)c", celsius: 50) }
        smc.setTemp(key: "TG0D", celsius: 47)
        smc.setTemp(key: "TM0P", celsius: 38)
        smc.setTemp(key: "TA0P", celsius: 22)
        smc.setTemp(key: "TH0F", celsius: 40)
        smc.setRawByte(key: "FNum", b0: 1)
        smc.setFltFan(key: "F0Mn", rpm: 1200)
        smc.setFltFan(key: "F0Mx", rpm: 2700)
        return smc
    }

    @Test func missingSensors_IdenticalCatalog_ReportsComplete() {
        let cat = CatalogProbe.probe(reader: fullFixtures(), t2: true)
        #expect(cat.isMissingSensorsFrom(cat) == false)
    }

    @Test func missingSensors_DroppedGPU_ReportsMissing() {
        let expected = CatalogProbe.probe(reader: fullFixtures(), t2: true)
        // Re-probe where GPU has gone stale (key returns nothing).
        let degraded = fullFixtures()
        degraded.fixtures["TG0D"] = nil
        let current = CatalogProbe.probe(reader: degraded, t2: true)
        #expect(current.gpu == nil)
        #expect(current.isMissingSensorsFrom(expected) == true)
    }

    @Test func missingSensors_DroppedRAMAmbient_ReportsMissing() {
        let expected = CatalogProbe.probe(reader: fullFixtures(), t2: true)
        let degraded = fullFixtures()
        degraded.fixtures["TM0P"] = nil   // RAM
        degraded.fixtures["TA0P"] = nil   // ambient
        let current = CatalogProbe.probe(reader: degraded, t2: true)
        #expect(current.isMissingSensorsFrom(expected) == true)
    }

    @Test func missingSensors_FewerCores_ReportsMissing() {
        let expected = CatalogProbe.probe(reader: fullFixtures(), t2: true)
        let degraded = fullFixtures()
        degraded.fixtures["TC3c"] = nil   // lost one core
        let current = CatalogProbe.probe(reader: degraded, t2: true)
        #expect(current.cpuCores.count == 3)
        #expect(current.isMissingSensorsFrom(expected) == true)
    }

    @Test func missingSensors_ExtraSensors_NotReportedAsMissing() {
        // A re-probe that finds MORE than startup (e.g. a sensor that was
        // briefly absent at boot) is not "missing" anything.
        let expected = CatalogProbe.probe(reader: fullFixtures(), t2: true)
        let richer = fullFixtures()
        richer.setTemp(key: "TW0P", celsius: 42)   // Wi-Fi appears
        let current = CatalogProbe.probe(reader: richer, t2: true)
        #expect(current.wifi?.key == "TW0P")
        #expect(current.isMissingSensorsFrom(expected) == false)
    }

    @Test func missingSensors_SensorAbsentAtStartup_NotConsideredMissing() {
        // If Wi-Fi was never present at startup, a re-probe without it is
        // complete — we only chase sensors that actually worked before.
        let expected = CatalogProbe.probe(reader: fullFixtures(), t2: true)  // no Wi-Fi
        let current = CatalogProbe.probe(reader: fullFixtures(), t2: true)   // also no Wi-Fi
        #expect(expected.wifi == nil)
        #expect(current.isMissingSensorsFrom(expected) == false)
    }
}
