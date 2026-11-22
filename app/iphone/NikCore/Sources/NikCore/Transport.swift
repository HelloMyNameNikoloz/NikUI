import Foundation

public struct SocketClosure: Sendable, Equatable {
    public var code: Int
    public var reason: String
    public init(code: Int, reason: String) { self.code = code; self.reason = reason }
}
public protocol SocketTransport: Sendable {
    func send(_ text: String) async throws
    func receive() async throws -> String
    func close() async
    func closure() async -> SocketClosure?
}
extension SocketTransport { public func closure() async -> SocketClosure? { nil } }
public protocol SocketFactory: Sendable { func open(url: URL, maximumMessageBytes: Int) async throws -> any SocketTransport }
public struct URLSessionSocketFactory: SocketFactory {
    private let session: URLSession
    public init() {
        let c = URLSessionConfiguration.ephemeral; c.httpCookieStorage = nil; c.urlCache = nil
        c.timeoutIntervalForRequest = 30
        session = URLSession(configuration: c, delegate: NoSocketRedirects(), delegateQueue: nil)
    }
    public func open(url: URL, maximumMessageBytes: Int) -> any SocketTransport {
        let task = session.webSocketTask(with: URLRequest(url: url)) // Deliberately no Origin, cookie, bearer, or subprotocol.
        task.maximumMessageSize = maximumMessageBytes; task.resume()
        return URLSessionSocket(task: task)
    }
}
private final class NoSocketRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
private actor URLSessionSocket: SocketTransport {
    let task: URLSessionWebSocketTask
    init(task: URLSessionWebSocketTask) { self.task = task }
    func send(_ text: String) async throws { try await task.send(.string(text)) }
    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let value): return value
        case .data: throw CoreFailure(.protocolViolation, "Binary WebSocket messages are unsupported.")
        @unknown default: throw CoreFailure(.protocolViolation, "Unknown WebSocket message format.")
        }
    }
    func close() { task.cancel(with: .goingAway, reason: nil) }
    func closure() -> SocketClosure? {
        guard task.closeCode != .invalid else { return nil }
        return SocketClosure(code: task.closeCode.rawValue, reason: task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }
}
public struct TransportConfiguration: Sendable, Equatable {
    public var maximumReceiveBytes = 64 * 1024 * 1024
    public var maximumSendBytes = 24 * 1024 * 1024
    public var handshakeTimeout: Duration = .seconds(10)
    public var negotiationTimeout: Duration = .seconds(10)
    public var clientID = V2Wire.randomID()
    public var clientKind: ProtocolClientKind = .iphone
    public init() {}
}
public enum ConnectionUpdate: Sendable, Equatable {
    case state(SocketRole, ConnectionState), welcome(SocketRole, Seat, version: String?)
    case event(SocketRole, ServerEvent), failure(SocketRole, CoreFailure)
    case negotiated(SocketRole, ProtocolSession), intent(SocketRole, IntentChange)
}
public struct ConnectionExit: Sendable {
    public var failure: CoreFailure?
    public var wasLive: Bool
    public var retryable: Bool
}
public actor NonceReplayCache {
    private var nonces: Set<String> = []
    private var order: [String] = []
    public init() {}
    public func insert(_ nonce: String) throws {
        guard !nonces.contains(nonce) else { throw CoreFailure(.replay, "The laptop repeated an authentication nonce.") }
        nonces.insert(nonce); order.append(nonce)
        if order.count > 1024 { nonces.remove(order.removeFirst()) }
    }
}
func withDeadline<T: Sendable>(_ duration: Duration, clock: any Clock, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask { try await clock.sleep(for: duration); throw CoreFailure(.timeout, "The laptop did not answer in time.") }
        defer { group.cancelAll() }
        guard let result = try await group.next() else { throw CancellationError() }; return result
    }
}

