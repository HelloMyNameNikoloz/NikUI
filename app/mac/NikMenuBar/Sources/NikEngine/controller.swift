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
func waitRunning(_ root: String, previous: String? = nil, validate: ([String: Any]) throws -> Void) throws -> [String: Any] {
    let started = Date()
    let deadline = Date().addingTimeInterval(25)
    repeat {
        do {
            let state = try controlStatus(root)
            if previous == nil || state["generation"] as? String != previous { try validate(state); return state }
        } catch let error as MenuFailure where error.code == "SERVICE_BUNDLE_MISMATCH" { throw Refusal(error.code) }
        catch let error as Refusal { throw error }
        catch { /* The exact package may still be publishing its endpoint. */ }
        if let code = EngineControl.startupFailure(root: root, since: started) { throw Refusal(code) }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < deadline
    throw Refusal("ENGINE_START_TIMEOUT")
}
func runController() -> Never {
do {
    let selection = try AppSelection.selected()
    let actualExecutable = URL(fileURLWithPath: try ExecutablePackage.runningExecutable())
    let actualContents = try ExecutablePackage.contents(executable: actualExecutable.path)
    try BuildFlavour.current.validateRegistration(label: label)
    let root = selection.root
    guard ControllerArguments.valid(Array(CommandLine.arguments.dropFirst())) else { throw Refusal("CONTROLLER_ARGUMENT_INVALID") }
    let service = SMAppService.agent(plistName: label + ".plist")
    let target = "gui/\(getuid())/\(label)"
    let program = try ExecutablePackage.canonicalPath(actualContents.appendingPathComponent("MacOS/nikd").path)
    let registrationProof = root + "/service-registration-proof.json"
    func prepareDevelopmentRegistration() throws -> Bool {
        let state = LoginRegistration(rawValue: statusName(service.status)) ?? .unknown
        guard state != .requiresApproval else { throw Refusal("SERVICE_REQUIRES_APPROVAL") }
        let action = try ServiceRegistration.action(status: state, job: ServiceOwner.loadedJob(label: label))
        if action == .replaceStale { try service.unregister() }
        if action != .reuse { try service.register() }
        return action != .reuse
    }
    func rememberRegistration(_ job: String) throws {
        guard let identity = ServiceOwner.registrationIdentity(job: job) else { throw Refusal("SERVICE_BUNDLE_MISMATCH") }
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "executable": program, "identity": identity])
        let temporary = root + "/service-registration-" + UUID().uuidString
        defer { _ = unlink(temporary) }
        try PrivateFiles.directory(root)
        if FileManager.default.fileExists(atPath: registrationProof) { try PrivateFiles.entry(registrationProof, kind: S_IFREG, mode: 0o600) }
        try PrivateFiles.create(temporary, data: data)
        guard rename(temporary, registrationProof) == 0 else { throw Refusal("SERVICE_BUNDLE_MISMATCH") }
    }
    @discardableResult func validatePackageRegistration(allowStopped: Bool = false, control: [String: Any]? = nil, removal: Bool = false) throws -> String {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            let snapshot = try ServiceOwner.loadedJob(label: label)
            if removal && ServiceOwner.matchesRemoval(job: snapshot, executable: program,
                registered: service.status == .enabled || service.status == .requiresApproval) { return snapshot ?? "" }
            if let job = snapshot {
                if removal {
                    if ServiceOwner.matchesRemoval(job: job, executable: program,
                        registered: service.status == .enabled || service.status == .requiresApproval) { return job }
                    Thread.sleep(forTimeInterval: 0.1); continue
                }
                if let control {
                    guard let pid = control["pid"] as? Int, let peer = control["controlPeerPID"] as? Int,
                          ServiceOwner.matchesControl(job: job, executable: program, controlPID: pid, peerPID: peer) else {
                        Thread.sleep(forTimeInterval: 0.1); continue
                    }
                    try rememberRegistration(job); return job
                }
                if ServiceOwner.matchesPackage(job: job, executable: program) { try rememberRegistration(job); return job }
                if allowStopped && ServiceOwner.matchesPackage(job: job, executable: program, enabled: service.status == .enabled, allowStopped: true) {
                    return job // Permission to attempt Start, never running-package proof.
                }
            }
            Thread.sleep(forTimeInterval: 0.1)
        } while Date() < deadline
        throw Refusal("SERVICE_BUNDLE_MISMATCH")
    }
    let command = CommandLine.arguments[1]
    if selection.flavour == .production && ["start", "intentional-stop", "crash-relaunch"].contains(command) {
        guard command != "crash-relaunch" else { throw Refusal("DEVELOPMENT_PROFILE_ONLY") }
        guard actualContents.deletingLastPathComponent().path == "/Applications/NikUI.app" else { throw Refusal("INSTALL_IN_APPLICATIONS_REQUIRED") }
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
        let executable = try ExecutablePackage.canonicalPath(actualExecutable.path)
        let requestedPIDs = Set(CommandLine.arguments.dropFirst(2).compactMap(Int32.init))
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: selection.flavour.appID).filter {
            $0.processIdentifier != getpid() && $0.executableURL.flatMap { try? ExecutablePackage.canonicalPath($0.path) } == executable
                && (requestedPIDs.isEmpty || requestedPIDs.contains($0.processIdentifier))
        }
        if command == "quit-app" {
            guard apps.allSatisfy({ $0.terminate() }) else { throw Refusal("APP_QUIT_FAILED") }
        }
        output(["ok": true, "label": label, "pids": apps.map { Int($0.processIdentifier) }])
    case "register":
        guard selection.flavour == .development else { throw Refusal("USER_CUTOVER_REQUIRED") }
        let created = try prepareDevelopmentRegistration()
        guard service.status == .enabled else { throw Refusal(service.status == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_UNAVAILABLE") }
        let registered = try validatePackageRegistration(allowStopped: true)
        if created { try rememberRegistration(registered) }
        output(["ok": true, "registration": statusName(service.status), "label": label])
    case "validate-registration":
        let registered = try validatePackageRegistration(allowStopped: true)
        output(["ok": true, "label": label, "registrationIdentity": ServiceOwner.registrationIdentity(job: registered) as Any? ?? NSNull()])
    case "validate-removal":
        try validatePackageRegistration(allowStopped: true, removal: true)
        output(["ok": true, "label": label])
    case "status":
        var state: [String: Any]?, issue: String?
        var firstReadError: ControlReadEvidence?
        do { state = try EngineControl.status(root: root, allowReturning: true, onReadError: { if firstReadError == nil { firstReadError = $0 } }) }
        catch { issue = (error as? MenuFailure)?.code ?? "CONTROL_UNAVAILABLE" }
        output(["ok": true, "registration": statusName(service.status), "label": label,
                "engine": state == nil ? "stopped-or-unavailable" : "running", "control": state as Any? ?? NSNull(),
                "controlError": issue as Any? ?? NSNull(), "firstControlReadError": firstReadError?.fields as Any? ?? NSNull()])
    case "start":
        // Production recovery is confined to SystemEngineService's clicked
        // Move/Start path. Its controller never repairs in the background.
        if selection.flavour == .development { _ = try prepareDevelopmentRegistration() }
        guard service.status == .enabled else { throw Refusal(service.status == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_NOT_REGISTERED") }
        try validatePackageRegistration(allowStopped: true)
        _ = try launchctl(["kickstart", target]) // no -k: never kill a running engine
        output(["ok": true, "registration": statusName(service.status),
                "control": try waitRunning(root, validate: { try validatePackageRegistration(control: $0) })])
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
                let job = try ServiceOwner.loadedJob(label: label)
                absentSamples = job?.range(of: "(?m)^\\s*pid = [0-9]+$", options: .regularExpression) == nil ? absentSamples + 1 : 0
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
        try validatePackageRegistration(control: try controlStatus(root, allowReturning: command == "intentional-stop"))
        _ = try launchctl(["kill", command == "intentional-stop" ? "SIGTERM" : "SIGKILL", target])
        if command == "crash-relaunch" {
            output(["ok": true, "previousGeneration": owner.generation,
                    "control": try waitRunning(root, previous: owner.generation, validate: { try validatePackageRegistration(control: $0) })])
        }
        let deadline = Date().addingTimeInterval(10)
        while kill(pid_t(pid), 0) == 0 && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        guard kill(pid_t(pid), 0) != 0 else { throw Refusal("ENGINE_STOP_TIMEOUT") }
        output(["ok": true, "registration": statusName(service.status), "engine": "stopped", "intentional": true])
    case "unregister":
        guard selection.flavour == .development else { throw Refusal("USER_ROLLBACK_REQUIRED") }
        if service.status != .notRegistered && service.status != .notFound {
            try validatePackageRegistration(allowStopped: true, removal: true)
            try service.unregister()
        }
        guard service.status == .notRegistered || service.status == .notFound,
              try ServiceOwner.loadedJob(label: label) == nil else { throw Refusal("SERVICE_UNREGISTER_FAILED") }
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
