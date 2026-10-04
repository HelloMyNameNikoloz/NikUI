// swift-tools-version: 6.0
//
// The laptop half of talking to the phone: one recording in, its words out.
// Built on this Mac by src/voice.js, the first time somebody asks for it, and
// run only for as long as one recording takes.
import PackageDescription

let package = Package(
    name: "nikui-voice",
    platforms: [.macOS(.v14)],
    dependencies: [
        // The library VoiceInk itself transcribes with, pinned so the model
        // files it reads are the ones VoiceInk downloaded.
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.5")
    ],
    targets: [
        .executableTarget(
            name: "nikui-voice",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/nikui-voice",
            linkerSettings: [.linkedLibrary("sqlite3")]
        )
    ]
)
