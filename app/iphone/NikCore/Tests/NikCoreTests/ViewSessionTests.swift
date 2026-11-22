import Foundation
import Testing
@testable import NikCore

@Suite("Concurrent window view sessions") @MainActor struct ViewSessionTests {
    @Test func ambiguousControlFencesBothWindowsUntilLateRejectionAndHoldsReceiptLease() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left"); await client.acquireConversation("a", forView: "right")
        try await eventually { await MainActor.run { client.conversation("a").initialized && client.connection.isLive } }
        let socket = try #require(await factory.socket(1)), mid = V2Wire.randomID()
        var metadata = IntentMetadata(mid: mid); metadata.controlIdentity = "a:approval:one"
        let sending = Task { await client.perform(.send(text: "captured control"), forView: "left", preconditions: metadata) }
        try await eventually { await socket.actions.contains { $0["mid"].stringValue == mid } }
        #expect(client.pendingIntents[mid]?.controlIdentity == "a:approval:one")
        var duplicate = IntentMetadata(); duplicate.controlIdentity = metadata.controlIdentity
        #expect(await client.perform(.send(text: "other window"), forView: "right", preconditions: duplicate) == .notSent(CoreFailure(.refused, "DUPLICATE_CONTROL")))
        client.timeoutRequest(mid, generation: client.clientGeneration)
        if case .ambiguous = await sending.value {} else { Issue.record("Timed-out control must remain ambiguous") }
        #expect(client.isViewControlBlocked("a:approval:one"))
        await client.releaseViewSession("left"); await client.releaseViewSession("right")
        #expect(await socket.isClosed() == false)
        let outgoing = try #require(await socket.actions.first { $0["mid"].stringValue == mid })
        try await socket.enqueue(testAck(outgoing, target: "session:a", data: .object([:]), outcome: "rejected", error: .object(["code": .string("PROVIDER_REJECTED"), "message": .string("retry allowed"), "retryable": .bool(false)])))
        do { try await eventually { await MainActor.run { !client.isViewControlBlocked("a:approval:one") } } }
        catch { Issue.record("Late rejection state=\(String(describing: client.pendingIntents[mid]?.state)) error=\(String(describing: client.lastFailure)) claims=\(client.viewControlClaims)"); throw error }
        try await eventually { await socket.isClosed() }
        await client.acquireConversation("a", forView: "right")
        try await eventually { await client.conversation("a").connection.isLive }
        let retrySocket = try #require(await factory.socket(2))
        let retryID = V2Wire.randomID()
        var retry = IntentMetadata(mid: retryID); retry.controlIdentity = metadata.controlIdentity
        let retried = Task { await client.perform(.send(text: "retry rejected control"), forView: "right", preconditions: retry) }
        try await eventually { await retrySocket.actions.contains { $0["mid"].stringValue == retryID } }
        let retryMessage = try #require(await retrySocket.actions.first { $0["mid"].stringValue == retryID })
        try await retrySocket.enqueue(testAck(retryMessage, target: "session:a", data: .object(["instance": .string("a"), "queueId": .string("q-retry"), "operation": .string(retryID)])))
        if case .accepted = await retried.value {} else { Issue.record("Rejected control did not become retryable in another window") }
        await client.disconnect()
    }
    @Test func localMacNegotiatesItsOwnKindAndDefaultPhoneAPIStaysIdentical() {
        #expect(ProtocolSession.hello(clientID: "a")["client"]["kind"].stringValue == "iphone")
        #expect(ProtocolSession.hello(clientID: "a", kind: .mac)["client"]["kind"].stringValue == "mac")
    }
    private func client(factory: any SocketFactory, cache: any KeyValueStore = MemoryKeyValueStore()) async throws -> NikClient {
        let secure = MemoryKeyValueStore(); try await secure.set(WireCoding.encode(record()), forKey: PairingService.pairingKey)
        let client = NikClient(signingKey: try softwareKey(), secureStore: secure, cacheStore: cache, socketFactory: factory)
        await client.restore(); await client.connect(); return client
    }
    @Test func referenceCountedSocketsAndDefaultPhoneSelection() async throws {
        let factory = ScriptedFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left"); await client.acquireConversation("a", forView: "right")
        try await eventually { await factory.activeCount() == 2 }
        await client.releaseViewSession("left")
        #expect(await factory.activeCount() == 2)
        await client.selectConversation("b")
        try await eventually { await factory.activeCount() == 3 }
        await client.selectConversation(nil)
        #expect(await factory.activeCount() == 2)
        await client.releaseViewSession("right")
        #expect(await factory.activeCount() == 1)
        await client.disconnect()
    }
    @Test func unchangedLeaseUnionDoesNotResubscribeAnySocket() async throws {
        let factory = ScriptedFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left")
        await client.acquireConversation("b", forView: "right")
        try await eventually { await MainActor.run { client.connection.isLive && client.conversation("a").initialized && client.conversation("b").initialized } }
        let fleet = try #require(await factory.socket(0)), a = try #require(await factory.socket(1)), b = try #require(await factory.socket(2))
        let before = await [fleet.actions, a.actions, b.actions]
        await client.acquireConversation("a", forView: "intent:one")
        await client.releaseViewSession("intent:one")
        await client.acquireConversation("a", forView: "left")
        #expect(await fleet.actions == before[0]); #expect(await a.actions == before[1]); #expect(await b.actions == before[2])
        var features = FeatureVisibility(); features.pr = true
        await client.acquireConversation("a", forView: "pane", visibility: features)
        #expect(await a.actions.contains { $0["type"].stringValue == "pr:watch" })
        #expect(await b.actions == before[2])
        let enabled = await a.actions
        await client.acquireConversation("a", forView: "another-pane", visibility: features)
        await client.releaseViewSession("pane")
        #expect(await a.actions == enabled)
        await client.releaseViewSession("another-pane")
        #expect(await a.actions.contains { $0["type"].stringValue == "pr:watch" && $0["on"].boolValue == false })
        await client.disconnect()
    }
    @Test func differentConversationsAndIndependentReadingAndCompositions() async throws {
        let factory = ScriptedFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left"); await client.acquireConversation("b", forView: "right")
        try await eventually { await factory.activeCount() == 3 }
        client.setViewDraft(Draft(text: "left"), forView: "left", conversationID: "a")
        client.setViewDraft(Draft(text: "right"), forView: "right", conversationID: "b")
        var reading = ReadingState(); reading.offset = 927; reading.followsLatest = false
        client.setViewReading(reading, forView: "left", conversationID: "a")
        await client.acquireConversation("a", forView: "right")
        #expect(client.viewDraft("left", conversationID: "a").text == "left")
        #expect(client.viewDraft("right", conversationID: "a").text.isEmpty)
        #expect(client.viewDraft("right", conversationID: "b").text == "right")
        #expect(client.viewSessions["left"]?.reading["a"]?.offset == 927)
        #expect(client.viewSessions["right"]?.reading["a"] == nil)
        await client.disconnect()
    }
    @Test func firstWindowClosingDoesNotAmbiguateOtherLeaseAndMatchingAckClearsOnlyItsComposition() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left"); await client.acquireConversation("a", forView: "right")
        try await eventually { await MainActor.run { client.conversation("a").initialized && client.connection.isLive } }
        client.setViewDraft(Draft(text: "left prompt"), forView: "left", conversationID: "a")
        client.setViewDraft(Draft(text: "right prompt"), forView: "right", conversationID: "a")
        let captured = try client.captureDraft(forView: "left"), socket = try #require(await factory.socket(1))
        let sending = Task { await client.submit(captured) }
        try await eventually { await socket.actions.contains { $0["mid"].stringValue == captured.mid } }
        let retained = try #require(client.pendingIntents[captured.mid])
        #expect(retained.viewToken == "left"); #expect(retained.draft?.compositionID == captured.draft.compositionID)
        await client.releaseViewSession("left")
        #expect(client.pendingOperations[captured.mid]?.state != .ambiguous)
        #expect(await socket.isClosed() == false)
        let outgoing = try #require(await socket.actions.first { $0["mid"].stringValue == captured.mid })
        try await socket.enqueue(testAck(outgoing, target: "session:a", data: .object(["instance": .string("a"), "queueId": .string("q-1"), "operation": .string(captured.mid)])) )
        if case .accepted = await sending.value {} else { Issue.record("Matching receipt did not resolve") }
        #expect(client.viewDraft("left", conversationID: "a").text.isEmpty)
        #expect(client.viewDraft("right", conversationID: "a").text == "right prompt")
        await client.disconnect()
    }
    @Test func lateReceiptCannotClearAnEditedWindowDraft() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left")
        try await eventually { await MainActor.run { client.conversation("a").initialized && client.connection.isLive } }
        client.setViewDraft(Draft(text: "old"), forView: "left", conversationID: "a")
        let captured = try client.captureDraft(forView: "left"), socket = try #require(await factory.socket(1))
        let sending = Task { await client.submit(captured) }
        try await eventually { await socket.actions.contains { $0["mid"].stringValue == captured.mid } }
        client.setViewDraft(Draft(text: "new"), forView: "left", conversationID: "a")
        let outgoing = try #require(await socket.actions.first { $0["mid"].stringValue == captured.mid })
        try await socket.enqueue(testAck(outgoing, target: "session:a", data: .object(["instance": .string("a"), "queueId": .string("q-1"), "operation": .string(captured.mid)])))
        if case .accepted = await sending.value {} else { Issue.record("Late ack did not resolve") }
        #expect(client.viewDraft("left", conversationID: "a").text == "new")
        #expect(client.viewDraft("left", conversationID: "a").delivery == .draft)
        await client.disconnect()
    }
    @Test func duplicateConcurrentSubmissionOfOneCompositionWritesOnlyOneMid() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left")
        try await eventually { await MainActor.run { client.conversation("a").initialized && client.connection.isLive } }
        client.setViewDraft(Draft(text: "one click only"), forView: "left", conversationID: "a")
        let first = try client.captureDraft(forView: "left"), duplicate = try client.captureDraft(forView: "left")
        let sending = Task { await client.submit(first) }, socket = try #require(await factory.socket(1))
        try await eventually { await socket.actions.contains { $0["mid"].stringValue == first.mid } }
        #expect(await client.submit(duplicate) == .notSent(CoreFailure(.refused, "COMPOSITION_IN_FLIGHT")))
        let outgoing = try #require(await socket.actions.first { $0["mid"].stringValue == first.mid })
        try await socket.enqueue(testAck(outgoing, target: "session:a", data: .object(["instance": .string("a"), "queueId": .string("q-1"), "operation": .string(first.mid)])))
        _ = await sending.value
        #expect(await socket.actions.filter { $0["type"].stringValue == "send" }.count == 1)
        await client.disconnect()
    }
    @Test func switchedOrEditedSubmissionRefusesBeforePersistence() async throws {
        let client = NikClient()
        await client.acquireConversation("a", forView: "left")
        client.setViewDraft(Draft(text: "captured"), forView: "left", conversationID: "a")
        let captured = try client.captureDraft(forView: "left")
        await client.acquireConversation("b", forView: "left")
        #expect(await client.submit(captured) == .notSent(CoreFailure(.refused, "STALE_COMPOSITION")))
        #expect(client.pendingIntents.isEmpty)
    }
    @Test func persistenceFailureNeverWritesImmutableViewSubmission() async throws {
        let cache = FailingStore(), factory = NegotiatingFactory(), client = try await client(factory: factory, cache: cache)
        await client.acquireConversation("a", forView: "left")
        try await eventually { await MainActor.run { client.conversation("a").initialized && client.connection.isLive } }
        client.setViewDraft(Draft(text: "keep full payload", attachments: PreviewFixtures.conversation.items[0].images), forView: "left", conversationID: "a")
        await cache.setFailWrites(true)
        let captured = try client.captureDraft(forView: "left")
        if case .notSent = await client.submit(captured) {} else { Issue.record("Failed persistence claimed acceptance") }
        let socket = try #require(await factory.socket(1))
        #expect(await socket.actions.allSatisfy { $0["mid"].stringValue != captured.mid })
        #expect(client.viewDraft("left", conversationID: "a").text == "keep full payload")
        #expect(!client.viewDraft("left", conversationID: "a").attachments.isEmpty)
        #expect(await client.flushPersistence() == false)
        await cache.setFailWrites(false)
        #expect(await client.flushPersistence() == true)
        await client.disconnect()
    }
    @Test func restoreKeepsBothWindowDraftsAndReadingWithoutOpeningSockets() async throws {
        let factory = ScriptedFactory(), cache = MemoryKeyValueStore(), client = try await client(factory: factory, cache: cache)
        await client.acquireConversation("a", forView: "left"); await client.acquireConversation("a", forView: "right")
        client.setViewDraft(Draft(text: "one"), forView: "left", conversationID: "a")
        client.setViewDraft(Draft(text: "two"), forView: "right", conversationID: "a")
        var reading = ReadingState(); reading.offset = 420; client.setViewReading(reading, forView: "right", conversationID: "a")
        await client.flushPersistence(); await client.disconnect()
        let restoredFactory = ScriptedFactory()
        let restored = NikClient(signingKey: try softwareKey(), secureStore: client.secureStore, cacheStore: cache, socketFactory: restoredFactory)
        await restored.restore()
        #expect(restored.viewDraft("left", conversationID: "a").text == "one")
        #expect(restored.viewDraft("right", conversationID: "a").text == "two")
        #expect(restored.viewSessions["right"]?.reading["a"]?.offset == 420)
        #expect(await restoredFactory.count() == 0)
        #expect(restored.viewSessions.values.allSatisfy { $0.conversationID == nil })
    }
    @Test func featureVisibilityIsTheUnionAndMemoryPressureRetainsVisibleTranscripts() async throws {
        let factory = ScriptedFactory(), client = try await client(factory: factory)
        var features = FeatureVisibility(); features.pr = true
        await client.acquireConversation("a", forView: "left", visibility: features)
        await client.acquireConversation("a", forView: "right", visibility: features)
        try await eventually { await client.conversation("a").initialized }
        let socket = try #require(await factory.socket(1))
        await client.releaseViewSession("left")
        #expect(await socket.actions.allSatisfy { $0["type"].stringValue != "pr:pane" || $0["open"].boolValue != false })
        client.handleMemoryPressure()
        #expect(!client.conversation("a").items.isEmpty)
        await client.disconnect()
    }
    @Test func pendingClickRetainsItsSocketAfterEveryVisibleLeaseHasMovedOrClosed() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        await client.acquireConversation("a", forView: "left"); await client.acquireConversation("a", forView: "right")
        try await eventually { await MainActor.run { client.conversation("a").initialized && client.connection.isLive } }
        client.setViewDraft(Draft(text: "in flight"), forView: "left", conversationID: "a")
        let captured = try client.captureDraft(forView: "left"), socket = try #require(await factory.socket(1))
        let sending = Task { await client.submit(captured) }
        try await eventually { await socket.actions.contains { $0["mid"].stringValue == captured.mid } }
        await client.acquireConversation("b", forView: "left"); await client.releaseViewSession("right")
        #expect(await socket.isClosed() == false)
        #expect(client.pendingOperations[captured.mid]?.state != .ambiguous)
        let outgoing = try #require(await socket.actions.first { $0["mid"].stringValue == captured.mid })
        try await socket.enqueue(testAck(outgoing, target: "session:a", data: .object(["instance": .string("a"), "queueId": .string("q-1"), "operation": .string(captured.mid)])))
        if case .accepted = await sending.value {} else { Issue.record("Navigation tore down a pending click") }
        #expect(await socket.isClosed())
        #expect(client.viewDraft("left", conversationID: "a").text.isEmpty)
        #expect(client.viewSessions["left"]?.conversationID == "b")
        await client.disconnect()
    }
    @Test func outboxAloneRestoresNewestCompositionAfterAnOlderAcceptedDraft() async throws {
        let cache = MemoryKeyValueStore(), secure = MemoryKeyValueStore(), pairing = try record()
        try await secure.set(WireCoding.encode(pairing), forKey: PairingService.pairingKey)
        let welcome = try ProtocolWelcome(validating: v2Welcome(device: "device1")), scope = welcome.receipts!.scope
        let repository = PendingIntentRepository(store: cache)
        for (n, text) in [(1, "already accepted"), (2, "new retained composition")] {
            let mid = String(repeating: String(n), count: 32), payload: JSONValue = .object(["type": .string("send"), "text": .string(text), "mid": .string(mid), "scope": .string(scope), "issuedAt": .number(1_795_179_602_000)])
            var intent = try PendingIntent(hostFingerprint: pairing.fingerprint, engineID: welcome.engineID, scope: scope, principal: "device:device1", target: "session:a", payload: payload,
                draft: Draft(text: text, updatedAt: Date(timeIntervalSince1970: 1_795_179_602)), selection: "a", updatesDraft: true, origin: "left-origin", viewToken: "left")
            if n == 1 {
                intent.state = .applied
                intent.acknowledgement = try MutationAck(validating: testAck(payload, target: "session:a", data: .object(["instance": .string("a"), "queueId": .string("q-1"), "operation": .string(mid)])))
            }
            try await repository.retain(intent, scope: pairing.scope)
        }
        let restored = NikClient(signingKey: try softwareKey(), secureStore: secure, cacheStore: cache)
        await restored.restore()
        #expect(restored.viewDraft("left", conversationID: "a").text == "new retained composition")
        #expect(restored.viewDraft("left", conversationID: "a").delivery == .ambiguous)
        #expect(restored.viewSessions["left"]?.conversationID == nil)
    }
}
