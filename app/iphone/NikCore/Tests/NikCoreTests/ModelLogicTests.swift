import Foundation
import Testing
@testable import NikCore

@Suite("Wire DTOs and reducers") struct ModelTests {
    @Test func unknownFieldsAndVariantsRoundTrip() throws {
        let raw = try json(#"{"id":"u1","kind":"future","text":"hello","novel":{"a":[true,42,null]}}"#)
        let item = try JSONDecoder().decode(TranscriptItem.self, from: raw.encoded())
        #expect(item.kind == "future"); #expect(try JSONValue.decode(JSONEncoder().encode(item)) == raw)
        let event = try ServerEvent.decode(try json(#"{"type":"future:event","x":42}"#), role: .fleet)
        if case .unknown(let type, let raw) = event { #expect(type == "future:event"); #expect(raw["x"].intValue == 42) } else { Issue.record("Unknown event failed") }
    }
    @Test func missingNullAndNumericFieldsAreTolerant() throws {
        let value = try JSONDecoder().decode(Report.self, from: Data(#"{"totals":{"cost":null,"turns":0},"instance":{"provider":"other"}}"#.utf8))
        #expect(value.totals.cost == nil); #expect(value.totals.turns == 0); #expect(value.totals.tokens.total == nil); #expect(value.instance.provider == .unknown)
        #expect(JSONValue.number(Double(Int.max)).intValue == nil); #expect(JSONValue.number(1.2).intValue == nil)
    }
    @Test func dateConventionsAndZeroUnknown() throws {
        #expect(WireDate.date(.number(0)) == nil)
        #expect(WireDate.date(.number(1_800_000_000_000))?.timeIntervalSince1970 == 1_800_000_000)
        #expect(WireDate.date(.string("2026-11-20T08:00:00.125Z")) != nil)
        #expect(WireDate.date(.string("2026-11-20T08:00:00Z")) != nil)
    }
    @Test func statusDisambiguatesByRole() throws {
        #expect(try ServerEvent.decode(try json(#"{"type":"status","status":"waiting"}"#), role: .conversation("x")) == .conversationStatus(.waiting))
        if case .report(let available, let report, _) = try ServerEvent.decode(try json(#"{"type":"status","available":true,"report":null}"#), role: .fleet) { #expect(available); #expect(report == nil) } else { Issue.record("Report confused with status") }
    }
    @Test func initReplacesTranscriptPreservesDraftAndReading() {
        var state = ConversationState(id: "x"); state.draft = Draft(text: "private draft"); state.reading.anchorID = "a"
        state.reduce(.initialized(PreviewFixtures.conversation)); state.reduce(.initialized(PreviewFixtures.conversation))
        #expect(state.items.count == PreviewFixtures.conversation.items.count); #expect(state.draft.text == "private draft"); #expect(state.reading.anchorID == "a")
    }
    @Test func cumulativeUpsertsAndLateImage() throws {
        var state = ConversationState(id: "x")
        state.reduce(.items([TranscriptItem(try json(#"{"id":"a","kind":"text","text":"Hi","streaming":true}"#))]))
        state.reduce(.items([TranscriptItem(try json(#"{"id":"a","text":"Hi there","images":[{"name":"x","mediaType":"image/png","data":"AAAA"}]}"#))]))
        #expect(state.items.count == 1); #expect(state.items[0].text == "Hi there"); #expect(state.items[0].kind == "text"); #expect(state.items[0].images.count == 1)
    }
    @Test func trimmingRetainsUnresolvedPermission() throws {
        var snapshot = PreviewFixtures.conversation; snapshot.raw["maxItems"] = .number(2)
        snapshot.raw["items"] = .array([try json(#"{"id":"p","kind":"permission","requestId":"p","name":"Bash","input":{}}"#)] + (0..<4).map { .object(["id":.string("t\($0)"),"kind":.string("text"),"text":.string("\($0)")]) })
        var state = ConversationState(id: "x"); state.reduce(.initialized(snapshot)); #expect(state.items.count == 5); #expect(state.permissions.count == 1)
        state.reduce(.items([TranscriptItem(try json(#"{"id":"p","resolved":"allow"}"#))])); #expect(state.items.count == 2); #expect(state.dropped == snapshot.dropped + 3)
    }
    @Test func resetAndReturnedDraftSpacing() {
        var state = ConversationState(id: "x"); state.draft.text = "existing"; state.reading.findQuery = "test"
        state.reduce(.draft("appended")); #expect(state.draft.text == "existing\nappended")
        state.reduce(.editPrompt("reclaimed")); #expect(state.draft.text == "reclaimed\n\nexisting\nappended")
        state.reduce(.reset); #expect(state.items.isEmpty); #expect(state.reading.findQuery.isEmpty); #expect(state.draft.text.hasPrefix("reclaimed"))
    }
    @Test func elapsedFreezesAndQueueUsesServerDeadline() {
        let now = Date(); var state = ConversationState(id: "x"); state.stats = PreviewFixtures.conversation.stats; state.statsReceivedAt = now; state.drainAt = now.addingTimeInterval(5)
        #expect(state.runningElapsed(at: now.addingTimeInterval(3), live: true) == state.stats.elapsedMs / 1000 + 3)
        #expect(state.runningElapsed(at: now.addingTimeInterval(3), live: false) == state.stats.elapsedMs / 1000)
        #expect(state.queueRemaining(at: now.addingTimeInterval(7)) == 0)
    }
    @Test func terminalStreamFinalReplacementAndDuplicateWireIDs() throws {
        var state = TerminalState(); let descriptor = PreviewFixtures.terminal
        var first = TerminalRun(PreviewFixtures.runs.arrayValue[0]); first.raw["id"] = .string("same"); first.raw["done"] = .bool(false)
        state.reduce(.began(descriptor, first)); state.reduce(.output(terminal: descriptor.id, run: "same", stream: "err", text: "streamed"))
        first.raw["done"] = .bool(true); first.raw["output"] = .string("authoritative"); state.reduce(.done(descriptor, first))
        var second = first; second.raw["at"] = .number(first.number("at") + 1000); second.raw["command"] = .string("pwd"); second.raw["done"] = .bool(false); second.raw["output"] = .string("")
        state.reduce(.began(descriptor, second)); state.reduce(.output(terminal: descriptor.id, run: "same", stream: "out", text: "latest"))
        #expect(state.runsByTerminal[descriptor.id]?.count == 2); #expect(state.runsByTerminal[descriptor.id]?[0].output == "authoritative"); #expect(state.runsByTerminal[descriptor.id]?[1].output == "latest")
    }
    @Test func slackPagingDedupeAndStaleSelection() {
        var state = SlackFeatureState(); let page = PreviewFixtures.slackThread
        state.selection = SlackThreadID(conversation: "D1"); state.reduce(.thread(page)); #expect(state.selectedThread?.messages.count == 2)
        state.reduce(.older(page)); #expect(state.selectedThread?.messages.count == 2)
        var stale = page; stale.raw["thread"] = .string("other"); state.reduce(.thread(stale)); #expect(state.threads.count == 1)
        #expect(state.selectedThread?.messages[0].files.count == 1)
    }
    @Test func prKeepsLastGoodSnapshotAndRejectsStaleMentions() {
        var state = PRFeatureState(); let url = PreviewFixtures.pr.url!; state.url = url; state.snapshot = PreviewFixtures.pr; state.mentionQuery = "ni"
        state.reduce(.state(PRStateEvent(.object(["prUrl":.string(url),"state":.null,"loading":.bool(false),"error":.string("network")]))))
        #expect(state.snapshot != nil); #expect(state.error == "network")
        state.reduce(.mentions(PRMentions(.object(["url":.string("other"),"query":.string("ni")])))); #expect(state.mentions == nil)
        state.reduce(.mentions(PRMentions(.object(["url":.string(url),"query":.string("ni")])))); #expect(state.mentions != nil)
    }
    @Test func reportScopeUnknownVsZeroAndDisclosures() {
        var state = ReportState(); state.expandedSections = ["tools"]
        state.receive(available: true, value: PreviewFixtures.report, trouble: nil, at: Date()); state.receive(available: true, value: nil, trouble: "failed", at: Date())
        #expect(state.report != nil); #expect(state.isStale); #expect(state.expandedSections == ["tools"])
        #expect(Report().totals.cost == nil); #expect(Report(.object(["totals":.object(["cost":.number(0)])])).totals.cost == 0)
        #expect(Report(.object(["instance": .object(["provider": .string("codex")]), "totals": .object(["cost": .number(0)])])).reportedCost == nil)
        #expect(PreviewFixtures.report.plainText(stale: true).contains("Kept-window")); #expect(PreviewFixtures.report.plainText(stale: true).contains("stale"))
    }
    @Test func allPreviewModelsHaveRealData() async {
        await MainActor.run {
            let factory: @MainActor () -> NikClient = NikClient.preview
            let client = factory(); #expect(client.fleet.rows.count == 7); #expect(client.fleet.codex.count == 3); #expect(client.conversation("claude-1").permissions.count == 1)
            #expect(client.prSnapshot?.threads.count == 1); #expect(client.terminal.runs.count == 2); #expect(client.slack.selectedThread?.messages.count == 2); #expect(client.report.report?.turns.count == 7)
        }
    }
}
@Suite("Composer, fleet and feature pure logic") struct LogicTests {
    @Test func nodeSnippetVectors() throws {
        for row in try fixture("rendering")["snippets"].arrayValue {
            let table = row["table"].objectValue.compactMapValues(\.stringValue); let actual = SnippetExpander.expand(row["source"].stringValue!, snippets: table)
            #expect(actual.text == row["expected"]["text"].stringValue); #expect(actual.sent == row["expected"]["sent"].stringValue); #expect(actual.used == row["expected"]["used"].arrayValue.compactMap(\.stringValue))
        }
    }
    @Test func localCommandsRequireBareNoAttachment() {
        #expect(SnippetExpander.localIntent(text: " /status ", attachmentCount: 0) == .report)
        #expect(SnippetExpander.localIntent(text: "/status more", attachmentCount: 0) == nil); #expect(SnippetExpander.localIntent(text: "/slack", attachmentCount: 1) == nil)
    }
    @Test func paletteDynamicRankingAndSuffix() throws {
        let c = RenderConfiguration(try json(#"{"slashCommands":["project:test","model","effort","brief"],"snippets":{"brief":"Be brief."},"commandArgs":{"model":["claude-opus",{"value":"opus","label":"Opus","detail":"smart"}]}}"#))
        let plan = try #require(SlashPalette.plan("/model op", configuration: c, current: ["model":"opus"]))
        #expect(plan.matches.map(\.value) == ["opus", "claude-opus"]); #expect(plan.matches[0].note.contains("current"))
        #expect(SlashPalette.plan("text /", configuration: c)?.matches.map(\.value) == ["brief"])
        #expect(SlashPalette.plan("https://host/path", configuration: c) == nil); #expect(SlashPalette.plan("src/path", configuration: c) == nil)
        let commands = try #require(SlashPalette.plan("/mo", configuration: c)); #expect(SlashPalette.apply(commands, index: 0, configuration: c)?.text == "/model "); #expect(SlashPalette.apply(commands, index: 0, configuration: c)?.more == true)
    }
    @Test func recallDedupeAndDraftRestoration() {
        var recall = PromptHistory(limit: 2)
        let first = recall.remember("first", itemID: "1"), duplicate = recall.remember("first", itemID: "2"), seen = recall.remember("other", itemID: "1")
        #expect(first); #expect(!duplicate); #expect(!seen); recall.remember("second", itemID: "3")
        #expect(recall.older(draft: "private") == "second"); #expect(recall.older(draft: "ignored") == "first"); #expect(recall.newer() == "second"); #expect(recall.newer() == "private")
        _ = recall.older(draft: "draft"); recall.edited("changed"); #expect(recall.index == nil)
    }
    @Test func suggestionsMatchNode() throws { for row in try fixture("rendering")["replies"].arrayValue { #expect(ReplySuggestions.replies(row["source"].stringValue!) == row["expected"].arrayValue.compactMap(\.stringValue)) } }
    @Test func providerQualifiedMergeAndScopes() throws {
        let active = [FleetRow(try json(#"{"id":"live","sessionId":"same","label":"Current","status":"working","cwd":"/x"}"#)), FleetRow(try json(#"{"id":"cx-same","provider":"codex","cwd":"/x"}"#))]
        let past = [HistoryEntry(try json(#"{"sessionId":"same","provider":"claude","label":"Old","modified":2000}"#)), HistoryEntry(try json(#"{"sessionId":"same","provider":"codex","label":"Codex","modified":3000}"#)), HistoryEntry(try json(#"{"sessionId":"older","provider":"claude","label":"Archive","modified":1000}"#))]
        let merged = FleetLogic.merge(active: active, history: past); #expect(merged.count == 3); #expect(merged.first(where: { $0.provider == .claude && $0.transcriptID == "same" })?.id == "live")
        #expect(merged.first(where: { $0.provider == .codex })?.id == "cx-same")
        var fleet = Fleet(); fleet.raw["instances"] = .array(active.filter { $0.provider == .claude }.map(\.raw)); fleet.raw["codex"] = .array(active.filter { $0.provider == .codex }.map(\.raw))
        let history = HistorySnapshot(.object(["entries":.array(past.map(\.raw))]))
        #expect(FleetLogic.list(fleet: fleet, history: history, scope: .active).count == 2)
        #expect(FleetLogic.list(fleet: fleet, history: history, scope: .earlier).count == 3)
        #expect(FleetLogic.list(fleet: fleet, history: history, scope: .active, query: "archive").first?.past == true)
    }
    @Test func attentionAndFolderOrdering() {
        let rows = FleetLogic.merge(active: PreviewFixtures.fleet.rows, history: [])
        let groups = FleetLogic.attentionGroups(rows); #expect(groups.first?.name == "Needs you"); #expect(groups.first?.rows.count == 2)
        #expect(groups[1].kind == "working"); #expect(PreviewFixtures.fleet.codex.first?.project?.name == "NikUI")
        #expect(groups.flatMap(\.rows).count == rows.count)
        #expect(FleetLogic.folderGroups(rows, folders: [NamedFolder(.object(["id":.string("empty"),"name":.string("Empty")]))], includeEmpty: true).contains { $0.name == "Empty" && $0.rows.isEmpty })
        #expect(FleetLogic.list(fleet: PreviewFixtures.fleet, history: PreviewFixtures.history, query: "nikui", provider: .codex, projectPath: "/no-match").isEmpty)
    }
    @Test func runnableIsConservative() {
        #expect(RunnableCode.looksRunnable(language: "bash", code: "echo hi;")); #expect(!RunnableCode.looksRunnable(language: "swift", code: "echo hi"))
        #expect(RunnableCode.looksRunnable(language: nil, code: "$ git status\n# pwd")); #expect(!RunnableCode.looksRunnable(language: nil, code: "const x = 42;"))
        #expect(RunnableCode.clean("$ git status\n# pwd") == "git status\npwd")
    }
    @Test func notificationsDedupFilterRouteRedact() throws {
        var coordinator = NotificationCoordinator(); var prefs = NotificationPreferences(); prefs.on = true
        let event = NotificationEvent(try json(#"{"kind":"slack","at":1800000000000,"tag":"slack:D1","conversation":"D1","title":"Maya","body":"Private"}"#))
        #expect(coordinator.receive(event, preferences: prefs, locked: true)?.body == "Open NikUI to view.")
        #expect(coordinator.receive(event, preferences: prefs, locked: false) == nil)
        #expect(NotificationCoordinator.destination(event) == .slack("D1")); prefs.on = false
        #expect(coordinator.receive(NotificationEvent(try json(#"{"kind":"failed","at":1}"#)), preferences: prefs, locked: false) == nil)
    }
    @Test func diffLineNumbers() {
        let files = UnifiedDiffParser.parse("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,2 +20,2 @@\n same\n-old\n+new")
        #expect(files[0].path == "x"); let deletion = files[0].lines.first { $0.kind == .deletion }; #expect(deletion?.oldLine == 11); #expect(files[0].lines.last?.newLine == 21)
    }
    @Test func wavAndComposerSelection() throws {
        let wav = try WAV.pcm16(Array(repeating: 0, count: 16000)); #expect(try WAV.inspect(wav).seconds == 1); #expect(wav.count == 32044)
        expectFailure(.invalidInput) { _ = try WAV.inspect(Data("not a WAV".utf8)) }
        let inserted = WAV.insert("dictated words", into: "Hello world", selection: 5..<5); #expect(inserted.text == "Hello dictated words world"); #expect(inserted.caret == 20)
    }
    @Test func actionValidationAndWireBudgets() throws {
        expectFailure(.invalidInput) { try ClientAction.send(text: "").validate(on: .conversation("x")) }
        expectFailure(.invalidInput) { try ClientAction.terminalList.validate(on: .conversation("x")) }
        expectFailure(.invalidInput) { try ClientAction.slackOpen(conversation: String(repeating: "x", count: 41)).validate(on: .fleet) }
        let image = Attachment(.object(["name":.string("image.png"),"mediaType":.string("image/png"),"data":.string(Data(repeating: 255, count: 10 * 1024 * 1024).base64EncodedString())]))
        try ClientAction.send(text: "", attachments: [image]).validate(on: .conversation("x"))
        expectFailure(.tooLarge) { try ClientAction.send(text: "", attachments: [image, image]).validate(on: .conversation("x")) }
    }
}
