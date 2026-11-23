import Foundation
import Darwin
import NikMacIdentity

public struct ServiceOwner: Equatable {
    /// A failed/denied inventory is not an absent job. Only launchctl's exact
    /// no-service reply permits repair of this bundle's stale SMAppService.
    public static func jobSnapshot(output: String, status: Int32, label: String) throws -> String? {
        if status == 0 && !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return output }
        if status == 113 && output.contains("Could not find service \"\(label)\"") { return nil }
        throw IdentityFailure("LAUNCHD_OPERATION_FAILED")
    }
    public static func loadedJob(label: String) throws -> String? {
        let result = try BoundedProcess().runSynchronousResult(executable: URL(fileURLWithPath: "/bin/launchctl"),
            arguments: ["print", "gui/\(getuid())/\(label)"], environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"], timeout: 10)
        return try jobSnapshot(output: String(data: result.data, encoding: .utf8) ?? "", status: result.status, label: label)
    }
    private static func values(_ key: String, job: String) -> [String] {
        let entries: [(Int, String)] = job.split(separator: "\n").compactMap { line in
            let value = line.trimmingCharacters(in: .whitespaces), prefix = key + " = "
            guard value.hasPrefix(prefix) else { return nil }
            return (line.prefix(while: { $0.isWhitespace }).count, String(value.dropFirst(prefix.count)))
        }
        let indent = entries.map { $0.0 }.min()
        return entries.filter { key != "state" || $0.0 == indent }.map { $0.1 }
    }
    /// Darwin 27 SMAppService output has no absolute program/bundle path.
    /// Enabled without a PID permits a startup attempt only. It never proves
    /// that a running engine or a control endpoint belongs to this package.
    public static func matchesPackage(job: String, executable: String, appID: String = BuildFlavour.current.appID,
                                      enabled: Bool = false, allowStopped: Bool = false,
                                      processPath: (Int32) -> String? = executablePath) -> Bool {
        func values(_ key: String) -> [String] { Self.values(key, job: job) }
        guard values("parent bundle identifier") == [appID],
              values("program identifier") == ["Contents/MacOS/nikd (mode: 2)"] else { return false }
        let pids = values("pid")
        guard pids.count <= 1 else { return false }
        guard let pidText = pids.first else {
            return allowStopped && enabled && values("state") == ["not running"]
        }
        guard let pid = Int32(pidText), pid > 0, let actual = processPath(pid), actual.hasPrefix("/") else { return false }
        guard let expected = try? ExecutablePackage.canonicalPath(executable),
              let actual = try? ExecutablePackage.canonicalPath(actual) else { return false }
        // nikd execs the sealed Node in-place (launcher.swift). The same
        // launchd PID therefore changes executable during a normal startup.
        let node = URL(fileURLWithPath: expected).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/engine/node")
        return actual == expected || (try? ExecutablePackage.canonicalPath(node.path)) == actual
    }
    /// Only for unregister on the calling bundle's own SMAppService instance.
    /// Failed startup changes runs/coalitions and may leave no PID at all.
    /// Removing that registration needs no live engine/control endpoint.
    public static func matchesRemoval(job: String?, executable: String, registered: Bool,
                                      appID: String = BuildFlavour.current.appID,
                                      processPath: (Int32) -> String? = executablePath) -> Bool {
        guard registered else { return false }
        guard let job else { return true } // Own stale BTM record; unregister is bundle-bound.
        guard values("parent bundle identifier", job: job) == [appID],
              values("program identifier", job: job) == ["Contents/MacOS/nikd (mode: 2)"],
              values("pid", job: job).count <= 1 else { return false }
        if values("pid", job: job).isEmpty { return true }
        return matchesPackage(job: job, executable: executable, appID: appID, processPath: processPath)
    }
    public static func matchesControl(job: String, executable: String, controlPID: Int, peerPID: Int,
                                      appID: String = BuildFlavour.current.appID,
                                      processPath: (Int32) -> String? = executablePath) -> Bool {
        guard controlPID > 0, controlPID == peerPID,
              matchesPackage(job: job, executable: executable, appID: appID, processPath: processPath) else { return false }
        return ServiceOwner(pid: controlPID, generation: "").matches(job: job)
    }
    /// These fields survive Stop and distinguish a loaded registration from a
    /// different same-ID copy/re-registration. The token is saved only after
    /// executable proof (or our own successful new registration), never enabled
    /// status alone. A restart increments runs and requires fresh proof.
    public static func registrationIdentity(job: String) -> String? {
        func value(_ pattern: String) -> String? {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  regex.numberOfCaptureGroups == 1 else { return nil }
            let matches = regex.matches(in: job, range: NSRange(job.startIndex..., in: job))
            guard matches.count == 1, let range = Range(matches[0].range(at: 1), in: job) else { return nil }
            return String(job[range])
        }
        let fields = [value("(?m)^\\s*BTM uuid = ([A-Fa-f0-9-]+)$"),
                      value("(?m)^\\s*resource coalition = \\{\\n\\s*ID = ([0-9]+)$"),
                      value("(?m)^\\s*runs = ([0-9]+)$"),
                      value("(?m)^\\s*parent bundle identifier = (.+)$"),
                      value("(?m)^\\s*parent bundle version = (.+)$"),
                      value("(?m)^\\s*stdout path = (.+)$")]
        guard fields.allSatisfy({ $0 != nil }) else { return nil }
        return fields.compactMap { $0 }.joined(separator: "\n")
    }
    public static func matchesStoppedRegistration(job: String, executable: String, recordedExecutable: String,
                                                  recordedIdentity: String, enabled: Bool,
                                                  appID: String = BuildFlavour.current.appID) -> Bool {
        guard matchesPackage(job: job, executable: executable, appID: appID, enabled: enabled, allowStopped: true,
                             processPath: { _ in nil }), let identity = registrationIdentity(job: job) else { return false }
        guard let expected = try? ExecutablePackage.canonicalPath(executable),
              let recorded = try? ExecutablePackage.canonicalPath(recordedExecutable) else { return false }
        return expected == recorded && identity == recordedIdentity
    }
    public static func executablePath(pid: Int32) -> String? {
        var bytes = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0 else { return nil }
        return String(cString: bytes)
    }
    public let pid: Int
    public let generation: String
    public init(pid: Int, generation: String) { self.pid = pid; self.generation = generation }
    public func matches(job: String) -> Bool {
        pid > 0 && job.range(of: "(?m)^\\s*pid = \(pid)$", options: .regularExpression) != nil
    }
    /// A KeepAlive process may serve c.sock before launchd publishes its PID.
    /// Require two stable, independently checked samples before signalling.
    public static func wait(sample: () throws -> ServiceOwner?, pause: () -> Void = { Thread.sleep(forTimeInterval: 0.1) },
                            now: () -> Date = Date.init, timeout: TimeInterval = 25) throws -> ServiceOwner {
        let deadline = now().addingTimeInterval(timeout)
        var previous: ServiceOwner?
        repeat {
            let current = try sample()
            if let current, current == previous { return current }
            previous = current
            pause()
        } while now() < deadline
        throw IdentityFailure("SERVICE_OWNER_MISMATCH")
    }
}
