// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "smcreader",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "smcreader",
            path: "Sources/smcreader"
        ),
        .testTarget(
            name: "smcreaderTests",
            dependencies: ["smcreader"],
            path: "Tests/smcreaderTests"
        ),
    ]
)
