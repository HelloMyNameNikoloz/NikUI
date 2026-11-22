import Foundation
import NikMenuCore
import NikMacIdentity

public enum EngineControl {
    public static func status(root: String, allowReturning: Bool = false, onReadError: ((ControlReadEvidence) -> Void)? = nil) throws -> [String: Any] {
        // A just-published endpoint may close while its startup generation is
        // being replaced. Retry only transient reads; preserve unsafe/invalid
        // diagnostics and never infer an absent service from a parse failure.
        for attempt in 0..<3 {
            var failure: ControlReadEvidence?
            do {
                let data = try UnixControlTransport(root: root).requestSynchronous(Data(#"{"op":"status"}"#.utf8), onFailure: { failure = $0 })
                guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      value["ok"] as? Bool == true, value["root"] as? String == root,
                      (value["state"] as? String == "running" || allowReturning && value["state"] as? String == "returning"),
                      let pid = value["pid"] as? Int, pid > 0,
                      let generation = value["generation"] as? String, !generation.isEmpty else { throw MenuFailure.invalid }
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
