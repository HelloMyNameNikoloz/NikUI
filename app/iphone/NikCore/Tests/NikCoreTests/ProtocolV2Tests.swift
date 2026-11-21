import Foundation
import Testing
@testable import NikCore

private func protocolVectors(_ file: String) throws -> [JSONValue] {
    var root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return try JSONValue.decode(Data(contentsOf: root.appendingPathComponent("test/fixtures/protocol-v2/" + file + ".json")))["vectors"].arrayValue
}
private func v2Welcome(device: String = "phone-1", optional: Bool = false) throws -> JSONValue {
    var value = try protocolVectors("negotiation")[0]["expected"]["replies"].arrayValue[0]
    value["seat"]["id"] = .string(device)
    if optional { value["caps"] = .array(ProtocolCapabilities.supported.map(JSONValue.string)) }
    return value
}
private let vectorDate = Date(timeIntervalSince1970: 1_795_179_602)
private func vectorContext(_ reconnect: JSONValue = .object([:]), role: SocketRole = .conversation("instance-7")) throws -> IntentContext {
    var welcome = try v2Welcome()
    if let scope = reconnect.objectValue["scope"] { welcome["receipts"]["scope"] = scope }
    if let engine = reconnect.objectValue["engineId"] { welcome["engine"]["id"] = engine }
    if let boot = reconnect.objectValue["boot"] { welcome["engine"]["boot"] = boot }
    welcome["receipts"]["now"] = reconnect.objectValue["now"] ?? .number(1_795_179_602_000)
    let session = reconnect["proto"].intValue == 1 ? ProtocolSession(receivedAt: vectorDate) : ProtocolSession(welcome: try ProtocolWelcome(validating: welcome), receivedAt: vectorDate)
    return IntentContext(pairingScope: "fixture-pairing", hostFingerprint: reconnect["hostFingerprint"].stringValue ?? "synthetic-pin", principal: "device:phone-1", role: role, session: session)
}
private func tempOutboxDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nikcore-v2-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

