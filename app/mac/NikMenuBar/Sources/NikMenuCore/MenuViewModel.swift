import Foundation
import Combine
import NikCore
import NikMacIdentity

public enum LoginRegistration: String, Sendable { case notRegistered, enabled, requiresApproval, notFound, unknown }
@MainActor public protocol EngineService: AnyObject {
    var loginStatus: LoginRegistration { get }
    var agentStatus: LoginRegistration { get }
    func setLogin(enabled: Bool) async throws
    func start() async throws
    func stop() async throws
}
public enum StatusGlyph: String, Sendable {
    case running, starting, stopped, attention
    public var symbol: String {
        switch self { case .running: "circle.fill"; case .starting: "circle.dotted"
        case .stopped: "circle"; case .attention: "exclamationmark.circle.fill" }
    }
}
public struct ReconnectBackoff: Sendable {
    public private(set) var failures = 0
    public init() {}
    public mutating func next() -> TimeInterval {
        let value = min(30, pow(2, Double(min(failures, 5)))); failures = min(failures + 1, 6); return value
    }
    public mutating func reset() { failures = 0 }
}
public struct MenuState: Sendable, Equatable {
    public private(set) var glyph: StatusGlyph = .starting
    public private(set) var connected = false
    public private(set) var label = "Connecting…"
    public private(set) var problem: String?
    public init() {}
    public mutating func received(_ value: MenuSnapshot, approval: Bool = false) {
        connected = true; problem = nil
        if approval { glyph = .attention; label = "Approval required"; problem = "SERVICE_REQUIRES_APPROVAL" }
        else if value.updateBlockers.contains("UNSAFE_OPERATION_PENDING") || value.updateBlockers.contains("AUTHORITY_UNAVAILABLE") {
            glyph = .attention; label = "Engine needs attention"; problem = value.updateBlockers.first
        } else {
            glyph = value.status.state == "running" ? .running : .starting
            label = value.status.state == "running" ? "Engine running" : "Engine \(value.status.state)"
        }
    }
    public mutating func lost(_ error: any Error, hadConnection: Bool) {
        connected = false
        let failure = error as? MenuFailure ?? .invalid
        if !hadConnection && failure == .unavailable { glyph = .stopped; label = "Engine stopped"; problem = nil }
        else { glyph = .attention; label = "Engine unavailable"; problem = failure.code }
    }
    public mutating func beginning(start: Bool) {
        glyph = .starting; label = start ? "Starting engine…" : "Stopping engine…"; problem = nil
    }
    public mutating func intentionallyStopped() { glyph = .stopped; label = "Engine stopped"; connected = false; problem = nil }
    public mutating func failed(_ error: any Error) {
        glyph = .attention; problem = (error as? MenuFailure)?.code ?? "SERVICE_OPERATION_FAILED"; label = "Engine needs attention"
    }
}
public struct SettingsDraft: Equatable, Sendable {
    public var claude = "", codex = "", node = "", gh = "", codexHome = "", port = "0", bind = "127.0.0.1"
    public var revision = 0
    public init() {}
    public init(_ value: EngineSettings) {
        claude = value.tools.claude ?? ""; codex = value.tools.codex ?? ""; node = value.tools.node ?? ""; gh = value.tools.gh ?? ""
        codexHome = value.codexHome; port = String(value.port); bind = value.bind; revision = value.revision
    }
    public func settings(privateHome: String) throws -> EngineSettings {
        guard !port.isEmpty, port.allSatisfy(\.isNumber), let number = Int(port) else { throw MenuFailure.refused("PORT_INVALID") }
        func optional(_ value: String) -> String? { value.isEmpty ? nil : value }
        let result = EngineSettings(revision: revision, tools: .init(claude: optional(claude), codex: optional(codex), node: optional(node), gh: optional(gh)),
                                    codexHome: codexHome, port: number, bind: bind)
        try result.validate(privateHome: privateHome); return result
    }
}

