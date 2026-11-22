import Foundation
import Testing
import NikCore
import NikMacIdentity
@testable import NikMacCore

private actor LoopCache: KeyValueStore {
    var values: [String: Data] = [:]
    var failing = false
    func failWrites(_ value: Bool) { failing = value }
    func data(forKey key: String) -> Data? { values[key] }
    func set(_ data: Data, forKey key: String) throws {
        if failing { throw CoreFailure(.persistence, "Fixture disk unavailable") }; values[key] = data
    }
    func removeValue(forKey key: String) { values[key] = nil }
}

@Suite("Headless Mac against the real development engine") @MainActor struct NativeLoopTests {
    @Test func enrollmentSealedV2AndBothFleetProviders() async throws {
        let home = BuildFlavour.testBase + "/r05-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(atPath: home) }
        var repo = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { repo.deleteLastPathComponent() }
        let process = Process(), output = Pipe(), input = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", repo.appendingPathComponent("test/helpers/mac-native-server.js").path, home + "/profile"]
        process.standardOutput = output; process.standardInput = input; process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate() }; process.waitUntilExit() }
        func line() throws -> JSONValue {
            var data = Data()
            while let bytes = try output.fileHandleForReading.read(upToCount: 1), !bytes.isEmpty {
                if bytes.first == 10 { break }; data.append(bytes)
                guard data.count < 65536 else { throw IdentityFailure("FIXTURE_OUTPUT_TOO_LARGE") }
            }
            return try JSONValue.decode(data)
        }
        let first = try line()
        for _ in 0..<8 {
            let control = try EngineControl.status(root: home + "/profile")
            #expect(control["generation"] as? String == first["generation"].stringValue)
            #expect(control["pid"] as? Int == Int(process.processIdentifier))
        }
        let selection = try BuildFlavour.development.selection(info: ["CFBundleIdentifier": "com.nikui.app.dev", "NikBuildFlavour": "dev",
            "NikEngineLabel": "com.nikui.engine.development", "NikEngineTestHome": home, "NikEngineTestRoot": home + "/profile"], accountHome: "/Users/fixture")
        let cache = LoopCache(), session = MacAppSession(selection: selection, store: MemoryKeyValueStore(), cache: cache)
        await session.connect()
        #expect(session.problem == nil)
        #expect(session.generation == first["generation"].stringValue)
        let client = try #require(session.client)
        let window = MacWindowModel(token: "headless-loop")
        func wait(_ name: String, _ predicate: () -> Bool) async throws {
            let deadline = Date().addingTimeInterval(8)
            while !predicate() {
                guard Date() < deadline else {
                    Issue.record("Timeout \(name): \(session.diagnostics(window: window))")
                    throw IdentityFailure("FIXTURE_TIMEOUT_" + name)
                }
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        func call(_ action: String) throws -> JSONValue {
            try input.fileHandleForWriting.write(contentsOf: Data((action + "\n").utf8)); return try line()
        }
        try await wait("FLEET") { client.connection.isLive && client.fleet.rows.contains { $0.id == "p2-claude" } && client.fleet.codex.contains { $0.id == "cx-p2-codex" } }
        #expect(client.connection.isLive, "connection=\(client.connection), problem=\(session.problem ?? "nil"), error=\(String(describing: client.lastFailure))")
        #expect(client.fleet.rows.contains { $0.id == "p2-claude" }, "fleet=\(client.fleet.rows.map(\.id))")
        #expect(client.fleet.codex.contains { $0.id == "cx-p2-codex" }, "codex=\(client.fleet.codex.map(\.id))")
        await window.select("cx-p2-codex", client: client)
        try await wait("CODEX") { client.conversation("cx-p2-codex").initialized }
        #expect(client.conversation("cx-p2-codex").meta.provider == .codex)
        await window.select("p2-claude", client: client)
        try await wait("CLAUDE") { client.conversation("p2-claude").initialized && client.conversation("p2-claude").connection.isLive }
        let welcome = try #require(client.protocolSessions[.conversation("p2-claude")]?.welcome)
        #expect(welcome.version == .v2 && welcome.seat.raw["local"].boolValue == true && welcome.seat.control)
        window.edit("Headless native core send", client: client); await window.send(client: client)
        #expect(window.problem == nil); #expect(window.text(client).isEmpty)
        #expect(try call("mac-core-stream-start")["ok"].boolValue == true)
        try await wait("STREAM") { client.conversation("p2-claude").items.contains { $0.id == "p3-native-reply:0" && $0.streaming && !$0.text.isEmpty } }
        #expect(try call("mac-core-stream-end")["ok"].boolValue == true)
        #expect(try call("pending")["ok"].boolValue == true)
        try await wait("APPROVAL") { client.conversation("p2-claude").permissions.contains { $0.requestId == "p2-approval" } }
        let permission = try #require(client.conversation("p2-claude").permissions.first { $0.requestId == "p2-approval" })
        let approval = try #require(window.capture(.approval, client: client, item: permission))
        // A failed pre-write persistence attempt must leave the original button
        // retryable, with no provider effect or new receipt claimed as accepted.
        await cache.failWrites(true)
        await window.act(approval, client: client, allow: true)
        #expect(window.problem != nil); #expect(!window.consumed(approval, client: client))
        #expect(try call("state")["effects"]["approvals"].intValue == 0)
        await cache.failWrites(false)
        await window.act(approval, client: client, allow: true)
        #expect(window.problem == nil); #expect(window.consumed(approval, client: client))
        await window.act(approval, client: client, allow: true)
        #expect(window.problem == "DUPLICATE_CONTROL")
        window.edit("Headless durable queue", client: client); await window.send(client: client)
        #expect(window.problem == nil)
        try await wait("QUEUE") { client.conversation("p2-claude").queue.contains { $0.text == "Headless durable queue" } }
        let stop = try #require(window.capture(.stop, client: client))
        await window.act(stop, client: client); #expect(window.problem == nil)
        try await wait("STOP") { client.conversation("p2-claude").items.contains { $0.kind == "result" && $0.interrupted } }
        let effects = try call("state")["effects"]
        #expect(effects["approvals"].intValue == 1 && effects["interrupts"].intValue == 1)
        #expect(session.diagnostics(window: window)["codexIDs"].arrayValue == [.string("cx-p2-codex")])
        await client.disconnect()
        try input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
        process.waitUntilExit(); #expect(process.terminationStatus == 0)
    }
}
