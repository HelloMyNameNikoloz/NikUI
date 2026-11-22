import Foundation
import ServiceManagement
import AppKit
import Darwin
import NikMacIdentity
import NikMenuCore
import NikMacCore

let label = BuildFlavour.current.engineLabel
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
    do {
        let data = try BoundedProcess().runSynchronous(executable: URL(fileURLWithPath: "/bin/launchctl"),
            arguments: args, environment: ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"], timeout: 10)
        return String(data: data, encoding: .utf8) ?? ""
    } catch { throw Refusal((error as? IdentityFailure)?.code == "CUTOVER_TIMEOUT" ? "LAUNCHD_OPERATION_TIMEOUT" : "LAUNCHD_OPERATION_FAILED") }
}
func controlStatus(_ root: String, allowReturning: Bool = false) throws -> [String: Any] {
    try EngineControl.status(root: root, allowReturning: allowReturning)
}
func waitRunning(_ root: String, previous: String? = nil) throws -> [String: Any] {
    let started = Date()
    let deadline = Date().addingTimeInterval(25)
    repeat {
        if let state = try? controlStatus(root), previous == nil || state["generation"] as? String != previous { return state }
        if let code = EngineControl.startupFailure(root: root, since: started) { throw Refusal(code) }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < deadline
    throw Refusal("ENGINE_START_TIMEOUT")
}
func runController() -> Never {
do {
    let selection = try AppSelection.selected()
    try BuildFlavour.current.validateRegistration(label: label)
    let root = selection.root
    guard CommandLine.arguments.count == 2 else { throw Refusal("CONTROLLER_ARGUMENT_INVALID") }
    let service = SMAppService.agent(plistName: label + ".plist")
    let target = "gui/\(getuid())/\(label)"
    let command = CommandLine.arguments[1]
    if selection.flavour == .production && ["start", "intentional-stop", "crash-relaunch"].contains(command) {
        guard command != "crash-relaunch" else { throw Refusal("DEVELOPMENT_PROFILE_ONLY") }
        guard Bundle.main.bundleURL.path == "/Applications/NikUI.app" else { throw Refusal("INSTALL_IN_APPLICATIONS_REQUIRED") }
    }
    switch command {
    case "delete-test-client-identity":
        try LocalDeviceKeychain.deleteTestSelection(selection)
        output(["ok": true, "localDeviceItemsAbsent": true])
    case "build-identity":
        // Read-only native acceptance probe. No socket, service registration,
        // Keychain or selected-root operation is performed.
        output(["ok": true, "flavour": selection.flavour.rawValue, "appID": selection.flavour.appID,
                "label": label, "root": root, "home": selection.home])
    case "app-status", "quit-app":
        let executable = Bundle.main.executableURL?.resolvingSymlinksInPath()
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: selection.flavour.appID).filter {
            $0.processIdentifier != getpid() && $0.executableURL?.resolvingSymlinksInPath() == executable
        }
        if command == "quit-app" {
            guard apps.allSatisfy({ $0.terminate() }) else { throw Refusal("APP_QUIT_FAILED") }
        }
        output(["ok": true, "label": label, "pids": apps.map { Int($0.processIdentifier) }])
    case "register":
        guard selection.flavour == .development else { throw Refusal("USER_CUTOVER_REQUIRED") }
        if service.status == .notRegistered || service.status == .notFound { try service.register() }
        guard service.status == .enabled else { throw Refusal(service.status == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_UNAVAILABLE") }
        output(["ok": true, "registration": statusName(service.status), "label": label])
    case "status":
        var state: [String: Any]?, issue: String?
        var firstReadError: ControlReadEvidence?
        do { state = try EngineControl.status(root: root, allowReturning: true, onReadError: { if firstReadError == nil { firstReadError = $0 } }) }
        catch { issue = (error as? MenuFailure)?.code ?? "CONTROL_UNAVAILABLE" }
        output(["ok": true, "registration": statusName(service.status), "label": label,
                "engine": state == nil ? "stopped-or-unavailable" : "running", "control": state as Any? ?? NSNull(),
                "controlError": issue as Any? ?? NSNull(), "firstControlReadError": firstReadError?.fields as Any? ?? NSNull()])
    case "start":
        guard service.status == .enabled else { throw Refusal(service.status == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_NOT_REGISTERED") }
        _ = try launchctl(["kickstart", target]) // no -k: never kill a running engine
        output(["ok": true, "registration": statusName(service.status), "control": try waitRunning(root)])
    case "intentional-stop", "crash-relaunch":
        guard service.status == .enabled else { throw Refusal("SERVICE_NOT_REGISTERED") }
        if command == "intentional-stop", (try? controlStatus(root, allowReturning: true)) == nil,
           let journal = try? JSONSerialization.jsonObject(with: PrivateFiles.read(root + "/cutover-request.json")) as? [String: Any],
           ["returned", "aborted"].contains(journal["stage"] as? String ?? ""),
           let owner = try? JSONSerialization.jsonObject(with: PrivateFiles.read(root + "/o/engine-owner.json")) as? [String: Any],
           owner["mode"] as? String == "window" {
            // A failed startup can hand back its verified inactive current
            // state without ever publishing c.sock. Prove the job has no PID
            // twice; no signal or ownership guess is needed in that case.
            var absentSamples = 0
            let deadline = Date().addingTimeInterval(10)
            repeat {
                let job = try launchctl(["print", target])
                absentSamples = job.range(of: "(?m)^\\s*pid = [0-9]+$", options: .regularExpression) == nil ? absentSamples + 1 : 0
                if absentSamples == 2 { output(["ok": true, "engine": "stopped", "intentional": true]) }
                Thread.sleep(forTimeInterval: 0.1)
            } while Date() < deadline
            throw Refusal("ENGINE_STOP_TIMEOUT")
        }
        let owner = try ServiceOwner.wait {
            guard let state = try? controlStatus(root, allowReturning: command == "intentional-stop"), let pid = state["pid"] as? Int,
                  let generation = state["generation"] as? String else { return nil }
            let owner = ServiceOwner(pid: pid, generation: generation)
            let job = try launchctl(["print", target])
            guard owner.matches(job: job), let checked = try? controlStatus(root, allowReturning: command == "intentional-stop"),
                  checked["pid"] as? Int == pid, checked["generation"] as? String == generation else { return nil }
            return owner
        }
        let pid = owner.pid
        _ = try launchctl(["kill", command == "intentional-stop" ? "SIGTERM" : "SIGKILL", target])
        if command == "crash-relaunch" {
            output(["ok": true, "previousGeneration": owner.generation, "control": try waitRunning(root, previous: owner.generation)])
        }
        let deadline = Date().addingTimeInterval(10)
        while kill(pid_t(pid), 0) == 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        guard kill(pid_t(pid), 0) != 0 else { throw Refusal("ENGINE_STOP_TIMEOUT") }
        output(["ok": true, "registration": statusName(service.status), "engine": "stopped", "intentional": true])
    case "unregister":
        guard selection.flavour == .development else { throw Refusal("USER_ROLLBACK_REQUIRED") }
        if service.status != .notRegistered { try service.unregister() }
        guard service.status == .notRegistered else { throw Refusal("SERVICE_UNREGISTER_FAILED") }
        output(["ok": true, "registration": statusName(service.status), "label": label])
    default: throw Refusal("CONTROLLER_ARGUMENT_INVALID")
    }
} catch let error as Refusal { output(["ok": false, "code": error.code, "label": label], 1) }
catch let error as IdentityFailure { output(["ok": false, "code": error.code, "label": label], 1) }
catch {
    let error = error as NSError
    output(["ok": false, "code": "SERVICE_OPERATION_FAILED", "domain": error.domain, "status": error.code, "label": label], 1)
}

}
