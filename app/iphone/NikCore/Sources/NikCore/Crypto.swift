import Foundation
import CryptoKit
import Security

public enum NikCrypto {
    public static let spkiPrefix = Data([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
                                        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00])
    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public static func decodeBase64URL(_ text: String) throws -> Data {
        guard !text.isEmpty, text.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }), text.count % 4 != 1 else {
            throw CoreFailure(.crypto, "Invalid base64url encoding.")
        }
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let data = Data(base64Encoded: value), base64URL(data) == text else { throw CoreFailure(.crypto, "Invalid base64url encoding.") }
        return data
    }
    public static func randomBytes(count: Int) throws -> Data {
        guard count >= 0, count <= 1_048_576 else { throw CoreFailure(.invalidInput, "Invalid random byte count.") }
        if count == 0 { return Data() }
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { bytes in SecRandomCopyBytes(kSecRandomDefault, count, bytes.baseAddress!) }
        guard status == errSecSuccess else { throw CoreFailure(.crypto, "Secure random generation failed.") }; return data
    }
    public static func spki(x963: Data) throws -> Data {
        guard x963.count == 65, x963.first == 4 else { throw CoreFailure(.crypto, "Expected an uncompressed P-256 point.") }
        let der = spkiPrefix + x963; try validateSPKI(der); return der
    }
    public static func validateSPKI(_ der: Data) throws {
        guard der.count == 91, der.prefix(26) == spkiPrefix else { throw CoreFailure(.crypto, "Expected a P-256 SubjectPublicKeyInfo key.") }
        do { _ = try P256.Signing.PublicKey(derRepresentation: der) }
        catch { throw CoreFailure(.crypto, "The P-256 public point is invalid.") }
    }
    public static func fingerprint(_ der: Data) -> String { base64URL(Data(SHA256.hash(data: der).prefix(16))) }
    public static func rawSignature(fromDER data: Data) throws -> Data { try P256.Signing.ECDSASignature(derRepresentation: data).rawRepresentation }
    public static func derSignature(fromRaw data: Data) throws -> Data { try P256.Signing.ECDSASignature(rawRepresentation: data).derRepresentation }
    public static func verify(signature: Data, message: Data, publicSPKI: Data) -> Bool {
        guard signature.count == 64, let key = try? P256.Signing.PublicKey(derRepresentation: publicSPKI), let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return key.isValidSignature(sig, for: message)
    }
    public static func binding(serverSPKI: Data, clientSPKI: Data) -> String { base64URL(Data(SHA256.hash(data: serverSPKI + clientSPKI))) }
    public static func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }; var diff: UInt8 = 0
        for (a, b) in zip(lhs, rhs) { diff |= a ^ b }; return diff == 0
    }
}

/// In-memory software key for Simulator adapters/tests. It is never represented as hardware protection.
public actor SoftwareSigningKey: SigningKeyProvider {
    public nonisolated let keyID: String
    public nonisolated let protection: KeyProtection = .software
    private var key: P256.Signing.PrivateKey?
    public init(keyID: String = "software-" + UUID().uuidString, rawRepresentation: Data? = nil) throws {
        self.keyID = keyID; self.key = try rawRepresentation.map { try P256.Signing.PrivateKey(rawRepresentation: $0) } ?? P256.Signing.PrivateKey()
    }
    public func publicSPKI() throws -> Data {
        guard let key else { throw CoreFailure(.missingKey, "The signing identity is missing.") }; return key.publicKey.derRepresentation
    }
    public func sign(message: Data) throws -> Data {
        guard let key else { throw CoreFailure(.missingKey, "The signing identity is missing.") }; return try key.signature(for: message).rawRepresentation
    }
    public func delete() async throws { key = nil }
}
public struct DirectionalKey: Sendable, Equatable {
    public let key: Data
    public let baseNonce: Data
    public init(key: Data, baseNonce: Data) throws {
        guard key.count == 32, baseNonce.count == 12 else { throw CoreFailure(.crypto, "Invalid channel key size.") }
        self.key = key; self.baseNonce = baseNonce
    }
}
public struct ChannelKeys: Sendable, Equatable {
    public let toClient: DirectionalKey
    public let toServer: DirectionalKey
    public static func derive(sharedSecret: Data, serverNonce: String, clientNonce: String) throws -> ChannelKeys {
        guard sharedSecret.count == 32 else { throw CoreFailure(.crypto, "Invalid P-256 shared secret.") }
        let salt = Data(SHA256.hash(data: Data("\(serverNonce):\(clientNonce)".utf8)))
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: sharedSecret), salt: salt, info: Data("nikui-e2e:v1".utf8), outputByteCount: 88)
        let material = key.withUnsafeBytes { Data($0) }
        return try ChannelKeys(toClient: DirectionalKey(key: material.subdata(in: 0..<32), baseNonce: material.subdata(in: 32..<44)), toServer: DirectionalKey(key: material.subdata(in: 44..<76), baseNonce: material.subdata(in: 76..<88)))
    }
}

