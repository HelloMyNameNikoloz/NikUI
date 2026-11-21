import Foundation
import CommonCrypto

public struct PINRecord: Sendable, Codable, Equatable {
    public var salt: Data
    public var hash: Data
    public var rounds: Int
    public var length: Int
    public var biometric: Bool
    public var wrong: Int
    public var until: Date?
    public init(salt: Data, hash: Data, rounds: Int = 210_000, length: Int, biometric: Bool = false, wrong: Int = 0, until: Date? = nil) {
        self.salt = salt; self.hash = hash; self.rounds = rounds; self.length = length; self.biometric = biometric; self.wrong = wrong; self.until = until
    }
}
public struct PINStatus: Sendable, Equatable {
    public var enabled: Bool
    public var length: Int?
    public var biometric: Bool
    public var wrong: Int
    public var until: Date?
}
public enum PINResult: Sendable, Equatable {
    case unlocked, configured, disabled, wrong(attempts: Int, until: Date?), cooldown(until: Date), invalidPIN, mismatch, requiresCurrentPIN, notConfigured
}
public enum PBKDF2 {
    /// Apple CommonCrypto PBKDF2-HMAC-SHA256, no dependencies or UI frameworks. Run off the main actor.
    public static func sha256(password: Data, salt: Data, rounds: Int = 210_000, byteCount: Int = 32) throws -> Data {
        guard rounds > 0, rounds <= 10_000_000, byteCount > 0, byteCount <= 1024 else { throw CoreFailure(.invalidInput, "Invalid PBKDF2 parameters.") }
        var output = Data(count: byteCount)
        let status = output.withUnsafeMutableBytes { out in
            password.withUnsafeBytes { pass in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pass.baseAddress?.assumingMemoryBound(to: Int8.self), password.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(rounds), out.baseAddress?.assumingMemoryBound(to: UInt8.self), byteCount)
                }
            }
        }
        guard status == kCCSuccess else { throw CoreFailure(.crypto, "PIN derivation failed.") }; return output
    }
}
/// Persistent attempt/cooldown logic. The injectable store should be ThisDeviceOnly Keychain on iOS.
public actor PINVerifier {
    public static let storageKey = "nikui.pin.v1"
    private let store: any KeyValueStore
    private let clock: any Clock
    // Operations explicitly queue: store awaits must not allow two failed attempts to lose an increment.
    private var tail: Task<PINResult, any Error>?
    public init(store: any KeyValueStore, clock: any Clock = SystemClock()) { self.store = store; self.clock = clock }
    public static func valid(_ pin: String) -> Bool { (4...12).contains(pin.utf8.count) && pin.utf8.allSatisfy { (48...57).contains($0) } }
    public static func cooldown(wrong: Int) -> TimeInterval { wrong >= 10 ? 900 : (wrong >= 7 ? 120 : (wrong >= 5 ? 30 : 0)) }
    private func load() async throws -> PINRecord? {
        guard let data = try await store.data(forKey: Self.storageKey) else { return nil }
        let value: PINRecord
        do { value = try JSONDecoder().decode(PINRecord.self, from: data) } catch { throw CoreFailure(.persistence, "The PIN record is unreadable; it was not reset.") }
        guard value.salt.count == 16, value.hash.count == 32, value.rounds == 210_000, (4...12).contains(value.length), value.wrong >= 0 else { throw CoreFailure(.persistence, "The PIN record is invalid; it was not reset.") }
        return value
    }
    public func status() async throws -> PINStatus {
        _ = try await tail?.value
        let record = try await load()
        return PINStatus(enabled: record != nil, length: record?.length, biometric: record?.biometric ?? false, wrong: record?.wrong ?? 0, until: record?.until)
    }
    private func queued(_ work: @escaping @Sendable () async throws -> PINResult) async throws -> PINResult {
        let previous = tail
        let task = Task { _ = try? await previous?.value; return try await work() }
        tail = task; return try await task.value
    }
    public func verify(_ pin: String) async throws -> PINResult { try await queued { try await self.check(pin) } }
    private func check(_ pin: String) async throws -> PINResult {
        guard var record = try await load() else { return .notConfigured }
        let now = clock.now()
        if let until = record.until, until > now { return .cooldown(until: until) }
        guard Self.valid(pin) else { return .invalidPIN }
        let actual = try PBKDF2.sha256(password: Data(pin.utf8), salt: record.salt, rounds: record.rounds)
        if NikCrypto.constantTimeEqual(actual, record.hash) {
            record.wrong = 0; record.until = nil
            try await store.set(WireCoding.encode(record), forKey: Self.storageKey); return .unlocked
        }
        record.wrong = min(record.wrong + 1, 1_000_000)
        let wait = Self.cooldown(wrong: record.wrong); record.until = wait > 0 ? now.addingTimeInterval(wait) : nil
        try await store.set(WireCoding.encode(record), forKey: Self.storageKey)
        return .wrong(attempts: record.wrong, until: record.until)
    }
    public func configure(pin: String, confirmation: String, currentPIN: String? = nil) async throws -> PINResult {
        try await queued { try await self.configureNow(pin: pin, confirmation: confirmation, currentPIN: currentPIN) }
    }
    private func configureNow(pin: String, confirmation: String, currentPIN: String?) async throws -> PINResult {
        guard Self.valid(pin) else { return .invalidPIN }; guard pin == confirmation else { return .mismatch }
        let old = try await load()
        if old != nil {
            guard let currentPIN else { return .requiresCurrentPIN }
            let result = try await check(currentPIN); guard result == .unlocked else { return result }
        }
        let salt = try NikCrypto.randomBytes(count: 16)
        let record = try PINRecord(salt: salt, hash: PBKDF2.sha256(password: Data(pin.utf8), salt: salt), length: pin.count, biometric: old?.biometric ?? false)
        try await store.set(WireCoding.encode(record), forKey: Self.storageKey); return .configured
    }
    public func disable(currentPIN: String) async throws -> PINResult {
        try await queued {
            let result = try await self.check(currentPIN); guard result == .unlocked else { return result }
            try await self.store.removeValue(forKey: Self.storageKey); return .disabled
        }
    }
    /// Policy: biometrics cannot bypass a PIN cooldown. A successful biometric resets persisted attempts.
    public func biometricSucceeded() async throws -> PINResult {
        try await queued {
            guard var record = try await self.load() else { return .notConfigured }
            if let until = record.until, until > self.clock.now() { return .cooldown(until: until) }
            guard record.biometric else { return .requiresCurrentPIN }
            record.wrong = 0; record.until = nil
            try await self.store.set(WireCoding.encode(record), forKey: Self.storageKey); return .unlocked
        }
    }
    public func setBiometric(_ enabled: Bool) async throws {
        _ = try await queued {
            guard var record = try await self.load() else { throw CoreFailure(.invalidInput, "Set a PIN first.") }
            record.biometric = enabled; try await self.store.set(WireCoding.encode(record), forKey: Self.storageKey)
            return .configured
        }
    }
}
public struct AppLockPolicy: Sendable, Equatable {
    public private(set) var isLocked = true
    public private(set) var hideSnapshot = true
    public private(set) var biometricAttempts = 0
    private var awayAt: Date?
    public init() {}
    public mutating func unlock() { isLocked = false; hideSnapshot = false; biometricAttempts = 0 }
    public mutating func biometricFailed(wasCancellation: Bool = false) { if !wasCancellation { biometricAttempts += 1 } }
    public var mayAttemptBiometric: Bool { biometricAttempts < 3 }
    public mutating func lifecycle(_ value: AppLifecycle, at now: Date, enabled: Bool) {
        switch value {
        case .inactive, .background, .locked:
            hideSnapshot = true; if awayAt == nil { awayAt = now }; if value == .locked { isLocked = enabled }
        case .foreground:
            if enabled, let awayAt, now.timeIntervalSince(awayAt) >= 300 { isLocked = true; biometricAttempts = 0 }
            if !enabled { isLocked = false }; hideSnapshot = isLocked; awayAt = nil
        }
    }
}
