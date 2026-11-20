import Foundation
import Testing
@testable import NikCore

@Suite("Retention and cross-generation regressions") struct RegressionTests {
    @Test func renderConfigurationDoesNotRetainTranscriptEnvelope() {
        var state = ConversationState(id: "x"); state.reduce(.initialized(PreviewFixtures.conversation))
        #expect(state.configuration.raw["items"].isNull); #expect(state.configuration.raw["queue"].isNull)
        state.reduce(.reset); #expect(state.items.isEmpty); #expect(state.configuration.raw["items"].isNull)
    }
    @Test func prDraftsAndTabsStayWithTheirURL() {
        var state = PRFeatureState()
        state.reduce(.state(PRStateEvent(.object(["prUrl":.string("https://github.com/a/b/pull/1")])))); state.drafts["comment"] = "For PR one"; state.tab = "files"
        state.reduce(.state(PRStateEvent(.object(["prUrl":.string("https://github.com/a/b/pull/2")])))); #expect(state.drafts.isEmpty); #expect(state.tab == "conversation")
        state.drafts["comment"] = "For PR two"
        state.reduce(.state(PRStateEvent(.object(["prUrl":.string("https://github.com/a/b/pull/1")])))); #expect(state.drafts["comment"] == "For PR one"); #expect(state.tab == "files")
    }
    @Test func terminalUnicodeOutputIsBoundedInUTF16() {
        var state = TerminalState(); var run = TerminalRun(PreviewFixtures.runs.arrayValue[1]); run.raw["output"] = .string("")
        state.reduce(.began(PreviewFixtures.terminal, run)); state.reduce(.output(terminal: run.terminal, run: run.id, stream: "out", text: String(repeating: "👋", count: 150_000)))
        #expect(state.runsByTerminal[run.terminal]!.last!.output.utf16.count <= 200 * 1024 + 2)
    }
    @Test func findUsesRenderedTextAcrossInlineFormatting() throws {
        let item = TranscriptItem(try json(#"{"id":"a","kind":"text","text":"Hello **world** and `code`."}"#))
        let hits = TranscriptSearch.matches("hello world", items: [item]); #expect(hits.count == 1); #expect(hits[0].range == 0..<11)
    }
    @Test func adversarialUnclosedMarkdownStillPreservesText() {
        let source = String(repeating: "[", count: 10_000)
        #expect(MarkdownParser.inline(source).map(\.text).joined() == source)
    }
    @Test @MainActor func offlineDirectActionKeepsFullDraft() async {
        let client = NikClient(); let images = PreviewFixtures.conversation.items[0].images
        let result = await client.perform(.send(text: "Offline words", attachments: images), on: .conversation("x"))
        if case .notSent(let e) = result { #expect(e.code == .offline) } else { Issue.record("Offline action was sent") }
        #expect(client.conversation("x").draft.text == "Offline words"); #expect(client.conversation("x").draft.attachments == images)
    }
    @Test @MainActor func uncorrelatedRefusalDoesNotInventWhichPromptFailed() async throws {
        let (client, _) = try await FacadeTests().liveClient(); await client.selectConversation("claude-1"); try await eventually { await client.conversation("claude-1").initialized }
        _ = await client.perform(.send(text: "First"), on: .conversation("claude-1")); _ = await client.perform(.send(text: "Second"), on: .conversation("claude-1"))
        client.ingest(.refused(what: "send", reason: "control changed", id: nil), on: .conversation("claude-1"))
        let submissions = client.pendingOperations.values.filter { $0.action == "send" }
        #expect(submissions.count == 2); #expect(submissions.allSatisfy { $0.state == .ambiguous }); #expect(client.conversation("claude-1").draft.text == "Second")
        await client.disconnect()
    }
    @Test @MainActor func prTimeoutRetainsDraftAndDoesNotReplay() async throws {
        let clock = TestClock(); let (client, factory) = try await FacadeTests().liveClient(clock: clock)
        // This test advances the PR receipt deadline, independently of history freshness.
        client.ingest(.history(PreviewFixtures.history))
        await client.selectConversation("claude-1"); try await eventually { await client.conversation("claude-1").initialized }
        client.setPRDraft("Keep this comment", conversationID: "claude-1")
        let operation = Task { await client.perform(.prComment("Keep this comment"), on: .conversation("claude-1")) }
        try await eventually { clock.hasSleeper(after: 12) }; clock.advance(13)
        if case .ambiguous = await operation.value {} else { Issue.record("Timed-out PR mutation was treated as known delivery") }
        #expect(client.conversation("claude-1").pr.drafts["comment"] == "Keep this comment")
        let socket = try #require(await factory.socket(1)); #expect(await socket.actions.filter { $0["type"].stringValue == "pr:comment" }.count == 1)
        await client.disconnect()
    }
    @Test @MainActor func canceledTaskDoesNotWrite() async throws {
        let (client, factory) = try await FacadeTests().liveClient()
        let operation = Task { await client.perform(.setAwake(false)) }; operation.cancel()
        if case .notSent(let e) = await operation.value { #expect(e.code == .canceled) } else { Issue.record("Canceled operation wrote to socket") }
        let socket = try #require(await factory.socket()); #expect(!(await socket.actions.contains { $0["type"].stringValue == "awake:set" }))
        await client.disconnect()
    }
    @Test @MainActor func staleManagerEventCannotChangeNewPairingState() async throws {
        let (client, _) = try await FacadeTests().liveClient()
        await client.receive(.event(.fleet, .device(Seat(.object(["id":.string("attacker"),"control":.bool(false)])))), managerID: UUID())
        #expect(client.seat?.id == "device1")
        client.ingest(.device(Seat(.object(["id": .string("device1"), "control": .bool(false)]))))
        await client.receive(.welcome(.conversation("claude-1"), Seat(.object(["id": .string("device1"), "control": .bool(true)])), version: nil))
        #expect(client.seat?.control == false); await client.disconnect()
    }
    @Test @MainActor func tokenWaitsForVerifiedWelcomeAndIsUnconfirmed() async throws {
        let store = MemoryKeyValueStore(), factory = ScriptedFactory(); await store.set(try JSONEncoder().encode(record()), forKey: PairingService.pairingKey)
        let client = NikClient(signingKey: try softwareKey(), secureStore: store, socketFactory: factory); await client.restore()
        let token = String(repeating: "ab", count: 32); _ = await client.perform(.appleToken(token)); await client.connect()
        try await eventually { if let socket = await factory.socket() { return await socket.actions.contains { $0["type"].stringValue == "@apple" } }; return false }
        #expect(!client.diagnostics().contains(token)); #expect(client.diagnostics().contains("not offered")); await client.disconnect()
    }
    @Test @MainActor func promptDisconnectCannotRelabelANewerAttachmentDraft() async throws {
        let (client, _) = try await FacadeTests().liveClient()
        await client.selectConversation("claude-1"); try await eventually { await client.conversation("claude-1").initialized }
        client.setDraft(Draft(text: "Same words"), conversationID: "claude-1")
        _ = await client.send(conversationID: "claude-1")
        var next = client.conversation("claude-1").draft
        next.attachments = PreviewFixtures.conversation.items[0].images
        client.setDraft(next, conversationID: "claude-1")
        #expect(client.conversation("claude-1").draft.delivery == .draft)
        await client.disconnect()
        #expect(client.conversation("claude-1").draft.delivery == .draft)
        #expect(client.conversation("claude-1").draft.attachments == next.attachments)
    }
    @Test @MainActor func slackReceiptCannotRelabelANewerDraft() async throws {
        let (client, _) = try await FacadeTests().liveClient(); client.ingest(.slack(.state(PreviewFixtures.slack)))
        client.setSlackDraft("First reply", conversation: "D1")
        let task = Task { await client.perform(.slackReply(id: "draft-revision", conversation: "D1", text: "First reply")) }
        try await eventually { await client.pendingOperations["draft-revision"]?.state == .submitted }
        client.setSlackDraft("Next reply", conversation: "D1")
        client.ingest(.slack(.sent(id: "draft-revision", ok: true, reason: nil)))
        if case .accepted = await task.value {} else { Issue.record("The correlated receipt was not accepted") }
        let next = client.slack.threads[SlackThreadID(conversation: "D1")]
        #expect(next?.draft.text == "Next reply"); #expect(next?.draft.delivery == .draft); #expect(next?.pending == nil)
        await client.disconnect()
    }
    @Test @MainActor func visibilitySetBeforeConnectReachesTheFirstManager() async throws {
        let store = MemoryKeyValueStore(), factory = ScriptedFactory()
        await store.set(try JSONEncoder().encode(record()), forKey: PairingService.pairingKey)
        let client = NikClient(signingKey: try softwareKey(), secureStore: store, socketFactory: factory)
        await client.restore()
        var visibility = FeatureVisibility(); visibility.settings = true; visibility.terminal = true
        await client.setVisibility(visibility); await client.selectConversation("claude-1"); await client.connect()
        try await eventually {
            guard let fleet = await factory.socket(0), let chat = await factory.socket(1) else { return false }
            let fleetReady = await fleet.actions.contains { $0["type"].stringValue == "term:list" }
            let chatReady = await chat.actions.contains { $0["type"].stringValue == "settingsOpen" && $0["open"].boolValue == true }
            return fleetReady && chatReady
        }
        await client.disconnect()
    }
    @Test @MainActor func forgettingWhilePairingCannotResurrectIdentity() async throws {
        let vectors = try fixture(), http = HoldingHTTP(), store = MemoryKeyValueStore()
        let client = NikClient(signingKey: try softwareKey(), secureStore: store, http: http)
        let invitation = PairingInvitation(baseURL: URL(string: "https://laptop.example")!, code: "23ABCDEF", fingerprint: vectors["fingerprint"].stringValue)
        let pairing = Task { await client.pair(invitation) }; try await eventually { await http.started }
        let forgetting = Task { await client.forgetLaptop(deleteKey: false) }; try await eventually { await client.clientGeneration > 0 }
        await http.release(HTTPResponse(status: 200, data: try JSONValue.object(["device":.string("device1"),"serverKey":vectors["hostSPKI"],"fingerprint":vectors["fingerprint"]]).encoded()))
        _ = await pairing.value; _ = await forgetting.value
        #expect(client.pairedConnection == nil); #expect(await store.data(forKey: PairingService.pairingKey) == nil)
    }
    @Test @MainActor func slashControlsPreserveTextImagesAndUnresolvedDelivery() async throws {
        let (client, factory) = try await FacadeTests().liveClient()
        await client.selectConversation("claude-1")
        try await eventually { await client.conversation("claude-1").initialized }
        client.setDraft(Draft(text: "Keep this /concise", attachments: PreviewFixtures.conversation.items[0].images), conversationID: "claude-1")
        _ = await client.send(conversationID: "claude-1")
        let saved = client.conversation("claude-1").draft
        let tracked = client.pendingOperations.count
        let result = await client.sendControlCommand("/model sonnet", conversationID: "claude-1")
        #expect(client.pendingOperations.count == tracked)
        if case .submitted = result {} else { Issue.record("Control was not submitted") }
        #expect(client.conversation("claude-1").draft == saved)
        let socket = try #require(await factory.socket(1))
        #expect(await socket.actions.contains { $0["type"].stringValue == "send" && $0["text"].stringValue == "/model sonnet" })
        await client.disconnect()
        let offline = client.conversation("claude-1").draft
        if case .notSent = await client.sendControlCommand("/review", conversationID: "claude-1") {} else { Issue.record("Offline control was sent") }
        #expect(client.conversation("claude-1").draft == offline)
    }
    @Test @MainActor func unrelatedUserAndQueueEventsCannotConfirmPromptDelivery() async throws {
        let (client, _) = try await FacadeTests().liveClient()
        await client.selectConversation("claude-1")
        try await eventually { await client.conversation("claude-1").initialized }
        client.setDraft(Draft(text: "Unacknowledged"), conversationID: "claude-1")
        _ = await client.send(conversationID: "claude-1")
        client.ingest(.items([TranscriptItem(.object(["id": .string("other-device"), "kind": .string("user"), "text": .string("Another person's prompt")]))]), on: .conversation("claude-1"))
        client.ingest(.queue([QueueEntry(.object(["id": .string("unrelated-queue"), "text": .string("Different text")]))], drainAt: nil), on: .conversation("claude-1"))
        #expect(client.conversation("claude-1").draft.text == "Unacknowledged")
        #expect(client.conversation("claude-1").draft.delivery == .submitted)
        client.markDraftReviewed(conversationID: "claude-1", clear: false)
        #expect(client.conversation("claude-1").draft.delivery == .draft)
        await client.disconnect()
    }
    @Test @MainActor func snapshotTimeoutKeepsValuesAndAnIdenticalReplyCompletesRefresh() async throws {
        let clock = TestClock()
        let client = NikClient(clock: clock)
        client.ingest(.history(PreviewFixtures.history))
        let previous = client.history
        let revision = client.historyStatus.revision
        client.beginSnapshot("history")
        #expect(client.historyStatus.isLoading)
        try await eventually { clock.hasSleeper(after: 12) }
        clock.advance(13)
        try await eventually { await client.historyStatus.error != nil }
        #expect(client.history == previous)
        #expect(!client.historyStatus.isLoading)
        client.beginSnapshot("history")
        client.ingest(.history(previous))
        #expect(client.historyStatus.revision == revision + 1)
        #expect(client.historyStatus.error == nil)
        #expect(!client.historyStatus.isLoading)
    }
    @Test @MainActor func reportDisclosureAndSnapshotsStayInTheirScope() {
        let client = NikClient()
        client.setReportSections(["Tools"], conversationID: "a")
        client.setReportSections(["Projects"])
        client.ingest(.report(available: true, report: PreviewFixtures.report, trouble: nil))
        client.ingest(.statusReport(Report(.object(["instance": .object(["id": .string("a")])]))), on: .conversation("a"))
        #expect(client.report.report == PreviewFixtures.report)
        #expect(client.conversation("a").report.report?.instance.id == "a")
        #expect(client.report.expandedSections == ["Projects"])
        #expect(client.conversation("a").report.expandedSections == ["Tools"])
        #expect(client.conversation("a").report.disclosuresInitialized)
        #expect(client.report.revision == 1)
        client.ingest(.report(available: false, report: nil, trouble: nil))
        #expect(client.report.report == PreviewFixtures.report)
        #expect(client.report.isStale)
    }
    @Test func permissionArgumentsAreSearchableAndEditPromptStartsANewComposition() throws {
        #expect(throws: CoreFailure.self) {
            try ClientAction.saveCommand(name: "nameé", prompt: "Prompt", description: "").validate(on: .conversation("a"))
        }
        let permission = TranscriptItem(try json(#"{"id":"p","kind":"permission","name":"Read","input":{"file_path":"/tmp/needle.txt"}}"#))
        #expect(TranscriptSearch.matches("needle", items: [permission]).count == 1)
        var state = ConversationState(id: "a")
        state.draft = Draft(text: "Older", delivery: .submitted)
        state.reduce(.editPrompt("Reclaimed"))
        #expect(state.draft.text == "Reclaimed\n\nOlder")
        #expect(state.draft.delivery == .draft)
        #expect(state.editPromptRevision == 1)
    }

    @Test @MainActor func privacySuspensionImmediatelyRefusesWritesBeforeSocketShutdown() async throws {
        let (client, factory) = try await FacadeTests().liveClient()
        client.suspendForPrivacy(.inactive)
        #expect(!client.mayControl)
        if case .notSent(let failure) = await client.perform(.setAwake(false)) { #expect(failure.code == .locked) }
        else { Issue.record("A write escaped the synchronous privacy gate") }
        let socket = try #require(await factory.socket())
        #expect(!(await socket.actions.contains { $0["type"].stringValue == "awake:set" }))
        await client.setLifecycle(.inactive)
        await client.disconnect()
    }
    @Test @MainActor func historyFailureRetainsTheLastGoodEntries() {
        let client = NikClient()
        client.ingest(.history(PreviewFixtures.history))
        let previous = client.history.entries
        client.ingest(.history(HistorySnapshot(.object(["available": .bool(true), "trouble": .string("History read failed")]))))
        #expect(client.history.entries == previous)
        #expect(client.history.trouble == "History read failed")
        client.ingest(.history(HistorySnapshot(.object(["available": .bool(true), "entries": .array([])]))))
        #expect(client.history.entries.isEmpty)
        #expect(client.history.trouble == nil)
    }
    @Test func avFoundationMetadataNormalizesWithoutReencodingPCM() throws {
        let samples = [Int16](repeating: 123, count: 4_800)
        let canonical = try WAV.pcm16(samples)
        var withMetadata = canonical
        withMetadata.insert(contentsOf: Array("JUNK".utf8) + [3, 0, 0, 0, 1, 2, 3, 0], at: 12)
        let riffSize = withMetadata.count - 8
        for i in 0..<4 { withMetadata[4 + i] = UInt8(truncatingIfNeeded: riffSize >> (i * 8)) }
        #expect(try WAV.canonicalPCM16(withMetadata) == canonical)
        #expect(try WAV.inspect(WAV.canonicalPCM16(withMetadata)).seconds == 0.3)
        withMetadata.removeLast()
        #expect(throws: CoreFailure.self) { try WAV.canonicalPCM16(withMetadata) }
    }

    @Test @MainActor func pairingStartedBeforeInactivityKeepsMemoryAndDurablePointerConsistent() async throws {
        let vectors = try fixture(), http = HoldingHTTP(), store = MemoryKeyValueStore()
        let client = NikClient(signingKey: try softwareKey(), secureStore: store, http: http)
        let invitation = PairingInvitation(baseURL: URL(string: "https://laptop.example")!, code: "23ABCDEF", fingerprint: vectors["fingerprint"].stringValue)
        let pairing = Task { await client.pair(invitation) }
        try await eventually { await http.started }
        client.suspendForPrivacy(.inactive)
        await http.release(HTTPResponse(status: 200, data: try JSONValue.object(["device":.string("device1"),"serverKey":vectors["hostSPKI"],"fingerprint":vectors["fingerprint"]]).encoded()))
        if case .paired(let connection) = await pairing.value {
            #expect(client.pairedConnection == connection)
            let data = try #require(await store.data(forKey: PairingService.pairingKey))
            #expect(try JSONDecoder().decode(PairedConnection.self, from: data) == connection)
            #expect(!client.connection.isLive)
            #expect(!client.mayControl)
        } else { Issue.record("An authorized pairing completed with an inconsistent local pointer") }
        if case .failed(let failure) = await client.pair(invitation) { #expect(failure.code == .locked) }
        else { Issue.record("A new pairing started while inactive") }
    }

}
private actor HoldingHTTP: HTTPClient {
    private var continuation: CheckedContinuation<HTTPResponse, Never>?
    private(set) var started = false
    func send(_ request: URLRequest) async -> HTTPResponse { started = true; return await withCheckedContinuation { continuation = $0 } }
    func release(_ response: HTTPResponse) { continuation?.resume(returning: response); continuation = nil }
}