/// Own one value per socket and call only from its actor; failed opens are fatal to that socket.
public struct Box: Sendable {
    public static let counterCeiling: UInt64 = 1 << 48
    private let sending: DirectionalKey
    private let receiving: DirectionalKey
    public private(set) var sent: UInt64 = 0
    public private(set) var seen: UInt64?
    public init(sending: DirectionalKey, receiving: DirectionalKey) { self.sending = sending; self.receiving = receiving }
    public static func nonce(base: Data, counter: UInt64) throws -> Data {
        guard base.count == 12, counter < counterCeiling else { throw CoreFailure(.crypto, "The channel counter is exhausted.") }
        var value = [UInt8](base)
        for i in 0..<6 { value[11 - i] ^= UInt8(truncatingIfNeeded: counter >> (i * 8)) }; return Data(value)
    }
    public mutating func seal(_ text: String) throws -> JSONValue {
        guard sent < Self.counterCeiling else { throw CoreFailure(.crypto, "The channel counter is exhausted.") }
        let counter = sent
        let nonce = try AES.GCM.Nonce(data: Self.nonce(base: sending.baseNonce, counter: counter))
        let sealed = try AES.GCM.seal(Data(text.utf8), using: SymmetricKey(data: sending.key), nonce: nonce)
        sent += 1
        return .object(["type": .string("@box"), "n": .number(Double(counter)), "c": .string(NikCrypto.base64URL(sealed.ciphertext + sealed.tag))])
    }
    public mutating func open(_ frame: JSONValue) throws -> String {
        guard frame["type"].stringValue == "@box", let n = frame["n"].doubleValue, n >= 0, n < Double(Self.counterCeiling), n.rounded() == n, let c = frame["c"].stringValue else {
            throw CoreFailure(.protocolViolation, "Expected a valid sealed message.")
        }
        let counter = UInt64(n)
        guard seen.map({ counter > $0 }) ?? true else { throw CoreFailure(.replay, "The sealed message was replayed or reordered.") }
        let data = try NikCrypto.decodeBase64URL(c)
        guard data.count >= 17 else { throw CoreFailure(.crypto, "The sealed message is incomplete.") }
        do {
            let nonce = try AES.GCM.Nonce(data: Self.nonce(base: receiving.baseNonce, counter: counter))
            let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: data.dropLast(16), tag: data.suffix(16))
            let clear = try AES.GCM.open(sealed, using: SymmetricKey(data: receiving.key))
            guard let text = String(data: clear, encoding: .utf8) else { throw CoreFailure(.protocolViolation, "The sealed message is not UTF-8.") }
            seen = counter; return text
        } catch let e as CoreFailure { throw e }
        catch { throw CoreFailure(.crypto, "Sealed-message authentication failed.") }
    }
}

