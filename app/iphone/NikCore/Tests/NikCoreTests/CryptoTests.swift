import Foundation
import CryptoKit
import Testing
@testable import NikCore

@Suite("Node / CryptoKit wire compatibility") struct CryptoTests {
    @Test func spkiWrappingAndFingerprint() throws {
        let v = try fixture(); let key = try P256.Signing.PrivateKey(rawRepresentation: unhex(v["hostRaw"].stringValue!))
        let spki = try NikCrypto.spki(x963: key.publicKey.x963Representation)
        #expect(spki.count == 91); #expect(NikCrypto.base64URL(spki) == v["hostSPKI"].stringValue)
        #expect(NikCrypto.fingerprint(spki) == v["fingerprint"].stringValue); #expect(NikCrypto.fingerprint(spki).count == 22)
    }
    @Test(arguments: ["", "A", "++//", "YWJj=", "YW Jj", "AA!", "AB"])
    func malformedBase64URL(_ text: String) { expectFailure(.crypto) { _ = try NikCrypto.decodeBase64URL(text) } }
    @Test func base64RoundTrip() throws {
        for count in 1...65 { let data = Data((0..<count).map { UInt8($0 * 3 % 256) }); #expect(try NikCrypto.decodeBase64URL(NikCrypto.base64URL(data)) == data) }
    }
    @Test func spkiRejectsWrongCurveShape() throws {
        let p384 = P384.Signing.PrivateKey().publicKey.derRepresentation
        expectFailure(.crypto) { try NikCrypto.validateSPKI(p384) }
        expectFailure(.crypto) { _ = try NikCrypto.spki(x963: Data(repeating: 0, count: 65)) }
    }
    @Test func nodeSignatureAndUnicodeNoDoubleHash() throws {
        let v = try fixture(); let spki = try NikCrypto.decodeBase64URL(v["hostSPKI"].stringValue!); let signature = try NikCrypto.decodeBase64URL(v["signature"].stringValue!)
        let message = Data(v["signatureMessage"].stringValue!.utf8)
        #expect(NikCrypto.verify(signature: signature, message: message, publicSPKI: spki))
        #expect(!NikCrypto.verify(signature: signature, message: message + Data([10]), publicSPKI: spki))
        #expect(!NikCrypto.verify(signature: signature, message: Data(SHA256.hash(data: message)), publicSPKI: spki))
        let der = try NikCrypto.decodeBase64URL(v["signatureDER"].stringValue!)
        #expect(NikCrypto.verify(signature: try NikCrypto.rawSignature(fromDER: der), message: message, publicSPKI: spki))
    }
    @Test(arguments: [0x01, 0x7f, 0x80, 0xff]) func p1363LeadingZeroDER(_ first: Int) throws {
        var raw = Data(repeating: 0, count: 64); raw[0] = UInt8(first); raw[31] = 1; raw[63] = 1
        let der = try NikCrypto.derSignature(fromRaw: raw)
        #expect(try NikCrypto.rawSignature(fromDER: der) == raw)
    }
    @Test func keyDeletionDoesNotRecreate() async throws {
        let key = try softwareKey(); let publicKey = try await key.publicSPKI(); #expect(publicKey.count == 91)
        try await key.delete()
        do { _ = try await key.sign(message: Data("test".utf8)); Issue.record("Deleted key signed") } catch let e as CoreFailure { #expect(e.code == .missingKey) }
    }
    @Test func ecdhAndAll88HKDFBytes() throws {
        let v = try fixture(); let mine = try P256.KeyAgreement.PrivateKey(rawRepresentation: unhex(v["clientEphemeralRaw"].stringValue!))
        let remote = try P256.KeyAgreement.PublicKey(derRepresentation: NikCrypto.decodeBase64URL(v["serverEphemeralSPKI"].stringValue!))
        let shared = try mine.sharedSecretFromKeyAgreement(with: remote).withUnsafeBytes { Data($0) }
        #expect(hex(shared) == v["shared"].stringValue)
        let keys = try ChannelKeys.derive(sharedSecret: shared, serverNonce: v["serverNonce"].stringValue!, clientNonce: v["clientNonce"].stringValue!)
        #expect(hex(keys.toClient.key) == v["toClientKey"].stringValue); #expect(hex(keys.toClient.baseNonce) == v["toClientNonce"].stringValue)
        #expect(hex(keys.toServer.key) == v["toServerKey"].stringValue); #expect(hex(keys.toServer.baseNonce) == v["toServerNonce"].stringValue)
        #expect(keys.toClient != keys.toServer)
    }
    @Test func bindingOrderIsServerFirst() throws {
        let v = try fixture(); let server = try NikCrypto.decodeBase64URL(v["serverEphemeralSPKI"].stringValue!), client = try NikCrypto.decodeBase64URL(v["clientEphemeralSPKI"].stringValue!)
        #expect(NikCrypto.binding(serverSPKI: server, clientSPKI: client) == v["binding"].stringValue)
        #expect(NikCrypto.binding(serverSPKI: client, clientSPKI: server) != v["binding"].stringValue)
    }
    @Test func sixByteCountersMatchNode() throws {
        let v = try fixture(); let base = unhex(v["toServerNonce"].stringValue!)
        for n in v["nonces"].arrayValue { #expect(hex(try Box.nonce(base: base, counter: UInt64(n["n"].doubleValue!))) == n["hex"].stringValue) }
        expectFailure(.crypto) { _ = try Box.nonce(base: base, counter: Box.counterCeiling) }
    }
    @Test func swiftSealsExactlyLikeNode() throws {
        let v = try fixture(); let keys = try channelKeys(v); var box = Box(sending: keys.toServer, receiving: keys.toClient)
        for (message, expected) in zip(v["messages"].arrayValue, v["phonePackets"].arrayValue) { #expect(try box.seal(message.stringValue!) == expected) }
    }
    @Test func nodeBoxesOpenWithoutNoncePrefix() throws {
        let v = try fixture(); let keys = try channelKeys(v); var box = Box(sending: keys.toServer, receiving: keys.toClient)
        #expect(try JSONValue.decode(Data(box.open(v["boxedWelcome"]).utf8)) == v["welcome"])
        for (message, frame) in zip(v["messages"].arrayValue, v["serverPackets"].arrayValue) { #expect(try box.open(frame) == message.stringValue) }
        #expect(box.seen == 2)
    }
    @Test func replayOutOfOrderBadTagAndDirection() throws {
        let v = try fixture(); let keys = try channelKeys(v); var box = Box(sending: keys.toServer, receiving: keys.toClient)
        let frame = v["serverPackets"].arrayValue[1]; _ = try box.open(frame)
        expectFailure(.replay) { _ = try box.open(frame) }
        expectFailure(.replay) { _ = try box.open(v["serverPackets"].arrayValue[0]) }
        var bad: JSONValue = .object(["type": .string("@box"), "n": .number(3), "c": .string(NikCrypto.base64URL(Data(repeating: 0, count: 24)))])
        expectFailure(.crypto) { _ = try box.open(bad) }; #expect(box.seen == 2)
        bad["n"] = .number(Double(Box.counterCeiling)); expectFailure(.protocolViolation) { _ = try box.open(bad) }
        var fresh = Box(sending: keys.toServer, receiving: keys.toClient); expectFailure(.crypto) { _ = try fresh.open(v["phonePackets"].arrayValue[0]) }
    }
    @Test(arguments: [-1.0, 0.5, Double(Box.counterCeiling)]) func invalidCounter(_ counter: Double) throws {
        let v = try fixture(); var box = Box(sending: try channelKeys(v).toServer, receiving: try channelKeys(v).toClient)
        var frame = v["phonePackets"].arrayValue[0]; frame["n"] = .number(counter)
        expectFailure(.protocolViolation) { _ = try box.open(frame) }
    }
    @Test func fullHandshakeVerifiesBoxedWelcome() async throws {
        let v = try fixture(); let proof = try await Handshake.authenticate(challenge: v["challenge"], pairing: record(v), key: softwareKey(v), clientNonce: v["clientNonce"].stringValue!, ephemeralRaw: unhex(v["clientEphemeralRaw"].stringValue!))
        #expect(proof.binding == v["binding"].stringValue)
        let sig = try NikCrypto.decodeBase64URL(proof.auth["signature"].stringValue!)
        #expect(NikCrypto.verify(signature: sig, message: Data("nikui-auth:\(proof.serverNonce):\(proof.clientNonce):\(proof.binding)".utf8), publicSPKI: try record(v).publicSPKI))
        var box = Box(sending: proof.keys.toServer, receiving: proof.keys.toClient)
        let welcome = try JSONValue.decode(Data(box.open(v["boxedWelcome"]).utf8)); #expect(try proof.verifyWelcome(welcome).control)
    }
    @Test func handshakeRefusesChangedHostAndMissingSealing() async throws {
        let v = try fixture(); var challenge = v["challenge"]; challenge["fingerprint"] = .string("changed")
        do { _ = try await Handshake.authenticate(challenge: challenge, pairing: record(v), key: softwareKey(v)); Issue.record("Changed pin accepted") } catch let e as CoreFailure { #expect(e.code == .wrongLaptop) }
        challenge = v["challenge"]; challenge["epk"] = .null
        do { _ = try await Handshake.authenticate(challenge: challenge, pairing: record(v), key: softwareKey(v)); Issue.record("Unsealed challenge accepted") } catch let e as CoreFailure { #expect(e.code == .protocolViolation) }
    }
    @Test func swappedEphemeralAndForgedWelcomeFail() async throws {
        let v = try fixture(); let proof = try await Handshake.authenticate(challenge: v["challenge"], pairing: record(v), key: softwareKey(v))
        expectFailure(.crypto) { _ = try proof.verifyWelcome(v["welcome"]) }
    }
    @Test func pbkdf2MatchesNode() throws {
        for vector in try fixture()["pbkdf2"].arrayValue {
            #expect(hex(try PBKDF2.sha256(password: Data(vector["password"].stringValue!.utf8), salt: Data(vector["salt"].stringValue!.utf8), rounds: vector["rounds"].intValue!)) == vector["hex"].stringValue)
        }
    }
}
func channelKeys(_ v: JSONValue) throws -> ChannelKeys { try ChannelKeys.derive(sharedSecret: unhex(v["shared"].stringValue!), serverNonce: v["serverNonce"].stringValue!, clientNonce: v["clientNonce"].stringValue!) }