@Suite("Protocol v2 runtime models and exact-envelope recovery") struct ProtocolV2Tests {
    @Test func productionCanonicalizerMatchesAllSharedHashVectors() throws {
        let rows = try protocolVectors("canonical-hashing")
        #expect(rows.count == 14)
        for row in rows {
            let message = row["input"].arrayValue[0]["message"], target = row["context"]["target"].stringValue!
            var fields = message.objectValue; fields.removeValue(forKey: "mid"); fields.removeValue(forKey: "scope")
            let bytes = try IntentCanonicalJSON.encode(.object(["message": .object(fields), "target": .string(target)]))
            #expect(bytes == Data(row["hash"]["canonical"].stringValue!.utf8), "\(row["id"])")
            #expect(try IntentCanonicalJSON.hash(message: message, target: target) == row["hash"]["sha256"].stringValue)
        }
        for (number, expected) in [(1e-7, "1e-7"), (1e-6, "0.000001"), (1e20, "100000000000000000000"), (1e21, "1e+21"), (-0.0, "0"), (333333333.3333333, "333333333.3333333")] {
            #expect(try IntentCanonicalJSON.text(.number(number)) == expected)
        }
        expectFailure(.protocolViolation) { _ = try IntentCanonicalJSON.encode(.number(.infinity)) }
    }
    @Test func typedModelsDecodeAllSharedRepliesWithoutLosingBytes() throws {
        var count = 0
        for file in ["negotiation", "receipts", "run-turn-binding", "codex-unknown", "seats-grants", "reconnect-outbox", "mutation-results"] {
            for row in try protocolVectors(file) {
                let role: SocketRole = row["context"]["role"].stringValue == "fleet" ? .fleet : .conversation("instance-7")
                for message in row["expected"]["replies"].arrayValue {
                    switch message["type"].stringValue {
                    case "ack":
                        let ack = try MutationAck(validating: message)
                        #expect(try IntentCanonicalJSON.encode(JSONValue.decode(WireCoding.encode(ack))) == IntentCanonicalJSON.encode(message))
                        if case .ack = try ServerEvent.decode(message, role: role) {} else { Issue.record("Untyped ack") }
                        count += 1
                    case "operation": _ = try ProviderOperation(validating: message); count += 1
                    case "welcome": _ = try ProtocolWelcome(validating: message)
                    case "receipt:missing", "operation:missing": _ = try LookupMissing(validating: message)
                    case "receipt:error", "operation:error": _ = try LookupFailure(validating: message)
                    default: break
                    }
                }
                for step in row["input"].arrayValue where !step["message"]["run"].isNull { _ = try RunRef(validating: step["message"]["run"]) }
            }
        }
        #expect(count > 180)
    }
    @Test func allSharedOutboxRecoveryVectorsUseProtectedPersistence() async throws {
        let rows = try protocolVectors("reconnect-outbox")
        #expect(rows.count == 16)
        for row in rows {
            let id = row["id"].stringValue!, directory = try tempOutboxDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = ProtectedFileStore(directory: directory)
            let initial = row["initial"]["record"].isNull ? row["input"].arrayValue.first(where: { $0["message"]["type"].stringValue == "persist" })?["message"]["record"] ?? .null : row["initial"]["record"]
            if initial.isNull {
                let failure = row["initial"]["persistFailure"].stringValue!
                let limits = PendingIntentLimits(maximumCount: failure == "128-intents" ? 0 : 128, maximumBytes: failure == "32MiB" ? 1 : 32 * 1024 * 1024)
                let failing = FailingStore(); await failing.setFailWrites(failure == "IO_ERROR")
                let repository = PendingIntentRepository(store: failing, limits: limits)
                let payload = row["input"].arrayValue[0]["message"]
                var refused = false
                do { try await repository.retain(PendingIntent(hostFingerprint: "synthetic-pin", engineID: "ae6a9e02284843bb9868f91637382219", scope: payload["scope"].stringValue!, principal: "device:phone-1", target: "session:instance-7", payload: payload), scope: "fixture-pairing") }
                catch { refused = true }
                #expect(refused, "\(id)"); #expect(try await repository.load(scope: "fixture-pairing").isEmpty)
                continue
            }
            let saved = try PendingIntent(validating: initial)
            let first = PendingIntentRepository(store: store)
            try await first.retain(saved, scope: "fixture-pairing")
            // New actor and new FileStore model a phone process restart on real disk.
            let repository = PendingIntentRepository(store: ProtectedFileStore(directory: directory))
            #expect(try await repository.load(scope: "fixture-pairing").first?.plaintext.utf8.elementsEqual(saved.plaintext.utf8) == true)
            let reconnect = row["input"].arrayValue.first(where: { $0["message"]["type"].stringValue == "reconnect" })?["message"] ?? .object([:])
            let context = try vectorContext(reconnect)
            _ = try await repository.recoveryQueries(context: context, at: vectorDate)
            if let outcome = reconnect["receiptOutcome"].stringValue {
                let error: JSONValue = outcome == "unknown" ? .object(["code": .string("OUTCOME_UNKNOWN"), "message": .string("Fixture uncertainty"), "retryable": .bool(false)]) : .null
                _ = try await repository.apply(.ack(MutationAck(validating: testAck(saved.payload, target: saved.target, data: .object([:]), outcome: outcome, error: error))), context: context)
            }
            if let code = reconnect["queryCode"].stringValue {
                let error = try LookupFailure(validating: .object(["type": .string("receipt:error"), "scope": .string(saved.scope), "mid": .string(saved.mid), "code": .string(code), "message": .string("Fixture lookup unavailable")]))
                _ = try await repository.apply(.receiptError(error), context: context)
                #expect(try await repository.record(saved.mid, scope: context.pairingScope)?.lookupFailure?.code.rawValue == code)
            }
            for step in row["input"].arrayValue where step["direction"].stringValue == "server" {
                _ = try await repository.apply(ServerEvent.decode(step["message"], role: context.role), context: context)
            }
            for reply in row["expected"]["replies"].arrayValue { _ = try await repository.apply(ServerEvent.decode(reply, role: context.role), context: context) }
            let resends = try await repository.takeResends(context: context, snapshot: ControlSnapshot(), at: vectorDate)
            #expect(resends.count == (row["expected"]["state"]["autoResend"].boolValue == true ? 1 : 0), "\(id)")
            if let resend = resends.first {
                #expect(resend.plaintext.utf8.elementsEqual(saved.plaintext.utf8)); #expect(resend.mid == saved.mid)
                #expect(try await repository.takeResends(context: context, snapshot: ControlSnapshot(), at: vectorDate).isEmpty)
            }
            let recovered = try #require(await repository.record(saved.mid, scope: "fixture-pairing"))
            #expect(recovered.plaintext.utf8.elementsEqual(saved.plaintext.utf8))
            if row["expected"]["state"]["outbox"].stringValue == "quarantined" { #expect(recovered.isQuarantined, "\(id)") }
            if id == "outbox-accepted-operation-query" {
                #expect(recovered.acknowledgement?.outcome == .applied); #expect(recovered.operation?.state == .unknown)
                let queries = try await repository.recoveryQueries(context: context, at: vectorDate).queries
                #expect(queries.first?["type"].stringValue == "operation:get")
            }
        }
    }
    @Test func pendingAndUnknownAndQueryErrorsNeverAuthorizeAResend() async throws {
        let context = try vectorContext(), rows = try protocolVectors("receipts")
        for name in ["receipt-pending", "receipt-unknown"] {
            let row = try #require(rows.first { $0["id"].stringValue == name })
            let payload = row["input"].arrayValue[0]["message"], repository = PendingIntentRepository(store: MemoryKeyValueStore())
            let record = try PendingIntent(hostFingerprint: "synthetic-pin", engineID: context.session.welcome!.engineID, scope: payload["scope"].stringValue!, principal: context.principal, target: row["context"]["target"].stringValue!, payload: payload)
            try await repository.retain(record, scope: context.pairingScope)
            for reply in row["expected"]["replies"].arrayValue { _ = try await repository.apply(ServerEvent.decode(reply, role: context.role), context: context) }
            #expect(try await repository.takeResends(context: context, snapshot: ControlSnapshot(), at: vectorDate).isEmpty)
        }
    }
    @Test func controlsWaitForFreshSnapshotAndKeepTheirIssuingTurn() async throws {
        let row = try #require(protocolVectors("reconnect-outbox").last), context = try vectorContext()
        let repository = PendingIntentRepository(store: MemoryKeyValueStore()), saved = try PendingIntent(validating: row["initial"]["record"])
        try await repository.retain(saved, scope: context.pairingScope)
        _ = try await repository.recoveryQueries(context: context, at: vectorDate)
        let missing = try LookupMissing(validating: .object(["type": .string("receipt:missing"), "scope": .string(saved.scope), "mid": .string(saved.mid), "reason": .string("not_found")]))
        _ = try await repository.apply(.receiptMissing(missing), context: context)
        #expect(try await repository.takeResends(context: context, snapshot: ControlSnapshot(), at: vectorDate).isEmpty)
        var snapshot = ControlSnapshot(); snapshot.fresh = true; snapshot.run = try RunRef(id: saved.payload["run"]["id"].stringValue!, turn: "replacement-turn")
        #expect(try await repository.takeResends(context: context, snapshot: snapshot, at: vectorDate).isEmpty)
        #expect(try await repository.record(saved.mid, scope: context.pairingScope)?.quarantineReason == "staleControl")
        let taskRun = try RunRef(id: snapshot.run!.id, turn: "older-turn")
        snapshot.tasks = [BackgroundShell(.object(["id": .string("task-4"), "run": taskRun.raw]))]
        #expect(snapshot.check(.object(["type": .string("stopTask"), "taskId": .string("task-4"), "run": taskRun.raw])) == .ready)
    }
    @Test func storageIsAtomicPrivateBoundedAndCorruptionDoesNotErasePayload() async throws {
        let directory = try tempOutboxDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let context = try vectorContext(), repository = PendingIntentRepository(store: ProtectedFileStore(directory: directory), limits: PendingIntentLimits(maximumCount: 1))
        let first = try await repository.prepare(.send(text: "ქართული 👋", attachments: PreviewFixtures.conversation.items[0].images), context: context, at: vectorDate)
        var refused = false
        do { _ = try await repository.prepare(.send(text: "second"), context: context, at: vectorDate) } catch { refused = true }
        #expect(refused); #expect(try await repository.load(scope: context.pairingScope).count == 1)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(files.count == 1)
        #expect((try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        #expect((try FileManager.default.attributesOfItem(atPath: files[0].path)[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        try Data("corrupt".utf8).write(to: files[0])
        let reopened = PendingIntentRepository(store: ProtectedFileStore(directory: directory))
        var fenced = false
        do { _ = try await reopened.prepare(.send(text: "third"), context: context, at: vectorDate) } catch { fenced = true }
        #expect(fenced); #expect(try Data(contentsOf: files[0]) == Data("corrupt".utf8))
        #expect(try await repository.record(first.mid, scope: context.pairingScope)?.plaintext == first.plaintext)
    }
    @Test func receiptsAcrossFleetAndIndependentNegotiationDoNotRetarget() async throws {
        let context = try vectorContext(), fleet = try vectorContext(role: .fleet)
        let repository = PendingIntentRepository(store: MemoryKeyValueStore())
        let original = try await repository.prepare(.send(text: "removed conversation"), context: context, at: vectorDate)
        let legacyFleet = try vectorContext(.object(["proto": .number(1)]), role: .fleet)
        _ = try await repository.recoveryQueries(context: legacyFleet, at: vectorDate)
        #expect(try await repository.record(original.mid, scope: context.pairingScope)?.state == .pending)
        let queries = try await repository.recoveryQueries(context: fleet, at: vectorDate).queries
        #expect(queries.first?["mid"].stringValue == original.mid)
        let ack = testAck(original.payload, target: original.target, data: .object(["instance": .string("instance-7"), "queueId": .string("q-29"), "operation": .string(original.mid)]))
        let change = try await repository.apply(.ack(MutationAck(validating: ack)), context: fleet)
        #expect(change?.intent.acknowledgement?.outcome == .applied)
        var conflict = ack; conflict["target"] = .string("session:other")
        var refused = false
        do { _ = try await repository.apply(.ack(MutationAck(validating: conflict)), context: fleet) } catch { refused = true }
        #expect(refused)
    }
    @Test func concurrentReservationsCannotOverwriteAndSameMidKeepsOriginalTime() async throws {
        let repository = PendingIntentRepository(store: MemoryKeyValueStore()), context = try vectorContext()
        try await withThrowingTaskGroup(of: PendingIntent.self) { group in
            for i in 0..<50 { group.addTask { try await repository.prepare(.send(text: "intent \(i)"), context: context, at: vectorDate) } }
            var ids = Set<String>(); for try await value in group { ids.insert(value.mid) }; #expect(ids.count == 50)
        }
        #expect(try await repository.load(scope: context.pairingScope).count == 50)
        let first = try await repository.prepare(.send(text: "same"), context: context, at: vectorDate)
        let retried = try await repository.prepare(.send(text: "same"), context: context, metadata: IntentMetadata(mid: first.mid), at: vectorDate.addingTimeInterval(30))
        #expect(first.plaintext.utf8.elementsEqual(retried.plaintext.utf8))
    }
    @Test func default128IntentCapacityRefusesThe129thWithoutEviction() async throws {
        let repository = PendingIntentRepository(store: MemoryKeyValueStore()), context = try vectorContext()
        for i in 0..<128 { _ = try await repository.prepare(.send(text: "protected \(i)"), context: context, at: vectorDate) }
        var full = false
        do { _ = try await repository.prepare(.send(text: "overflow"), context: context, at: vectorDate) } catch { full = true }
        #expect(full); #expect(try await repository.load(scope: context.pairingScope).count == 128)
        #expect(PendingIntentLimits().maximumBytes == 32 * 1024 * 1024)
    }
    @Test func operationEvidenceAndUnknownCannotBecomeRunnableOnMissingReceipt() async throws {
        let context = try vectorContext(), repository = PendingIntentRepository(store: MemoryKeyValueStore())
        let record = try await repository.prepare(.send(text: "retain"), context: context, at: vectorDate)
        var value = try protocolVectors("reconnect-outbox").first(where: { $0["id"].stringValue == "outbox-accepted-operation-query" })!["expected"]["replies"].arrayValue[0]
        value["mid"] = .string(record.mid)
        _ = try await repository.apply(.operation(ProviderOperation(validating: value)), context: context)
        _ = try await repository.recoveryQueries(context: context, at: vectorDate)
        let missing = try LookupMissing(validating: .object(["type": .string("receipt:missing"), "scope": .string(record.scope), "mid": .string(record.mid), "reason": .string("not_found")]))
        _ = try await repository.apply(.receiptMissing(missing), context: context)
        #expect(try await repository.takeResends(context: context, snapshot: ControlSnapshot(), at: vectorDate).isEmpty)
        value["revision"] = .number(4); value["state"] = .string("queued"); value["error"] = .null
        var refused = false
        do { _ = try await repository.apply(.operation(ProviderOperation(validating: value)), context: context) } catch { refused = true }
        #expect(refused); #expect(try await repository.record(record.mid, scope: context.pairingScope)?.operation?.state == .unknown)
    }
    @Test func forgettingFencesAnAlreadyAuthorizedConnectionAndConsumedSuccessFreesCapacity() async throws {
        let repository = PendingIntentRepository(store: MemoryKeyValueStore(), limits: PendingIntentLimits(maximumCount: 1))
        let context = try await repository.authorizedContext(vectorContext())
        let first = try await repository.prepare(.setSetting(id: "mode", value: .string("new")), context: context, at: vectorDate)
        let ack = try MutationAck(validating: testAck(first.payload, target: first.target, data: .object(["id": .string("mode"), "value": .string("new")])))
        _ = try await repository.apply(.ack(ack), context: context)
        _ = try await repository.prepare(.send(text: "next"), context: context, at: vectorDate)
        #expect(try await repository.load(scope: context.pairingScope).count == 1)
        try await repository.remove(scope: context.pairingScope)
        var fenced = false
        do { _ = try await repository.prepare(.send(text: "stale connection"), context: context, at: vectorDate) } catch { fenced = true }
        #expect(fenced); #expect(try await repository.load(scope: context.pairingScope).isEmpty)
    }
}

private actor IntentGateStore: KeyValueStore {
    var values: [String: Data] = [:]
    var gateRead = false
    var gateWrite = false
    private(set) var blocked = false
    private var continuation: CheckedContinuation<Void, Never>?
    func arm(read: Bool = false, write: Bool = false) { gateRead = read; gateWrite = write }
    private func waitIfNeeded(_ gate: Bool) async {
        if gate { blocked = true; await withCheckedContinuation { continuation = $0 }; blocked = false }
    }
    func data(forKey key: String) async -> Data? { await waitIfNeeded(gateRead && key.hasPrefix("nikui.pending-intents")); return values[key] }
    func set(_ data: Data, forKey key: String) async { await waitIfNeeded(gateWrite && key.hasPrefix("nikui.pending-intents")); values[key] = data }
    func removeValue(forKey key: String) { values.removeValue(forKey: key) }
    func release() { gateRead = false; gateWrite = false; continuation?.resume(); continuation = nil }
}

private actor NegotiatingFactory: SocketFactory {
    private(set) var sockets: [ScriptedSocket] = []
    var fleetV2: Bool
    var conversationV2: Bool
    let hold: Bool
    init(fleetV2: Bool = true, conversationV2: Bool = true, hold: Bool = false) { self.fleetV2 = fleetV2; self.conversationV2 = conversationV2; self.hold = hold }
    func open(url: URL, maximumMessageBytes: Int) throws -> any SocketTransport {
        let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "session" })?.value
        let socket = try ScriptedSocket(index: sockets.count + 80, role: id.map(SocketRole.conversation) ?? .fleet, applicationWelcome: (id == nil ? fleetV2 : conversationV2) ? v2Welcome(device: "device1", optional: true) : nil, holdNegotiation: hold)
        sockets.append(socket); return socket
    }
    func socket(_ index: Int) -> ScriptedSocket? { sockets.indices.contains(index) ? sockets[index] : nil }
    func downgradeConversation() { conversationV2 = false }
}

