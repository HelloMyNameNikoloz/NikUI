import Foundation

final class ServicePackageFixture {
    let directory: String
    let program: String
    let node: String
    init() throws {
        directory = "/private/tmp/nik-service-path-" + UUID().uuidString
        let contents = directory + "/NikUI Dev.app/Contents"
        program = contents + "/MacOS/nikd"; node = contents + "/Resources/engine/node"
        for file in [program, node] {
            try FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: file, contents: Data())
        }
    }
    deinit { try? FileManager.default.removeItem(atPath: directory) }
}
