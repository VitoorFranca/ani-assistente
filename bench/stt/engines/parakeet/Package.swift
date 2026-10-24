// swift-tools-version: 6.2
// Benchmark helper: Parakeet TDT (v3 or Ultra) through FluidAudio (Apache-2.0),
// pinned to the same commit as Spokemark.
import PackageDescription

let package = Package(
    name: "parakeet-bench",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", revision: "82eb4c1e0ab67e1c7d8de5092aa42a8f74cbd7b8")
    ],
    targets: [
        .executableTarget(
            name: "parakeet",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/parakeet")
    ]
)
