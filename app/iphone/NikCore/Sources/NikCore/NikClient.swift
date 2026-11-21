import Foundation
import Observation

/// Single UI facade. All observable state is main-actor isolated; socket/crypto work lives in actors.
@MainActor @Observable public final class NikClient {
    public internal(set) var connection: ConnectionState = .idle
    public internal(set) var seat: Seat?
    public internal(set) var pairedConnection: PairedConnection?
    public internal(set) var extensionVersion: String?
    public internal(set) var fleet = Fleet()
    public internal(set) var history = HistorySnapshot()
    public internal(set) var fleetStatus = SnapshotStatus()
    public internal(set) var historyStatus = SnapshotStatus()
    public internal(set) var conversationByID: [String: ConversationState] = [:]
    public internal(set) var selectedConversationID: String?
    public internal(set) var terminal = TerminalState()
    public internal(set) var report = ReportState()
    public internal(set) var slack = SlackFeatureState()
    public internal(set) var devices = DevicesSnapshot()
    public internal(set) var awake = AwakeState()
    public internal(set) var voice = VoiceAvailability()
    public internal(set) var preferences = LocalPreferences()
    public internal(set) var pendingOperations: [String: PendingOperation] = [:]
    public internal(set) var pendingIntents: [String: PendingIntent] = [:]
    public internal(set) var protocolSessions: [SocketRole: ProtocolSession] = [:]
    public internal(set) var lastFailure: CoreFailure?
    public internal(set) var intent: LocalIntent?
    public internal(set) var isPreview = false
    public var visibility = FeatureVisibility()
    @ObservationIgnored public let events: AsyncStream<CoreEvent>
    @ObservationIgnored let continuation: AsyncStream<CoreEvent>.Continuation
    @ObservationIgnored let signingKey: (any SigningKeyProvider)?
    @ObservationIgnored let secureStore: any KeyValueStore
    @ObservationIgnored let cacheStore: any KeyValueStore
    @ObservationIgnored let clock: any Clock
    @ObservationIgnored let socketFactory: any SocketFactory
    @ObservationIgnored let http: any HTTPClient
    @ObservationIgnored let transportConfiguration: TransportConfiguration
    @ObservationIgnored let cacheRepository: CacheRepository
    @ObservationIgnored let intentRepository: PendingIntentRepository
    @ObservationIgnored var manager: ConnectionManager?
    @ObservationIgnored var managerID: UUID?
    @ObservationIgnored var pairingTask: Task<PairedConnection, any Error>?
    @ObservationIgnored var pairingGeneration: UInt64 = 0
    @ObservationIgnored var lifecycle: AppLifecycle = .foreground
    @ObservationIgnored var clientGeneration: UInt64 = 0
    @ObservationIgnored var requests: [String: TrackedRequest] = [:]
    @ObservationIgnored var persistenceTask: Task<Void, Never>?
    @ObservationIgnored var pollTask: Task<Void, Never>?
    @ObservationIgnored var notifications = NotificationCoordinator()
    @ObservationIgnored var promptHistories: [String: PromptHistory] = [:]
    @ObservationIgnored var pendingAppleToken: String?
    @ObservationIgnored var snapshotTimeouts: [String: Task<Void, Never>] = [:]
    @ObservationIgnored var selectionOrigin = V2Wire.randomID()
    @ObservationIgnored var composerQueries: [SocketRole: ComposerQuery] = [:]

