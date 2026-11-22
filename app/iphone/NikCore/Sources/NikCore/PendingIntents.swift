import Foundation

public struct PendingIntentLimits: Sendable, Equatable {
    public var maximumCount = 128
    public var maximumBytes = 32 * 1024 * 1024
    public init(maximumCount: Int = 128, maximumBytes: Int = 32 * 1024 * 1024) { self.maximumCount = maximumCount; self.maximumBytes = maximumBytes }
}
public struct IntentContext: Sendable, Equatable {
    public let pairingScope: String
    public let hostFingerprint: String
    public let principal: String
    public let role: SocketRole
    public let session: ProtocolSession
    var storeEpoch: UUID?
    public init(pairing: PairedConnection, role: SocketRole, session: ProtocolSession) {
        pairingScope = pairing.scope; hostFingerprint = pairing.fingerprint; principal = "device:" + pairing.deviceID; self.role = role; self.session = session
    }
    public init(pairingScope: String, hostFingerprint: String, principal: String, role: SocketRole, session: ProtocolSession) {
        self.pairingScope = pairingScope; self.hostFingerprint = hostFingerprint; self.principal = principal; self.role = role; self.session = session
    }
}
public struct IntentMetadata: Sendable {
    public var mid: String?
    public var fields: [String: JSONValue]
    public var draft: Draft?
    public var selection: String?
    public var updatesDraft: Bool
    public var origin: String?
    public var prDraftRevision: String?
    public var viewToken: String?
    public var controlIdentity: String?
    public init(mid: String? = nil, fields: [String: JSONValue] = [:], draft: Draft? = nil, selection: String? = nil, updatesDraft: Bool = false) {
        self.mid = mid; self.fields = fields; self.draft = draft; self.selection = selection
        self.updatesDraft = updatesDraft
    }
}
public struct PendingIntent: Codable, Sendable, Equatable, Identifiable {
    public enum State: String, Codable, Sendable { case pending, applied, rejected, unknown, quarantined }
    public let hostFingerprint: String
    public let engineID: String
    public let scope: String
    public let principal: String
    public let target: String
    public let mid: String
    public let issuedAt: Int
    /// The exact plaintext serialized before the first write. Never persisted ciphertext.
    public let plaintext: String
    public let hash: String
    public let draft: Draft?
    public let selection: String?
    public let updatesDraft: Bool
    public let origin: String?
    public let prDraftRevision: String?
    public let viewToken: String?
    public let controlIdentity: String?
    public internal(set) var state: State = .pending
    public internal(set) var acknowledgement: MutationAck?
    public internal(set) var operation: ProviderOperation?
    public internal(set) var lookupFailure: LookupFailure?
    public internal(set) var quarantineReason: String?
    public internal(set) var resultConsumed = false
    public internal(set) var localOrder: UInt64 = 0
    public var id: String { mid }
    public var payload: JSONValue { try! JSONValue.decode(Data(plaintext.utf8)) }
    public var what: String { payload["type"].stringValue! }
    public var isQuarantined: Bool { state == .quarantined || state == .unknown || operation?.state == .unknown }
    var mayDiscardAutomatically: Bool {
        state == .applied && resultConsumed && (what != "send" || [OperationPhase.completed, .rejected].contains(operation?.state ?? .queued))
    }
    public init(hostFingerprint: String, engineID: String, scope: String, principal: String, target: String, payload: JSONValue, draft: Draft? = nil, selection: String? = nil, updatesDraft: Bool = false, origin: String? = nil, prDraftRevision: String? = nil, viewToken: String? = nil, controlIdentity: String? = nil) throws {
        try V2Wire.object(payload, ["type", "mid", "scope", "issuedAt"])
        try V2Wire.require(!hostFingerprint.isEmpty && V2Wire.id(.string(engineID)) && V2Wire.id(.string(scope)) && !principal.isEmpty && V2Wire.target(.string(target)) && V2Wire.id(payload["mid"]) && payload["scope"].stringValue == scope && V2Wire.integer(payload["issuedAt"]) && V2Wire.text(payload["type"]), "persisted intent")
        self.hostFingerprint = hostFingerprint; self.engineID = engineID; self.scope = scope; self.principal = principal; self.target = target
        mid = payload["mid"].stringValue!; issuedAt = payload["issuedAt"].intValue!
        plaintext = try IntentCanonicalJSON.text(payload); hash = try IntentCanonicalJSON.hash(message: payload, target: target)
        self.draft = draft; self.selection = selection
        self.updatesDraft = updatesDraft
        self.origin = origin
        self.prDraftRevision = prDraftRevision
        self.viewToken = viewToken
        self.controlIdentity = controlIdentity
    }
    /// Shared fixture/import shape. Persistence itself uses a versioned, validated container.
    public init(validating record: JSONValue) throws {
        try self.init(hostFingerprint: record["hostFingerprint"].stringValue ?? "", engineID: record["engineId"].stringValue ?? "", scope: record["scope"].stringValue ?? "", principal: record["principal"].stringValue ?? "", target: record["target"].stringValue ?? "", payload: record["payload"])
        try V2Wire.require(record["mid"].stringValue == mid && record["issuedAt"].intValue == issuedAt, "intent identity")
        guard let state = State(rawValue: record["state"].stringValue ?? "") else { throw CoreFailure(.persistence, "Invalid pending intent state.") }
        self.state = state
    }
    func compatible(with context: IntentContext) -> Bool {
        context.session.version == .v2 && hostFingerprint == context.hostFingerprint && principal == context.principal && engineID == context.session.welcome?.engineID && scope == context.session.welcome?.receipts?.scope
    }
    func expired(at now: Int) -> Bool { now - issuedAt >= 86_400_000 || issuedAt - now > 30_000 }
    func validated() throws {
        let value = try JSONValue.decode(Data(plaintext.utf8))
        let check = try PendingIntent(hostFingerprint: hostFingerprint, engineID: engineID, scope: scope, principal: principal, target: target, payload: value)
        try V2Wire.require(check.mid == mid && check.issuedAt == issuedAt && check.hash == hash, "saved intent checksum")
        if let ack = acknowledgement { try V2Wire.require(ack.mid == mid && ack.scope == scope && ack.target == target && ack.what == what, "saved ack identity") }
        if let operation { try V2Wire.require(operation.mid == mid && operation.scope == scope && operation.target == target, "saved operation identity") }
    }
}
public struct IntentChange: Sendable, Equatable {
    public let intent: PendingIntent
    public let consumesResult: Bool
}

