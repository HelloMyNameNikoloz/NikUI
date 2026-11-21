import Foundation
import Testing
@testable import NikCore

@Suite("Authenticated sockets, ordering and lifecycle") struct TransportTests {
    @Test func verifiedWelcomeAndReadyBeforeApplicationEvents() async throws {
        let factory = ScriptedFactory(), updates = UpdateRecorder(), connection = SocketConnection(factory: factory)
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { await updates.append($0) } }
        try await eventually { await updates.isLive() }
        let socket = try #require(await factory.socket()); #expect(await socket.authValid)
        #expect(await socket.actions.first?["type"].stringValue == "ready")
        let frames = await socket.wireFrames; #expect(frames[0]["type"].stringValue == "@auth"); #expect(frames[1]["type"].stringValue == "@box")
        task.cancel(); await connection.close(); _ = await task.value
    }
    @Test(arguments: [ScriptedSocket.Behavior.plaintextWelcome, .invalidWelcome, .wrongPin])
    func rejectsUntrustedWelcome(_ behavior: ScriptedSocket.Behavior) async throws {
        let factory = ScriptedFactory(behavior: behavior), updates = UpdateRecorder(), connection = SocketConnection(factory: factory)
        let result = await connection.run(pairing: try record(), key: try softwareKey(), role: .fleet) { await updates.append($0) }
        #expect(!result.wasLive); #expect(!result.retryable); #expect(!(await updates.isLive()))
        let socket = try #require(await factory.socket()); #expect(await socket.actions.isEmpty)
    }
    @Test func handshakeDeadlineCancelsPendingReceive() async throws {
        let clock = TestClock(), factory = ScriptedFactory(behavior: .noChallenge), connection = SocketConnection(factory: factory, clock: clock)
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { _ in } }
        try await eventually { clock.pendingSleeps() > 0 }; clock.advance(10)
        let result = await task.value; #expect(result.failure?.code == .timeout); #expect(result.retryable); #expect(!result.wasLive)
    }
    @Test func cancellationDuringAuthDoesNotBecomeLive() async throws {
        let factory = ScriptedFactory(behavior: .noWelcome), updates = UpdateRecorder(), connection = SocketConnection(factory: factory)
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { await updates.append($0) } }
        try await eventually { if let socket = await factory.socket() { return await socket.wireFrames.count > 0 }; return false }
        task.cancel(); await connection.close(); let result = await task.value
        #expect(result.failure == nil); #expect(!(await updates.isLive()))
    }
    @Test func concurrentWritesHaveStrictlyIncreasingCounters() async throws {
        let factory = ScriptedFactory(behavior: .delayedSend), updates = UpdateRecorder(), connection = SocketConnection(factory: factory)
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { await updates.append($0) } }
        try await eventually { await updates.isLive() }
        try await withThrowingTaskGroup(of: Void.self) { group in for _ in 0..<40 { group.addTask { try await connection.send(.status) } }; try await group.waitForAll() }
        let socket = try #require(await factory.socket()); let counters = await socket.wireFrames.filter { $0["type"].stringValue == "@box" }.compactMap { $0["n"].intValue }
        #expect(counters == Array(0...40)); #expect(await socket.actions.count == 41)
        task.cancel(); await connection.close(); _ = await task.value
    }
    @Test func plaintextAfterSealingFailsConnection() async throws {
        let factory = ScriptedFactory(), updates = UpdateRecorder(), connection = SocketConnection(factory: factory)
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { await updates.append($0) } }
        try await eventually { await updates.isLive() }
        let socket = try #require(await factory.socket()); await socket.plaintext(.object(["type":.string("fleet")]))
        let result = await task.value; #expect(result.failure?.code == .protocolViolation); #expect(!result.retryable)
    }
    @Test func policyRemovalDoesNotRetry() async throws {
        let factory = ScriptedFactory(), updates = UpdateRecorder(), connection = SocketConnection(factory: factory)
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { await updates.append($0) } }
        try await eventually { await updates.isLive() }; let socket = try #require(await factory.socket()); await socket.fail(code: 1008, reason: "this device was removed")
        let result = await task.value; #expect(result.failure?.code == .refused); #expect(!result.retryable)
    }
    @Test func replayNonceCacheRejectsDuplicate() async throws {
        let cache = NonceReplayCache(); try await cache.insert("nonce")
        do { try await cache.insert("nonce"); Issue.record("Repeated nonce accepted") } catch let e as CoreFailure { #expect(e.code == .replay) }
    }
    @Test func reconnectBackoffAndRestoresQueriesNeverWrites() async throws {
        let factory = ScriptedFactory(), updates = UpdateRecorder(), clock = TestClock()
        let manager = ConnectionManager(key: try softwareKey(), factory: factory, clock: clock) { await updates.append($0) }
        var visibility = FeatureVisibility(); visibility.slack = true
        await manager.setVisibility(visibility); await manager.connect(try record())
        try await eventually { if let socket = await factory.socket() { return await socket.actions.contains { $0["type"].stringValue == "slack:ready" } }; return false }
        try await manager.send(.slackOpen(conversation: "D1"), on: .fleet)
        let first = try #require(await factory.socket()); await first.fail()
        try await eventually { clock.pendingSleeps() > 0 }; clock.advance(1)
        try await eventually { if let socket = await factory.socket(1) { return await socket.actions.contains { $0["type"].stringValue == "slack:open" } }; return false }
        let second = try #require(await factory.socket(1)); let actions = await second.actions
        #expect(actions.first?["type"].stringValue == "ready"); #expect(!actions.contains { ["send", "term:run", "slack:reply", "pr:comment"].contains($0["type"].stringValue ?? "") })
        await manager.disconnect()
        #expect(ReconnectPolicy.delay(attempt: 1) == 0.4); #expect(ReconnectPolicy.delay(attempt: 6, jitterMilliseconds: 249) == 12.249); #expect(ReconnectPolicy.delay(attempt: 100) == 12)
    }
    @Test func managerKeepsTwoSocketsAndSuspendsWhenLocked() async throws {
        let factory = ScriptedFactory(), updates = UpdateRecorder()
        let manager = ConnectionManager(key: try softwareKey(), factory: factory) { await updates.append($0) }
        await manager.selectConversation("claude-1"); await manager.connect(try record())
        try await eventually { await factory.count() == 2 }; await manager.selectConversation("cx-thread-1")
        try await eventually { await factory.count() == 3 }
        await manager.setLifecycle(.locked)
        do { try await manager.send(.status, on: .fleet); Issue.record("Sent while locked") } catch let e as CoreFailure { #expect(e.code == .offline) }
        await manager.setLifecycle(.foreground); try await eventually { await factory.count() == 5 }; await manager.disconnect()
    }
    @Test func socketURLUsesNativeSchemeAndEncodesSession() throws {
        let url = try SocketConnection.url(base: URL(string: "https://laptop.example:4517")!, role: .conversation("cx-a?b&c"))
        #expect(url.scheme == "wss"); #expect(url.port == 4517); #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == "cx-a?b&c")
    }
}

@Suite("Observable facade actions") @MainActor struct FacadeTests {
    func liveClient(clock: any NikCore.Clock = SystemClock()) async throws -> (NikClient, ScriptedFactory) {
        let store = MemoryKeyValueStore(), factory = ScriptedFactory()
        try await store.set(JSONEncoder().encode(record()), forKey: PairingService.pairingKey)
        let client = NikClient(signingKey: try softwareKey(), secureStore: store, clock: clock, socketFactory: factory)
        await client.restore(); await client.connect(); try await eventually { await MainActor.run { client.connection.isLive && !client.fleet.projects.isEmpty } }
        return (client, factory)
    }
    @Test func promptIsPreservedAndNeverReplayed() async throws {
        let (client, factory) = try await liveClient(); await client.selectConversation("claude-1")
        try await eventually { await client.conversation("claude-1").initialized }
        client.setDraft(Draft(text: "Keep this /concise", attachments: PreviewFixtures.conversation.items[0].images), conversationID: "claude-1")
        let result = await client.send(conversationID: "claude-1")
        if case .submitted = result {} else { Issue.record("Unexpected send result \(result)") }
        #expect(client.conversation("claude-1").draft.text == "Keep this /concise"); #expect(client.conversation("claude-1").draft.attachments.count == 1)
        await client.disconnect(); #expect(client.conversation("claude-1").draft.delivery == .ambiguous)
        let count = await factory.count(); await client.connect()
        try await eventually { await factory.count() >= count + 2 }
        for index in count..<(await factory.count()) { if let socket = await factory.socket(index) { #expect(!(await socket.actions.contains { $0["type"].stringValue == "send" })) } }
        await client.disconnect()
    }
    @Test func correlatedCreateAndRefusalPreserveChoices() async throws {
        let (client, _) = try await liveClient()
        let result = await client.perform(.newInstance(id: "new1", cwd: "/Users/nik/Codes/NikUI", provider: .codex))
        #expect(result == .accepted(.object(["id":.string("new1"),"instance":.string("new-session")])))
        #expect(client.consumeIntent() == .navigate("new-session"))
        await client.disconnect()
    }
    @Test func slackCorrelatedSuccessCannotClearEditedOrOtherThreadDraft() async throws {
        let (client, factory) = try await liveClient(); client.ingest(.slack(.state(PreviewFixtures.slack)))
        client.setSlackDraft("original", conversation: "D1"); client.setSlackDraft("other", conversation: "D1", thread: "thread")
        let task = Task { await client.perform(.slackReply(id: "reply1", conversation: "D1", text: "original")) }
        try await eventually { await client.pendingOperations["reply1"]?.state == .submitted }
        client.setSlackDraft("edited", conversation: "D1")
        let socket = try #require(await factory.socket()); try await socket.enqueue(.object(["type":.string("slack:sent"),"id":.string("stale"),"ok":.bool(true)]))
        #expect(client.pendingOperations["reply1"]?.state == .submitted)
        try await socket.enqueue(.object(["type":.string("slack:sent"),"id":.string("reply1"),"ok":.bool(true)])); let result = await task.value
        if case .accepted = result {} else { Issue.record("Missing correlated receipt") }
        #expect(client.slack.threads[SlackThreadID(conversation: "D1")]?.draft.text == "edited"); #expect(client.slack.threads[SlackThreadID(conversation: "D1", thread: "thread")]?.draft.text == "other")
        await client.disconnect()
    }
    @Test func prSerializesMutationAndPreservesRefusedDraft() async throws {
        let (client, factory) = try await liveClient(); await client.selectConversation("claude-1"); try await eventually { await client.conversation("claude-1").initialized }
        client.ingest(.pr(.state(PRStateEvent(.object(["prUrl":.string(PreviewFixtures.pr.url!),"state":PreviewFixtures.pr.raw])))), on: .conversation("claude-1"))
        client.setPRDraft("Please review", conversationID: "claude-1")
        let task = Task { await client.perform(.prComment("Please review"), on: .conversation("claude-1")) }
        try await eventually { await client.conversation("claude-1").pr.pending != nil }
        let second = await client.perform(.prRerun, on: .conversation("claude-1")); if case .notSent(let e) = second { #expect(e.code == .refused) } else { Issue.record("Concurrent PR mutation was allowed") }
        let socket = try #require(await factory.socket(1)); try await socket.enqueue(.object(["type":.string("pr:done"),"action":.string("comment"),"ok":.bool(false),"message":.string("GitHub unavailable")]))
        let result = await task.value; if case .notSent = result {} else { Issue.record("Refusal lost") }
        #expect(client.conversation("claude-1").pr.drafts["comment"] == "Please review")
        await client.disconnect()
    }
    @Test func controlRevocationAndPermissionNotOptimistic() async throws {
        let (client, _) = try await liveClient(); await client.selectConversation("claude-1"); try await eventually { await client.conversation("claude-1").initialized }
        _ = await client.perform(.permission(requestID: "permission-1", allow: true), on: .conversation("claude-1"))
        #expect(client.conversation("claude-1").permissions.count == 1)
        client.ingest(.device(Seat(.object(["id":.string("device1"),"control":.bool(false)]))))
        #expect(!client.mayControl)
        let denied = await client.perform(.terminalList); if case .notSent(let e) = denied { #expect(e.code == .refused) } else { Issue.record("Revoked control was ignored") }
        await client.disconnect()
    }
    @Test func restoreDoesNotPersistTranscriptsAndMarksOldSubmissionAmbiguous() async throws {
        let secure = MemoryKeyValueStore(), cache = MemoryKeyValueStore(); let pairing = try record()
        try await secure.set(JSONEncoder().encode(pairing), forKey: PairingService.pairingKey)
        let client = NikClient(signingKey: try softwareKey(), secureStore: secure, cacheStore: cache); await client.restore()
        client.ingest(.initialized(PreviewFixtures.conversation), on: .conversation("claude-1")); client.setDraft(Draft(text: "retained", delivery: .submitted), conversationID: "claude-1")
        // An unchanged text preserves an explicitly supplied delivery status.
        var draft = client.conversation("claude-1").draft; draft.delivery = .submitted; client.setDraft(draft, conversationID: "claude-1"); await client.flushPersistence()
        let restored = NikClient(signingKey: try softwareKey(), secureStore: secure, cacheStore: cache); await restored.restore()
        #expect(restored.conversation("claude-1").items.isEmpty); #expect(restored.conversation("claude-1").draft.text == "retained"); #expect(restored.conversation("claude-1").draft.delivery == .ambiguous)
        _ = await client.forgetLaptop(deleteKey: false); await restored.restore()
    }
}

@Suite("Connection transition races") struct TransitionTests {
    @Test func switchingDuringDisconnectCannotLeaveASocketOpen() async throws {
        let factory = ScriptedFactory(), gate = CloseGate()
        let manager = ConnectionManager(key: try softwareKey(), factory: factory) { await gate.receive($0) }
        await manager.selectConversation("claude-1"); await manager.connect(try record())
        try await eventually { await factory.count() == 2 }
        await gate.arm()
        let closing = Task { await manager.disconnect() }
        try await eventually { await gate.blocked }
        await manager.selectConversation("cx-new")
        await gate.release(); await closing.value
        try await eventually { await factory.activeCount() == 0 }
        #expect(await factory.activeCount() == 0)
    }
    @Test func rapidSelectionKeepsAtMostFleetAndOneConversation() async throws {
        let factory = ScriptedFactory(), recorder = UpdateRecorder()
        let manager = ConnectionManager(key: try softwareKey(), factory: factory) { await recorder.append($0) }
        await manager.connect(try record()); try await eventually { await recorder.isLive() }
        await withTaskGroup(of: Void.self) { group in
            for index in 0..<30 { group.addTask { await manager.selectConversation("chat-\(index)") } }
        }
        await manager.selectConversation("final")
        try await eventually { await factory.activeCount() <= 2 }
        #expect(await factory.activeCount() <= 2)
        await manager.disconnect(); try await eventually { await factory.activeCount() == 0 }
    }
}
private actor CloseGate {
    private var armed = false
    private(set) var blocked = false
    private var continuation: CheckedContinuation<Void, Never>?
    func arm() { armed = true }
    func receive(_ update: ConnectionUpdate) async {
        if armed, case .state(.fleet, .offline) = update {
            blocked = true; await withCheckedContinuation { continuation = $0 }; armed = false
        }
    }
    func release() { continuation?.resume(); continuation = nil }
}
