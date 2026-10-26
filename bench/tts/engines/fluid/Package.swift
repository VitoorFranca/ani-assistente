// swift-tools-version: 6.2
// Benchmark helper: text-to-speech engines through FluidAudio (Apache-2.0) and
// the macOS voices, pinned to the same FluidAudio commit as native/voz.
import PackageDescription

let package = Package(
    name: "tts-bench",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "82eb4c1e0ab67e1c7d8de5092aa42a8f74cbd7b8")
    ],
    targets: [
        .executableTarget(
            name: "tts",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/tts")
    ]
)
