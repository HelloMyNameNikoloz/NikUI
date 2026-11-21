// swift-tools-version:6.0
import PackageDescription
let package = Package(
    name: "NikMenuBar", platforms: [.macOS(.v14)],
    products: [.executable(name: "NikEngine", targets: ["NikEngine"]), .library(name: "NikMenuCore", targets: ["NikMenuCore"])],
    dependencies: [.package(path: "../../iphone/NikCore")],
    targets: [
        .target(name: "NikMenuCore", dependencies: ["NikCore"]),
        .executableTarget(name: "NikEngine", dependencies: ["NikMenuCore"]),
        .testTarget(name: "NikMenuCoreTests", dependencies: ["NikMenuCore"])
    ]
)