    public convenience init(signingKey: (any SigningKeyProvider)? = nil, secureStore: any KeyValueStore = MemoryKeyValueStore(), cacheStore: any KeyValueStore = MemoryKeyValueStore(), clock: any Clock = SystemClock()) {
        self.init(signingKey: signingKey, secureStore: secureStore, cacheStore: cacheStore, clock: clock, socketFactory: URLSessionSocketFactory())
    }
    public convenience init(signingKey: (any SigningKeyProvider)? = nil, secureStore: any KeyValueStore = MemoryKeyValueStore(), cacheStore: any KeyValueStore = MemoryKeyValueStore(), clock: any Clock = SystemClock(), http: any HTTPClient, transportConfiguration: TransportConfiguration = TransportConfiguration()) {
        self.init(signingKey: signingKey, secureStore: secureStore, cacheStore: cacheStore, clock: clock, socketFactory: URLSessionSocketFactory(), http: http, transportConfiguration: transportConfiguration)
    }
    public init(signingKey: (any SigningKeyProvider)? = nil, secureStore: any KeyValueStore = MemoryKeyValueStore(), cacheStore: any KeyValueStore = MemoryKeyValueStore(), clock: any Clock = SystemClock(), socketFactory: any SocketFactory, http: any HTTPClient = URLSessionHTTPClient(), transportConfiguration: TransportConfiguration = TransportConfiguration()) {
        self.signingKey = signingKey; self.secureStore = secureStore; self.cacheStore = cacheStore; self.clock = clock
        self.socketFactory = socketFactory; self.http = http; self.transportConfiguration = transportConfiguration
        cacheRepository = CacheRepository(store: cacheStore)
        intentRepository = PendingIntentRepository(store: cacheStore)
        let stream = AsyncStream<CoreEvent>.makeStream(bufferingPolicy: .bufferingNewest(256))
        events = stream.stream; continuation = stream.continuation
    }
    deinit {
        persistenceTask?.cancel(); pollTask?.cancel(); continuation.finish()
        for task in snapshotTimeouts.values { task.cancel() }
        for query in composerQueries.values { query.timeout?.cancel() }
        if let manager { Task { await manager.disconnect() } }
    }
    public var selectedConversation: ConversationState? { selectedConversationID.flatMap { conversationByID[$0] } }
    public var prSnapshot: PRSnapshot? { selectedConversation?.pr.snapshot }
    public var mayControl: Bool { seat?.control == true && connection.isLive && lifecycle == .foreground }
    public func conversation(_ id: String) -> ConversationState { conversationByID[id] ?? ConversationState(id: id) }
    public func conversation(id: String) -> ConversationState { conversation(id) }
    public func setDraft(_ draft: Draft, conversationID: String) {
        var state = conversation(conversationID); var draft = draft; draft.updatedAt = clock.now()
        // A changed draft is a new composition, not a retry of a pending submission.
        if !draft.text.utf8.elementsEqual(state.draft.text.utf8) || draft.attachments != state.draft.attachments {
            draft.delivery = .draft; draft.compositionID = V2Wire.randomID()
            draft.sent = nil; draft.snippets = nil
            if state.draft.text.isEmpty && state.draft.attachments.isEmpty && draft.answerTo == nil { draft.answerTo = state.activeQuestion }
        }
        if draft.text.isEmpty && draft.attachments.isEmpty { draft.answerTo = nil }
        state.draft = draft; conversationByID[conversationID] = state
        promptHistories[conversationID]?.edited(draft.text); schedulePersistence()
    }
    public func setReading(_ reading: ReadingState, conversationID: String) {
        var state = conversation(conversationID)
        guard state.reading != reading else { return }
        state.reading = reading; conversationByID[conversationID] = state
    }
    public func setSlackDraft(_ text: String, conversation: String, thread: String? = nil) {
        let key = SlackThreadID(conversation: conversation, thread: thread)
        var state = slack.threads[key] ?? SlackThreadState(); state.draft = Draft(text: text, updatedAt: clock.now()); slack.threads[key] = state; schedulePersistence()
    }
    public func setPRDraft(_ text: String, key: String = "comment", conversationID: String) {
        var state = conversation(conversationID)
        if state.pr.drafts[key]?.utf8.elementsEqual(text.utf8) != true { state.pr.draftRevision = UUID().uuidString }
        state.pr.drafts[key] = text
        if let url = state.meta.prUrl, state.pr.url.isEmpty { state.pr.url = url }
        if !state.pr.url.isEmpty { state.pr.draftsByURL[state.pr.url] = state.pr.drafts }
        conversationByID[conversationID] = state; schedulePersistence()
    }
    public func setPRTab(_ tab: String, conversationID: String) {
        guard ["conversation", "threads", "commits", "checks", "files"].contains(tab) else { return }
        var state = conversation(conversationID); state.pr.tab = tab
        if !state.pr.url.isEmpty { state.pr.tabsByURL[state.pr.url] = tab }; conversationByID[conversationID] = state
    }
    public func setReportSections(_ sections: Set<String>, conversationID: String? = nil) {
        if let conversationID { var state = conversation(conversationID); state.report.expandedSections = sections; state.report.disclosuresInitialized = true; conversationByID[conversationID] = state }
        else { report.expandedSections = sections; report.disclosuresInitialized = true }
    }
    public func clearFailure() { lastFailure = nil }
    public func setTerminalDraft(_ text: String, terminalID: String) { terminal.drafts[terminalID] = text; schedulePersistence() }
    /// Explicit local resolution after the user reconciles an unacknowledged prompt with the laptop snapshot.
    public func markDraftReviewed(conversationID: String, clear: Bool) {
        for request in Array(requests.values) where request.role == .conversation(conversationID) {
            if case .send = request.action, !request.v2 { finishRequest(request.operation.id, result: .accepted(.object(["reviewedLocally": .bool(true)]))) }
        }
        var state = conversation(conversationID)
        if clear { state.draft = Draft(updatedAt: clock.now()) } else { state.draft.delivery = .draft }
        conversationByID[conversationID] = state; schedulePersistence()
    }
    public func updatePreferences(_ value: LocalPreferences) async {
        preferences = value
        do { try await cacheStore.set(WireCoding.encode(value), forKey: "nikui.preferences.v1") }
        catch { fail(CoreFailure(.persistence, "Local preferences could not be saved.")) }
    }
    public func restore() async {
        guard !isPreview else { return }
        do {
            if let data = try await cacheStore.data(forKey: "nikui.preferences.v1") { preferences = try JSONDecoder().decode(LocalPreferences.self, from: data) }
            guard let data = try await secureStore.data(forKey: PairingService.pairingKey) else { return }
            guard data.count <= 64 * 1024 else { throw CoreFailure(.persistence, "The saved pairing is invalid.") }
            let record = try JSONDecoder().decode(PairedConnection.self, from: data)
            _ = try PairingInvitation.address(record.baseURL.absoluteString); try NikCrypto.validateSPKI(record.serverSPKI); try NikCrypto.validateSPKI(record.publicSPKI)
            guard record.fingerprint == NikCrypto.fingerprint(record.serverSPKI) else { throw CoreFailure(.wrongLaptop, "The saved laptop fingerprint is invalid.") }
            pairedConnection = record
            for intent in try await intentRepository.load(scope: record.scope) { receiveIntent(IntentChange(intent: intent, consumesResult: false), restoring: true) }
            if let saved = try await cacheRepository.load(scope: record.scope) {
                fleet = saved.fleet
                for (id, draft) in saved.drafts {
                    var state = conversation(id)
                    let source = pendingIntents.values.filter { $0.target == "session:" + id && state.draft.matchesComposition($0.draft) }.max { $0.localOrder < $1.localOrder }
                    let chooseCache = source.map { draft.updatedAt > state.draft.updatedAt || draft.updatedAt == state.draft.updatedAt && (saved.lastIntentOrder ?? 0) >= $0.localOrder } ?? (draft.updatedAt >= state.draft.updatedAt || state.draft.text.isEmpty && state.draft.attachments.isEmpty)
                    if chooseCache {
                        state.draft = draft
                        if [.submitting, .submitted].contains(draft.delivery) { state.draft.delivery = .ambiguous }
                        if let intent = pendingIntents.values.first(where: { $0.target == "session:" + id && draft.matchesComposition($0.draft) }), let delivery = pendingOperations[intent.mid]?.state { state.draft.delivery = delivery }
                    }
                    conversationByID[id] = state
                }
                for (id, draft) in saved.slackDrafts {
                    var thread = slack.threads[id] ?? SlackThreadState()
                    if thread.draft.text.isEmpty || draft.updatedAt >= thread.draft.updatedAt {
                        thread.draft = draft
                        if [.submitting, .submitted].contains(draft.delivery) { thread.draft.delivery = .ambiguous }
                        if pendingIntents.values.contains(where: { $0.what == "slack:reply" && $0.acknowledgement?.outcome == .applied && draft.matchesComposition($0.draft) }) { thread.draft = Draft(updatedAt: clock.now()) }
                    }
                    slack.threads[id] = thread
                }
                for (id, drafts) in saved.prDrafts { var state = conversation(id); state.pr.drafts = drafts; conversationByID[id] = state }
                for (id, byURL) in saved.prDraftsByURL ?? [:] { var state = conversation(id); state.pr.draftsByURL = byURL; conversationByID[id] = state }
                terminal.drafts = saved.terminalDrafts
            }
        } catch { fail((error as? CoreFailure) ?? CoreFailure(.persistence, "Saved local state could not be read; the pairing was not erased.")) }
    }
    public func pair(_ invitation: PairingInvitation, deviceName: String = "iPhone") async -> PairingResult {
        guard lifecycle == .foreground else { return .failed(CoreFailure(.locked, "Unlock and return to NikUI before pairing.")) }
        guard let signingKey else { return .failed(CoreFailure(.missingKey, "Prepare the device identity before pairing.")) }
        guard pairingTask == nil else { return .failed(CoreFailure(.refused, "A pairing request is already in progress.")) }
        let generation = pairingGeneration
        let service = PairingService(key: signingKey, store: secureStore, http: http, clock: clock)
        let task = Task { try await service.pair(invitation, deviceName: deviceName) }
        pairingTask = task
        defer { pairingTask = nil }
        do {
            let old = pairedConnection
            let record = try await task.value
            guard generation == pairingGeneration else { return .failed(CoreFailure(.canceled, "Pairing was canceled before the local connection changed.")) }
            await disconnect()
            guard generation == pairingGeneration else { return .failed(CoreFailure(.canceled, "Pairing was canceled before the local connection changed.")) }
            pairedConnection = record; seat = nil
            clearMemory()
            if let old, old.scope != record.scope {
                do { try await cacheRepository.remove(scope: old.scope) }
                catch { fail(CoreFailure(.persistence, "Paired with the new laptop, but the previous laptop's protected cache could not be removed. Forget locally to retry deleting all saved laptop data.")) }
            }
            guard generation == pairingGeneration else { return .failed(CoreFailure(.canceled, "Pairing was canceled.")) }
            return .paired(record)
        } catch {
            if generation != pairingGeneration || error is CancellationError { return .failed(CoreFailure(.canceled, "Pairing was canceled.")) }
            let failure = (error as? CoreFailure) ?? CoreFailure(.transport, "Pairing failed. Request a new invitation on the laptop before retrying."); fail(failure); return .failed(failure)
        }
    }
    public func connect() async {
        guard !isPreview, let pairing = pairedConnection else { if !isPreview { fail(CoreFailure(.notPaired, "Pair with a laptop first.")) }; return }
        guard let key = signingKey else { fail(CoreFailure(.missingKey, "The paired signing identity is unavailable.")); return }
        if manager == nil {
            let id = UUID(); managerID = id
            manager = ConnectionManager(key: key, factory: socketFactory, clock: clock, configuration: transportConfiguration, outbox: intentRepository) { [weak self] update in await self?.receive(update, managerID: id) }
        }
        if let pendingAppleToken { await manager?.rememberAppleToken(pendingAppleToken) }
        await manager?.setLifecycle(lifecycle)
        await manager?.setVisibility(visibility)
        await manager?.connect(pairing)
        await manager?.selectConversation(selectedConversationID)
        restartPolling()
    }
    public func disconnect() async {
        clientGeneration &+= 1; pollTask?.cancel(); pollTask = nil
        managerID = nil
        markAmbiguous(on: nil); await manager?.disconnect(); manager = nil
        connection = .offline; report.isStale = true
        terminal.freshControlIDs.removeAll()
        protocolSessions.removeAll()
        for role in Array(composerQueries.keys) { clearComposerQuery(role) }
        for id in Array(conversationByID.keys) { conversationByID[id]?.connection = .offline; conversationByID[id]?.report.isStale = true; conversationByID[id]?.controlSnapshotFresh = false }
    }
    /// Synchronous write/event gate for an OS privacy transition. Socket shutdown
    /// and persistence follow on the serialized asynchronous lifecycle path.
    public func suspendForPrivacy(_ value: AppLifecycle = .locked) {
        guard value != .foreground else { return }
        lifecycle = value
        clientGeneration &+= 1; markAmbiguous(on: nil)
        pollTask?.cancel(); pollTask = nil; report.isStale = true
    }
    public func setLifecycle(_ value: AppLifecycle) async {
        if value != .foreground { suspendForPrivacy(value) } else { lifecycle = value }
        await manager?.setLifecycle(value)
        if value != .foreground { await flushPersistence() }
        if value == .foreground { if manager == nil, pairedConnection != nil { await connect() }; restartPolling() }
    }
    public func selectConversation(_ id: String?) async {
        if let id, id.isEmpty || id.utf8.count > 256 { fail(CoreFailure(.invalidInput, "The conversation ID is invalid.")); return }
        if let old = selectedConversationID, old != id { markAmbiguous(on: .conversation(old)) }
        if selectedConversationID != id { selectionOrigin = V2Wire.randomID() }
        selectedConversationID = id
        if let id, conversationByID[id] == nil { conversationByID[id] = ConversationState(id: id) }
        if !isPreview { await manager?.selectConversation(id) }
    }
    public func setVisibility(_ value: FeatureVisibility) async { visibility = value; await manager?.setVisibility(value); restartPolling() }
    public func networkBecameAvailable() async { if let manager { await manager.reconnectNow() } else { await connect() } }
    public func perform(_ action: ClientAction, on role: SocketRole = .fleet) async -> ActionResult { await execute(action, role: role) }
    /// Explicit observed preconditions let a view keep an older control bound to its issuing target.
    public func perform(_ action: ClientAction, on role: SocketRole, preconditions: IntentMetadata) async -> ActionResult { await execute(action, role: role, v2Metadata: preconditions) }
    /// Slash controls have no delivery receipt and must never borrow the private composer draft.
    public func sendControlCommand(_ command: String, conversationID: String) async -> ActionResult {
        guard command.hasPrefix("/") else { return .notSent(CoreFailure(.invalidInput, "Choose a slash command.")) }
        return await execute(.send(text: command), role: .conversation(conversationID), preservesDraft: true)
    }
    /// `prefix` (e.g. "/steer ") changes only the outgoing payload; the private draft keeps what the person wrote.
    public func send(conversationID: String, text: String? = nil, attachments: [Attachment]? = nil, prefix: String = "") async -> ActionResult {
        let original = conversation(conversationID).draft
        let value = text ?? original.text; let images = attachments ?? original.attachments
        if let local = SnippetExpander.localIntent(text: value, attachmentCount: images.count) { setIntent(local); return .local(local) }
        let expanded = SnippetExpander.expand(value, snippets: conversation(conversationID).configuration.snippets)
        let retainedExpansion = original.sent != nil && value.utf8.elementsEqual(original.text.utf8) && images == original.attachments
        let wireText = retainedExpansion ? value : expanded.text
        let wireSent = retainedExpansion ? original.sent : (expanded.used.isEmpty ? nil : expanded.sent)
        let wireSnippets = retainedExpansion ? original.snippets ?? [] : expanded.used
        // Keep the original written text/snippet tokens and every attachment in the private draft.
        var state = conversation(conversationID); state.draft = Draft(text: value, attachments: images, updatedAt: clock.now(), answerTo: original.answerTo, sent: retainedExpansion ? original.sent : nil, snippets: retainedExpansion ? original.snippets : nil); conversationByID[conversationID] = state
        return await execute(.send(text: prefix + wireText, attachments: images, sent: wireSent.map { prefix + $0 }, snippets: wireSnippets), role: .conversation(conversationID), sourceDraft: state.draft)
    }
    public func forgetLaptop(deleteKey: Bool = true) async -> ActionResult {
        pairingGeneration &+= 1; clientGeneration &+= 1; pairingTask?.cancel(); _ = try? await pairingTask?.value
        await disconnect(); persistenceTask?.cancel(); persistenceTask = nil
        let old = pairedConnection
        do {
            // Remove the pointer only after scoped protected data has been purged. A failure remains reviewable/retryable.
            if let old { try await cacheRepository.remove(scope: old.scope); try await intentRepository.remove(scope: old.scope) }
            try await secureStore.removeValue(forKey: PairingService.pairingKey)
            try await secureStore.removeValue(forKey: RekeyCoordinator.storageKey)
            if deleteKey { try await signingKey?.delete() }
            pairedConnection = nil; seat = nil; clearMemory(); return .accepted(.null)
        } catch { let failure = (error as? CoreFailure) ?? CoreFailure(.persistence, "The laptop's local data could not be fully removed."); fail(failure); return .notSent(failure) }
    }
    public func consumeIntent() -> LocalIntent? { defer { intent = nil }; return intent }
    public func health() async -> Result<TimeInterval, CoreFailure> {
        guard let pairedConnection else { return .failure(CoreFailure(.notPaired, "Pair with a laptop first.")) }
        do { return .success(try await PairingService.health(baseURL: pairedConnection.baseURL, http: http, clock: clock)) }
        catch { return .failure((error as? CoreFailure) ?? CoreFailure(.transport, "The laptop is unreachable.")) }
    }
    public func diagnostics() -> String {
        let status: String
        switch connection { case .live: status = "live, sealed"; case .refused: status = "refused"; case .wrongLaptop: status = "wrong laptop"; case .reconnecting: status = "reconnecting"; default: status = "offline or connecting" }
        return ["NikUI native protocol v\(protocolSessions[.fleet]?.version.rawValue ?? 1)", "Pending intents: \(cacheStore is MemoryKeyValueStore ? "memory only; no process recovery" : "saved in the supplied protected store")", "Extension: \(extensionVersion ?? "unknown")", "Connection: \(status)", "Laptop: \(pairedConnection?.baseURL.absoluteString ?? "not paired")", "Device: \(pairedConnection?.deviceID ?? "none")", "Control: \(seat?.control == true)", "Key protection: \(pairedConnection?.protection.rawValue ?? "unknown")", "Laptop fingerprint: \(pairedConnection?.fingerprint ?? "none")", "Paired: \(pairedConnection?.pairedAt.ISO8601Format() ?? "never")", "Notifications locally enabled: \(preferences.notifications.on)", "APNs receipt/preferences support: not offered by this server", "Keep awake requested: \(awake.on); held: \(awake.held)"].joined(separator: "\n")
    }
    func fail(_ error: CoreFailure) { lastFailure = error; continuation.yield(.failure(error)) }
    func setIntent(_ value: LocalIntent) { intent = value; continuation.yield(.intent(value)) }
    func clearMemory() {
        for task in snapshotTimeouts.values { task.cancel() }; snapshotTimeouts.removeAll()
        fleetStatus = SnapshotStatus(); historyStatus = SnapshotStatus()
        fleet = Fleet(); history = HistorySnapshot(); conversationByID.removeAll(); terminal = TerminalState(); report = ReportState(); slack = SlackFeatureState(); devices = DevicesSnapshot(); awake = AwakeState(); voice = VoiceAvailability(); selectedConversationID = nil; pendingOperations.removeAll(); promptHistories.removeAll(); notifications = NotificationCoordinator()
        pendingAppleToken = nil; intent = nil; extensionVersion = nil
        pendingIntents.removeAll(); protocolSessions.removeAll()
        selectionOrigin = V2Wire.randomID()
        for role in Array(composerQueries.keys) { clearComposerQuery(role) }
    }
    func beginSnapshot(_ key: String) {
        if key == "fleet" { fleetStatus.begin(at: clock.now()) } else { historyStatus.begin(at: clock.now()) }
        snapshotTimeouts[key]?.cancel()
        snapshotTimeouts[key] = Task { [weak self, clock] in
            do { try await clock.sleep(for: .seconds(12)); try Task.checkCancellation() } catch { return }
            guard let self else { return }
            if key == "fleet", self.fleetStatus.isLoading {
                self.fleetStatus.requestedAt = nil; self.fleetStatus.error = "The laptop did not send a fresh chat list. Try again."
            } else if key == "history", self.historyStatus.isLoading {
                self.historyStatus.requestedAt = nil; self.historyStatus.error = "The laptop did not send chat history. Try again."
            }
        }
    }
    func schedulePersistence() {
        guard !isPreview, pairedConnection != nil else { return }
        persistenceTask?.cancel()
        persistenceTask = Task { [weak self, clock] in
            do { try await clock.sleep(for: .milliseconds(150)); try Task.checkCancellation(); await self?.flushPersistence() } catch {}
        }
    }
    /// Await on background/termination coordination; only bounded drafts, prefs and last fleet are written.
    public func flushPersistence() async {
        guard !isPreview, let pairing = pairedConnection else { return }
        var state = PersistedUIState(); state.fleet = fleet
        state.lastIntentOrder = pendingIntents.values.map(\.localOrder).max()
        let protectedDrafts = Set(pendingIntents.values.compactMap { value -> String? in
            guard value.target.hasPrefix("session:") else { return nil }; return String(value.target.dropFirst(8))
        })
        state.protectedDraftIDs = protectedDrafts.sorted()
        state.drafts = conversationByID.compactMapValues { value in value.draft.text.isEmpty && value.draft.attachments.isEmpty && !protectedDrafts.contains(value.id) ? nil : value.draft }
        let protectedSlackDrafts = Set(pendingIntents.values.filter { $0.what == "slack:reply" }.map { SlackThreadID(conversation: $0.payload["conversation"].stringValue ?? "", thread: $0.payload["thread"].stringValue) })
        state.protectedSlackDraftIDs = Array(protectedSlackDrafts)
        state.slackDrafts = Dictionary(uniqueKeysWithValues: slack.threads.compactMap { key, value in value.draft.text.isEmpty && !protectedSlackDrafts.contains(key) ? nil : (key, value.draft) })
        state.prDrafts = conversationByID.compactMapValues { $0.pr.drafts.isEmpty ? nil : $0.pr.drafts }
        state.prDraftsByURL = conversationByID.compactMapValues { value in
            var scoped = value.pr.draftsByURL
            if !value.pr.url.isEmpty { scoped[value.pr.url] = value.pr.drafts }; return scoped.isEmpty ? nil : scoped
        }
        state.terminalDrafts = terminal.drafts
        do { try await cacheRepository.save(state, scope: pairing.scope) } catch { fail((error as? CoreFailure) ?? CoreFailure(.persistence, "Drafts could not be saved to protected storage.")) }
    }
    func restartPolling() {
        pollTask?.cancel(); pollTask = nil
        guard !isPreview, lifecycle == .foreground, visibility.report || visibility.slack || voice.building else { return }
        pollTask = Task { [weak self, clock] in
            var ticks = 0
            while !Task.isCancelled {
                do { try await clock.sleep(for: .seconds(5)); try Task.checkCancellation() } catch { return }
                guard let self, self.lifecycle == .foreground else { return }; ticks += 1
                if self.visibility.report { _ = await self.perform(.status, on: self.selectedConversationID.map(SocketRole.conversation) ?? .fleet) }
                if ticks % 3 == 0, self.visibility.slack { _ = await self.perform(.slackRefresh) }
                if ticks % 3 == 0, self.voice.building || self.voice.needsBuild { _ = await self.perform(.voiceState) }
            }
        }
    }
}
