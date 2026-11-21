import Foundation
import NikCore

public enum MenuFailure: Error, Equatable, Sendable, LocalizedError {
    case unavailable, unsafe, invalid, timeout, refused(String), unknown
    public var code: String {
        switch self {
        case .unavailable: "CONTROL_UNAVAILABLE"
        case .unsafe: "CONTROL_UNSAFE"
        case .invalid: "CONTROL_INVALID"
        case .timeout: "CONTROL_TIMEOUT"
        case .refused(let code): Self.safeCode(code)
        case .unknown: "LOCAL_OUTCOME_UNKNOWN"
        }
    }
    public static func safeCode(_ code: String) -> String {
        code.range(of: "^[A-Z][A-Z0-9_]{0,79}$", options: .regularExpression) != nil ? code : "CONTROL_FAILED"
    }
    public var errorDescription: String? { code }
}
public struct ToolDiagnostic: Codable, Equatable, Sendable {
    public let status: String
    public let path: String?
    public let source: String
}
public struct EngineStatus: Codable, Equatable, Sendable {
    public struct Engine: Codable, Equatable, Sendable { public let id: String; public let boot: String; public let version: String }
    public struct Listener: Codable, Equatable, Sendable { public let host: String; public let port: Int }
    public struct Account: Codable, Equatable, Sendable { public let home: String; public let borrowed: Bool }
    public struct Bridge: Codable, Equatable, Sendable { public let connected: Int; public let editors: Int; public let pendingEditorRequests: Int }
    public struct Blocker: Codable, Equatable, Sendable { public let code: String; public let tool: String? }
    public let ok: Bool
    public let root: String
    public let generation: String
    public let pid: Int
    public let state: String
    public let engine: Engine
    public let listener: Listener
    public let account: Account
    public let bridge: Bridge
    public let tools: [String: ToolDiagnostic]
    public let blockers: [Blocker]
}
public struct EngineSettings: Codable, Equatable, Sendable {
    public struct Tools: Codable, Equatable, Sendable {
        public var claude: String?, codex: String?, node: String?, gh: String?
        public init(claude: String? = nil, codex: String? = nil, node: String? = nil, gh: String? = nil) {
            self.claude = claude; self.codex = codex; self.node = node; self.gh = gh
        }
        public func encode(to encoder: any Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(claude, forKey: .claude); try c.encode(codex, forKey: .codex)
            try c.encode(node, forKey: .node); try c.encode(gh, forKey: .gh)
        }
    }
    public var revision: Int
    public var tools: Tools
    public var codexHome: String
    public var port: Int
    public var bind: String
    public init(revision: Int = 0, tools: Tools = .init(), codexHome: String, port: Int = 0, bind: String = "127.0.0.1") {
        self.revision = revision; self.tools = tools; self.codexHome = codexHome; self.port = port; self.bind = bind
    }
    public func validate(privateHome: String) throws {
        guard revision >= 0, (0...65535).contains(port) else { throw MenuFailure.refused("CONFIG_INVALID") }
        guard bind == "127.0.0.1" else { throw MenuFailure.refused("BIND_LOOPBACK_REQUIRED") }
        guard codexHome.hasPrefix(privateHome + "/"), codexHome.utf8.count <= 4096,
              !codexHome.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              URL(fileURLWithPath: codexHome).standardized.path == codexHome else {
            throw MenuFailure.refused("CODEX_HOME_OUTSIDE_TEST_PROFILE")
        }
        for file in [tools.claude, tools.codex, tools.node, tools.gh].compactMap({ $0 }) {
            guard file.hasPrefix("/"), !file.contains(where: { $0.isNewline || $0.asciiValue == 0 }), file.utf8.count <= 4096 else {
                throw MenuFailure.refused("TOOL_PATH_INVALID")
            }
        }
    }
}
public struct SettingsResult: Codable, Equatable, Sendable { public let settings: EngineSettings; public let requiresRestart: Bool }
public struct MenuSnapshot: Codable, Equatable, Sendable {
    public let status: EngineStatus
    public let fleet: Fleet
    // This is an action capability. Never render or copy it in diagnostics.
    public let browserURL: String?
    public let settings: EngineSettings
    public let requiresRestart: Bool
    public let importBlocker: String
    public let updateBlockers: [String]
    public func validate(root: String) throws {
        guard status.ok, status.root == root, status.pid > 0, !status.generation.isEmpty,
              !status.engine.id.isEmpty, (0...65535).contains(status.listener.port), status.listener.host == "127.0.0.1" else {
            throw MenuFailure.invalid
        }
        try settings.validate(privateHome: root + "/home")
        if let browserURL, !Self.isLocalURL(browserURL, port: status.listener.port) { throw MenuFailure.unsafe }
    }
    public static func isLocalURL(_ value: String, port: Int) -> Bool {
        guard let url = URLComponents(string: value) else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port && url.user == nil && url.password == nil
    }
    public func openURL(instance: String? = nil) -> URL? {
        guard let browserURL, Self.isLocalURL(browserURL, port: status.listener.port),
              var parts = URLComponents(string: browserURL) else { return nil }
        if let instance {
            guard instance.range(of: "^[A-Za-z0-9_:-]{1,128}$", options: .regularExpression) != nil else { return nil }
            parts.path = "/s/" + instance
        }
        return parts.url
    }
    public var runningRows: [FleetRow] {
        fleet.rows.filter { $0.raw["running"].boolValue == true && $0.status != .stopped }
    }
}
public enum MenuCommand: Sendable {
    case snapshot, refreshTools, settings, saveSettings(EngineSettings)
    public var operation: String {
        switch self { case .snapshot: "menu.snapshot"; case .refreshTools: "tools.refresh"
        case .settings: "engine.settings.get"; case .saveSettings: "engine.settings.update" }
    }
    public var mutates: Bool { if case .saveSettings = self { true } else { false } }
    public func arguments() throws -> JSONValue {
        if case .saveSettings(let settings) = self { return try JSONValue.decode(JSONEncoder().encode(settings)) }
        return .object([:])
    }
}
public struct LocalRequest: Encodable, Sendable {
    public let type = "local:request"
    public let version = 1
    public let id: String
    public let generation: String
    public let op: String
    public let args: JSONValue
    public init(_ command: MenuCommand, generation: String, id: String = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()) throws {
        self.id = id; self.generation = generation; op = command.operation; args = try command.arguments()
    }
}
public struct LocalResult<T: Decodable & Sendable>: Decodable, Sendable {
    public let type: String, version: Int, id: String?, generation: String, op: String?
    public let ok: Bool, outcome: String, code: String?, data: T?
    public func value(for request: LocalRequest) throws -> T {
        guard type == "local:result", version == 1, id == request.id, op == request.op else { throw MenuFailure.invalid }
        guard generation == request.generation else { throw MenuFailure.refused("STALE_GENERATION") }
        guard ok else {
            if outcome == "unknown" { throw MenuFailure.unknown }
            throw MenuFailure.refused(code ?? "CONTROL_FAILED")
        }
        guard outcome == "applied", code == nil, let data else { throw MenuFailure.invalid }
        return data
    }
}
public struct Enrollment: Codable, Sendable, Equatable {
    public let id: String, key: String, kind: String, engineId: String, hostFingerprint: String
    public init(id: String, key: String, kind: String = "local", engineId: String, hostFingerprint: String) {
        self.id = id; self.key = key; self.kind = kind; self.engineId = engineId; self.hostFingerprint = hostFingerprint
    }
}
