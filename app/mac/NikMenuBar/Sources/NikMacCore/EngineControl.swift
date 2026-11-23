import Foundation
import NikMenuCore
import NikMacIdentity

public enum EngineControl {
    /// Execute the real native launcher and sealed Node before source commit.
    /// Production's service authority still requires committed ownership; this
    /// idle process opens no selected storage, socket, keeper or Keychain item.
    public static func preflight(contents: URL, home: String, appID: String, label: String) async throws {
        var diagnostics = ["launcher": contents.appendingPathComponent("MacOS/nikd").path,
                           "home": home, "path": "/usr/bin:/bin", "timeoutSeconds": "15"]
        do {
            let result = try await BoundedProcess().runResult(executable: contents.appendingPathComponent("MacOS/nikd"),
                arguments: ["--preflight"], environment: ["HOME": home, "PATH": "/usr/bin:/bin"], timeout: 15)
            diagnostics["exitStatus"] = String(result.status)
            diagnostics["output"] = String(decoding: result.data.prefix(16384), as: UTF8.self)
            let expected = try ExecutablePackage.canonicalPath(contents.appendingPathComponent("Resources/engine/node").path)
            diagnostics["expectedExecutable"] = expected
            guard result.status == 0, let value = try? JSONSerialization.jsonObject(with: result.data) as? [String: Any],
                  value["ok"] as? Bool == true, value["mode"] as? String == "idle-preflight",
                  value["appID"] as? String == appID, value["label"] as? String == label,
                  let pid = value["pid"] as? Int, pid > 0,
                  let executable = value["executable"] as? String,
                  try ExecutablePackage.canonicalPath(executable) == expected
            else { throw IdentityFailure("ENGINE_PREFLIGHT_FAILED") }
        } catch {
            if let failure = error as? IdentityFailure {
                diagnostics.merge(failure.diagnostics) { _, value in value }
                diagnostics["cause"] = failure.code
            } else { diagnostics["cause"] = (error as NSError).domain + ":" + String((error as NSError).code) }
            throw IdentityFailure("ENGINE_PREFLIGHT_FAILED", diagnostics: diagnostics)
        }
    }
    public static func status(root: String, allowReturning: Bool = false, onReadError: ((ControlReadEvidence) -> Void)? = nil) throws -> [String: Any] {
        // A just-published endpoint may close while its startup generation is
        // being replaced. Retry only transient reads; preserve unsafe/invalid
        // diagnostics and never infer an absent service from a parse failure.
        for attempt in 0..<3 {
            var failure: ControlReadEvidence?
            do {
                var peerPID = Int32(0)
                let data = try UnixControlTransport(root: root).requestSynchronous(Data(#"{"op":"status"}"#.utf8),
                    onPeerPID: { peerPID = $0 }, onFailure: { failure = $0 })
                guard var value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      value["ok"] as? Bool == true, value["root"] as? String == root,
                      (value["state"] as? String == "running" || allowReturning && value["state"] as? String == "returning"),
                      let pid = value["pid"] as? Int, pid > 0,
                      let generation = value["generation"] as? String, !generation.isEmpty else { throw MenuFailure.invalid }
                guard pid == Int(peerPID) else { throw MenuFailure.refused("SERVICE_BUNDLE_MISMATCH") }
                value["controlPeerPID"] = Int(peerPID)
                return value
            } catch let error as MenuFailure {
                onReadError?(failure ?? .init(code: error.code, operation: "decode", errno: nil))
                guard attempt < 2, error == .unavailable || error == .timeout else { throw error }
                Thread.sleep(forTimeInterval: 0.1)
            } catch {
                onReadError?(.init(code: MenuFailure.invalid.code, operation: "decode", errno: nil))
                throw MenuFailure.invalid
            }
        }
        throw MenuFailure.unavailable
    }
    public static func startupFailure(root: String, since: Date) -> String? {
        guard let bytes = try? PrivateFiles.read(root + "/engine-startup-failure.json"),
              let value = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              value["version"] as? Int == 1, value["root"] as? String == root,
              let at = value["at"] as? Double, at >= since.timeIntervalSince1970 * 1000 - 2000,
              let code = value["code"] as? String, MenuFailure.safeCode(code) == code else { return nil }
        if let transition = value["transition"] as? String {
            guard let bytes = try? PrivateFiles.read(root + "/production-owner.json"),
                  let owner = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  owner["transition"] as? String == transition else { return nil }
        }
        return code
    }
}