public struct HandshakeProof: Sendable {
    public let auth: JSONValue
    public let serverNonce: String
    public let clientNonce: String
    public let binding: String
    public let keys: ChannelKeys
    public let serverSPKI: Data
    public func verifyWelcome(_ welcome: JSONValue) throws -> Seat {
        guard welcome["type"].stringValue == "@welcome", let signature = welcome["signature"].stringValue,
              let signatureData = try? NikCrypto.decodeBase64URL(signature),
              NikCrypto.verify(signature: signatureData, message: Data("nikui-host:\(clientNonce):\(serverNonce):\(binding)".utf8), publicSPKI: serverSPKI),
              !Seat(welcome["device"]).id.isEmpty else { throw CoreFailure(.crypto, "The laptop welcome could not be authenticated.") }
        return Seat(welcome["device"])
    }
}
public enum Handshake {
    public static func authenticate(challenge: JSONValue, pairing: PairedConnection, key: any SigningKeyProvider,
                                    clientNonce: String? = nil, ephemeralRaw: Data? = nil, rekey: (any SigningKeyProvider)? = nil) async throws -> HandshakeProof {
        guard challenge["type"].stringValue == "@challenge", let ns = challenge["nonce"].stringValue,
              let nsBytes = try? NikCrypto.decodeBase64URL(ns), nsBytes.count == 32,
              let serverKey = challenge["serverKey"].stringValue, let es = challenge["epk"].stringValue else {
            throw CoreFailure(.protocolViolation, "This laptop did not offer a sealed handshake.")
        }
        let host = try NikCrypto.decodeBase64URL(serverKey); try NikCrypto.validateSPKI(host)
        guard host == pairing.serverSPKI, NikCrypto.fingerprint(host) == pairing.fingerprint,
              challenge["fingerprint"].isNull || challenge["fingerprint"].stringValue == pairing.fingerprint else { throw CoreFailure(.wrongLaptop, "The laptop signing key changed.") }
        guard key.keyID == pairing.keyID, try await key.publicSPKI() == pairing.publicSPKI else { throw CoreFailure(.missingKey, "The paired signing identity does not match.") }
        let remote = try NikCrypto.decodeBase64URL(es); try NikCrypto.validateSPKI(remote)
        let theirs = try P256.KeyAgreement.PublicKey(derRepresentation: remote)
        let mine = try ephemeralRaw.map { try P256.KeyAgreement.PrivateKey(rawRepresentation: $0) } ?? P256.KeyAgreement.PrivateKey()
        let ec = mine.publicKey.derRepresentation
        let nc = try clientNonce ?? NikCrypto.base64URL(NikCrypto.randomBytes(count: 24))
        guard nc.count >= 16 else { throw CoreFailure(.invalidInput, "The client nonce is too short.") }
        let binding = NikCrypto.binding(serverSPKI: remote, clientSPKI: ec)
        var proof = "nikui-auth:\(ns):\(nc):\(binding)"
        var replacement: JSONValue?
        if let rekey {
            let spki = try await rekey.publicSPKI(); try NikCrypto.validateSPKI(spki)
            let fingerprint = NikCrypto.fingerprint(spki)
            proof = "nikui-rekey:\(ns):\(nc):\(fingerprint):\(binding)"
            let signature = try await rekey.sign(message: Data(proof.utf8))
            guard signature.count == 64 else { throw CoreFailure(.crypto, "The replacement signature must use P1363 encoding.") }
            replacement = .object(["publicKey": .string(NikCrypto.base64URL(spki)), "signature": .string(NikCrypto.base64URL(signature)), "protection": .string(rekey.protection.rawValue), "biometric": .bool(false)])
        }
        let signature = try await key.sign(message: Data(proof.utf8))
        guard signature.count == 64 else { throw CoreFailure(.crypto, "The device signature must use P1363 encoding.") }
        var auth: JSONValue = .object(["type": .string("@auth"), "device": .string(pairing.deviceID), "nonce": .string(nc), "signature": .string(NikCrypto.base64URL(signature)), "epk": .string(NikCrypto.base64URL(ec))])
        if let replacement { auth["rekey"] = replacement }
        let shared = try mine.sharedSecretFromKeyAgreement(with: theirs).withUnsafeBytes { Data($0) }
        return try HandshakeProof(auth: auth, serverNonce: ns, clientNonce: nc, binding: binding,
                                  keys: ChannelKeys.derive(sharedSecret: shared, serverNonce: ns, clientNonce: nc), serverSPKI: host)
    }
}
