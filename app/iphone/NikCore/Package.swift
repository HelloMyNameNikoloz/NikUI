// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "NikCore",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [.library(name: "NikCore", targets: ["NikCore"])],
    targets: [
        .target(name: "NikCore"),
        .testTarget(name: "NikCoreTests", dependencies: ["NikCore"], resources: [.copy("Fixtures")]),
    ]
)
