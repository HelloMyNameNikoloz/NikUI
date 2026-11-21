import Foundation
import Darwin
import NikCore
@testable import NikMenuCore

func fixture(_ root: String, generation: String = "generation-1") throws -> MenuSnapshot {
    try JSONDecoder().decode(MenuSnapshot.self, from: fixtureJSON(root, generation: generation).encoded())
}
func fixtureJSON(_ root: String, generation: String = "generation-1") -> JSONValue {
    .object([
        "status": .object(["ok": .bool(true), "root": .string(root), "generation": .string(generation), "pid": .number(2345), "state": .string("running"),
            "engine": .object(["id": .string("engine-1"), "boot": .string("boot-1"), "version": .string("1.2.3")]),
            "listener": .object(["host": .string("127.0.0.1"), "port": .number(43123)]),
            "account": .object(["home": .string(root + "/home/.codex-work"), "borrowed": .bool(false)]),
            "bridge": .object(["connected": .number(1), "editors": .number(0), "pendingEditorRequests": .number(0)]),
            "tools": .object(["claude": .object(["status": .string("resolved"), "path": .string("/Users/private-owner/.local/bin/claude"), "source": .string("configured")]),
                              "node": .object(["status": .string("resolved"), "path": .string(root + "/bundle/node"), "source": .string("configured")])]),
            "blockers": .array([.object(["code": .string("ISOLATED_P1")])])]),
        "fleet": .object(["instances": .array([
            .object(["id": .string("instance-1"), "label": .string("SECRET-TITLE"), "status": .string("working"), "running": .bool(true), "cwd": .string("/SECRET-PROJECT")]),
            .object(["id": .string("stopped"), "label": .string("Stopped"), "status": .string("stopped"), "running": .bool(false)])]),
            "codex": .array([.object(["id": .string("cx-one"), "label": .string("Codex"), "status": .string("waiting"), "running": .bool(true), "asleep": .bool(false)]),
                             .object(["id": .string("cx-asleep"), "status": .string("idle"), "running": .bool(false), "asleep": .bool(true)])]),
            "projects": .array([])]),
        "browserURL": .string("http://127.0.0.1:43123/?key=SECRET-BROWSER-KEY"),
        "settings": .object(["revision": .number(0), "tools": .object(["claude": .null, "codex": .null, "node": .null, "gh": .null]),
                             "codexHome": .string(root + "/home/.codex-work"), "port": .number(0), "bind": .string("127.0.0.1")]),
        "requiresRestart": .bool(false), "importBlocker": .string("PRODUCTION_CUTOVER_DISABLED"), "updateBlockers": .array([])
    ])
}
let testEnrollment = Enrollment(id: String(repeating: "a", count: 32), key: String(repeating: "k", count: 43), engineId: "engine-1", hostFingerprint: "pin-1")
final class MemoryEnrollmentStore: EnrollmentStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Enrollment?
    let failWrites: Bool
    init(_ value: Enrollment? = nil, failWrites: Bool = false) { self.value = value; self.failWrites = failWrites }
    func load() throws -> Enrollment? { lock.lock(); defer { lock.unlock() }; return value }
    func save(_ value: Enrollment) throws {
        lock.lock(); defer { lock.unlock() }
        if failWrites { throw MenuFailure.refused("SECRET_STORAGE_UNAVAILABLE") }; self.value = value
    }
}
final class FakeSocketServer: @unchecked Sendable {
    struct Response: Sendable { var frames: [Data]; var hold = false; var fragment = false }
    let root: String
    private let fd: Int32
    private let lock = NSLock()
    private var closed = false
    private var clients = Set<Int32>()
    private var received: [JSONValue] = []
    private let handler: @Sendable (JSONValue) throws -> Response
    init(handler: (@Sendable (JSONValue, String) throws -> Response)? = nil) throws {
        let temp = "/private/tmp/nik-menu-swift-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(atPath: temp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        root = temp
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        fd = descriptor
        guard fd >= 0 else { throw MenuFailure.unavailable }
        var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array((root + "/c.sock").utf8) + [UInt8(0)]
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        let bound = withUnsafePointer(to: &address) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, chmod(root + "/c.sock", 0o600) == 0, listen(fd, 16) == 0 else { close(fd); throw MenuFailure.unavailable }
        self.handler = { value in
            if let handler { return try handler(value, temp) }; return try Self.standard(value, root: temp)
        }
        DispatchQueue.global(qos: .utility).async { [self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { break }
                lock.lock()
                if closed { lock.unlock(); close(client); break }
                clients.insert(client); lock.unlock()
                DispatchQueue.global(qos: .utility).async { [self] in serve(client) }
            }
        }
    }
    var requests: [JSONValue] { lock.lock(); defer { lock.unlock() }; return received }
    var activeClients: Int { lock.lock(); defer { lock.unlock() }; return clients.count }
    func stop() {
        lock.lock(); if closed { lock.unlock(); return }; closed = true
        let active = clients; lock.unlock()
        _ = shutdown(fd, SHUT_RDWR); close(fd)
        for client in active { _ = shutdown(client, SHUT_RDWR) }
    }
    func cleanup() { stop(); try? FileManager.default.removeItem(atPath: root) }
    private func serve(_ client: Int32) {
        defer { lock.lock(); clients.remove(client); lock.unlock(); close(client) }
        var noSignal: Int32 = 1
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        var text = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while !text.contains(10) {
            let n = read(client, &buffer, buffer.count); if n <= 0 { return }; text.append(contentsOf: buffer.prefix(n))
            if text.count > 8192 { return }
        }
        guard let at = text.firstIndex(of: 10), let value = try? JSONValue.decode(Data(text[..<at])) else { return }
        lock.lock(); received.append(value); lock.unlock()
        guard let response = try? handler(value) else { return }
        for frame in response.frames {
            let bytes = frame + Data([10])
            let succeeded = bytes.withUnsafeBytes { raw -> Bool in
                var offset = 0
                while offset < raw.count {
                    let n = write(client, raw.baseAddress!.advanced(by: offset), min(response.fragment ? 3 : raw.count, raw.count - offset))
                    if n < 0 && errno == EINTR { continue }; if n <= 0 { return false }; offset += n
                }
                return true
            }
            if !succeeded { return }
        }
        if response.hold { while read(client, &buffer, buffer.count) > 0 {} }
    }
    static func standard(_ value: JSONValue, root: String) throws -> Response {
        let snapshot = fixtureJSON(root)
        switch value["op"].stringValue {
        case "status": return Response(frames: [try snapshot["status"].encoded()], fragment: true)
        case "enroll":
            var answer = try JSONValue.decode(JSONEncoder().encode(testEnrollment)); answer["ok"] = .bool(true)
            answer["protocol"] = .number(2); answer["localManagement"] = .object(["version": .number(1)])
            return Response(frames: [try answer.encoded()], fragment: true)
        case "menu-observe":
            return Response(frames: [try JSONValue.object(["type": .string("menu:snapshot"), "version": .number(1), "data": snapshot]).encoded()], hold: true, fragment: true)
        case "local":
            let r = value["request"]
            let payload = r["op"].stringValue == "engine.settings.get" || r["op"].stringValue == "engine.settings.update"
                ? JSONValue.object(["settings": r["op"].stringValue == "engine.settings.update" ? r["args"] : snapshot["settings"], "requiresRestart": .bool(r["op"].stringValue == "engine.settings.update")]) : snapshot
            return Response(frames: [try JSONValue.object(["type": .string("local:result"), "version": .number(1), "id": r["id"], "op": r["op"],
                "generation": r["generation"], "ok": .bool(true), "outcome": .string("applied"), "code": .null, "data": payload]).encoded()], fragment: true)
        default: return Response(frames: [])
        }
    }
}
func eventually(_ condition: @escaping @Sendable () async -> Bool) async throws {
    for _ in 0..<150 { if await condition() { return }; try await Task.sleep(for: .milliseconds(10)) }
    throw MenuFailure.timeout
}
@MainActor final class FakeService: EngineService {
    var loginStatus: LoginRegistration = .notRegistered, agentStatus: LoginRegistration = .enabled
    var starts = 0, stops = 0, logins = 0
    var startFailure: MenuFailure?, stopFailure: MenuFailure?, approval = false
    func setLogin(enabled: Bool) async throws { logins += 1; loginStatus = enabled ? (approval ? .requiresApproval : .enabled) : .notRegistered }
    func start() async throws { starts += 1; if let startFailure { throw startFailure } }
    func stop() async throws { stops += 1; if let stopFailure { throw stopFailure } }
}
