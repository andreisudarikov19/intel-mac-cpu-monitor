#!/usr/bin/env node
// Fake helper used by helper-supervisor.test.ts.
//
// Behavior is selected via argv[2]:
//   "ready-then-readings"  emit ready + 3 readings + sleep forever
//   "ready-then-crash"     emit ready then exit code 1
//   "garbage-then-ready"   emit a garbage line, then ready
//   "unsupported"          emit unsupported and exit 0
//   "silent"               do nothing until killed (tests stale detection)

const mode = process.argv[2] || "ready-then-readings";

const emit = (obj) => { process.stdout.write(JSON.stringify(obj) + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep the event loop alive so the process doesn't exit early when the
// async body falls off the end (an unresolved Promise doesn't count as an
// active handle in Node).
const keepalive = setInterval(() => {}, 1000000);
process.on("SIGTERM", () => { clearInterval(keepalive); process.exit(0); });
process.on("SIGINT",  () => { clearInterval(keepalive); process.exit(0); });

(async () => {
    if (mode === "silent") {
        // Wait forever; supervisor should kill us with a stale timeout
        await new Promise(() => {});
        return;
    }

    if (mode === "garbage-then-ready") {
        process.stdout.write("not json at all\n");
        await sleep(10);
    }

    if (mode === "unsupported") {
        emit({ event: "unsupported", reason: "Test reason" });
        process.exit(0);
    }

    // ready event
    emit({
        event: "ready",
        arch: "x86_64",
        t2: true,
        cpuCores: [{ index: 0, key: "TC0c" }],
        cpuPackageKey: "TC0P",
        gpuSensor: "TG0D",
        fans: [{ index: 0, min: 1200, max: 2700 }],
    });

    if (mode === "ready-then-crash") {
        process.exit(1);
    }

    for (let i = 0; i < 3; i++) {
        await sleep(40);
        emit({
            event: "reading",
            ts: 1700000000 + i,
            cpu: { TC0c: 50 + i },
            cpuAvg: 50 + i,
            cpuPackage: 48 + i,
            gpu: 45 + i,
            fans: [{ i: 0, rpm: 1200 + i * 10 }],
        });
    }

    // Then idle forever (until supervisor stops us).
    await new Promise(() => {});
})();