@MainActor public final class MenuViewModel: ObservableObject {
    @Published public private(set) var state = MenuState()
    @Published public private(set) var snapshot: MenuSnapshot?
    @Published public private(set) var login: LoginRegistration = .unknown
    @Published public private(set) var agent: LoginRegistration = .unknown
    @Published public private(set) var working = false
    @Published public var draft = SettingsDraft()
    @Published public private(set) var settingsLoaded = false
    @Published public private(set) var settingsMessage: String?
    @Published public private(set) var settingsUnknown = false
    @Published public private(set) var requiresRestart = false
    public let root: String
    private let client: any MenuClient
    private let service: any EngineService
    private let privateHome: String
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private var monitor: Task<Void, Never>?
    private var intentionalStop = false
    public var onSnapshot: ((MenuSnapshot) -> Void)?
    public init(root: String, client: any MenuClient, service: any EngineService,
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }, privateHome: String? = nil) {
        self.root = root; self.client = client; self.service = service; self.sleep = sleep
        self.privateHome = privateHome ?? root + "/home"
    }
    public var canStart: Bool { !working && !state.connected && state.glyph != .starting }
    public var canStop: Bool { !working && state.connected }
    public var rows: [FleetRow] { state.connected ? snapshot?.runningRows ?? [] : [] }
    public func showUnregistered() { state.intentionallyStopped(); refreshRegistration() }
    public func refreshRegistration() { login = service.loginStatus; agent = service.agentStatus }
    public func startMonitoring() {
        guard monitor == nil else { return }; refreshRegistration()
        monitor = Task { [weak self] in
            var backoff = ReconnectBackoff(), hadConnection = false
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let stream = try await self.client.observe()
                    for try await value in stream {
                        guard !Task.isCancelled else { return }
                        self.accept(value); hadConnection = true; backoff.reset()
                    }
                    throw MenuFailure.unavailable
                } catch {
                    guard !Task.isCancelled else { return }
                    if self.intentionalStop { self.state.intentionallyStopped() }
                    else { self.state.lost(error, hadConnection: hadConnection) }
                    self.refreshRegistration()
                    if self.agent == .requiresApproval { self.state.failed(MenuFailure.refused("SERVICE_REQUIRES_APPROVAL")) }
                    do { try await self.sleep(backoff.next()) } catch { return }
                }
            }
        }
    }
    // Closing the client only closes its sockets. It has no engine side effect.
    public func stopMonitoring() { monitor?.cancel(); monitor = nil }
    public func accept(_ value: MenuSnapshot) {
        snapshot = value; requiresRestart = value.requiresRestart; intentionalStop = false
        refreshRegistration(); state.received(value, approval: agent == .requiresApproval || login == .requiresApproval); onSnapshot?(value)
    }
    public func startEngine() async {
        guard !working else { return }; working = true; intentionalStop = false; state.beginning(start: true)
        defer { working = false; refreshRegistration() }
        do {
            try await service.start()
            // Reconnect immediately after an explicit Start, independent of a
            // previous stopped-state retry delay. Start never uses kickstart -k.
            stopMonitoring(); startMonitoring()
        } catch { state.failed(error) }
    }
    public func stopEngine() async {
        guard !working else { return }; working = true; state.beginning(start: false)
        defer { working = false; refreshRegistration() }
        do { try await service.stop(); intentionalStop = true; state.intentionallyStopped() }
        catch { state.failed(error) }
    }
    public func setLogin(_ enabled: Bool) async {
        guard !working else { return }; working = true
        defer { working = false; refreshRegistration() }
        do { try await service.setLogin(enabled: enabled) } catch { state.failed(error) }
    }
    public func refreshTools() async {
        guard !working else { return }; working = true; defer { working = false }
        do { accept(try await client.refreshTools()) } catch { state.failed(error) }
    }
    public func loadSettings() async {
        guard !working else { return }; working = true; defer { working = false }
        do {
            let result = try await client.settings(); draft = SettingsDraft(result.settings); settingsLoaded = true
            requiresRestart = result.requiresRestart; settingsMessage = nil; settingsUnknown = false
        } catch { settingsMessage = (error as? MenuFailure)?.code ?? "CONTROL_FAILED" }
    }
    public func saveSettings() async {
        guard settingsLoaded, !working, !settingsUnknown else { return }; working = true; defer { working = false }
        do {
            let settings = try draft.settings(privateHome: privateHome)
            let result = try await client.saveSettings(settings)
            draft = SettingsDraft(result.settings); requiresRestart = result.requiresRestart
            settingsMessage = result.requiresRestart ? "Saved. Stop and start the engine to apply." : "Settings saved."
        } catch {
            let failure = error as? MenuFailure ?? .invalid; settingsUnknown = failure == .unknown
            settingsMessage = settingsUnknown ? "Save outcome unknown. Reload settings before making another change." : failure.code
        }
    }
    public var diagnostics: String {
        // Explicit allowlist: no browser key, enrollment, account identifiers,
        // instance titles, project paths, prompt bytes, environment or errors.
        var lines = [BuildFlavour.current.appName, "State: \(state.label)", "Login: \(login.rawValue)", "Agent: \(agent.rawValue)"]
        guard let snapshot else { return lines.joined(separator: "\n") }
        let s = snapshot.status
        lines += ["Version: \(s.engine.version)", "Generation: \(s.generation)", "Listener: \(s.listener.host):\(s.listener.port)",
                  "Editors: \(s.bridge.editors)", "Pending editor requests: \(s.bridge.pendingEditorRequests)",
                  "Running Claude: \(rows.filter { $0.provider == .claude }.count)", "Running Codex: \(rows.filter { $0.provider == .codex }.count)",
                  "Codex account: <private-test-home>", "Import: \(MenuFailure.safeCode(snapshot.importBlocker))"]
        for name in ["claude", "codex", "node", "gh"] {
            if let tool = s.tools[name] { lines.append("\(name): \(redact(tool.path ?? "missing")) (\(tool.source))") }
        }
        lines += s.blockers.map { "Blocker: " + MenuFailure.safeCode($0.code) }
        lines += snapshot.updateBlockers.map { "Update: " + MenuFailure.safeCode($0) }
        if let problem = state.problem { lines.append("Problem: " + MenuFailure.safeCode(problem)) }
        return lines.joined(separator: "\n")
    }
    private func redact(_ path: String) -> String {
        var result = path.replacingOccurrences(of: root, with: "<test-profile>")
        result = result.replacingOccurrences(of: #"/(Users|home)/[^/\s]+"#, with: "<user-home>", options: .regularExpression)
        result = result.replacingOccurrences(of: #"/private/tmp/nik-mac/build/[^\s]+/Contents/"#, with: "<bundle>/Contents/", options: .regularExpression)
        return result
    }
}
