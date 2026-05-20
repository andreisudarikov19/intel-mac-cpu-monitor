import Testing
@testable import smcreader

@Suite("Sensors")
struct SensorsTests {

    @Test func cpuCoreCandidates_BothCases() {
        #expect(Sensors.cpuCoreCandidates(index: 0) == ["TC0C", "TC0c"])
        #expect(Sensors.cpuCoreCandidates(index: 7) == ["TC7C", "TC7c"])
    }

    @Test func cpuCoreIndices_Covers0Through8() {
        #expect(Sensors.cpuCoreIndices == [0, 1, 2, 3, 4, 5, 6, 7, 8])
    }

    @Test func fanKeysFormat() {
        #expect(Sensors.fanCountKey == "FNum")
        #expect(Sensors.fanCurrentRPMKey(index: 0) == "F0Ac")
        #expect(Sensors.fanCurrentRPMKey(index: 1) == "F1Ac")
        #expect(Sensors.fanMinimumRPMKey(index: 0) == "F0Mn")
        #expect(Sensors.fanMaximumRPMKey(index: 0) == "F0Mx")
        #expect(Sensors.fanTargetRPMKey(index: 0) == "F0Tg")
    }

    @Test func gpuKeyPreference_DiodeFirst() {
        #expect(Sensors.gpuKeysInPreferenceOrder.first == "TG0D")
        #expect(Sensors.gpuKeysInPreferenceOrder.contains("TCGC"))
    }

    @Test func cpuPackagePreference_TCADFirst() {
        #expect(Sensors.cpuPackageKeysInPreferenceOrder.first == "TCAD")
    }
}
