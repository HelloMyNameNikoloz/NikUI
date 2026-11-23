import Foundation
import Darwin
import Testing
import NikCore
@testable import NikMenuCore

@Suite("Typed private management client") struct LocalClientTests {
    @Test func synchronousControllerReadsAFragmentedFrameWithoutWaitingForEOF() throws {
        let server = try FakeSocketServer { _, root in
            .init(frames: [try fixtureJSON(root)["status"].encoded()], hold: true, fragment: true)
        }; defer { server.cleanup() }
        let started = Date()
        var peer = Int32(0)
        let bytes = try UnixControlTransport(root: server.root).requestSynchronous(Data(#"{"op":"status"}"#.utf8), onPeerPID: { peer = $0 })
        let status = try JSONValue.decode(bytes)
        #expect(status["generation"].stringValue == "generation-1")
        #expect(status["root"].stringValue == server.root)
        #expect(peer == getpid())
        #expect(Date().timeIntervalSince(started) < 1)
    }
    @Test func realUnixSocketAndSharedFleet() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let store = MemoryEnrollmentStore(), client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore())
        let value = try await client.snapshot()
        #expect(value.status.engine.version == "1.2.3")
        #expect(value.fleet.rows.map(\.provider) == [.claude, .claude, .codex, .codex])
        #expect(value.runningRows.map(\.id) == ["instance-1", "cx-one"])
        #expect(value.runningRows[1].status == .waiting)
        #expect(value.openURL(instance: "cx-one")?.path == "/s/cx-one")
        let serviceID = UUID().uuidString + ":" + UUID().uuidString
        #expect(value.openURL(instance: serviceID)?.path == "/s/" + serviceID)
        #expect(value.openURL(instance: "../other") == nil)
        #expect(value.openURL()?.query == "key=SECRET-BROWSER-KEY")
        let settings = try await client.settings()
        var changed = settings.settings; changed.port = 54321
        let saved = try await client.saveSettings(changed)
        #expect(saved.requiresRestart); #expect(saved.settings.port == 54321)
        let request = try #require(server.requests.last?["request"])
        #expect(request["version"].intValue == 1); #expect(request["generation"].stringValue == "generation-1")
        #expect(request["args"]["tools"].objectValue.keys.sorted() == ["claude", "codex", "gh", "node"])
        #expect(request["args"]["tools"]["node"] == .null)
        #expect(try store.load() == nil)
    }
    @Test func subscriptionCancellationClosesSocket() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore())
        let stream = try await client.observe()
        let task = Task { for try await _ in stream { try Task.checkCancellation() } }
        try await eventually { server.requests.contains { $0["op"].stringValue == "menu-observe" } && server.activeClients == 1 }
        task.cancel(); _ = await task.result
        try await eventually { server.activeClients == 0 }
        #expect(server.requests.count == 3) // status, enrollment, subscription; no tight polling
    }
    @Test func persistenceFailureNeverObserves() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore(failWrites: true))
        await #expect(throws: MenuFailure.refused("SECRET_STORAGE_UNAVAILABLE")) { _ = try await client.observe() }
        #expect(!server.requests.contains { $0["op"].stringValue == "menu-observe" })
    }
    @Test func selectedPinAndEnrollmentCannotChange() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let wrong = Enrollment(id: testEnrollment.id, key: testEnrollment.key, engineId: "different-owner", hostFingerprint: "pin-1")
        let client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore(wrong))
        await #expect(throws: MenuFailure.refused("ENROLLMENT_INVALID")) { _ = try await client.snapshot() }
        #expect(server.requests.last?["id"].stringValue == testEnrollment.id)
        #expect(!server.requests.contains { $0["op"].stringValue == "local" })
    }
    @Test func lostMutationReplyIsUnknownWithoutReplay() async throws {
        let server = try FakeSocketServer { value, root in
            if value["request"]["op"].stringValue == "engine.settings.update" { return .init(frames: []) }
            return try FakeSocketServer.standard(value, root: root)
        }; defer { server.cleanup() }
        let client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore())
        let settings = try await client.settings()
        await #expect(throws: MenuFailure.unknown) { _ = try await client.saveSettings(settings.settings) }
        #expect(server.requests.filter { $0["request"]["op"].stringValue == "engine.settings.update" }.count == 1)
    }
    @Test func staleGenerationAndWrongCorrelationRefuse() async throws {
        for wrongID in [false, true] {
            let server = try FakeSocketServer { value, root in
                let standard = try FakeSocketServer.standard(value, root: root)
                guard value["op"].stringValue == "local" else { return standard }
                var result = try JSONValue.decode(standard.frames[0])
                if wrongID { result["id"] = .string("wrong") } else { result["generation"] = .string("new-boot") }
                return .init(frames: [try result.encoded()])
            }; defer { server.cleanup() }
            let client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore())
            await #expect(throws: wrongID ? MenuFailure.invalid : .refused("STALE_GENERATION")) { _ = try await client.snapshot() }
        }
    }
    @Test func namedRefusalDoesNotEchoRawError() async throws {
        let server = try FakeSocketServer { value, root in
            if value["op"].stringValue == "local" {
                let request = value["request"]
                return .init(frames: [try JSONValue.object(["type": .string("local:result"), "version": .number(1), "id": request["id"],
                    "op": request["op"], "generation": request["generation"], "ok": .bool(false), "outcome": .string("refused"),
                    "code": .string("CODEX_HOME_OUTSIDE_TEST_PROFILE"), "data": .null, "error": .string("SECRET-RAW-ERROR")]).encoded()])
            }
            return try FakeSocketServer.standard(value, root: root)
        }; defer { server.cleanup() }
        let client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore())
        await #expect(throws: MenuFailure.refused("CODEX_HOME_OUTSIDE_TEST_PROFILE")) { _ = try await client.settings() }
        #expect(MenuFailure.refused("secret with spaces").code == "CONTROL_FAILED")
    }
    @Test func unsafeSocketAndDirectoryRefuseBeforeSending() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let transport = UnixControlTransport(root: server.root)
        chmod(server.root + "/c.sock", 0o666)
        await #expect(throws: MenuFailure.unsafe) { _ = try await transport.request(Data("{}".utf8)) }
        chmod(server.root + "/c.sock", 0o600); chmod(server.root, 0o755)
        await #expect(throws: MenuFailure.unsafe) { _ = try await transport.request(Data("{}".utf8)) }
        chmod(server.root, 0o700)
        #expect(server.requests.isEmpty)
    }
    @Test func oversizedFrameAndInvalidJSONAreBounded() async throws {
        let server = try FakeSocketServer { _, _ in .init(frames: [Data(repeating: 120, count: 262145)]) }; defer { server.cleanup() }
        let transport = UnixControlTransport(root: server.root)
        await #expect(throws: MenuFailure.invalid) { _ = try await transport.request(Data("{}".utf8)) }
        await #expect(throws: MenuFailure.invalid) { _ = try await transport.request(Data(repeating: 32, count: 8192)) }
    }
    @Test func enrollmentFileModesAndCorruptionRefuse() throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let store = FileEnrollmentStore(root: server.root)
        #expect(try store.load() == nil); try store.save(testEnrollment)
        #expect(try store.load() == testEnrollment)
        chmod(server.root + "/menu-client.json", 0o644)
        #expect(throws: MenuFailure.refused("ENROLLMENT_INVALID")) { _ = try store.load() }
        chmod(server.root + "/menu-client.json", 0o600)
        try Data("corrupt".utf8).write(to: URL(fileURLWithPath: server.root + "/menu-client.json"))
        #expect(throws: MenuFailure.refused("ENROLLMENT_INVALID")) { _ = try store.load() }
    }
    @Test func snapshotRejectsRemoteBrowserCapability() throws {
        var raw = fixtureJSON("/fixture")
        raw["browserURL"] = .string("http://evil.example:43123/?key=SECRET")
        let snapshot = try JSONDecoder().decode(MenuSnapshot.self, from: raw.encoded())
        #expect(throws: MenuFailure.unsafe) { try snapshot.validate(root: "/fixture") }
    }
    @Test func stoppedSocketIsUnavailableAndDoesNotReconnectItself() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        server.stop()
        let transport = UnixControlTransport(root: server.root)
        await #expect(throws: MenuFailure.unavailable) { _ = try await transport.request(Data("{}".utf8)) }
        #expect(server.requests.isEmpty)
    }
}