/// A pairing-scoped protected outbox. Transactions keep the actor locked across
/// store awaits, so a delayed save cannot overwrite a newer receipt or intent.
public actor PendingIntentRepository {
    private struct Container: Codable { var version = 1; var localOrder: UInt64; var intents: [PendingIntent] }
    private let store: any KeyValueStore
    private let limits: PendingIntentLimits
    private var scope: String?
    private var records: [String: PendingIntent] = [:]
    private var localOrder: UInt64 = 0
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var receiptQueries: Set<String> = []
    private var replayEligible: Set<String> = []
    private var resending: Set<String> = []
    private var storeEpochs: [String: UUID] = [:]
    public init(store: any KeyValueStore, limits: PendingIntentLimits = PendingIntentLimits()) { self.store = store; self.limits = limits }
    private func lock() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    private func unlock() { if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() } }
    private func key(_ scope: String) -> String { "nikui.pending-intents.v2:" + scope }
    private func nextLocalOrder() throws -> UInt64 {
        guard localOrder < UInt64.max else { throw CoreFailure(.persistence, "The pending-intent ordering counter is exhausted.") }
        return localOrder + 1
    }
    private func checkEpoch(_ context: IntentContext) throws {
        if let epoch = context.storeEpoch, storeEpochs[context.pairingScope] != epoch { throw CoreFailure(.canceled, "The pending-intent scope was removed while this connection was active.") }
    }
    func authorizedContext(_ context: IntentContext) async throws -> IntentContext {
        await lock(); defer { unlock() }; try await read(context.pairingScope)
        var value = context
        let epoch = storeEpochs[context.pairingScope] ?? UUID(); storeEpochs[context.pairingScope] = epoch; value.storeEpoch = epoch
        return value
    }
    private func read(_ scope: String) async throws {
        guard self.scope != scope else { return }
        var loaded: [String: PendingIntent] = [:], order: UInt64 = 0
        if let data = try await store.data(forKey: key(scope)) {
            guard data.count <= limits.maximumBytes else { throw CoreFailure(.persistence, "The protected pending-intent store exceeds its budget.") }
            let saved = try JSONDecoder().decode(Container.self, from: data)
            guard saved.version == 1, saved.intents.count <= limits.maximumCount else { throw CoreFailure(.persistence, "The pending-intent store has an unsupported format or capacity.") }
            for record in saved.intents {
                try record.validated()
                guard record.localOrder <= saved.localOrder else { throw CoreFailure(.persistence, "Invalid saved pending-intent ordering.") }
                guard loaded[record.mid] == nil else { throw CoreFailure(.persistence, "Duplicate saved pending-intent identity.") }
                loaded[record.mid] = record
            }
            order = saved.localOrder
        }
        self.scope = scope; records = loaded; localOrder = order; receiptQueries.removeAll(); replayEligible.removeAll(); resending.removeAll()
    }
    private func commit(_ values: [String: PendingIntent]) async throws {
        guard let scope else { throw CoreFailure(.persistence, "The protected outbox has no pairing scope.") }
        guard values.count <= limits.maximumCount else { throw CoreFailure(.persistence, "The protected outbox is full (128 pending intents). Review existing operations before sending.") }
        let order = max(localOrder, values.values.map(\.localOrder).max() ?? 0)
        let data = try WireCoding.encode(Container(localOrder: order, intents: values.values.sorted { $0.mid < $1.mid }))
        guard data.count <= limits.maximumBytes else { throw CoreFailure(.persistence, "The protected outbox exceeds its 32 MiB budget. Your draft is preserved.") }
        try await store.set(data, forKey: key(scope)); records = values; localOrder = order
    }
    public func load(scope: String) async throws -> [PendingIntent] {
        await lock(); defer { unlock() }; try await read(scope)
        return records.values.sorted { $0.localOrder == $1.localOrder ? $0.issuedAt < $1.issuedAt : $0.localOrder < $1.localOrder }
    }
    public func remove(scope: String) async throws {
        await lock(); defer { unlock() }
        try await store.removeValue(forKey: key(scope))
        storeEpochs[scope] = UUID()
        if self.scope == scope { self.scope = nil; records.removeAll(); localOrder = 0; receiptQueries.removeAll(); replayEligible.removeAll(); resending.removeAll() }
    }
    public func retain(_ record: PendingIntent, scope: String) async throws {
        await lock(); defer { unlock() }; try await read(scope); try record.validated()
        if let prior = records[record.mid] { try V2Wire.require(prior.plaintext.utf8.elementsEqual(record.plaintext.utf8) && prior.target == record.target && prior.principal == record.principal, "immutable intent"); return }
        var next = records, retained = record
        if retained.localOrder == 0 { retained.localOrder = try nextLocalOrder() }
        next[record.mid] = retained; try await commit(next)
    }
    public func prepare(_ action: ClientAction, context: IntentContext, metadata: IntentMetadata = IntentMetadata(), at now: Date) async throws -> PendingIntent {
        await lock(); defer { unlock() }; try checkEpoch(context); try await read(context.pairingScope)
        guard let welcome = context.session.welcome, let receipts = welcome.receipts, welcome.version == .v2 else { throw CoreFailure(.unsupported, "Durable intents require protocol v2.") }
        var payload = action.json.objectValue
        for (key, value) in metadata.fields {
            try V2Wire.require(!["type", "mid", "scope", "issuedAt"].contains(key), "intent metadata")
            payload[key] = value
        }
        let mid = metadata.mid ?? V2Wire.randomID()
        payload["mid"] = .string(mid); payload["scope"] = .string(receipts.scope); payload["issuedAt"] = .number(Double(records[mid]?.issuedAt ?? context.session.serverTime(at: now)))
        var record = try PendingIntent(hostFingerprint: context.hostFingerprint, engineID: welcome.engineID, scope: receipts.scope, principal: context.principal, target: context.role.target, payload: .object(payload), draft: metadata.draft, selection: metadata.selection, updatesDraft: metadata.updatesDraft, origin: metadata.origin, prDraftRevision: metadata.prDraftRevision, viewToken: metadata.viewToken, controlIdentity: metadata.controlIdentity)
        guard record.plaintext.utf8.count <= receipts.maximumMessageBytes else { throw CoreFailure(.tooLarge, "The intent exceeds the engine's message budget.") }
        if let prior = records[mid] {
            try V2Wire.require(prior.hash == record.hash && prior.compatible(with: context), "immutable intent")
            return prior
        }
        var next = records
        record.localOrder = try nextLocalOrder()
        // Completed and consumed work no longer occupies pending capacity.
        // Rejected/unknown work and accepted sends still awaiting progress stay intact.
        next = next.filter { !$0.value.mayDiscardAutomatically }
        next[mid] = record; try await commit(next); return record
    }
    public func record(_ mid: String, scope: String) async throws -> PendingIntent? {
        await lock(); defer { unlock() }; try await read(scope); return records[mid]
    }
    func pendingDeclaration(_ action: ClientAction, context: IntentContext, includeUncertain: Bool = false) async throws -> PendingIntent? {
        await lock(); defer { unlock() }; try await read(context.pairingScope)
        return try records.values.first { value in
            guard value.target == context.role.target, (value.state == .pending || includeUncertain && value.acknowledgement?.outcome != .applied), value.compatible(with: context), value.what == action.type else { return false }
            var fields = value.payload.objectValue
            for key in ["mid", "scope", "issuedAt"] { fields.removeValue(forKey: key) }
            return try IntentCanonicalJSON.encode(.object(fields)) == IntentCanonicalJSON.encode(action.json)
        }
    }
    public func recoveryQueries(context: IntentContext, at now: Date) async throws -> (changes: [IntentChange], queries: [JSONValue]) {
        await lock(); defer { unlock() }; try checkEpoch(context); try await read(context.pairingScope)
        let previousQueries = receiptQueries; var committed = false
        defer { if !committed { receiptQueries = previousQueries } }
        var next = records, changes: [IntentChange] = [], queries: [JSONValue] = []
        for var record in records.values.sorted(by: { $0.mid < $1.mid }) {
            let ownTarget = record.target == context.role.target
            guard ownTarget || context.role == .fleet else { continue }
            if !record.compatible(with: context) || record.expired(at: context.session.serverTime(at: now)) {
                // A legacy fleet socket must not downgrade an independent v2 conversation.
                let unresolved = record.state == .pending || record.state == .unknown || record.what == "send" && record.acknowledgement?.outcome == .applied && ![OperationPhase.completed, .rejected].contains(record.operation?.state ?? .queued)
                if ownTarget, unresolved {
                    record.state = .quarantined; record.quarantineReason = record.expired(at: context.session.serverTime(at: now)) ? "expired" : "identityOrProtocolChanged"
                    next[record.mid] = record; changes.append(IntentChange(intent: record, consumesResult: false))
                }
                continue
            }
            guard record.state != .quarantined else { continue }
            let type: String
            if record.acknowledgement?.outcome == .applied {
                guard record.what == "send", ![OperationPhase.completed, .rejected].contains(record.operation?.state ?? .queued) else { continue }
                type = "operation:get"
            } else {
                guard record.acknowledgement?.outcome != .rejected else { continue }
                type = "receipt:get"; receiptQueries.insert(record.mid)
            }
            queries.append(.object(["type": .string(type), "scope": .string(record.scope), "mid": .string(record.mid)]))
        }
        if !changes.isEmpty { try await commit(next) }
        committed = true
        return (changes, queries)
    }
    public func apply(_ event: ServerEvent, context: IntentContext) async throws -> IntentChange? {
        await lock(); defer { unlock() }; try checkEpoch(context); try await read(context.pairingScope)
        let mid: String?, eventScope: String
        switch event {
        case .ack(let ack): mid = ack.mid; eventScope = ack.scope
        case .operation(let operation): mid = operation.mid; eventScope = operation.scope
        case .receiptMissing(let missing), .operationMissing(let missing): mid = missing.mid; eventScope = missing.scope
        case .receiptError(let error), .operationError(let error): mid = error.mid; eventScope = error.scope
        default: return nil
        }
        guard let mid, var record = records[mid], record.scope == eventScope, record.compatible(with: context) else { return nil }
        let oldQueries = receiptQueries, oldEligible = replayEligible, oldResending = resending
        var committed = false
        defer { if !committed { receiptQueries = oldQueries; replayEligible = oldEligible; resending = oldResending } }
        var consumes = false
        switch event {
        case .ack(let ack):
            guard ack.what == record.what && ack.target == record.target else { throw CoreFailure(.protocolViolation, "The acknowledgement targets another intent.") }
            if let prior = record.acknowledgement, prior.admitted {
                if !ack.admitted { return nil }
                let stable = ["mid", "scope", "what", "target", "admitted", "at", "expiresAt"]
                try V2Wire.require(try stable.allSatisfy { try IntentCanonicalJSON.encode(prior.raw[$0]) == IntentCanonicalJSON.encode(ack.raw[$0]) }, "receipt identity changed")
                if [.applied, .rejected].contains(prior.outcome) {
                    try V2Wire.require(prior.outcome == ack.outcome && (try IntentCanonicalJSON.encode(prior.raw["result"])) == (try IntentCanonicalJSON.encode(ack.raw["result"])) && (try IntentCanonicalJSON.encode(prior.raw["error"])) == (try IntentCanonicalJSON.encode(ack.raw["error"])), "terminal receipt changed")
                    return nil
                }
                try V2Wire.require(prior.outcome != .unknown || ack.outcome != .pending, "unknown receipt became runnable")
            }
            record.acknowledgement = ack
            record.state = PendingIntent.State(rawValue: ack.outcome.rawValue)!
            receiptQueries.remove(mid); replayEligible.remove(mid); resending.remove(mid); record.lookupFailure = nil
            if ack.outcome == .applied, !record.resultConsumed { record.resultConsumed = true; consumes = true }
        case .operation(let operation):
            try V2Wire.require(operation.target == record.target, "operation target")
            if let prior = record.operation {
                if operation.revision < prior.revision { return nil }
                if operation.revision == prior.revision {
                    try V2Wire.require(try IntentCanonicalJSON.encode(operation.raw) == IntentCanonicalJSON.encode(prior.raw), "operation revision changed"); return nil
                }
                try V2Wire.require(![OperationPhase.completed, .rejected].contains(prior.state), "terminal operation changed")
                try V2Wire.require(prior.state != .unknown || ![OperationPhase.queued, .dispatching].contains(operation.state), "unknown operation became runnable")
            }
            record.operation = operation
        case .receiptMissing(let missing):
            guard receiptQueries.remove(mid) != nil else { return nil }
            if missing.reason == .notFound, record.acknowledgement?.admitted != true, record.operation == nil, record.state == .pending, !record.expired(at: context.session.serverTime(at: context.session.receivedAt)) { replayEligible.insert(mid) }
            else if missing.reason != .notFound { record.state = .quarantined; record.quarantineReason = missing.reason.rawValue; replayEligible.remove(mid) }
        case .receiptError(let error), .operationError(let error):
            record.lookupFailure = error; receiptQueries.remove(mid); replayEligible.remove(mid); resending.remove(mid)
        case .operationMissing: break // Missing progress never revokes a durable accepted send.
        default: return nil
        }
        var next = records; next[mid] = record; try await commit(next)
        committed = true
        return IntentChange(intent: record, consumesResult: consumes)
    }
    public func takeResends(context: IntentContext, snapshot: ControlSnapshot, at now: Date) async throws -> [PendingIntent] {
        await lock(); defer { unlock() }; try checkEpoch(context); try await read(context.pairingScope)
        let oldEligible = replayEligible, oldResending = resending; var committed = false
        defer { if !committed { replayEligible = oldEligible; resending = oldResending } }
        var result: [PendingIntent] = [], next = records
        for mid in replayEligible.sorted() {
            guard var record = records[mid], !resending.contains(mid), record.target == context.role.target, record.compatible(with: context), record.state == .pending, record.acknowledgement?.admitted != true, record.operation == nil else { continue }
            if record.expired(at: context.session.serverTime(at: now)) {
                record.state = .quarantined; record.quarantineReason = "expired"; next[mid] = record; replayEligible.remove(mid); continue
            }
            let check = snapshot.check(record.payload)
            if check == .wait { continue }
            if check == .stale {
                record.state = .quarantined; record.quarantineReason = "staleControl"; next[mid] = record; replayEligible.remove(mid); continue
            }
            resending.insert(mid); replayEligible.remove(mid); result.append(record)
        }
        if next != records { try await commit(next) }
        committed = true
        return result
    }
    public func disconnected(target: String) async {
        await lock(); defer { unlock() }
        for record in records.values where record.target == target { resending.remove(record.mid); replayEligible.remove(record.mid) }
    }
}

