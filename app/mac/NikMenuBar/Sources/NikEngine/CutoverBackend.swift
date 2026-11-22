import Foundation
import NikCore
import NikMacCore
import NikMacIdentity

struct BundledCutoverBackend: CutoverBackend {
    let selection: AppSelection
    func cancel() async { BoundedProcess.cancelAll() }
    func command(_ action: String, arguments: JSONValue) async throws -> JSONValue {
        let directory = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/engine")
        let home = selection.home
        var fields = arguments.objectValue; fields["action"] = .string(action)
        let input = try JSONEncoder().encode(JSONValue.object(fields))
        let data = try await BoundedProcess().run(executable: directory.appendingPathComponent("node"),
            arguments: [directory.appendingPathComponent("src/macCutover.js").path],
            environment: ["HOME": home, "USERPROFILE": home, "ZDOTDIR": home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                "NIKUI_CUTOVER_PARENT_PID": String(ProcessInfo.processInfo.processIdentifier)], input: input, timeout: 35, progress: true)
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { throw IdentityFailure("CUTOVER_UNAVAILABLE") }
        return value
    }
}