/// A single connection attempt. An ordered writer prevents actor reentrancy from reordering GCM counters.
public actor SocketConnection {
    private let factory: any SocketFactory
    private let clock: any Clock
    private let configuration: TransportConfiguration
    private let replayCache: NonceReplayCache
    private let outbox: PendingIntentRepository
    private var context: IntentContext?
    private var snapshot = ControlSnapshot()
    private var updateSink: (@Sendable (ConnectionUpdate) async -> Void)?
    private var receiptPollTask: Task<Void, Never>?
    private var legacyQuarantineTask: Task<Void, Never>?
    private var transport: (any SocketTransport)?
    private var box: Box?
    private var generation: UInt64 = 0
    private var live = false
    private var writing = false
    private struct Write {
        let text: String
        let generation: UInt64
        let continuation: CheckedContinuation<Void, any Error>
    }
    private var writes: [Write] = []
    public init(factory: any SocketFactory = URLSessionSocketFactory(), clock: any Clock = SystemClock(), configuration: TransportConfiguration = TransportConfiguration(), replayCache: NonceReplayCache = NonceReplayCache(), outbox: PendingIntentRepository = PendingIntentRepository(store: MemoryKeyValueStore())) {
        self.factory = factory; self.clock = clock; self.configuration = configuration; self.replayCache = replayCache
        self.outbox = outbox
    }
    public static func url(base: URL, role: SocketRole) throws -> URL {
        let validated = try PairingInvitation.address(base.absoluteString)
        guard var c = URLComponents(url: validated, resolvingAgainstBaseURL: false) else { throw CoreFailure(.invalidInput, "The laptop address is invalid.") }
        c.scheme = validated.scheme == "https" ? "wss" : "ws"; c.path = "/socket"
        c.queryItems = [URLQueryItem(name: "applicationProtocol", value: "2")]
        if case .conversation(let id) = role { c.queryItems?.append(URLQueryItem(name: "session", value: id)) }
        guard let url = c.url else { throw CoreFailure(.invalidInput, "The socket address is invalid.") }; return url
    }
    public func run(pairing: PairedConnection, key: any SigningKeyProvider, role: SocketRole, sink: @escaping @Sendable (ConnectionUpdate) async -> Void) async -> ConnectionExit {
        generation &+= 1; let attempt = generation
        updateSink = sink; snapshot = ControlSnapshot(); context = nil
        var wasLive = false
        do {
            await sink(.state(role, .connecting))
            let socket = try await factory.open(url: Self.url(base: pairing.baseURL, role: role), maximumMessageBytes: configuration.maximumReceiveBytes)
            guard generation == attempt, !Task.isCancelled else { await socket.close(); throw CancellationError() }
            transport = socket
            await sink(.state(role, .authenticating))
            let timeout = configuration.handshakeTimeout; let replay = replayCache
            let (proof, welcome, channel) = try await withDeadline(timeout, clock: clock) { [configuration] in
                let first = try await socket.receive()
                guard first.utf8.count <= configuration.maximumReceiveBytes else { throw CoreFailure(.tooLarge, "The laptop message is too large.") }
                let challenge = try JSONValue.decode(Data(first.utf8))
                if challenge["type"].stringValue == "@denied" { throw CoreFailure(.refused, challenge["reason"].stringValue ?? "The connection was refused.") }
                if let ns = challenge["nonce"].stringValue { try await replay.insert(ns) }
                let proof = try await Handshake.authenticate(challenge: challenge, pairing: pairing, key: key)
                try Task.checkCancellation()
                try await socket.send(proof.auth.text)
                var channel = Box(sending: proof.keys.toServer, receiving: proof.keys.toClient)
                let response = try await socket.receive()
                guard response.utf8.count <= configuration.maximumReceiveBytes else { throw CoreFailure(.tooLarge, "The laptop message is too large.") }
                let frame = try JSONValue.decode(Data(response.utf8))
                if frame["type"].stringValue == "@denied" { throw CoreFailure(.refused, frame["reason"].stringValue ?? "The connection was refused.") }
                let welcome = try JSONValue.decode(Data(channel.open(frame).utf8))
                _ = try proof.verifyWelcome(welcome)
                return (proof, welcome, channel)
            }
            guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
            var seat = try proof.verifyWelcome(welcome)
            guard seat.id == pairing.deviceID else { throw CoreFailure(.crypto, "The laptop welcomed a different device.") }
            var negotiatedChannel = channel
            var session = ProtocolSession(receivedAt: clock.now())
            if try ProtocolSession.advertised(welcome) {
                let (selected, selectedChannel) = try await withDeadline(configuration.negotiationTimeout, clock: clock) { [configuration, negotiatedChannel] in
                    var current = negotiatedChannel
                    let hello = ProtocolSession.hello(clientID: configuration.clientID, kind: configuration.clientKind)
                    try await socket.send(current.seal(hello.text).text)
                    let response = try await socket.receive()
                    guard response.utf8.count <= configuration.maximumReceiveBytes else { throw CoreFailure(.tooLarge, "The negotiation message is too large.") }
                    let clear = try JSONValue.decode(Data(current.open(JSONValue.decode(Data(response.utf8))).utf8))
                    if clear["type"].stringValue == "protocol:error" { throw CoreFailure(.unsupported, clear["message"].stringValue ?? "Application protocol negotiation failed.") }
                    let selected = try ProtocolWelcome(validating: clear)
                    let advertisedRange = try V2Wire.range(welcome["proto"])
                    let advertisedCaps = try V2Wire.caps(welcome["caps"])
                    let eligible = advertisedRange.contains(2) && ProtocolCapabilities.core.allSatisfy(advertisedCaps.contains) ? 2 : (advertisedRange.contains(1) ? 1 : 0)
                    let intersection = Set(advertisedCaps).intersection(ProtocolCapabilities.supported)
                    try V2Wire.require(selected.version.rawValue == eligible && (selected.version == .v1 || Set(selected.capabilities) == intersection), "selected protocol")
                    return (selected, current)
                }
                guard selected.seat.id == pairing.deviceID else { throw CoreFailure(.crypto, "The negotiated seat is a different device.") }
                seat = selected.seat; negotiatedChannel = selectedChannel; session = ProtocolSession(welcome: selected, receivedAt: clock.now())
            }
            guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
            let baseContext = IntentContext(pairing: pairing, role: role, session: session)
            let intentContext = session.version == .v2 ? try await outbox.authorizedContext(baseContext) : baseContext
            guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
            box = negotiatedChannel; live = true; context = intentContext
            let recovery = session.version == .v2 ? try await outbox.recoveryQueries(context: intentContext, at: clock.now()) : (changes: [IntentChange](), queries: [JSONValue]())
            guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
            for change in recovery.changes { await sink(.intent(role, change)) }
            await sink(.negotiated(role, session))
            // Legacy ready stays immediate. V2 ready is a durable, immutable view intent.
            if session.version == .v2, role != .fleet, let ready = try await outbox.pendingDeclaration(.ready(hidden: false), context: intentContext) {
                try await write(ready.plaintext)
            } else { try await send(.ready(hidden: false)) }
            guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
            wasLive = true
            await sink(.welcome(role, seat, version: welcome["version"].stringValue))
            await sink(.state(role, .live))
            for query in recovery.queries { try await write(query.text) }
            if session.version == .v2 {
                receiptPollTask = Task { [weak self, clock] in
                    while !Task.isCancelled {
                        do { try await clock.sleep(for: .seconds(3)); try Task.checkCancellation(); try await self?.pollReceipts(attempt: attempt) }
                        catch { return }
                    }
                }
            } else {
                // Protected v2 recovery must never delay legacy ready or gate v1 writes.
                legacyQuarantineTask = Task { [weak self] in await self?.quarantineLegacy(context: intentContext, attempt: attempt) }
            }
            while generation == attempt, !Task.isCancelled {
                let text = try await socket.receive()
                guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
                guard text.utf8.count <= configuration.maximumReceiveBytes else { throw CoreFailure(.tooLarge, "The conversation is too large to receive.") }
                guard var current = box else { throw CoreFailure(.protocolViolation, "The sealed channel is unavailable.") }
                let clear = try current.open(JSONValue.decode(Data(text.utf8))); box = current
                let value = try JSONValue.decode(Data(clear.utf8))
                if value["type"].stringValue?.hasPrefix("@") == true, ["@welcome", "@challenge", "@auth", "@box"].contains(value["type"].stringValue ?? "") {
                    throw CoreFailure(.protocolViolation, "Unexpected authentication message after welcome.")
                }
                if ["hello", "welcome", "protocol:error"].contains(value["type"].stringValue ?? "") { throw CoreFailure(.protocolViolation, "Unexpected repeated application negotiation.") }
                let event = try ServerEvent.decode(value, role: role)
                snapshot.observe(event)
                if session.version == .v2 {
                    if let change = try await outbox.apply(event, context: intentContext) { await sink(.intent(role, change)) }
                    if case .initialized(let initValue) = event {
                        for operation in initValue.operations {
                            if let change = try await outbox.apply(.operation(operation), context: intentContext) { await sink(.intent(role, change)) }
                        }
                    }
                    for intent in try await outbox.takeResends(context: intentContext, snapshot: snapshot, at: clock.now()) {
                        try await write(intent.plaintext)
                    }
                    if case .ack(let ack) = event, ack.what == "send", ack.outcome == .applied, let mid = ack.mid {
                        try await write(JSONValue.object(["type": .string("operation:get"), "scope": .string(ack.scope), "mid": .string(mid)]).text)
                    }
                }
                await sink(.event(role, event))
            }
            throw CancellationError()
        } catch {
            let closure = await transport?.closure()
            let canceled = Task.isCancelled || generation != attempt || error is CancellationError
            let failure: CoreFailure?
            if canceled { failure = nil }
            else if closure?.code == 1008 { failure = CoreFailure(.refused, closure?.reason.isEmpty == false ? closure!.reason : "The laptop refused this connection.") }
            else { failure = (error as? CoreFailure) ?? CoreFailure(.transport, "The laptop connection was interrupted.") }
            if generation == attempt { await close() }
            let retryable = failure.map { [.transport, .offline, .timeout].contains($0.code) } ?? false
            if let failure { await sink(.failure(role, failure)) }
            return ConnectionExit(failure: failure, wasLive: wasLive, retryable: retryable)
        }
    }
    @discardableResult public func send(_ action: ClientAction, metadata: IntentMetadata = IntentMetadata()) async throws -> PendingIntent? {
        if let capability = action.optionalCapability, context?.session.supports(capability) == false { throw CoreFailure(.unsupported, "The laptop did not negotiate " + capability + ".") }
        if let context, context.session.version == .v2, action.needsIntent(on: context.role) {
            let attempt = generation
            let intent = try await outbox.prepare(action, context: context, metadata: metadata, at: clock.now())
            await updateSink?(.intent(context.role, IntentChange(intent: intent, consumesResult: false)))
            guard attempt == generation, live else { throw CoreFailure(.offline, "The connection changed after the intent was saved.") }
            try await write(intent.plaintext); return intent
        }
        try await write(action.json.text); return nil
    }
    /// Reattaching a subscription must not mint a replacement for an unresolved mutation.
    func restore(_ action: ClientAction) async throws {
        if let context, context.session.version == .v2, action.needsIntent(on: context.role), try await outbox.pendingDeclaration(action, context: context, includeUncertain: true) != nil { return }
        try await send(action)
    }
    private func pollReceipts(attempt: UInt64) async throws {
        guard generation == attempt, live, let context else { return }
        let recovery = try await outbox.recoveryQueries(context: context, at: clock.now())
        guard generation == attempt, live else { return }
        for change in recovery.changes { await updateSink?(.intent(context.role, change)) }
        for query in recovery.queries { try await write(query.text) }
        for intent in try await outbox.takeResends(context: context, snapshot: snapshot, at: clock.now()) { try await write(intent.plaintext) }
    }
    private func quarantineLegacy(context: IntentContext, attempt: UInt64) async {
        do {
            let recovery = try await outbox.recoveryQueries(context: context, at: clock.now())
            guard attempt == generation, live else { return }
            for change in recovery.changes { await updateSink?(.intent(context.role, change)) }
        } catch {
            guard attempt == generation, live else { return }
            await updateSink?(.failure(context.role, CoreFailure(.persistence, "The retained v2 intents could not be read or quarantined. Legacy delivery remains available.")))
        }
    }
    private func write(_ text: String) async throws {
        guard live, transport != nil else { throw CoreFailure(.offline, "The laptop is not connected.") }
        guard text.utf8.count <= configuration.maximumSendBytes else { throw CoreFailure(.tooLarge, "The message and attachments exceed the laptop's wire limit.") }
        let attempt = generation
        try await withCheckedThrowingContinuation { continuation in
            writes.append(Write(text: text, generation: attempt, continuation: continuation))
            if !writing { writing = true; Task { await drain() } }
        }
    }
    private func drain() async {
        while !writes.isEmpty {
            let write = writes.removeFirst()
            guard live, write.generation == generation, let socket = transport, var current = box else { write.continuation.resume(throwing: CoreFailure(.offline, "The laptop is not connected.")); continue }
            do {
                let frame = try current.seal(write.text); box = current
                let data = try frame.encoded()
                guard data.count <= configuration.maximumSendBytes else { throw CoreFailure(.tooLarge, "The message and attachments exceed the laptop's wire limit.") }
                try await socket.send(String(decoding: data, as: UTF8.self))
                guard write.generation == generation else { throw CoreFailure(.transport, "The connection changed during the write.") }
                write.continuation.resume()
            } catch {
                write.continuation.resume(throwing: error)
                if (error as? CoreFailure)?.code != .tooLarge { live = false; await socket.close() }
            }
        }
        writing = false
    }
    public func close() async {
        generation &+= 1; live = false; box = nil
        receiptPollTask?.cancel(); receiptPollTask = nil
        legacyQuarantineTask?.cancel(); legacyQuarantineTask = nil
        let old = transport; transport = nil
        let oldContext = context; context = nil; snapshot = ControlSnapshot()
        let pending = writes; writes.removeAll()
        for write in pending { write.continuation.resume(throwing: CoreFailure(.offline, "The connection closed before the message was written.")) }
        await old?.close()
        if let oldContext { await outbox.disconnected(target: oldContext.role.target) }
    }
}

