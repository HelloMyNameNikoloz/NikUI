import Foundation
import NikCore

public protocol MenuClient: Sendable {
    func observe() async throws -> AsyncThrowingStream<MenuSnapshot, any Error>
    func snapshot() async throws -> MenuSnapshot
    func refreshTools() async throws -> MenuSnapshot
    func settings() async throws -> SettingsResult
    func saveSettings(_ value: EngineSettings) async throws -> SettingsResult
}
public actor LocalControlClient: MenuClient {
    public let root: String
    private let transport: any ControlTransport
    private let store: any EnrollmentStore
    private var enrollment: Enrollment?
    private var generation: String?
    public init(root: String, transport: (any ControlTransport)? = nil, store: (any EnrollmentStore)? = nil) {
        self.root = root; self.transport = transport ?? UnixControlTransport(root: root)
        self.store = store ?? FileEnrollmentStore(root: root)
    }
    private func prepare() async throws {
        let response = try await transport.request(Data(#"{"op":"status"}"#.utf8))
        let status: EngineStatus
        do { status = try JSONDecoder().decode(EngineStatus.self, from: response) } catch { throw MenuFailure.invalid }
        guard status.ok, status.root == root, status.state == "running", !status.generation.isEmpty else { throw MenuFailure.invalid }
        let stored = try store.load()
        var args: JSONValue = .object(["op": .string("enroll"), "kind": .string("local"), "protocol": .number(2)])
        if let stored { args["id"] = .string(stored.id); args["key"] = .string(stored.key) }
        let bytes = try await transport.request(args.encoded())
        let raw = try JSONValue.decode(bytes)
        guard raw["ok"].boolValue == true else { throw MenuFailure.refused(raw["code"].stringValue ?? "ENROLLMENT_INVALID") }
        let selected = try JSONDecoder().decode(Enrollment.self, from: bytes)
        guard raw["protocol"].intValue == 2, raw["localManagement"]["version"].intValue == 1,
              selected.kind == "local", selected.engineId == status.engine.id,
              selected.id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              selected.key.utf8.count >= 32, !selected.hostFingerprint.isEmpty,
              stored == nil || stored == selected else { throw MenuFailure.refused("ENROLLMENT_INVALID") }
        try store.save(selected) // no memory-only fallback when persistence fails
        enrollment = selected; generation = status.generation
    }
    private func authenticated(_ op: String) throws -> JSONValue {
        guard let enrollment else { throw MenuFailure.unavailable }
        return .object(["op": .string(op), "id": .string(enrollment.id), "key": .string(enrollment.key)])
    }
    public func observe() async throws -> AsyncThrowingStream<MenuSnapshot, any Error> {
        try await prepare()
        guard let generation else { throw MenuFailure.unavailable }
        var request = try authenticated("menu-observe"); request["generation"] = .string(generation)
        let upstream = transport.observe(try request.encoded()), root = root, engineID = enrollment!.engineId
        return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    for try await frame in upstream {
                        try Task.checkCancellation()
                        let raw = try JSONValue.decode(frame)
                        guard raw["type"].stringValue == "menu:snapshot", raw["version"].intValue == 1 else {
                            throw MenuFailure.refused(raw["code"].stringValue ?? "CONTROL_INVALID")
                        }
                        let value = try JSONDecoder().decode(MenuSnapshot.self, from: raw["data"].encoded())
                        try value.validate(root: root)
                        guard value.status.generation == generation, value.status.engine.id == engineID else { throw MenuFailure.refused("STALE_GENERATION") }
                        continuation.yield(value)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
    private func execute<T: Decodable & Sendable>(_ command: MenuCommand, as: T.Type) async throws -> T {
        if enrollment == nil { try await prepare() }
        guard let generation else { throw MenuFailure.unavailable }
        let request = try LocalRequest(command, generation: generation)
        var wrapper = try authenticated("local"); wrapper["request"] = try JSONValue.decode(JSONEncoder().encode(request))
        let encoded = try wrapper.encoded()
        guard encoded.count < 8192 else { throw MenuFailure.invalid }
        let bytes: Data
        do { bytes = try await transport.request(encoded) }
        catch {
            // A write with a missing reply is unknown. Never automatically
            // repeat a save, or silently assign it a new request identity.
            if command.mutates { throw MenuFailure.unknown }; throw error
        }
        let answer: LocalResult<T>
        do { answer = try JSONDecoder().decode(LocalResult<T>.self, from: bytes) }
        catch { throw command.mutates ? MenuFailure.unknown : MenuFailure.invalid }
        do { return try answer.value(for: request) }
        catch {
            if command.mutates && ((error as? MenuFailure) == .invalid || answer.ok) { throw MenuFailure.unknown }
            throw error
        }
    }
    public func snapshot() async throws -> MenuSnapshot {
        let value = try await execute(.snapshot, as: MenuSnapshot.self); try value.validate(root: root); return value
    }
    public func refreshTools() async throws -> MenuSnapshot {
        let value = try await execute(.refreshTools, as: MenuSnapshot.self); try value.validate(root: root); return value
    }
    public func settings() async throws -> SettingsResult { try await execute(.settings, as: SettingsResult.self) }
    public func saveSettings(_ value: EngineSettings) async throws -> SettingsResult {
        try value.validate(privateHome: root + "/home")
        return try await execute(.saveSettings(value), as: SettingsResult.self)
    }
}
