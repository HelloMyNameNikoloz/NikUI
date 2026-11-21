import Foundation

/// Lossless, Sendable JSON used for tool arguments, unknown variants, and optional wire fields.
public enum JSONValue: Codable, Sendable, Equatable, Hashable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    public subscript(_ key: String) -> JSONValue {
        get { if case .object(let d) = self { return d[key] ?? .null }; return .null }
        set { var d = objectValue; d[key] = newValue; self = .object(d) }
    }
    public var objectValue: [String: JSONValue] { if case .object(let v) = self { return v }; return [:] }
    public var arrayValue: [JSONValue] { if case .array(let v) = self { return v }; return [] }
    public var stringValue: String? { if case .string(let v) = self { return v }; return nil }
    public var doubleValue: Double? { if case .number(let v) = self, v.isFinite { return v }; return nil }
    public var intValue: Int? {
        guard let v = doubleValue, v.rounded(.towardZero) == v, v >= Double(Int.min), v < Double(Int.max) else { return nil }
        return Int(v)
    }
    public var boolValue: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var isNull: Bool { self == .null }
    public func merged(with patch: JSONValue) -> JSONValue {
        .object(objectValue.merging(patch.objectValue) { _, new in new })
    }
    public static func decode(_ data: Data) throws -> JSONValue { try JSONDecoder().decode(Self.self, from: data) }
    public func encoded() throws -> Data { try WireCoding.encode(self) }
    public var text: String { (try? String(data: encoded(), encoding: .utf8)) ?? "null" }
}
public enum WireCoding {
    /// Avoid doubling '/' in standard image/audio base64 before the encrypted outer envelope expands it again.
    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]; return try encoder.encode(value)
    }
}

/// DTOs retain the original JSON. Missing/null fields have safe defaults; unknown fields round-trip.
public protocol WireModel: Codable, Sendable, Equatable {
    var raw: JSONValue { get set }
    init(_ raw: JSONValue)
}
extension WireModel {
    public init(from decoder: any Decoder) throws { self.init(try JSONValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
    public func string(_ key: String, default fallback: String = "") -> String { raw[key].stringValue ?? fallback }
    public func number(_ key: String, default fallback: Double = 0) -> Double { raw[key].doubleValue ?? fallback }
    public func integer(_ key: String, default fallback: Int = 0) -> Int { raw[key].intValue ?? fallback }
    public func flag(_ key: String, default fallback: Bool = false) -> Bool { raw[key].boolValue ?? fallback }
    public func model<T: WireModel>(_ key: String, as type: T.Type = T.self) -> T? {
        guard case .object = raw[key] else { return nil }; return T(raw[key])
    }
    public func models<T: WireModel>(_ key: String, as type: T.Type = T.self) -> [T] {
        raw[key].arrayValue.compactMap { if case .object = $0 { return T($0) }; return nil }
    }
}

public enum Provider: String, Codable, Sendable, CaseIterable { case claude, codex, unknown }
public enum ConversationStatus: String, Codable, Sendable, CaseIterable { case idle, working, waiting, done, error, stopped, unknown }
public enum KeyProtection: String, Codable, Sendable { case secureEnclave = "secure-enclave", keychain, strongbox, keystore, software, unknown }
public enum SocketRole: Sendable, Hashable { case fleet, conversation(String) }
public enum AppLifecycle: Sendable, Equatable { case foreground, inactive, background, locked }
public enum ConnectionState: Sendable, Equatable {
    case idle, connecting, authenticating, live, reconnecting(attempt: Int, delay: TimeInterval), offline
    case refused(String), wrongLaptop, failed(CoreFailure)
    public var isLive: Bool { self == .live }
}
public struct CoreFailure: Error, Sendable, Equatable, LocalizedError, Codable {
    public enum Code: String, Sendable, Codable {
        case invalidInput, notPaired, missingKey, locked, noEntitlement, keychain, canceled
        case offline, refused, wrongLaptop, protocolViolation, crypto, replay, tooLarge, timeout, unsupported, persistence, transport
    }
    public let code: Code
    public let message: String
    public init(_ code: Code, _ message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { message }
}
public enum DeliveryState: String, Codable, Sendable { case draft, submitting, submitted, accepted, ambiguous, failed }
public struct PendingOperation: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var action: String
    public var state: DeliveryState
    public var createdAt: Date
    public var reason: String?
    public init(id: String = UUID().uuidString, action: String, state: DeliveryState = .submitting, createdAt: Date = Date(), reason: String? = nil) {
        self.id = id; self.action = action; self.state = state; self.createdAt = createdAt; self.reason = reason
    }
}
public enum LocalIntent: Sendable, Equatable { case report, settings, commands, slack, navigate(String), focus, externalURL(URL) }
public enum ActionResult: Sendable, Equatable {
    case notSent(CoreFailure)
    /// Written to the socket; the current server has no receipt for this operation.
    case submitted(PendingOperation)
    case accepted(JSONValue)
    case ambiguous(PendingOperation)
    case local(LocalIntent)
}

/// Adapter signs UTF-8 message bytes once with ECDSA/SHA256 and returns 64-byte P1363 r||s.
public protocol SigningKeyProvider: Sendable {
    var keyID: String { get }
    var protection: KeyProtection { get }
    func publicSPKI() async throws -> Data
    func sign(message: Data) async throws -> Data
    func delete() async throws
}
extension SigningKeyProvider {
    public func delete() async throws { throw CoreFailure(.unsupported, "Key deletion is unavailable.") }
}
/// Use a ThisDeviceOnly Keychain adapter for pairing and PIN records, protected files for UI state.
public protocol KeyValueStore: Sendable {
    func data(forKey key: String) async throws -> Data?
    func set(_ data: Data, forKey key: String) async throws
    func removeValue(forKey key: String) async throws
}
public protocol Clock: Sendable {
    func now() -> Date
    func sleep(for duration: Duration) async throws
}
public struct SystemClock: Clock {
    public init() {}
    public func now() -> Date { Date() }
    public func sleep(for duration: Duration) async throws { try await Task.sleep(for: duration) }
}
public actor MemoryKeyValueStore: KeyValueStore {
    private var values: [String: Data] = [:]
    public init() {}
    public func data(forKey key: String) -> Data? { values[key] }
    public func set(_ data: Data, forKey key: String) { values[key] = data }
    public func removeValue(forKey key: String) { values.removeValue(forKey: key) }
}
public enum WireDate {
    public static func date(_ value: JSONValue) -> Date? {
        if let n = value.doubleValue, n > 0 { return Date(timeIntervalSince1970: n / 1_000) }
        guard let s = value.stringValue else { return nil }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]; return f.date(from: s)
    }
    public static func milliseconds(_ date: Date) -> Double { date.timeIntervalSince1970 * 1_000 }
}
