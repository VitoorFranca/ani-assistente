// swift-tools-version: 6.2
// voz: the assistant's ears and voice, as one helper process.
// Speech recognition (Parakeet through FluidAudio, Apache-2.0, pinned) with
// Silero VAD for the end of speech; speech synthesis with the macOS voices or
// a neural voice (Supertonic 3, PocketTTS) downloaded on first use.
import PackageDescription

let package = Package(
    name: "voz",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "82eb4c1e0ab67e1c7d8de5092aa42a8f74cbd7b8")
    ],
    targets: [
        .executableTarget(
            name: "voz",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/voz")
    ]
)
