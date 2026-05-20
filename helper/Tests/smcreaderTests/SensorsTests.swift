import Testing
@testable import smcreader

@Suite("Sensors")
struct SensorsTests {

    @Test func cpuCoreCandidates_BothCases() {
        #expect(Sensors.cpuCoreCandidates(index: 0) == ["TC0C", "TC0c"])
        #expect(Sensors.cpuCoreCandidates(index: 7) == ["TC7C", "TC7c"])
    }

    @Test func cpuCoreIndices_Covers0Through15() {
        // Wide enough to cover any current Intel iMac/MacBook (e.g. the
        // 10-core iMac uses cores 0–9). Non-existent sensors are dropped at
        // probe time.
        #expect(Sensors.cpuCoreIndices == [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
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

    @Test func ambientPreference_TA0PFirst_includesMacBookLowercase() {
        // TA0P is the standard intake-air key (iMacs). MacBooks sometimes
        // only expose lowercase variants (TaLP / TaRF) — both must be
        // present so the probe finds *some* ambient sensor on each model.
        #expect(Sensors.ambientKeysInPreferenceOrder.first == "TA0P")
        #expect(Sensors.ambientKeysInPreferenceOrder.contains("TaLP"))
        #expect(Sensors.ambientKeysInPreferenceOrder.contains("TaRF"))
    }

    @Test func ramPreference_Ts0SFirst() {
        // Ts0S is the most reliable memory slot temp on Intel iMacs.
        #expect(Sensors.ramKeysInPreferenceOrder.first == "Ts0S")
    }

    @Test func ssdPreference_TH0AFirst() {
        // TH0A is exelban/stats' canonical primary-disk key.
        #expect(Sensors.ssdKeysInPreferenceOrder.first == "TH0A")
        #expect(Sensors.ssdKeysInPreferenceOrder.contains("TH0F"))
    }

    @Test func chipsetPreference_TN0DFirst() {
        // Northbridge diode is the most accurate chipset reading.
        #expect(Sensors.chipsetKeysInPreferenceOrder.first == "TN0D")
        #expect(Sensors.chipsetKeysInPreferenceOrder.contains("TN0P"))
    }

    @Test func wifiPreference_OnlyTW0P() {
        // Only one key is documented for Wi-Fi proximity.
        #expect(Sensors.wifiKeysInPreferenceOrder == ["TW0P"])
    }

    @Test func thunderboltPreference_TI0PFirst_AndCoversTwoControllers() {
        // First TB controller's proximity; second controller's; then
        // MacBook Pro left/right diodes as fallbacks.
        #expect(Sensors.thunderboltKeysInPreferenceOrder.first == "TI0P")
        #expect(Sensors.thunderboltKeysInPreferenceOrder.contains("TI1P"))
        #expect(Sensors.thunderboltKeysInPreferenceOrder.contains("TTLD"))
        #expect(Sensors.thunderboltKeysInPreferenceOrder.contains("TTRD"))
    }
}
