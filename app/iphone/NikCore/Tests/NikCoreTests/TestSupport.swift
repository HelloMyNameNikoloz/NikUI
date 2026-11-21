import Foundation
import CryptoKit
import Testing
@testable import NikCore

func fixture(_ name: String = "interop") throws -> JSONValue {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
    return try JSONValue.decode(Data(contentsOf: url))
}
func unhex(_ text: String) -> Data { var result = Data(); var i = text.startIndex; while i < text.endIndex { let end = text.index(i, offsetBy: 2); result.append(UInt8(text[i..<end], radix: 16)!); i = end }; return result }
func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
func json(_ text: String) throws -> JSONValue { try .decode(Data(text.utf8)) }
func record(_ vectors: JSONValue = try! fixture()) throws -> PairedConnection {
    PairedConnection(deviceID: "device1", baseURL: URL(string: "http://127.0.0.1:4517")!, laptopName: "Test laptop", serverSPKI: try NikCrypto.decodeBase64URL(vectors["hostSPKI"].stringValue!), fingerprint: vectors["fingerprint"].stringValue!, keyID: "device-key", publicSPKI: try NikCrypto.decodeBase64URL(vectors["deviceSPKI"].stringValue!), protection: .software)
}
func softwareKey(_ vectors: JSONValue = try! fixture()) throws -> SoftwareSigningKey { try SoftwareSigningKey(keyID: "device-key", rawRepresentation: unhex(vectors["deviceRaw"].stringValue!)) }
func expectFailure(_ code: CoreFailure.Code, sourceLocation: SourceLocation = #_sourceLocation, operation: () throws -> Void) {
    do { try operation(); Issue.record("Expected failure \(code)", sourceLocation: sourceLocation) }
    catch let e as CoreFailure { #expect(e.code == code, sourceLocation: sourceLocation) }
    catch { Issue.record("Unexpected error \(error)", sourceLocation: sourceLocation) }
}
func eventually(_ predicate: @escaping @Sendable () async -> Bool, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    for _ in 0..<300 { if await predicate() { return }; try await Task.sleep(for: .milliseconds(5)) }
    Issue.record("Condition did not become true", sourceLocation: sourceLocation)
}
final class TestClock: Clock, @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_800_000_000)
    private struct Sleeper { let id: UUID; let deadline: Date; let continuation: CheckedContinuation<Void, any Error> }
    private var sleepers: [Sleeper] = []
    private var canceled: Set<UUID> = []
    func now() -> Date { lock.withLock { date } }
    func advance(_ seconds: TimeInterval) {
        let wake: [Sleeper] = lock.withLock { date = date.addingTimeInterval(seconds); let ready = sleepers.filter { $0.deadline <= date }; sleepers.removeAll { $0.deadline <= date }; return ready }
        for sleeper in wake { sleeper.continuation.resume() }
    }
    func pendingSleeps() -> Int { lock.withLock { sleepers.count } }
    func hasSleeper(after seconds: TimeInterval) -> Bool { lock.withLock { sleepers.contains { $0.deadline.timeIntervalSince(date) >= seconds } } }
    func sleep(for duration: Duration) async throws {
        let parts = duration.components; let seconds = Double(parts.seconds) + Double(parts.attoseconds) / 1e18
        let id = UUID()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let cancel = lock.withLock {
                    if canceled.remove(id) != nil { return true }
                    sleepers.append(Sleeper(id: id, deadline: date.addingTimeInterval(seconds), continuation: continuation)); return false
                }
                if cancel { continuation.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let sleeper: Sleeper? = self.lock.withLock {
                if let i = self.sleepers.firstIndex(where: { $0.id == id }) { return self.sleepers.remove(at: i) }
                self.canceled.insert(id); return nil
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }
}
actor RecordingHTTP: HTTPClient {
    private(set) var requests: [URLRequest] = []
    var response: HTTPResponse
    init(response: HTTPResponse) { self.response = response }
    func send(_ request: URLRequest) -> HTTPResponse { requests.append(request); return response }
}
actor FailingStore: KeyValueStore {
    var values: [String: Data] = [:]
    var failWrites = false
    func data(forKey key: String) -> Data? { values[key] }
    func set(_ data: Data, forKey key: String) throws { if failWrites { throw CoreFailure(.persistence, "Simulated write failure") }; values[key] = data }
    func removeValue(forKey key: String) { values.removeValue(forKey: key) }
    func setFailWrites(_ fail: Bool) { failWrites = fail }
}
actor ScriptedSocket: SocketTransport {
    enum Behavior: Sendable { case normal, plaintextWelcome, invalidWelcome, noWelcome, wrongPin, noChallenge, delayedSend }
    private var inbox: [String] = []
    private var receiver: CheckedContinuation<String, any Error>?
    private var closed = false
    private var closeInfo: SocketClosure?
    private var channel: Box?
    private let host: P256.Signing.PrivateKey
    private let ephemeral: P256.KeyAgreement.PrivateKey
    private let deviceSPKI: Data
    private let nonce: String
    private let behavior: Behavior
    private let role: SocketRole
    private let applicationWelcome: JSONValue?
    private let holdNegotiation: Bool
    private(set) var actions: [JSONValue] = []
    private(set) var wireFrames: [JSONValue] = []
    private(set) var authValid = false
    init(index: Int, role: SocketRole = .fleet, behavior: Behavior = .normal, applicationWelcome: JSONValue? = nil, holdNegotiation: Bool = false) throws {
        let v = try fixture(); host = try P256.Signing.PrivateKey(rawRepresentation: unhex(v["hostRaw"].stringValue!))
        ephemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: unhex(v["serverEphemeralRaw"].stringValue!))
        deviceSPKI = try NikCrypto.decodeBase64URL(v["deviceSPKI"].stringValue!); nonce = NikCrypto.base64URL(Data(repeating: UInt8(index % 255 + 1), count: 32)); self.behavior = behavior; self.role = role
        self.applicationWelcome = applicationWelcome; self.holdNegotiation = holdNegotiation
        if behavior != .noChallenge {
            inbox = [JSONValue.object(["type": .string("@challenge"), "nonce": .string(nonce), "epk": .string(NikCrypto.base64URL(ephemeral.publicKey.derRepresentation)), "serverKey": .string(NikCrypto.base64URL(host.publicKey.derRepresentation)), "fingerprint": .string(behavior == .wrongPin ? "wrong" : NikCrypto.fingerprint(host.publicKey.derRepresentation))]).text]
        }
    }
    func receive() async throws -> String {
        if !inbox.isEmpty { return inbox.removeFirst() }; if closed { throw CoreFailure(.transport, "Closed test socket") }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) } else { receiver = continuation }
            }
        } onCancel: { Task { await self.cancelReceive() } }
    }
    private func cancelReceive() { receiver?.resume(throwing: CancellationError()); receiver = nil }
    private func push(_ text: String) {
        if let receiver { self.receiver = nil; receiver.resume(returning: text) } else { inbox.append(text) }
    }
    func send(_ text: String) async throws {
        if closed { throw CoreFailure(.transport, "Closed test socket") }
        let frame = try json(text); wireFrames.append(frame)
        if frame["type"].stringValue == "@auth" {
            let ec = try NikCrypto.decodeBase64URL(frame["epk"].stringValue!); let nc = frame["nonce"].stringValue!
            let binding = NikCrypto.binding(serverSPKI: ephemeral.publicKey.derRepresentation, clientSPKI: ec)
            authValid = NikCrypto.verify(signature: try NikCrypto.decodeBase64URL(frame["signature"].stringValue!), message: Data("nikui-auth:\(nonce):\(nc):\(binding)".utf8), publicSPKI: deviceSPKI)
            guard authValid else { push(JSONValue.object(["type":.string("@denied"),"reason":.string("invalid signature")]).text); return }
            let shared = try ephemeral.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(derRepresentation: ec)).withUnsafeBytes { Data($0) }
            let keys = try ChannelKeys.derive(sharedSecret: shared, serverNonce: nonce, clientNonce: nc)
            channel = Box(sending: keys.toClient, receiving: keys.toServer)
            guard behavior != .noWelcome else { return }
            let message = Data("nikui-host:\(nc):\(nonce):\(binding)".utf8)
            var welcome: JSONValue = .object(["type":.string("@welcome"),"device":.object(["id":.string("device1"),"name":.string("iPhone"),"kind":.string("device"),"control":.bool(true)]),"signature":.string(NikCrypto.base64URL(try host.signature(for: message).rawRepresentation)),"version":.string("0.2.0")])
            if behavior == .invalidWelcome { welcome["signature"] = .string(NikCrypto.base64URL(Data(repeating: 0, count: 64))) }
            if let applicationWelcome {
                welcome["proto"] = .object(["min": .number(1), "max": .number(2)])
                welcome["caps"] = applicationWelcome["proto"].intValue == 2 ? applicationWelcome["caps"] : .array(ProtocolCapabilities.core.map(JSONValue.string))
            }
            if behavior == .plaintextWelcome { push(welcome.text) } else { try enqueue(welcome) }; return
        }
        guard var current = channel else { throw CoreFailure(.protocolViolation, "No test channel") }
        let clear = try current.open(frame); channel = current
        let action = try json(clear); actions.append(action)
        if behavior == .delayedSend { try await Task.sleep(for: .milliseconds(2)) }
        switch action["type"].stringValue {
        case "hello":
            if let applicationWelcome, !holdNegotiation { try enqueue(applicationWelcome) }
        case "ready":
            if case .conversation(let id) = role {
                var snapshot = PreviewFixtures.conversation.raw; snapshot["sessionId"] = .string(id)
                if applicationWelcome?["proto"].intValue == 2 {
                    let run: JSONValue = .object(["id": .string("a81ec16e4ac74040a9107dbe669380b5"), "turn": .string("turn-9")])
                    snapshot["run"] = run
                    snapshot["items"] = .array(snapshot["items"].arrayValue.map { value in var item = value; if item["kind"].stringValue == "permission" { item["run"] = run }; return item })
                    try enqueue(testAck(action, target: role.target, data: .object(["instance": .string(id), "run": run])))
                }
                try enqueue(snapshot)
            }
            else { var fleet = PreviewFixtures.fleet.raw; fleet["type"] = .string("fleet"); try enqueue(fleet) }
        case "instance:new", "instance:resume": try enqueue(.object(["type":.string("instance:created"),"id":action["id"],"instance":.string("new-session")]))
        case "instance:place": try enqueue(.object(["type":.string("instance:placed"),"id":action["id"]]))
        default: break
        }
    }
    func enqueue(_ event: JSONValue) throws { guard var box = channel else { throw CoreFailure(.crypto, "No channel") }; let frame = try box.seal(event.text); channel = box; push(frame.text) }
    func plaintext(_ event: JSONValue) { push(event.text) }
    func close() { closed = true; receiver?.resume(throwing: CoreFailure(.transport, "Closed test socket")); receiver = nil }
    func closure() -> SocketClosure? { closeInfo }
    func fail(code: Int? = nil, reason: String = "") { if let code { closeInfo = SocketClosure(code: code, reason: reason) }; close() }
    func isClosed() -> Bool { closed }
}
func testAck(_ action: JSONValue, target: String, data: JSONValue, outcome: String = "applied", error: JSONValue = .null, replies: [JSONValue] = []) -> JSONValue {
    let at = action["issuedAt"].intValue ?? 1_795_179_601_000
    return .object(["type": .string("ack"), "scope": action["scope"], "mid": action["mid"], "what": action["type"], "target": .string(target), "status": .string(outcome), "outcome": .string(outcome), "admitted": .bool(true), "at": .number(Double(at)), "expiresAt": .number(Double(at + 86_400_000)), "result": outcome == "applied" ? .object(["code": .string(action["type"].stringValue == "send" ? "accepted" : "ok"), "data": data, "replies": .array(replies)]) : .null, "error": error])
}
actor ScriptedFactory: SocketFactory {
    private(set) var sockets: [ScriptedSocket] = []
    private(set) var urls: [URL] = []
    let behavior: ScriptedSocket.Behavior
    init(behavior: ScriptedSocket.Behavior = .normal) { self.behavior = behavior }
    func open(url: URL, maximumMessageBytes: Int) throws -> any SocketTransport {
        let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "session" })?.value
        let socket = try ScriptedSocket(index: sockets.count, role: id.map(SocketRole.conversation) ?? .fleet, behavior: behavior)
        sockets.append(socket); urls.append(url); return socket
    }
    func socket(_ index: Int = 0) -> ScriptedSocket? { sockets.indices.contains(index) ? sockets[index] : nil }
    func count() -> Int { sockets.count }
    func activeCount() async -> Int { var count = 0; for socket in sockets { if !(await socket.isClosed()) { count += 1 } }; return count }
}
actor UpdateRecorder {
    private(set) var updates: [ConnectionUpdate] = []
    func append(_ value: ConnectionUpdate) { updates.append(value) }
    func isLive() -> Bool { updates.contains { if case .state(_, .live) = $0 { return true }; return false } }
}
