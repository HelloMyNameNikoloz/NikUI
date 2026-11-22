// swift-tools-version:6.0
import PackageDescription
let package = Package(
    name: "NikMenuBar", platforms: [.macOS(.v14)],
    products: [.executable(name: "NikEngine", targets: ["NikEngine"]), .library(name: "NikMenuCore", targets: ["NikMenuCore"]),
               .library(name: "NikMacIdentity", targets: ["NikMacIdentity"]),
               .library(name: "NikMacCore", targets: ["NikMacCore"])],
    dependencies: [.package(path: "../../iphone/NikCore")],
    targets: [
        .target(name: "NikMacIdentity"),
        .target(name: "NikMenuCore", dependencies: ["NikCore", "NikMacIdentity"]),
        .target(name: "NikMacCore", dependencies: ["NikCore", "NikMenuCore", "NikMacIdentity"]),
        .executableTarget(name: "NikEngine", dependencies: ["NikMenuCore", "NikMacIdentity", "NikMacCore"]),
        .testTarget(name: "NikMenuCoreTests", dependencies: ["NikMenuCore"]),
        .testTarget(name: "NikMacIdentityTests", dependencies: ["NikMacIdentity"]),
        .testTarget(name: "NikMacCoreTests", dependencies: ["NikMacCore"])
    ]
)