/// Only a snapshot from this connection can authorize replay of a captured control.
public struct ControlSnapshot: Sendable {
    enum Check { case ready, wait, stale }
    public var fresh = false
    public var run: RunRef?
    public var status: ConversationStatus = .unknown
    public var items: [TranscriptItem] = []
    public var tasks: [BackgroundShell] = []
    public var terminals: [TerminalDescriptor] = []
    public var prURL: String?
    public init() {}
    mutating func observe(_ event: ServerEvent) {
        switch event {
        case .initialized(let value): fresh = true; run = value.run; status = value.status; items = value.items; tasks = value.stats.shellList; prURL = value.meta.prUrl
        case .runMeta(let meta, _, let value): run = value; if let url = meta.prUrl { prURL = url }
        case .runStatus(let status, let value): run = value; self.status = status
        case .items(let values):
            for value in values { if let i = items.firstIndex(where: { $0.id == value.id }) { items[i].raw = items[i].raw.merged(with: value.raw) } else { items.append(value) } }
        case .stats(let stats): tasks = stats.shellList
        case .terminal(.list(let values)): fresh = true; terminals = values
        case .terminal(.opened(let terminal)), .terminal(.began(let terminal, _)), .terminal(.done(let terminal, _)), .terminal(.scrollback(let terminal, _)):
            if let i = terminals.firstIndex(where: { $0.id == terminal.id }) { terminals[i] = terminal } else { terminals.append(terminal) }
        case .pr(.state(let value)): prURL = value.prUrl
        default: break
        }
    }
    func check(_ payload: JSONValue) -> Check {
        let type = payload["type"].stringValue ?? ""
        let bound = !payload["run"].isNull || !payload["answerTo"].isNull || !payload["prUrl"].isNull || ["term:stop", "term:close"].contains(type)
        guard bound else { return .ready }
        guard fresh else { return .wait }
        if !payload["answerTo"].isNull {
            guard let question = try? QuestionRef(validating: payload["answerTo"]), question.run == run, status == .waiting, items.contains(where: { $0.answerTo == question && $0.resolved == nil }) else { return .stale }
        }
        if let expected = try? RunRef(validating: payload["run"]) {
            switch type {
            case "permission":
                guard items.contains(where: { $0.kind == "permission" && $0.requestId == payload["requestId"].stringValue && $0.resolved == nil && $0.run == expected }), run?.id == expected.id else { return .stale }
            case "stopTask":
                guard tasks.contains(where: { $0.id == payload["taskId"].stringValue && $0.run == expected && !$0.stopping }), run?.id == expected.id else { return .stale }
            default: guard run == expected && expected.turn != nil else { return .stale }
            }
        }
        if !payload["prUrl"].isNull, payload["prUrl"].stringValue != prURL { return .stale }
        if ["term:stop", "term:close"].contains(type) {
            guard let terminal = terminals.first(where: { $0.id == payload["id"].stringValue }), terminal.raw.objectValue["activeRun"] != nil, terminal.raw["activeRun"] == payload["terminalRun"] else { return .stale }
        }
        return .ready
    }
}