public enum ReconnectPolicy {
    public static func delay(attempt: Int, jitterMilliseconds: Int = 0) -> TimeInterval {
        let values: [Double] = [0.4, 0.8, 1.6, 3.2, 6.4, 12]
        return values[min(max(attempt - 1, 0), values.count - 1)] + Double(min(max(jitterMilliseconds, 0), 249)) / 1_000
    }
}

/// Owns independent fleet/conversation negotiation and restores queries on reconnect.
public actor ConnectionManager {
    private let key: any SigningKeyProvider
    private let factory: any SocketFactory
    private let clock: any Clock
    private let configuration: TransportConfiguration
    private let outbox: PendingIntentRepository
    private let sink: @Sendable (ConnectionUpdate) async -> Void
    private let replay = NonceReplayCache()
    private var pairing: PairedConnection?
    private var lifecycle: AppLifecycle = .foreground
    private var selected: String?
    private var views: [String: (conversation: String, visibility: FeatureVisibility)] = [:]
    private var desiredConversations: Set<String> { Set(views.values.map(\.conversation) + [selected].compactMap { $0 }) }
    private func features(for role: SocketRole) -> FeatureVisibility {
        var result = role == .fleet || role.conversationID == selected ? visibility : FeatureVisibility()
        for view in views.values where role == .fleet || role.conversationID == view.conversation { result.formUnion(view.visibility) }
        return result
    }
    private var visibility = FeatureVisibility()
    private var terminalID: String?
    private var slackSelection: SlackThreadID?
    private var appleToken: String?
    private var epoch: UInt64 = 0
    private var wantsConnection = false
    private var closingCount = 0
    private var stopping: Set<SocketRole> = []
    private struct Slot { let connection: SocketConnection; let task: Task<Void, Never>; let epoch: UInt64 }
    private var slots: [SocketRole: Slot] = [:]
    public init(key: any SigningKeyProvider, factory: any SocketFactory = URLSessionSocketFactory(), clock: any Clock = SystemClock(), configuration: TransportConfiguration = TransportConfiguration(), outbox: PendingIntentRepository = PendingIntentRepository(store: MemoryKeyValueStore()), sink: @escaping @Sendable (ConnectionUpdate) async -> Void) {
        self.key = key; self.factory = factory; self.clock = clock; self.configuration = configuration; self.sink = sink
        self.outbox = outbox
    }
    public func connect(_ pairing: PairedConnection) async {
        wantsConnection = true
        if self.pairing != pairing { self.pairing = pairing; await closeAll() }
        guard wantsConnection, closingCount == 0, lifecycle == .foreground else { return }
        start(.fleet); for id in desiredConversations { start(.conversation(id)) }
    }
    private func start(_ role: SocketRole) {
        guard wantsConnection, closingCount == 0, !stopping.contains(role), slots[role] == nil, pairing != nil, lifecycle == .foreground else { return }
        epoch &+= 1; let current = epoch
        let connection = SocketConnection(factory: factory, clock: clock, configuration: configuration, replayCache: replay, outbox: outbox)
        let task = Task { await self.runLoop(role, connection: connection, epoch: current) }
        slots[role] = Slot(connection: connection, task: task, epoch: current)
    }
    private func runLoop(_ role: SocketRole, connection: SocketConnection, epoch: UInt64) async {
        var attempt = 0
        while let record = pairing, slots[role]?.epoch == epoch, !Task.isCancelled, lifecycle == .foreground {
            let result = await connection.run(pairing: record, key: key, role: role) { [weak self] update in await self?.forward(update, role: role, epoch: epoch) }
            guard slots[role]?.epoch == epoch, !Task.isCancelled, lifecycle == .foreground else { return }
            guard result.retryable else {
                if let e = result.failure {
                    let state: ConnectionState = e.code == .wrongLaptop ? .wrongLaptop : (e.code == .refused ? .refused(e.message) : .failed(e))
                    await sink(.state(role, state))
                } else { await sink(.state(role, .offline)) }
                return
            }
            if result.wasLive { attempt = 0 }
            attempt += 1
            let delay = ReconnectPolicy.delay(attempt: attempt, jitterMilliseconds: Int.random(in: 0...249))
            await sink(.state(role, .reconnecting(attempt: attempt, delay: delay)))
            do { try await clock.sleep(for: .milliseconds(Int64(delay * 1_000))) } catch { return }
        }
    }
    private func forward(_ update: ConnectionUpdate, role: SocketRole, epoch: UInt64) async {
        guard slots[role]?.epoch == epoch, lifecycle == .foreground else { return }
        await sink(update)
        if case .welcome = update { await resubscribe(role) }
    }
    @discardableResult public func send(_ action: ClientAction, on role: SocketRole, metadata: IntentMetadata = IntentMetadata()) async throws -> PendingIntent? {
        guard lifecycle == .foreground, let slot = slots[role] else { throw CoreFailure(.offline, "The laptop is not connected.") }
        let intent = try await slot.connection.send(action, metadata: metadata)
        if case .terminalAttach(let id) = action { terminalID = id }
        if case .slackOpen(let conversation, let thread) = action { slackSelection = SlackThreadID(conversation: conversation, thread: thread) }
        if case .appleToken(let token) = action { appleToken = token }
        return intent
    }
    /// Registration is idempotent metadata; retain it before welcome and resend after each authenticated reconnect.
    public func rememberAppleToken(_ token: String) { appleToken = token }
    private func resubscribe(_ role: SocketRole) async {
        let visibility = features(for: role)
        var actions: [ClientAction] = []
        switch role {
        case .fleet:
            actions = [.watchCodex, .history(), .devices, .awake]
            if visibility.report { actions.append(.status) }
            if visibility.terminal { actions.append(.terminalList); if let terminalID { actions.append(.terminalAttach(terminalID)) } }
            if visibility.slack { actions.append(.slackReady); if let s = slackSelection { actions.append(.slackOpen(conversation: s.conversation, thread: s.thread)) } }
            if let appleToken { actions.append(.appleToken(appleToken)) }
        case .conversation:
            if visibility.report { actions += [.statusOpen(true), .status] }
            if visibility.settings { actions += [.settingsOpen(true), .settings] }
            if visibility.commands { actions += [.commandsOpen(true), .commands] }
            if visibility.pr { actions.append(.prWatch(true)) }
        }
        for action in actions {
            do { if let slot = slots[role] { try await slot.connection.restore(action) } }
            catch { /* A lost subscription will restore after the next welcome. */ }
        }
    }
    public func selectConversation(_ id: String?) async {
        selected = id
        await reconcileViews()
    }
    public func setViewSession(_ token: String, conversationID: String?, visibility: FeatureVisibility = FeatureVisibility()) async {
        let before = Dictionary(uniqueKeysWithValues: slots.keys.map { ($0, features(for: $0)) })
        if let conversationID { views[token] = (conversationID, visibility) } else { views[token] = nil }
        await reconcileViews()
        await refreshFeatures(before: before)
    }
    private func reconcileViews() async {
        for role in Array(slots.keys) {
            if let id = role.conversationID, !desiredConversations.contains(id) { await stop(role) }
        }
        for id in desiredConversations { start(.conversation(id)) }
    }
    public func setVisibility(_ value: FeatureVisibility) async {
        let before = Dictionary(uniqueKeysWithValues: slots.keys.map { ($0, features(for: $0)) })
        visibility = value
        await refreshFeatures(before: before)
    }
    private func refreshFeatures(before: [SocketRole: FeatureVisibility]) async {
        for role in Array(slots.keys) {
            let old = before[role] ?? FeatureVisibility(), value = features(for: role)
            guard old != value else { continue }
            if role.conversationID != nil {
                if old.report != value.report { _ = try? await send(.statusOpen(value.report), on: role) }
                if old.settings != value.settings { _ = try? await send(.settingsOpen(value.settings), on: role) }
                if old.commands != value.commands { _ = try? await send(.commandsOpen(value.commands), on: role) }
                if old.pr != value.pr { _ = try? await send(.prWatch(value.pr), on: role) }
            }
            await resubscribe(role)
        }
    }
    public func setLifecycle(_ value: AppLifecycle) async {
        lifecycle = value
        if value != .foreground { await closeAll() }
        else if wantsConnection, let pairing { await connect(pairing) }
    }
    public func reconnectNow() async { wantsConnection = true; await closeAll() }
    private func stop(_ role: SocketRole) async {
        guard let slot = slots.removeValue(forKey: role) else { return }
        stopping.insert(role)
        slot.task.cancel(); await slot.connection.close(); await sink(.state(role, .offline))
        stopping.remove(role)
        if let id = role.conversationID, desiredConversations.contains(id) { start(role) }
    }
    private func closeAll() async {
        closingCount += 1
        let old = slots; slots.removeAll() // Invalidate every generation before the first asynchronous close.
        for (role, slot) in old {
            slot.task.cancel(); await slot.connection.close(); await sink(.state(role, .offline))
        }
        closingCount -= 1
        if closingCount == 0, wantsConnection, lifecycle == .foreground {
            start(.fleet); for id in desiredConversations { start(.conversation(id)) }
        }
    }
    public func disconnect() async { wantsConnection = false; await closeAll() }
}
