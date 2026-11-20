import Foundation
import LocalAuthentication
import Observation
import NikCore

/// Presentation and LocalAuthentication only; NikCore owns verification,
/// derivation, durable throttling, and the five-minute away policy.
@MainActor @Observable final class AppLock {
    enum Outcome: Equatable { case unlocked, wrong(left: Int?), waitUntil(Date), failed(String) }

    private(set) var locked = true
    private(set) var loaded = false
    private(set) var isOn = true // Fail closed until a successful Keychain read.
    private(set) var pinLength: Int?
    private(set) var usesFaceID = false
    private(set) var waitUntil: Date?
    private(set) var storageError: String?
    private(set) var busy = false
    private var offeredAutomaticBiometric = false
    private var policy = AppLockPolicy()
    private var lifecycle: AppLifecycle = .foreground
    private let store: MigratingPINStore
    private var verifier: PINVerifier
    private var authentication: LAContext?
    @ObservationIgnored var onChange: (() -> Void)?

    init(store: KeychainStore = KeychainStore()) {
        let migrating = MigratingPINStore(keychain: store)
        self.store = migrating
        verifier = PINVerifier(store: migrating)
    }

    var faceIDAvailable: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) }
    var biometryName: String {
        let context = LAContext(); _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return context.biometryType == .touchID ? "Touch ID" : "Face ID"
    }
    var mayTryFaceID: Bool {
        lifecycle == .foreground && loaded && storageError == nil && usesFaceID && faceIDAvailable && policy.mayAttemptBiometric && !coolingDown(at: .now) && !busy
    }
    func coolingDown(at date: Date) -> Bool { waitUntil.map { $0 > date } ?? false }

    func refreshStatus() async {
        do {
            let status = try await verifier.status()
            let unknownLength = try await store.hasUnknownLength()
            isOn = status.enabled; pinLength = unknownLength ? nil : status.length
            usesFaceID = status.biometric; waitUntil = status.until
            storageError = nil; loaded = true
            if !isOn { policy.unlock() }
            policy.lifecycle(lifecycle, at: .now, enabled: isOn)
            publish()
        } catch { failClosed(error) }
    }

    /// Synchronous policy update, including inactive time before background.
    func sceneLifecycle(_ value: AppLifecycle) {
        lifecycle = value
        if value == .background { authentication?.invalidate() }
        let wasLocked = policy.isLocked
        policy.lifecycle(value, at: .now, enabled: isOn)
        if !wasLocked, policy.isLocked { offeredAutomaticBiometric = false }
        publish()
    }

    func lock() { offeredAutomaticBiometric = false; policy.lifecycle(.locked, at: .now, enabled: isOn); publish() }
    func claimAutomaticBiometric() -> Bool {
        guard !offeredAutomaticBiometric, mayTryFaceID else { return false }
        offeredAutomaticBiometric = true
        return true
    }

    func unlock(pin: String) async -> Outcome { await check(pin, unlocking: true) }
    func checkCurrent(_ pin: String) async -> Outcome { await check(pin, unlocking: false) }

    private func check(_ pin: String, unlocking: Bool) async -> Outcome {
        guard loaded, storageError == nil else { return .failed(storageError ?? "Read the saved app lock first.") }
        guard !busy else { return .failed("Please wait for the current PIN check.") }
        busy = true
        defer { busy = false }
        do {
            let result = try await verifier.verify(pin)
            await refreshStatus()
            guard storageError == nil else { return .failed(storageError!) }
            if result == .unlocked || result == .notConfigured {
                if unlocking { policy.unlock(); policy.lifecycle(lifecycle, at: .now, enabled: isOn); publish() }
                return .unlocked
            }
            return outcome(result)
        } catch { failClosed(error); return .failed(storageError!) }
    }

    func unlockWithFaceID() async -> Bool {
        guard mayTryFaceID else { return false }
        busy = true
        let context = LAContext(); context.localizedFallbackTitle = "Use PIN"
        authentication = context
        defer { authentication = nil; busy = false }
        do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Unlock NikUI"), lifecycle != .background else { return false }
            let result = try await verifier.biometricSucceeded()
            await refreshStatus()
            guard result == .unlocked, storageError == nil else { return false }
            policy.unlock(); policy.lifecycle(lifecycle, at: .now, enabled: isOn); publish()
            return true
        } catch let error as LAError {
            // Only an actual biometric mismatch consumes an app attempt.
            policy.biometricFailed(wasCancellation: error.code != .authenticationFailed)
            publish()
            return false
        } catch { failClosed(error); return false }
    }

    func setPIN(_ pin: String, current: String?, faceID: Bool) async -> Outcome {
        guard !busy else { return .failed("Please wait for the current PIN check.") }
        busy = true
        defer { busy = false }
        do {
            let result = try await verifier.configure(pin: pin, confirmation: pin, currentPIN: current)
            guard result == .configured else { await refreshStatus(); return outcome(result) }
            // Configuration is durable before enabled/unlocked presentation changes.
            try await verifier.setBiometric(faceID)
            try await store.clearUnknownLength()
            await refreshStatus()
            guard storageError == nil else { return .failed(storageError!) }
            policy.unlock(); policy.lifecycle(lifecycle, at: .now, enabled: isOn); publish()
            return .unlocked
        } catch { failClosed(error); return .failed(storageError!) }
    }

    func setFaceID(_ on: Bool) async {
        do { try await verifier.setBiometric(on); await refreshStatus() }
        catch { failClosed(error) }
    }

    func turnOff(current: String) async -> Outcome {
        guard !busy else { return .failed("Please wait for the current PIN check.") }
        busy = true
        defer { busy = false }
        do {
            let result = try await verifier.disable(currentPIN: current)
            if result == .disabled { try await store.clearUnknownLength() }
            await refreshStatus()
            guard storageError == nil else { return .failed(storageError!) }
            return result == .disabled ? .unlocked : outcome(result)
        } catch { failClosed(error); return .failed(storageError!) }
    }

    static func isValid(_ pin: String) -> Bool { PINVerifier.valid(pin) }

    private func outcome(_ result: PINResult) -> Outcome {
        switch result {
        case .wrong(let attempts, let until):
            if let until, until > .now { return .waitUntil(until) }
            return .wrong(left: max(0, 5 - attempts))
        case .cooldown(let until): return .waitUntil(until)
        case .invalidPIN: return .failed("Use 4 to 12 decimal digits.")
        default: return .failed("The PIN could not be changed. Check the current PIN and try again.")
        }
    }

    private func failClosed(_ error: any Error) {
        // A failed verifier task must not poison subsequent storage retries.
        // Every mutation above has finished before this adapter replaces it.
        verifier = PINVerifier(store: store)
        storageError = "\(error.localizedDescription) Your app lock was not reset. Try again."
        policy.lifecycle(.locked, at: .now, enabled: true)
        locked = true
        onChange?()
    }
    private func publish() { locked = storageError != nil || policy.isLocked; onChange?() }
}