@Suite("Protocol v2 encrypted sockets and facade") @MainActor struct ProtocolV2ConnectionTests {
    private func client(factory: NegotiatingFactory, cache: any KeyValueStore = MemoryKeyValueStore(), clock: any NikCore.Clock = SystemClock()) async throws -> NikClient {
        let secure = MemoryKeyValueStore(); try await secure.set(WireCoding.encode(record()), forKey: PairingService.pairingKey)
        let client = NikClient(signingKey: try softwareKey(), secureStore: secure, cacheStore: cache, clock: clock, socketFactory: factory)
        await client.restore(); await client.selectConversation("instance-7"); await client.connect()
        try await eventually { await MainActor.run { client.conversation("instance-7").initialized && client.connection.isLive } }
        return client
    }
    @Test func helloPrecedesReadyAndRolesNegotiateIndependently() async throws {
        for (fleet, conversation) in [(true, false), (false, true), (true, true)] {
            let factory = NegotiatingFactory(fleetV2: fleet, conversationV2: conversation), client = try await client(factory: factory)
            #expect(client.protocolSessions[.fleet]?.version == (fleet ? .v2 : .v1))
            #expect(client.protocolSessions[.conversation("instance-7")]?.version == (conversation ? .v2 : .v1))
            for (i, v2) in [(0, fleet), (1, conversation)] {
                let socket = try #require(await factory.socket(i)), actions = await socket.actions
                #expect(actions.first?["type"].stringValue == (v2 ? "hello" : "ready"))
                if v2, i == 1 { #expect(actions.first(where: { $0["type"].stringValue == "ready" })?["mid"].stringValue?.count == 32) }
            }
            await client.disconnect()
        }
    }
    @Test func applicationNegotiationHasItsOwnDeadlineAndNoLiveBeforeWelcome() async throws {
        let factory = NegotiatingFactory(hold: true), clock = TestClock(), updates = UpdateRecorder()
        let connection = SocketConnection(factory: factory, clock: clock)
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { await updates.append($0) } }
        try await eventually { if let socket = await factory.socket(0) { return await socket.actions.first?["type"].stringValue == "hello" }; return false }
        #expect(!(await updates.isLive()))
        clock.advance(11); let result = await task.value
        #expect(result.failure?.code == .timeout); #expect(!result.wasLive)
        let socket = try #require(await factory.socket(0)); #expect(await socket.actions.count == 1)
    }
    @Test func authoritativeAckSurvivesLateEditsAndOperationUnknownAndRestart() async throws {
        let directory = try tempOutboxDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let factory = NegotiatingFactory(), cache = ProtectedFileStore(directory: directory), client = try await client(factory: factory, cache: cache)
        let images = PreviewFixtures.conversation.items[0].images
        client.setDraft(Draft(text: "original ქართული 👋", attachments: images), conversationID: "instance-7")
        let sending = Task { await client.send(conversationID: "instance-7") }
        let socket = try #require(await factory.socket(1))
        try await eventually { await socket.actions.contains { $0["type"].stringValue == "send" } }
        let outgoing = try #require(await socket.actions.first(where: { $0["type"].stringValue == "send" })), mid = outgoing["mid"].stringValue!
        client.ingest(.items([TranscriptItem(.object(["id": .string("echo"), "kind": .string("user"), "text": outgoing["text"]]))]), on: .conversation("instance-7"))
        #expect(client.pendingOperations[mid]?.state == .submitted)
        client.setDraft(Draft(text: "new draft", attachments: images), conversationID: "instance-7")
        let ack = testAck(outgoing, target: "session:instance-7", data: .object(["instance": .string("instance-7"), "queueId": .string("q-29"), "operation": .string(mid)]))
        try await socket.enqueue(ack)
        if case .accepted = await sending.value {} else { Issue.record("Ack did not resolve the intent") }
        #expect(client.conversation("instance-7").draft.text == "new draft"); #expect(client.conversation("instance-7").draft.delivery == .draft)
        var unknown = try protocolVectors("reconnect-outbox").first(where: { $0["id"].stringValue == "outbox-accepted-operation-query" })!["expected"]["replies"].arrayValue[0]
        unknown["mid"] = .string(mid); try await socket.enqueue(unknown)
        try await eventually { await client.pendingIntents[mid]?.operation?.state == .unknown }
        #expect(client.pendingIntents[mid]?.acknowledgement?.outcome == .applied)
        await client.flushPersistence(); await client.disconnect()
        let restored = NikClient(signingKey: try softwareKey(), secureStore: client.secureStore, cacheStore: ProtectedFileStore(directory: directory), socketFactory: NegotiatingFactory())
        await restored.restore()
        #expect(restored.pendingIntents[mid]?.plaintext.utf8.elementsEqual(client.pendingIntents[mid]!.plaintext.utf8) == true)
        #expect(restored.conversation("instance-7").draft.text == "new draft"); #expect(restored.conversation("instance-7").draft.attachments == images)
    }
    @Test func failedPersistenceWritesNothingAndKeepsImagesAndDraft() async throws {
        let store = FailingStore(), factory = NegotiatingFactory(), client = try await client(factory: factory, cache: store)
        let socket = try #require(await factory.socket(1))
        client.setDraft(Draft(text: "keep me", attachments: PreviewFixtures.conversation.items[0].images), conversationID: "instance-7")
        await store.setFailWrites(true)
        let result = await client.send(conversationID: "instance-7")
        if case .notSent = result {} else { Issue.record("Storage failure claimed submission") }
        #expect(!(await socket.actions.contains { $0["type"].stringValue == "send" }))
        #expect(client.conversation("instance-7").draft.text == "keep me"); #expect(!client.conversation("instance-7").draft.attachments.isEmpty)
        await client.disconnect()
    }
    @Test func downgradePreservesPendingIntentWithoutSendingItOnLegacySocket() async throws {
        let factory = NegotiatingFactory(), clock = TestClock(), client = try await client(factory: factory, clock: clock)
        client.setDraft(Draft(text: "unanswered"), conversationID: "instance-7")
        let sending = Task { await client.send(conversationID: "instance-7") }
        let first = try #require(await factory.socket(1))
        try await eventually { await first.actions.contains { $0["type"].stringValue == "send" } }
        let mid = try #require(await first.actions.first(where: { $0["type"].stringValue == "send" })?["mid"].stringValue)
        await client.disconnect(); _ = await sending.value; await factory.downgradeConversation(); await client.connect()
        try await eventually { await MainActor.run { client.protocolSessions[.conversation("instance-7")]?.version == .v1 && client.conversation("instance-7").connection.isLive } }
        let legacy = try #require(await factory.socket(3))
        #expect(!(await legacy.actions.contains { $0["type"].stringValue == "send" }))
        try await eventually { await client.pendingIntents[mid]?.state == .quarantined }
        #expect(client.pendingIntents[mid]?.state == .quarantined); #expect(client.conversation("instance-7").draft.text == "unanswered")
        await client.disconnect()
    }
    @Test func encryptedReconnectResealsTheExactIntentAfterAuthoritativeMissingOnce() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        client.setDraft(Draft(text: "exact ქართული 👋", attachments: PreviewFixtures.conversation.items[0].images), conversationID: "instance-7")
        let task = Task { await client.send(conversationID: "instance-7") }, first = try #require(await factory.socket(1))
        try await eventually { await first.actions.contains { $0["type"].stringValue == "send" } }
        let original = try #require(await first.actions.first(where: { $0["type"].stringValue == "send" })), mid = original["mid"].stringValue!
        let originalIndex = try #require(await first.actions.firstIndex(where: { $0["mid"].stringValue == mid }))
        let firstCiphertext = await first.wireFrames.filter { $0["type"].stringValue == "@box" }[originalIndex]
        await client.disconnect(); _ = await task.value; await client.connect()
        try await eventually { if let socket = await factory.socket(3) { return await socket.actions.contains { $0["type"].stringValue == "receipt:get" && $0["mid"].stringValue == mid } }; return false }
        let second = try #require(await factory.socket(3))
        #expect(!(await second.actions.contains { $0["type"].stringValue == "send" }))
        let missing: JSONValue = .object(["type": .string("receipt:missing"), "scope": original["scope"], "mid": .string(mid), "reason": .string("not_found")])
        try await second.enqueue(missing)
        try await eventually { await second.actions.contains { $0["type"].stringValue == "send" } }
        try await second.enqueue(missing)
        let retransmissions = await second.actions.filter { $0["type"].stringValue == "send" }
        #expect(retransmissions.count == 1); #expect(try IntentCanonicalJSON.encode(retransmissions[0]) == IntentCanonicalJSON.encode(original))
        let index = try #require(await second.actions.firstIndex(where: { $0["type"].stringValue == "send" }))
        let secondCiphertext = await second.wireFrames.filter { $0["type"].stringValue == "@box" }[index]
        #expect(firstCiphertext["c"] != secondCiphertext["c"])
        #expect(await second.wireFrames.filter { $0["type"].stringValue == "@box" }.first?["n"].intValue == 0)
        await client.disconnect()
    }
    @Test func reclaimedDraftIsConsumedOnceAndLateReplyCannotEraseEdits() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory), socket = try #require(await factory.socket(1))
        for editAfterSend in [true, false] {
            client.setDraft(Draft(), conversationID: "instance-7")
            let previous = await socket.actions.count
            let task = Task { await client.perform(.editQueued("q-29"), on: .conversation("instance-7")) }
            try await eventually { await socket.actions.dropFirst(previous).contains { $0["type"].stringValue == "editQueued" } }
            let outgoing = try #require(await socket.actions.last(where: { $0["type"].stringValue == "editQueued" }))
            if editAfterSend { client.setDraft(Draft(text: "newer composition"), conversationID: "instance-7") }
            let reply: JSONValue = .object(["type": .string("editPrompt"), "text": .string("full reclaimed draft"), "sent": .string("/expanded"), "snippets": .array([.string("expanded")]), "attachments": .array(PreviewFixtures.conversation.items[0].images.map(\.raw))])
            try await socket.enqueue(reply)
            let ack = testAck(outgoing, target: "session:instance-7", data: .object(["queueId": .string("q-29")]), replies: [reply])
            try await socket.enqueue(ack); _ = await task.value
            if editAfterSend { #expect(client.conversation("instance-7").draft.text == "newer composition") }
            else {
                #expect(client.conversation("instance-7").draft.text == "full reclaimed draft")
                #expect(!client.conversation("instance-7").draft.attachments.isEmpty)
                #expect(client.conversation("instance-7").draft.sent == "/expanded")
                #expect(client.conversation("instance-7").draft.snippets == ["expanded"])
            }
            let revision = client.conversation("instance-7").editPromptRevision
            var duplicate = ack; duplicate["status"] = .string("duplicate"); try await socket.enqueue(duplicate)
            let context = IntentContext(pairing: client.pairedConnection!, role: .conversation("instance-7"), session: client.protocolSessions[.conversation("instance-7")]!)
            #expect(try await client.intentRepository.apply(.ack(MutationAck(validating: duplicate)), context: context) == nil)
            #expect(client.conversation("instance-7").editPromptRevision == revision)
            if !editAfterSend {
                let sending = Task { await client.send(conversationID: "instance-7") }
                try await eventually { await socket.actions.contains { $0["type"].stringValue == "send" } }
                let forwarded = try #require(await socket.actions.last(where: { $0["type"].stringValue == "send" }))
                #expect(forwarded["sent"].stringValue == "/expanded"); #expect(forwarded["snippets"].arrayValue == [.string("expanded")])
                #expect(forwarded["attachments"].arrayValue == reply["attachments"].arrayValue)
                try await socket.enqueue(testAck(forwarded, target: "session:instance-7", data: .object(["instance": .string("instance-7"), "queueId": .string("q-30"), "operation": forwarded["mid"]])))
                _ = await sending.value
            }
        }
        await client.disconnect()
    }
    @Test func lateNavigationCannotRedirectANewerSelectionEvenAfterReturningToItsOldID() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory), socket = try #require(await factory.socket(0))
        let cwd = try #require(client.fleet.projects.first?.path)
        let task = Task { await client.perform(.newInstance(id: "create-1", cwd: cwd, provider: .claude)) }
        try await eventually { await socket.actions.contains { $0["type"].stringValue == "instance:new" } }
        let outgoing = try #require(await socket.actions.first(where: { $0["type"].stringValue == "instance:new" }))
        #expect(client.consumeIntent() == nil)
        await client.selectConversation("other"); await client.selectConversation("instance-7")
        let ack = testAck(outgoing, target: "fleet", data: .object(["instance": .string("new-session")]), replies: [.object(["type": .string("instance:created"), "id": .string("create-1"), "instance": .string("new-session")])])
        try await socket.enqueue(ack); _ = await task.value
        #expect(client.consumeIntent() == nil); #expect(client.selectedConversationID == "instance-7")
        await client.disconnect()
    }
    @Test func revokedV2ControlAndLostSelfForgetReplyNeverInventAcceptance() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory), socket = try #require(await factory.socket(0))
        client.ingest(.device(Seat(.object(["id": .string("device1"), "control": .bool(false)]))))
        let denied = await client.send(conversationID: "instance-7", text: "do not send")
        if case .notSent(let failure) = denied { #expect(failure.code == .refused) } else { Issue.record("Revoked grant was ignored") }
        let task = Task { await client.perform(.forget(id: "device1")) }
        try await eventually { await socket.actions.contains { $0["type"].stringValue == "forget" } }
        let mid = try #require(await socket.actions.last(where: { $0["type"].stringValue == "forget" })?["mid"].stringValue)
        await socket.fail(code: 1008, reason: "this device was removed")
        if case .ambiguous = await task.value {} else { Issue.record("A policy close was mistaken for a v2 ack") }
        #expect(client.pendingIntents[mid]?.acknowledgement == nil); #expect(client.pendingIntents[mid]?.state == .pending)
        await client.disconnect()
    }
    @Test func legacyReadyDoesNotWaitForProtectedV2StoreReads() async throws {
        let store = IntentGateStore(); await store.arm(read: true)
        let factory = ScriptedFactory(), updates = UpdateRecorder(), connection = SocketConnection(factory: factory, outbox: PendingIntentRepository(store: store))
        let task = Task { await connection.run(pairing: try! record(), key: try! softwareKey(), role: .fleet) { await updates.append($0) } }
        try await eventually { await store.blocked }
        #expect(await updates.isLive())
        let socket = try #require(await factory.socket()); #expect(await socket.actions.first?["type"].stringValue == "ready")
        await store.release(); task.cancel(); await connection.close(); _ = await task.value
    }
    @Test func capturedStalePermissionKeepsTheOriginalRunAcrossPersistenceWait() async throws {
        let store = IntentGateStore(), factory = NegotiatingFactory(), client = try await client(factory: factory, cache: store, clock: TestClock())
        let socket = try #require(await factory.socket(1)), permission = try #require(client.conversation("instance-7").permissions.first)
        client.setDraft(Draft(text: "keep the composer", attachments: PreviewFixtures.conversation.items[0].images), conversationID: "instance-7")
        await store.arm(write: true)
        let task = Task { await client.perform(.permission(requestID: permission.requestId, allow: true), on: .conversation("instance-7")) }
        try await eventually { await store.blocked }
        let replacement = try RunRef(id: "22222222222222222222222222222222", turn: "replacement")
        client.ingest(.runStatus(.waiting, replacement), on: .conversation("instance-7"))
        await store.release()
        try await eventually { await socket.actions.contains { $0["type"].stringValue == "permission" } }
        let outgoing = try #require(await socket.actions.first(where: { $0["type"].stringValue == "permission" }))
        #expect(try RunRef(validating: outgoing["run"]) == permission.run); #expect(outgoing["run"] != replacement.raw)
        let error: JSONValue = .object(["code": .string("STALE_RUN"), "message": .string("Original execution ended"), "retryable": .bool(false)])
        try await socket.enqueue(testAck(outgoing, target: "session:instance-7", data: .object([:]), outcome: "rejected", error: error))
        if case .notSent = await task.value {} else { Issue.record("Stale control was not rejected") }
        let mid = outgoing["mid"].stringValue!
        #expect(client.pendingIntents[mid]?.acknowledgement?.error?.code == .staleRun)
        #expect(client.conversation("instance-7").draft.text == "keep the composer"); #expect(!client.conversation("instance-7").draft.attachments.isEmpty)
        await client.disconnect()
    }
    @Test func clearedComposerSurvivesProcessRestartWithoutRestoringTheSubmittedText() async throws {
        let cache = MemoryKeyValueStore(), factory = NegotiatingFactory(), client = try await client(factory: factory, cache: cache)
        client.setDraft(Draft(text: "pending original"), conversationID: "instance-7")
        let task = Task { await client.send(conversationID: "instance-7") }, socket = try #require(await factory.socket(1))
        try await eventually { await socket.actions.contains { $0["type"].stringValue == "send" } }
        client.setDraft(Draft(), conversationID: "instance-7"); await client.flushPersistence(); await client.disconnect(); _ = await task.value
        let restored = NikClient(signingKey: try softwareKey(), secureStore: client.secureStore, cacheStore: cache)
        await restored.restore()
        #expect(restored.conversation("instance-7").draft.text.isEmpty)
        #expect(restored.pendingIntents.values.contains { $0.payload["text"].stringValue == "pending original" })
    }
    @Test func restartRestoresTheNewestPendingCompositionWhenTimesAndAnOlderUICacheTie() async throws {
        let secure = MemoryKeyValueStore(), cache = MemoryKeyValueStore(), clock = TestClock(), pairing = try record()
        try await secure.set(WireCoding.encode(pairing), forKey: PairingService.pairingKey)
        let repository = PendingIntentRepository(store: cache)
        let context = IntentContext(pairing: pairing, role: .conversation("instance-7"), session: ProtocolSession(welcome: try ProtocolWelcome(validating: v2Welcome(device: "device1")), receivedAt: clock.now()))
        for text in ["first pending", "newest pending"] {
            let draft = Draft(text: text, updatedAt: clock.now())
            let pending = try await repository.prepare(.send(text: text), context: context, metadata: IntentMetadata(draft: draft, updatesDraft: true), at: clock.now())
            if text == "first pending" {
                var oldCache = PersistedUIState(); oldCache.drafts["instance-7"] = draft; oldCache.lastIntentOrder = pending.localOrder
                try await CacheRepository(store: cache).save(oldCache, scope: pairing.scope)
            }
        }
        let restored = NikClient(signingKey: try softwareKey(), secureStore: secure, cacheStore: cache, clock: clock)
        await restored.restore()
        #expect(restored.pendingIntents.count == 2); #expect(restored.conversation("instance-7").draft.text == "newest pending")
        #expect(restored.conversation("instance-7").draft.delivery == .ambiguous)
    }
    @Test func v2SlackOpenSelectsItsThreadAndPRDraftEditsAreProtectedFromOldAcks() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        let fleet = try #require(await factory.socket(0)), conversation = try #require(await factory.socket(1))
        let opening = Task { await client.perform(.slackOpen(conversation: "D1")) }
        try await eventually { await fleet.actions.contains { $0["type"].stringValue == "slack:open" } }
        #expect(client.slack.selection == SlackThreadID(conversation: "D1"))
        let open = try #require(await fleet.actions.first(where: { $0["type"].stringValue == "slack:open" }))
        try await fleet.enqueue(testAck(open, target: "fleet", data: .object(["conversation": .string("D1"), "thread": .null])))
        _ = await opening.value
        client.ingest(.pr(.state(PRStateEvent(.object(["prUrl": .string("https://github.com/fixture/repo/pull/2")])))), on: .conversation("instance-7"))
        client.setPRDraft("original comment", conversationID: "instance-7")
        let commenting = Task { await client.perform(.prComment("original comment"), on: .conversation("instance-7")) }
        try await eventually { await conversation.actions.contains { $0["type"].stringValue == "pr:comment" } }
        let comment = try #require(await conversation.actions.first(where: { $0["type"].stringValue == "pr:comment" }))
        #expect(client.conversation("instance-7").pr.pending != nil)
        client.setPRDraft("edited", conversationID: "instance-7"); client.setPRDraft("original comment", conversationID: "instance-7")
        try await conversation.enqueue(.object(["type": .string("pr:done"), "action": .string("comment"), "ok": .bool(true), "message": .string("done")]))
        #expect(client.conversation("instance-7").pr.pending != nil)
        try await conversation.enqueue(testAck(comment, target: "session:instance-7", data: .object(["prUrl": comment["prUrl"], "action": .string("comment"), "message": .string("done"), "providerId": .null])))
        _ = await commenting.value
        #expect(client.conversation("instance-7").pr.drafts["comment"] == "original comment")
        #expect(client.conversation("instance-7").pr.pending == nil)
        await client.disconnect()
    }
    @Test func lateQueryComposerRepliesPreserveEditsAndFreshQueriesRemainAvailable() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory)
        client.setDraft(Draft(text: "before query"), conversationID: "instance-7")
        _ = await client.perform(.prAskConflicts, on: .conversation("instance-7"))
        client.setDraft(Draft(text: "newer words"), conversationID: "instance-7")
        client.ingest(.editPrompt("late query result"), on: .conversation("instance-7"))
        #expect(client.conversation("instance-7").draft.text == "newer words")
        _ = await client.perform(.prAskThread("thread-2"), on: .conversation("instance-7"))
        client.ingest(.editPrompt("current query result"), on: .conversation("instance-7"))
        #expect(client.conversation("instance-7").draft.text == "current query result\n\nnewer words")
        await client.disconnect()
    }
    @Test func questionDraftKeepsItsIssuingMarkerAndExplicitControlsStillWaitForSnapshot() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory), socket = try #require(await factory.socket(1))
        let oldRun = try #require(client.conversation("instance-7").run)
        let old = try QuestionRef(validating: .object(["requestId": .string("question-1"), "run": oldRun.raw]))
        client.setDraft(Draft(text: "written before the question"), conversationID: "instance-7")
        client.ingest(.items([TranscriptItem(.object(["id": .string("q:1"), "kind": .string("text"), "answerTo": old.raw]))]), on: .conversation("instance-7"))
        client.ingest(.runStatus(.waiting, oldRun), on: .conversation("instance-7"))
        if case .notSent = await client.send(conversationID: "instance-7") {} else { Issue.record("Unbound existing draft implicitly answered a question") }
        #expect(!(await socket.actions.contains { $0["type"].stringValue == "send" }))
        client.setDraft(Draft(), conversationID: "instance-7"); client.setDraft(Draft(text: "bound answer"), conversationID: "instance-7")
        #expect(client.conversation("instance-7").draft.answerTo == old)
        let newRun = try RunRef(id: oldRun.id, turn: "turn-10"), replacement = try QuestionRef(validating: .object(["requestId": .string("question-2"), "run": newRun.raw]))
        client.ingest(.runStatus(.waiting, newRun), on: .conversation("instance-7"))
        client.ingest(.items([TranscriptItem(.object(["id": .string("q:2"), "kind": .string("text"), "answerTo": replacement.raw]))]), on: .conversation("instance-7"))
        let sending = Task { await client.send(conversationID: "instance-7") }
        try await eventually { await socket.actions.contains { $0["type"].stringValue == "send" } }
        let outgoing = try #require(await socket.actions.first(where: { $0["type"].stringValue == "send" }))
        #expect(outgoing["answerTo"] == old.raw)
        let error: JSONValue = .object(["code": .string("STALE_TURN"), "message": .string("Old question ended"), "retryable": .bool(false)])
        try await socket.enqueue(testAck(outgoing, target: "session:instance-7", data: .object([:]), outcome: "rejected", error: error)); _ = await sending.value
        #expect(client.pendingIntents[outgoing["mid"].stringValue!]?.payload["answerTo"] == old.raw)
        #expect(client.conversation("instance-7").draft.text == "bound answer")
        client.conversationByID["instance-7"]?.controlSnapshotFresh = false
        let result = await client.perform(.interrupt, on: .conversation("instance-7"), preconditions: IntentMetadata(fields: ["run": oldRun.raw]))
        if case .notSent = result {} else { Issue.record("Explicit stale control bypassed the fresh snapshot gate") }
        #expect(!(await socket.actions.contains { $0["type"].stringValue == "interrupt" }))
        await client.disconnect()
    }
    @Test func onlyAnExplicitNewSendGetsRetryOfAndRetainsTheUnknownOriginal() async throws {
        let factory = NegotiatingFactory(), client = try await client(factory: factory), socket = try #require(await factory.socket(1))
        client.setDraft(Draft(text: "same retained words"), conversationID: "instance-7")
        let firstTask = Task { await client.send(conversationID: "instance-7") }
        try await eventually { await socket.actions.contains { $0["type"].stringValue == "send" } }
        let first = try #require(await socket.actions.first(where: { $0["type"].stringValue == "send" }))
        let error: JSONValue = .object(["code": .string("OUTCOME_UNKNOWN"), "message": .string("Check before sending again"), "retryable": .bool(false)])
        try await socket.enqueue(testAck(first, target: "session:instance-7", data: .object([:]), outcome: "unknown", error: error)); _ = await firstTask.value
        #expect(await socket.actions.filter { $0["type"].stringValue == "send" }.count == 1)
        let secondTask = Task { await client.send(conversationID: "instance-7") }
        try await eventually { await socket.actions.filter { $0["type"].stringValue == "send" }.count == 2 }
        let second = try #require(await socket.actions.last(where: { $0["type"].stringValue == "send" }))
        #expect(first["mid"] != second["mid"]); #expect(second["retryOf"] == first["mid"])
        #expect(client.pendingIntents[first["mid"].stringValue!]?.state == .unknown)
        try await socket.enqueue(testAck(second, target: "session:instance-7", data: .object(["instance": .string("instance-7"), "queueId": .string("q-new"), "operation": second["mid"]]))); _ = await secondTask.value
        await client.disconnect()
    }
}
