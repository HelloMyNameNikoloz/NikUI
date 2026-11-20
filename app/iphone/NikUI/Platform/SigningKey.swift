import CryptoKit
import Foundation
import Synchronization
import NikCore

/// Loading an identity never creates one. Only the explicit pairing preparation
/// may create a key, after checking the durable pairing pointer as well.
final class DeviceSigningKey: SigningKeyProvider {
    private struct Loaded {
        var id: String
        var handle: Data
        var protection: KeyProtection { id.hasPrefix("se-") ? .secureEnclave : .software }
    }
    private enum State { case unprepared, missing, loaded(Loaded), failed(CoreFailure) }
    private let store: KeychainStore
    private let state = Mutex<State>(.unprepared)
    private let knownIdentity = Mutex<Loaded?>(nil)
    private static let slot = "identity.v1"

    init(store: KeychainStore = KeychainStore()) { self.store = store }

    var keyID: String {
        knownIdentity.withLock { $0?.id ?? "" }
    }
    var protection: KeyProtection {
        knownIdentity.withLock { $0?.protection ?? .unknown }
    }

    func prepareExisting(_ pairing: PairedConnection) async throws {
        let key = try reload()
        guard let key else { throw CoreFailure(.missingKey, "The paired signing key is missing. It was not recreated. Forget the local pairing explicitly, then request a new pairing on the laptop.") }
        guard key.id == pairing.keyID, try publicKey(key) == pairing.publicSPKI else {
            throw CoreFailure(.missingKey, "The saved identity does not match this pairing. It was preserved. Remove the old device on the laptop and explicitly pair again.")
        }
    }

    func prepareNewPairing() async throws {
        // Read even when the facade could not restore: an inaccessible/corrupt
        // pairing record must never be interpreted as permission to replace it.
        let pairingData = try store.read(PairingService.pairingKey)
        if let pairingData {
            let pairing: PairedConnection
            do { pairing = try JSONDecoder().decode(PairedConnection.self, from: pairingData) }
            catch { throw CoreFailure(.persistence, "The saved pairing is unreadable. It was preserved. Retry, or explicitly forget it before pairing again.") }
            try await prepareExisting(pairing)
            return
        }
        if try reload() != nil { return }
        try state.withLock { current in
            // A second caller may have finished preparation while we waited.
            if case .loaded = current { return }
            let handle: Data
            let id: String
            do {
                if SecureEnclave.isAvailable {
                    handle = try SecureEnclave.P256.Signing.PrivateKey().dataRepresentation
                    id = "se-" + UUID().uuidString.lowercased()
                } else {
                    handle = P256.Signing.PrivateKey().rawRepresentation
                    id = "sw-" + UUID().uuidString.lowercased()
                }
                let value = Loaded(id: id, handle: handle)
                let record = try JSONEncoder().encode(["id": Data(id.utf8), "key": handle])
                try store.write(record, Self.slot)
                current = .loaded(value)
                knownIdentity.withLock { $0 = value }
            } catch {
                let failure = (error as? CoreFailure) ?? CoreFailure(.missingKey, "The phone could not prepare a pairing identity. Try again.")
                current = .failed(failure)
                throw failure
            }
        }
    }

    func publicSPKI() async throws -> Data { try publicKey(loaded()) }

    func sign(message: Data) async throws -> Data {
        let key = try loaded()
        do {
            if key.protection == .secureEnclave {
                return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: key.handle).signature(for: message).rawRepresentation
            }
            return try P256.Signing.PrivateKey(rawRepresentation: key.handle).signature(for: message).rawRepresentation
        } catch {
            throw CoreFailure(.missingKey, "The saved signing key is unavailable. Unlock the iPhone and retry; the identity was not replaced.")
        }
    }

    func delete() async throws {
        try store.remove(Self.slot)
        state.withLock { $0 = .missing }
        knownIdentity.withLock { $0 = nil }
    }

    private func reload() throws -> Loaded? {
        try state.withLock { current in
            do {
                guard let data = try store.read(Self.slot) else { current = .missing; return nil }
                let record = try JSONDecoder().decode([String: Data].self, from: data)
                guard let id = record["id"].flatMap({ String(data: $0, encoding: .utf8) }),
                      id.hasPrefix("se-") || id.hasPrefix("sw-"), let handle = record["key"], !handle.isEmpty else {
                    throw CoreFailure(.missingKey, "The saved signing identity is invalid. It was not replaced. Retry or explicitly re-pair.")
                }
                let key = Loaded(id: id, handle: handle)
                _ = try publicKey(key)
                current = .loaded(key)
                knownIdentity.withLock { $0 = key }
                return key
            } catch {
                let failure = (error as? CoreFailure) ?? CoreFailure(.missingKey, "The saved signing identity could not be opened. It was not replaced. Unlock the iPhone and retry, or explicitly re-pair.")
                current = .failed(failure)
                throw failure
            }
        }
    }

    private func loaded() throws -> Loaded {
        try state.withLock {
            switch $0 {
            case .loaded(let key): return key
            case .failed(let error): throw error
            case .missing: throw CoreFailure(.missingKey, "The signing identity is missing. Prepare a new pairing explicitly.")
            case .unprepared: throw CoreFailure(.missingKey, "The signing identity has not been prepared. Unlock the app and retry.")
            }
        }
    }

    private func publicKey(_ key: Loaded) throws -> Data {
        if key.protection == .secureEnclave {
            return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: key.handle).publicKey.derRepresentation
        }
        return try P256.Signing.PrivateKey(rawRepresentation: key.handle).publicKey.derRepresentation
    }
}
