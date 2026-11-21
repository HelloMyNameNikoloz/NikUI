import Foundation
import ServiceManagement
import AppKit
import Darwin

let label = "com.nikui.engine.dev"
struct Refusal: Error { let code: String; init(_ code: String) { self.code = code } }
func output(_ value: [String: Any], _ code: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
    exit(code)
}
func statusName(_ status: SMAppService.Status) -> String {
    switch status {
    case .notRegistered: return "notRegistered"
    case .enabled: return "enabled"
    case .requiresApproval: return "requiresApproval"
    case .notFound: return "notFound"
    @unknown default: return "unknown"
    }
}
func launchctl(_ args: [String]) throws -> String {
    let process = Process(), stdout = Pipe(), stderr = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = args
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
    process.standardOutput = stdout; process.standardError = stderr
    try process.run()
    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    _ = stderr.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw Refusal("LAUNCHD_OPERATION_FAILED") }
    return String(data: data, encoding: .utf8) ?? ""
}
func privateEntry(_ path: String, directory: Bool) throws {
    var entry = stat()
    guard lstat(path, &entry) == 0, entry.st_uid == getuid(),
          entry.st_mode & 0o777 == (directory ? 0o700 : 0o600),
          entry.st_mode & S_IFMT == (directory ? S_IFDIR : S_IFSOCK) else { throw Refusal("CONTROL_UNSAFE") }
}
func controlStatus(_ root: String) throws -> [String: Any] {
    try privateEntry(root, directory: true)
    let path = root + "/c.sock"
    try privateEntry(path, directory: false)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Refusal("CONTROL_UNAVAILABLE") }
    defer { close(fd) }
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSignal: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [UInt8(0)]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw Refusal("CONTROL_UNSAFE") }
    withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else { throw Refusal("CONTROL_UNAVAILABLE") }
    var peer = uid_t(0), group = gid_t(0)
    guard getpeereid(fd, &peer, &group) == 0, peer == getuid() else { throw Refusal("CONTROL_UNSAFE") }
    let request = Array("{\"op\":\"status\"}\n".utf8)
    guard request.withUnsafeBytes({ write(fd, $0.baseAddress, $0.count) }) == request.count else { throw Refusal("CONTROL_UNAVAILABLE") }
    var result = Data(), buffer = [UInt8](repeating: 0, count: 8192)
    while true {
        let count = read(fd, &buffer, buffer.count)
        if count == 0 { break }
        guard count > 0, result.count + count <= 262144 else { throw Refusal("CONTROL_UNAVAILABLE") }
        result.append(contentsOf: buffer.prefix(count))
    }
    guard let value = try JSONSerialization.jsonObject(with: result) as? [String: Any],
          value["ok"] as? Bool == true, value["root"] as? String == root,
          value["state"] as? String == "running", value["pid"] as? Int != nil,
          value["generation"] as? String != nil else { throw Refusal("CONTROL_INVALID") }
    return value
}
func waitRunning(_ root: String, previous: String? = nil) throws -> [String: Any] {
    let deadline = Date().addingTimeInterval(25)
    repeat {
        if let state = try? controlStatus(root), previous == nil || state["generation"] as? String != previous { return state }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < deadline
    throw Refusal("ENGINE_START_TIMEOUT")
}
func runController() -> Never {
do {
    guard Bundle.main.bundleIdentifier == label,
          let home = Bundle.main.object(forInfoDictionaryKey: "NikEngineTestHome") as? String,
          let root = Bundle.main.object(forInfoDictionaryKey: "NikEngineTestRoot") as? String,
          home.hasPrefix("/private/tmp/nik-mac/build/"), root.hasPrefix(home + "/"),
          CommandLine.arguments.count == 2 else { throw Refusal("CONTROLLER_ARGUMENT_INVALID") }
    let service = SMAppService.agent(plistName: label + ".plist")
    let target = "gui/\(getuid())/\(label)"
    let command = CommandLine.arguments[1]
    switch command {
    case "app-status", "quit-app":
        let executable = Bundle.main.executableURL?.resolvingSymlinksInPath()
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: label).filter {
            $0.processIdentifier != getpid() && $0.executableURL?.resolvingSymlinksInPath() == executable
        }
        if command == "quit-app" {
            guard apps.allSatisfy({ $0.terminate() }) else { throw Refusal("APP_QUIT_FAILED") }
        }
        output(["ok": true, "label": label, "pids": apps.map { Int($0.processIdentifier) }])
    case "register":
        if service.status == .notRegistered || service.status == .notFound { try service.register() }
        guard service.status == .enabled else { throw Refusal(service.status == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_UNAVAILABLE") }
        output(["ok": true, "registration": statusName(service.status), "label": label])
    case "status":
        let state = try? controlStatus(root)
        output(["ok": true, "registration": statusName(service.status), "label": label,
                "engine": state == nil ? "stopped-or-unavailable" : "running", "control": state as Any? ?? NSNull()])
    case "start":
        guard service.status == .enabled else { throw Refusal(service.status == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_NOT_REGISTERED") }
        _ = try launchctl(["kickstart", target]) // no -k: never kill a running engine
        output(["ok": true, "registration": statusName(service.status), "control": try waitRunning(root)])
    case "intentional-stop", "crash-relaunch":
        guard service.status == .enabled else { throw Refusal("SERVICE_NOT_REGISTERED") }
        let before = try controlStatus(root)
        // Check the job and socket identify the same process before signalling.
        let job = try launchctl(["print", target])
        guard let pid = before["pid"] as? Int, job.range(of: "(?m)^\\s*pid = \(pid)$", options: .regularExpression) != nil else { throw Refusal("SERVICE_OWNER_MISMATCH") }
        _ = try launchctl(["kill", command == "intentional-stop" ? "SIGTERM" : "SIGKILL", target])
        if command == "crash-relaunch" {
            output(["ok": true, "previousGeneration": before["generation"]!, "control": try waitRunning(root, previous: before["generation"] as? String)])
        }
        let deadline = Date().addingTimeInterval(10)
        while kill(pid_t(pid), 0) == 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        guard kill(pid_t(pid), 0) != 0 else { throw Refusal("ENGINE_STOP_TIMEOUT") }
        output(["ok": true, "registration": statusName(service.status), "engine": "stopped", "intentional": true])
    case "unregister":
        if service.status != .notRegistered { try service.unregister() }
        guard service.status == .notRegistered else { throw Refusal("SERVICE_UNREGISTER_FAILED") }
        output(["ok": true, "registration": statusName(service.status), "label": label])
    default: throw Refusal("CONTROLLER_ARGUMENT_INVALID")
    }
} catch let error as Refusal { output(["ok": false, "code": error.code, "label": label], 1) }
catch {
    let error = error as NSError
    output(["ok": false, "code": "SERVICE_OPERATION_FAILED", "domain": error.domain, "status": error.code, "label": label], 1)
}

}
