import Testing
@testable import smcreader

@Suite("JSON protocol")
struct ProtocolTests {

    @Test func encodeOneLine_NoNewlinesInOutput() {
        let ev = ReadyEvent(
            arch: "x86_64",
            t2: true,
            cpuCores: [CPUCoreInfo(index: 0, key: "TC0c")],
            cpuPackageKey: "TC0P",
            gpuSensor: "TG0D",
            ambientSensor: "TA0P",
            ramSensor: "TM0P",
            ssdSensor: "TH0F",
            chipsetSensor: "TN0P",
            wifiSensor: "TW0P",
            thunderboltSensor: "TI0P",
            cpuPowerSensor: "PCPC",
            gpuPowerSensor: "PG0C",
            fans: [FanInfo(index: 0, min: 1200, max: 2700)]
        )
        let line = encodeOneLine(ev)
        #expect(line != nil)
        #expect(line!.contains("\n") == false)
    }

    @Test func encodeOneLine_KeysAreSorted() {
        // Sorted keys make the output stable, which matters for the Node
        // consumer's JSON-Line debugging and for diffable wire dumps.
        let ev = ReadyEvent(
            arch: "x86_64", t2: true, cpuCores: [],
            cpuPackageKey: nil, gpuSensor: nil,
            ambientSensor: nil, ramSensor: nil, ssdSensor: nil,
            chipsetSensor: nil, wifiSensor: nil, thunderboltSensor: nil,
            cpuPowerSensor: nil, gpuPowerSensor: nil,
            fans: []
        )
        let line = encodeOneLine(ev)!
        let archPos = line.range(of: "arch")!.lowerBound
        let eventPos = line.range(of: "event")!.lowerBound
        #expect(archPos < eventPos)
    }

    @Test func readingEvent_HasAllExpectedFields() {
        let ev = ReadingEvent(
            ts: 1700000000,
            cpu: ["TC0c": 45.5],
            cpuAvg: 45.5,
            cpuPackage: 50.0,
            gpu: 60.0,
            ambient: 22.5,
            ram: 38.0,
            ssd: 40.0,
            chipset: 65.0,
            wifi: 42.0,
            thunderbolt: 48.0,
            cpuPower: 25.0,
            gpuPower: 18.5,
            ramUsagePercent: nil,
            diskReadBytesPerSec: nil,
            diskWriteBytesPerSec: nil,
            fans: [FanReading(i: 0, rpm: 1200)]
        )
        let line = encodeOneLine(ev)!
        #expect(line.contains("\"event\":\"reading\""))
        #expect(line.contains("\"ts\":1700000000"))
        #expect(line.contains("\"TC0c\":45.5"))
        #expect(line.contains("\"cpuAvg\":45.5"))
        #expect(line.contains("\"cpuPackage\":50"))
        #expect(line.contains("\"gpu\":60"))
        #expect(line.contains("\"ambient\":22.5"))
        #expect(line.contains("\"ram\":38"))
        #expect(line.contains("\"ssd\":40"))
        #expect(line.contains("\"chipset\":65"))
        #expect(line.contains("\"wifi\":42"))
        #expect(line.contains("\"thunderbolt\":48"))
        #expect(line.contains("\"cpuPower\":25"))
        #expect(line.contains("\"gpuPower\":18.5"))
    }

    @Test func readingEvent_NilFields_areOmitted() {
        // Swift's JSONEncoder OMITS nil Optionals rather than writing null.
        // The Node side must treat missing keys as "no value" (undefined).
        // We pin this wire contract here so any future change to the
        // encoding strategy is caught.
        let ev = ReadingEvent(
            ts: 1, cpu: [:], cpuAvg: nil, cpuPackage: nil, gpu: nil,
            ambient: nil, ram: nil, ssd: nil,
            chipset: nil, wifi: nil, thunderbolt: nil,
            cpuPower: nil, gpuPower: nil,
            ramUsagePercent: nil,
            diskReadBytesPerSec: nil,
            diskWriteBytesPerSec: nil,
            fans: []
        )
        let line = encodeOneLine(ev)!
        #expect(line.contains("cpuAvg") == false)
        #expect(line.contains("cpuPackage") == false)
        #expect(line.contains("\"gpu\"") == false)
        #expect(line.contains("\"ambient\"") == false)
        #expect(line.contains("\"ram\"") == false)
        #expect(line.contains("\"ssd\"") == false)
        #expect(line.contains("\"chipset\"") == false)
        #expect(line.contains("\"wifi\"") == false)
        #expect(line.contains("\"thunderbolt\"") == false)
        #expect(line.contains("\"cpuPower\"") == false)
        #expect(line.contains("\"gpuPower\"") == false)
    }

    @Test func fanReading_NilRPM_isOmitted() {
        let ev = ReadingEvent(
            ts: 1, cpu: [:], cpuAvg: nil, cpuPackage: nil, gpu: nil,
            ambient: nil, ram: nil, ssd: nil,
            chipset: nil, wifi: nil, thunderbolt: nil,
            cpuPower: nil, gpuPower: nil,
            ramUsagePercent: nil,
            diskReadBytesPerSec: nil,
            diskWriteBytesPerSec: nil,
            fans: [FanReading(i: 0, rpm: nil)]
        )
        let line = encodeOneLine(ev)!
        #expect(line.contains("\"rpm\"") == false)
        // The fan entry itself must still be present
        #expect(line.contains("\"i\":0"))
    }

    @Test func unsupportedEvent_Shape() {
        let ev = UnsupportedEvent(reason: "Apple Silicon")
        let line = encodeOneLine(ev)!
        #expect(line.contains("\"event\":\"unsupported\""))
        #expect(line.contains("\"reason\":\"Apple Silicon\""))
    }

    @Test func errorEvent_Shape() {
        let ev = ErrorEvent(message: "no SMC")
        let line = encodeOneLine(ev)!
        #expect(line.contains("\"event\":\"error\""))
        #expect(line.contains("\"message\":\"no SMC\""))
    }
}
