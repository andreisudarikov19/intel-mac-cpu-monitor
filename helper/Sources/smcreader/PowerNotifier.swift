// Listens for macOS sleep/wake events via IOKit power management
// notifications and invokes a callback when the system has powered on.
//
// Background: package-level SMC sensors (RAM/GPU/ambient — keys like TM0P,
// TG0D, TA0P) silently stop returning data through a sleep/wake cycle on
// some Intel Macs. v1.5.1 tried to recover by recycling the io_connect_t
// and re-probing in process after a tick-gap heuristic; that wasn't
// reliable. The only path observed to consistently recover is a fresh
// helper process. The kernel sends kIOMessageSystemHasPoweredOn after the
// AppleSMC driver has re-initialized, so triggering an exit at that moment
// lets the plugin's supervisor respawn us into a clean state.

import Foundation
import IOKit
import IOKit.pwr_mgt

// IOKit power-management message constants are declared in IOMessage.h as
// C macros and are not exposed by the Swift IOKit overlay. Values are stable
// platform ABI (iokit_common_msg(N) = 0xE0000000 | N).
private let kIOMessageCanSystemSleep:     UInt32 = 0xE0000270
private let kIOMessageSystemWillSleep:    UInt32 = 0xE0000280
private let kIOMessageSystemHasPoweredOn: UInt32 = 0xE0000300

final class PowerNotifier {
    private let onWake: () -> Void
    private var rootPort: io_connect_t = 0
    private var notifyPort: IONotificationPortRef?
    private var notifier: io_object_t = 0
    private var thread: Thread?

    init(onWake: @escaping () -> Void) {
        self.onWake = onWake
    }

    /// Spawn a dedicated thread that owns a CFRunLoop receiving IOKit
    /// power messages. Returns immediately.
    func start() {
        let t = Thread { [weak self] in self?.runOnThread() }
        t.name = "smcreader.power"
        thread = t
        t.start()
    }

    private func runOnThread() {
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var port: IONotificationPortRef?
        var noti: io_object_t = 0

        // C-convention callback (no captures). Routes the event back to
        // `self` through the refcon round-trip and ACKs sleep so we don't
        // delay the system going to sleep.
        let callback: IOServiceInterestCallback = { (refcon, _, messageType, messageArgument) in
            guard let refcon = refcon else { return }
            let me = Unmanaged<PowerNotifier>.fromOpaque(refcon).takeUnretainedValue()
            switch messageType {
            case UInt32(kIOMessageCanSystemSleep), UInt32(kIOMessageSystemWillSleep):
                IOAllowPowerChange(me.rootPort, Int(bitPattern: messageArgument))
            case UInt32(kIOMessageSystemHasPoweredOn):
                me.onWake()
            default:
                break
            }
        }

        let rp = IORegisterForSystemPower(refcon, &port, callback, &noti)
        guard rp != 0, let port = port else {
            FileHandle.standardError.write(
                Data("power: IORegisterForSystemPower failed\n".utf8)
            )
            return
        }
        rootPort = rp
        notifyPort = port
        notifier = noti

        let source = IONotificationPortGetRunLoopSource(port).takeUnretainedValue()
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
        CFRunLoopRun()
    }
}