/// One-way, restart-safe migration of the previous UI verifier, including its
/// wrong-attempt count and cooldown. Never treats an unreadable record as absent.
private actor MigratingPINStore: KeyValueStore {
    private struct Legacy: Decodable {
        var salt: Data; var hash: Data; var iterations: Int; var faceID: Bool
        var length: Int?; var failures: Int; var lockedUntil: Date?
        enum CodingKeys: String, CodingKey { case salt, hash, iterations, faceID, length, failures, lockedUntil }
        init(from decoder: any Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            salt = try values.decode(Data.self, forKey: .salt)
            hash = try values.decode(Data.self, forKey: .hash)
            iterations = try values.decode(Int.self, forKey: .iterations)
            faceID = try values.decodeIfPresent(Bool.self, forKey: .faceID) ?? false
            length = try values.decodeIfPresent(Int.self, forKey: .length)
            failures = try values.decodeIfPresent(Int.self, forKey: .failures) ?? 0
            lockedUntil = try values.decodeIfPresent(Date.self, forKey: .lockedUntil)
        }
    }
    private let keychain: KeychainStore
    private let legacyKey = "applock.v1"
    private let unknownLengthKey = "applock.unknown-length.v1"
    init(keychain: KeychainStore) { self.keychain = keychain }

    func data(forKey key: String) throws -> Data? {
        guard key == PINVerifier.storageKey else { return try keychain.read(key) }
        if let data = try keychain.read(key) {
            let record = try JSONDecoder().decode(PINRecord.self, from: data)
            guard record.salt.count == 16, record.hash.count == 32, record.rounds == 210_000,
                  (4...12).contains(record.length), (0...1_000_000).contains(record.wrong) else {
                throw CoreFailure(.persistence, "The saved PIN record is invalid; it was preserved.")
            }
            // If interrupted after the canonical write, finish the migration.
            if try keychain.read(legacyKey) != nil { try keychain.remove(legacyKey) }
            return data
        }
        guard let data = try keychain.read(legacyKey) else { return nil }
        let old: Legacy
        do { old = try JSONDecoder().decode(Legacy.self, from: data) }
        catch { throw CoreFailure(.persistence, "The existing app-lock record is unreadable; it was preserved.") }
        guard old.salt.count == 16, old.hash.count == 32, old.iterations == 210_000,
              old.failures >= 0, old.failures <= 1_000_000,
              old.length.map({ (4...12).contains($0) }) ?? true else {
            throw CoreFailure(.persistence, "The existing app-lock record is invalid; it was preserved.")
        }
        // Core verification accepts every valid PIN length. For an old record
        // without length metadata, retain explicit Done instead of auto-submit.
        if old.length == nil { try keychain.write(Data([1]), unknownLengthKey) }
        let record = PINRecord(salt: old.salt, hash: old.hash, rounds: old.iterations,
                               length: old.length ?? 4, biometric: old.faceID,
                               wrong: old.failures, until: old.lockedUntil)
        try keychain.write(JSONEncoder().encode(record), key)
        try keychain.remove(legacyKey)
        return try keychain.read(key)
    }
    func set(_ data: Data, forKey key: String) throws { try keychain.write(data, key) }
    func removeValue(forKey key: String) throws { try keychain.remove(key) }
    func hasUnknownLength() throws -> Bool { try keychain.read(unknownLengthKey) != nil }
    func clearUnknownLength() throws { try keychain.remove(unknownLengthKey) }
}
