import Foundation
import CryptoKit
import Testing
@testable import NikCore

@Suite("Pairing and staged identity") struct PairingTests {
    @Test func invitationParsesNormalizedCodeAndNeverLeaksFragment() throws {
        let v = try fixture(); let invitation = try PairingInvitation.parse("nikui://pair#c=23ab-cdef&h=laptop.example%3A4517&f=\(v["fingerprint"].stringValue!)&n=MacBook%20Pro&s=https")
        #expect(invitation.code == "23ABCDEF"); #expect(invitation.baseURL.absoluteString == "https://laptop.example:4517"); #expect(invitation.laptopName == "MacBook Pro")
        #expect(invitation.baseURL.fragment == nil); #expect(invitation.baseURL.query == nil)
        #expect(try PairingInvitation.parse("https://laptop.example/pair#c=23ABCDEF").baseURL.absoluteString == "https://laptop.example")
        #expect(try PairingInvitation.address("localhost:4517").scheme == "http")
    }
    @Test(arguments: ["nikui://pair#c=23ABCDEF", "nikui://pair#c=23ABCUUU&h=host", "nikui://pair#c=23ABCDEF&h=host&s=http", "https://u:p@host/pair#c=23ABCDEF", "nikui://pair#c=23ABCDEF&c=23ABCDEF&h=host", "https://host/other#c=23ABCDEF"])
    func invalidInvitation(_ source: String) { expectFailure(.invalidInput) { _ = try PairingInvitation.parse(source) } }
    @Test func pairPOSTUsesNoOriginAndVerifiesKeyBeforePersisting() async throws {
        let v = try fixture(); let body: JSONValue = .object(["device":.string("device1"),"name":.string("iPhone"),"control":.bool(false),"serverKey":v["hostSPKI"],"fingerprint":v["fingerprint"]])
        let http = RecordingHTTP(response: HTTPResponse(status: 200, data: try body.encoded())), store = MemoryKeyValueStore()
        let key = try softwareKey(), service = PairingService(key: key, store: store, http: http)
        let invitation = PairingInvitation(baseURL: URL(string: "https://laptop.example:4517")!, code: "23ab-cdef", fingerprint: v["fingerprint"].stringValue)
        let paired = try await service.pair(invitation, deviceName: "  My   iPhone  ")
        #expect(paired.fingerprint == v["fingerprint"].stringValue); #expect(paired.protection == .software)
        let request = try #require(await http.requests.first); #expect(request.value(forHTTPHeaderField: "Origin") == nil); #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.url?.path == "/pair"); #expect(request.url?.fragment == nil)
        let posted = try JSONValue.decode(#require(request.httpBody)); #expect(posted["code"].stringValue == "23ABCDEF"); #expect(posted["name"].stringValue == "My iPhone")
        #expect(NikCrypto.verify(signature: try NikCrypto.decodeBase64URL(posted["signature"].stringValue!), message: Data("nikui-pair:23ABCDEF".utf8), publicSPKI: try await key.publicSPKI()))
        #expect(await store.data(forKey: PairingService.pairingKey) != nil)
    }
    @Test func wrongFingerprintSavesNothingAndDoesNotRetry() async throws {
        let v = try fixture(), store = MemoryKeyValueStore()
        let http = RecordingHTTP(response: HTTPResponse(status: 200, data: try JSONValue.object(["device":.string("device1"),"serverKey":v["hostSPKI"],"fingerprint":v["fingerprint"]]).encoded()))
        let service = PairingService(key: try softwareKey(), store: store, http: http)
        let invitation = PairingInvitation(baseURL: URL(string: "https://laptop.example")!, code: "23ABCDEF", fingerprint: NikCrypto.base64URL(Data(repeating: 0, count: 16)))
        do { _ = try await service.pair(invitation); Issue.record("Wrong laptop accepted") } catch let e as CoreFailure { #expect(e.code == .wrongLaptop) }
        #expect(await http.requests.count == 1); #expect(await store.data(forKey: PairingService.pairingKey) == nil)
    }
    @Test func manualPairingAllowsExplicitTOFU() async throws {
        let v = try fixture(), store = MemoryKeyValueStore()
        let http = RecordingHTTP(response: HTTPResponse(status: 200, data: try JSONValue.object(["device":.string("device1"),"serverKey":v["hostSPKI"],"fingerprint":v["fingerprint"]]).encoded()))
        let value = try await PairingService(key: softwareKey(), store: store, http: http).pair(PairingInvitation(baseURL: URL(string: "https://laptop.example")!, code: "23ABCDEF"))
        #expect(value.deviceID == "device1")
    }
    @Test func rekeyHasTwoProofsAndCommitsAfterAuthenticatedReceipt() async throws {
        let v = try fixture(), store = MemoryKeyValueStore(), old = try softwareKey()
        let replacement = try SoftwareSigningKey(keyID: "candidate", rawRepresentation: unhex(v["candidateRaw"].stringValue!))
        let coordinator = RekeyCoordinator(store: store); let staged = try await coordinator.stage(pairing: record(), replacement: replacement)
        let proof = try await coordinator.authenticate(challenge: v["challenge"], current: old, replacement: replacement)
        let claim = Data("nikui-rekey:\(proof.serverNonce):\(proof.clientNonce):\(staged.candidateFingerprint):\(proof.binding)".utf8)
        #expect(NikCrypto.verify(signature: try NikCrypto.decodeBase64URL(proof.auth["signature"].stringValue!), message: claim, publicSPKI: try await old.publicSPKI()))
        #expect(NikCrypto.verify(signature: try NikCrypto.decodeBase64URL(proof.auth["rekey"]["signature"].stringValue!), message: claim, publicSPKI: try await replacement.publicSPKI()))
        #expect(await store.data(forKey: PairingService.pairingKey) == nil)
        let welcome = try makeWelcome(proof, rekeyed: staged.candidateFingerprint)
        let accepted = try #require(await coordinator.accept(welcome: welcome, proof: proof, oldKey: old)); #expect(accepted.keyID == "candidate")
        #expect(try await coordinator.load() == nil)
        do { _ = try await old.publicSPKI(); Issue.record("Old key was not deleted after commit") } catch let e as CoreFailure { #expect(e.code == .missingKey) }
    }
    @Test func missingAckKeepsStagingAndRecoveryProvesCandidate() async throws {
        let v = try fixture(), store = MemoryKeyValueStore(), old = try softwareKey()
        let candidate = try SoftwareSigningKey(keyID: "candidate", rawRepresentation: unhex(v["candidateRaw"].stringValue!))
        let first = RekeyCoordinator(store: store); _ = try await first.stage(pairing: record(), replacement: candidate)
        let proof = try await first.authenticate(challenge: v["challenge"], current: old, replacement: candidate)
        #expect(try await first.accept(welcome: makeWelcome(proof), proof: proof, oldKey: old) == nil)
        let resumed = RekeyCoordinator(store: store); #expect(try await resumed.load()?.attempted == true)
        do { try await resumed.discardUnattempted(replacement: candidate); Issue.record("Ambiguous candidate was discarded") } catch let e as CoreFailure { #expect(e.code == .refused) }
        let recovery = try await resumed.recoveryPairing(); let candidateProof = try await Handshake.authenticate(challenge: v["challenge"], pairing: recovery, key: candidate)
        let accepted = try await resumed.acceptRecovery(welcome: makeWelcome(candidateProof), proof: candidateProof, oldKey: old)
        #expect(accepted.keyID == "candidate"); #expect(try await resumed.load() == nil)
    }
    @Test func rekeyPersistenceFailureRetainsBothKeys() async throws {
        let v = try fixture(), store = FailingStore(), old = try softwareKey(), candidate = try SoftwareSigningKey(keyID: "candidate", rawRepresentation: unhex(v["candidateRaw"].stringValue!))
        let coordinator = RekeyCoordinator(store: store); let stage = try await coordinator.stage(pairing: record(), replacement: candidate)
        let proof = try await coordinator.authenticate(challenge: v["challenge"], current: old, replacement: candidate)
        await store.setFailWrites(true)
        do { _ = try await coordinator.accept(welcome: makeWelcome(proof, rekeyed: stage.candidateFingerprint), proof: proof, oldKey: old); Issue.record("Write failure ignored") } catch {}
        #expect(try await old.publicSPKI().count == 91); #expect(try await candidate.publicSPKI().count == 91); #expect(try await coordinator.load() != nil)
    }
}
func makeWelcome(_ proof: HandshakeProof, rekeyed: String? = nil) throws -> JSONValue {
    let v = try fixture(); let host = try P256.Signing.PrivateKey(rawRepresentation: unhex(v["hostRaw"].stringValue!))
    let signature = try host.signature(for: Data("nikui-host:\(proof.clientNonce):\(proof.serverNonce):\(proof.binding)".utf8)).rawRepresentation
    var welcome: JSONValue = .object(["type":.string("@welcome"),"device":.object(["id":.string("device1"),"control":.bool(true)]),"signature":.string(NikCrypto.base64URL(signature))])
    if let rekeyed { welcome["rekeyed"] = .object(["fingerprint":.string(rekeyed),"protection":.string("software")]) }; return welcome
}
