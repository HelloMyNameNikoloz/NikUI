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
    public init() {}
}
public enum ConnectionUpdate: Sendable, Equatable {
    case state(SocketRole, ConnectionState), welcome(SocketRole, Seat, version: String?)
    case event(SocketRole, ServerEvent), failure(SocketRole, CoreFailure)
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
    public init(factory: any SocketFactory = URLSessionSocketFactory(), clock: any Clock = SystemClock(), configuration: TransportConfiguration = TransportConfiguration(), replayCache: NonceReplayCache = NonceReplayCache()) {
        self.factory = factory; self.clock = clock; self.configuration = configuration; self.replayCache = replayCache
    }
    public static func url(base: URL, role: SocketRole) throws -> URL {
        let validated = try PairingInvitation.address(base.absoluteString)
        guard var c = URLComponents(url: validated, resolvingAgainstBaseURL: false) else { throw CoreFailure(.invalidInput, "The laptop address is invalid.") }
        c.scheme = validated.scheme == "https" ? "wss" : "ws"; c.path = "/socket"
        if case .conversation(let id) = role { c.queryItems = [URLQueryItem(name: "session", value: id)] }
        guard let url = c.url else { throw CoreFailure(.invalidInput, "The socket address is invalid.") }; return url
    }
    public func run(pairing: PairedConnection, key: any SigningKeyProvider, role: SocketRole, sink: @escaping @Sendable (ConnectionUpdate) async -> Void) async -> ConnectionExit {
        generation &+= 1; let attempt = generation
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
            let seat = try proof.verifyWelcome(welcome)
            guard seat.id == pairing.deviceID else { throw CoreFailure(.crypto, "The laptop welcomed a different device.") }
            box = channel; live = true
            // ready is always the first application message, before exposing live state to the UI.
            try await send(.ready(hidden: false))
            guard generation == attempt, !Task.isCancelled else { throw CancellationError() }
            wasLive = true
            await sink(.welcome(role, seat, version: welcome["version"].stringValue))
            await sink(.state(role, .live))
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
                await sink(.event(role, try ServerEvent.decode(value, role: role)))
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
    public func send(_ action: ClientAction) async throws {
        guard live, transport != nil else { throw CoreFailure(.offline, "The laptop is not connected.") }
        let data = try action.json.encoded()
        guard data.count <= configuration.maximumSendBytes else { throw CoreFailure(.tooLarge, "The message and attachments exceed the laptop's wire limit.") }
        let text = String(decoding: data, as: UTF8.self); let attempt = generation
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
        let old = transport; transport = nil
        let pending = writes; writes.removeAll()
        for write in pending { write.continuation.resume(throwing: CoreFailure(.offline, "The connection closed before the message was written.")) }
        await old?.close()
    }
}

public enum ReconnectPolicy {
    public static func delay(attempt: Int, jitterMilliseconds: Int = 0) -> TimeInterval {
        let values: [Double] = [0.4, 0.8, 1.6, 3.2, 6.4, 12]
        return values[min(max(attempt - 1, 0), values.count - 1)] + Double(min(max(jitterMilliseconds, 0), 249)) / 1_000
    }
}

/// Owns one fleet socket and at most one selected conversation socket. Mutations are never replayed.
public actor ConnectionManager {
    private let key: any SigningKeyProvider
    private let factory: any SocketFactory
    private let clock: any Clock
    private let configuration: TransportConfiguration
    private let sink: @Sendable (ConnectionUpdate) async -> Void
    private let replay = NonceReplayCache()
    private var pairing: PairedConnection?
    private var lifecycle: AppLifecycle = .foreground
    private var selected: String?
    private var visibility = FeatureVisibility()
    private var terminalID: String?
    private var slackSelection: SlackThreadID?
    private var appleToken: String?
    private var epoch: UInt64 = 0
    private var wantsConnection = false
    private var closingCount = 0
    private struct Slot { let connection: SocketConnection; let task: Task<Void, Never>; let epoch: UInt64 }
    private var slots: [SocketRole: Slot] = [:]
    public init(key: any SigningKeyProvider, factory: any SocketFactory = URLSessionSocketFactory(), clock: any Clock = SystemClock(), configuration: TransportConfiguration = TransportConfiguration(), sink: @escaping @Sendable (ConnectionUpdate) async -> Void) {
        self.key = key; self.factory = factory; self.clock = clock; self.configuration = configuration; self.sink = sink
    }
    public func connect(_ pairing: PairedConnection) async {
        wantsConnection = true
        if self.pairing != pairing { self.pairing = pairing; await closeAll() }
        guard wantsConnection, closingCount == 0, lifecycle == .foreground else { return }
        start(.fleet); if let selected { start(.conversation(selected)) }
    }
    private func start(_ role: SocketRole) {
        guard wantsConnection, closingCount == 0, slots[role] == nil, pairing != nil, lifecycle == .foreground else { return }
        epoch &+= 1; let current = epoch
        let connection = SocketConnection(factory: factory, clock: clock, configuration: configuration, replayCache: replay)
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
    public func send(_ action: ClientAction, on role: SocketRole) async throws {
        guard lifecycle == .foreground, let slot = slots[role] else { throw CoreFailure(.offline, "The laptop is not connected.") }
        try await slot.connection.send(action)
        if case .terminalAttach(let id) = action { terminalID = id }
        if case .slackOpen(let conversation, let thread) = action { slackSelection = SlackThreadID(conversation: conversation, thread: thread) }
        if case .appleToken(let token) = action { appleToken = token }
    }
    /// Registration is idempotent metadata; retain it before welcome and resend after each authenticated reconnect.
    public func rememberAppleToken(_ token: String) { appleToken = token }
    private func resubscribe(_ role: SocketRole) async {
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
        for action in actions { do { try await send(action, on: role) } catch { /* A lost subscription will restore after the next welcome. */ } }
    }
    public func selectConversation(_ id: String?) async {
        guard selected != id else { return }
        let old = selected; selected = id
        if let old { await stop(.conversation(old)) }
        guard selected == id else { return }
        if let id { start(.conversation(id)) }
    }
    public func setVisibility(_ value: FeatureVisibility) async {
        let old = visibility; visibility = value
        if let selected {
            let role = SocketRole.conversation(selected)
            if old.report != value.report { try? await send(.statusOpen(value.report), on: role) }
            if old.settings != value.settings { try? await send(.settingsOpen(value.settings), on: role) }
            if old.commands != value.commands { try? await send(.commandsOpen(value.commands), on: role) }
            if old.pr != value.pr { try? await send(.prWatch(value.pr), on: role) }
        }
        for role in Array(slots.keys) { await resubscribe(role) }
    }
    public func setLifecycle(_ value: AppLifecycle) async {
        lifecycle = value
        if value != .foreground { await closeAll() }
        else if wantsConnection, let pairing { await connect(pairing) }
    }
    public func reconnectNow() async { wantsConnection = true; await closeAll() }
    private func stop(_ role: SocketRole) async {
        guard let slot = slots.removeValue(forKey: role) else { return }
        slot.task.cancel(); await slot.connection.close(); await sink(.state(role, .offline))
    }
    private func closeAll() async {
        closingCount += 1
        let old = slots; slots.removeAll() // Invalidate every generation before the first asynchronous close.
        for (role, slot) in old {
            slot.task.cancel(); await slot.connection.close(); await sink(.state(role, .offline))
        }
        closingCount -= 1
        if closingCount == 0, wantsConnection, lifecycle == .foreground {
            start(.fleet); if let selected { start(.conversation(selected)) }
        }
    }
    public func disconnect() async { wantsConnection = false; await closeAll() }
}
