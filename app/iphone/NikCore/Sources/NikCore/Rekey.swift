import Foundation

public struct RekeyStage: Sendable, Codable, Equatable {
    public var pairing: PairedConnection
    public var candidateKeyID: String
    public var candidateSPKI: Data
    public var candidateFingerprint: String
    public var protection: KeyProtection
    public var attempted: Bool
    public var committed: Bool
}
/// Optional identity transaction. Fresh pairing does not invoke rekey. The adapter must retain both keys.
public actor RekeyCoordinator {
    public static let storageKey = "nikui.rekey.v1"
    private let store: any KeyValueStore
    private var busy = false
    private func beginTransaction() throws {
        guard !busy else { throw CoreFailure(.refused, "An identity transaction is already in progress.") }; busy = true
    }
    public init(store: any KeyValueStore) { self.store = store }
    public func load() async throws -> RekeyStage? {
        guard let data = try await store.data(forKey: Self.storageKey) else { return nil }
        let value = try JSONDecoder().decode(RekeyStage.self, from: data)
        try NikCrypto.validateSPKI(value.candidateSPKI)
        guard value.candidateFingerprint == NikCrypto.fingerprint(value.candidateSPKI) else { throw CoreFailure(.persistence, "The staged identity is invalid; both keys were retained.") }; return value
    }
    public func stage(pairing: PairedConnection, replacement: any SigningKeyProvider) async throws -> RekeyStage {
        try beginTransaction(); defer { busy = false }
        if let existing = try await load() {
            guard existing.pairing.scope == pairing.scope, existing.candidateKeyID == replacement.keyID else { throw CoreFailure(.refused, "Resolve the existing staged identity before replacing it.") }; return existing
        }
        let spki = try await replacement.publicSPKI(); try NikCrypto.validateSPKI(spki)
        guard replacement.keyID != pairing.keyID, spki != pairing.publicSPKI else { throw CoreFailure(.invalidInput, "Stage a separate replacement key.") }
        let value = RekeyStage(pairing: pairing, candidateKeyID: replacement.keyID, candidateSPKI: spki, candidateFingerprint: NikCrypto.fingerprint(spki), protection: replacement.protection, attempted: false, committed: false)
        try await store.set(WireCoding.encode(value), forKey: Self.storageKey); return value
    }
    public func authenticate(challenge: JSONValue, current: any SigningKeyProvider, replacement: any SigningKeyProvider) async throws -> HandshakeProof {
        try beginTransaction(); defer { busy = false }
        guard var stage = try await load(), stage.candidateKeyID == replacement.keyID, stage.pairing.keyID == current.keyID, try await replacement.publicSPKI() == stage.candidateSPKI else { throw CoreFailure(.missingKey, "Both staged identities must remain available.") }
        // Persist before releasing a proof: a lost welcome is an ambiguous server commit, never a reason to delete staging.
        stage.attempted = true; try await store.set(WireCoding.encode(stage), forKey: Self.storageKey)
        return try await Handshake.authenticate(challenge: challenge, pairing: stage.pairing, key: current, rekey: replacement)
    }
    public func accept(welcome: JSONValue, proof: HandshakeProof, oldKey: any SigningKeyProvider) async throws -> PairedConnection? {
        try beginTransaction(); defer { busy = false }
        guard let stage = try await load() else { throw CoreFailure(.invalidInput, "No identity is staged.") }
        guard proof.serverSPKI == stage.pairing.serverSPKI,
              proof.auth["rekey"]["publicKey"].stringValue == NikCrypto.base64URL(stage.candidateSPKI) else { throw CoreFailure(.crypto, "The identity receipt belongs to a different transaction.") }
        let seat = try proof.verifyWelcome(welcome)
        guard seat.id == stage.pairing.deviceID else { throw CoreFailure(.crypto, "The receipt names another device.") }
        guard !welcome["rekeyed"].isNull else { return nil }
        guard welcome["rekeyed"]["fingerprint"].stringValue == stage.candidateFingerprint else { throw CoreFailure(.crypto, "The laptop accepted a different replacement key.") }
        return try await commit(stage, oldKey: oldKey)
    }
    /// Try ordinary sealed auth with this record after an ambiguous rekey. Do not persist it until its welcome verifies.
    public func recoveryPairing() async throws -> PairedConnection {
        guard let stage = try await load(), stage.attempted else { throw CoreFailure(.invalidInput, "No ambiguous identity change needs recovery.") }
        var record = stage.pairing; record.keyID = stage.candidateKeyID; record.publicSPKI = stage.candidateSPKI; record.protection = stage.protection; return record
    }
    public func acceptRecovery(welcome: JSONValue, proof: HandshakeProof, oldKey: any SigningKeyProvider) async throws -> PairedConnection {
        try beginTransaction(); defer { busy = false }
        guard let stage = try await load(), stage.attempted else { throw CoreFailure(.invalidInput, "No ambiguous identity change needs recovery.") }
        let seat = try proof.verifyWelcome(welcome)
        let message = Data("nikui-auth:\(proof.serverNonce):\(proof.clientNonce):\(proof.binding)".utf8)
        guard proof.serverSPKI == stage.pairing.serverSPKI, seat.id == stage.pairing.deviceID, proof.auth["rekey"].isNull,
              let signature = proof.auth["signature"].stringValue, let raw = try? NikCrypto.decodeBase64URL(signature),
              NikCrypto.verify(signature: raw, message: message, publicSPKI: stage.candidateSPKI) else { throw CoreFailure(.crypto, "The recovery welcome did not authenticate the candidate identity.") }
        return try await commit(stage, oldKey: oldKey)
    }
    private func commit(_ original: RekeyStage, oldKey: any SigningKeyProvider) async throws -> PairedConnection {
        guard oldKey.keyID == original.pairing.keyID else { throw CoreFailure(.missingKey, "The old identity does not match staging.") }
        var record = original.pairing; record.keyID = original.candidateKeyID; record.publicSPKI = original.candidateSPKI; record.protection = original.protection
        try await store.set(WireCoding.encode(record), forKey: PairingService.pairingKey)
        var stage = original; stage.committed = true
        try await store.set(WireCoding.encode(stage), forKey: Self.storageKey)
        try await oldKey.delete() // Only after the durable primary pointer names the accepted candidate.
        try await store.removeValue(forKey: Self.storageKey); return record
    }
    /// Only a never-attempted transaction can be safely discarded locally.
    public func discardUnattempted(replacement: any SigningKeyProvider) async throws {
        try beginTransaction(); defer { busy = false }
        guard let stage = try await load(), !stage.attempted, stage.candidateKeyID == replacement.keyID else { throw CoreFailure(.refused, "An attempted replacement must be recovered or explicitly re-paired; it cannot be discarded on timeout.") }
        try await replacement.delete(); try await store.removeValue(forKey: Self.storageKey)
    }
}
