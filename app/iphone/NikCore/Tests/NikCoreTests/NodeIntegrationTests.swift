#if os(macOS)
import Foundation
import Testing
@testable import NikCore

private func repositoryRoot() -> URL {
    var url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    for _ in 0..<5 { url.deleteLastPathComponent() }; return url
}
private func nodeProcess(_ script: String, arguments: [String] = []) throws -> (Process, Pipe, Pipe) {
    let executable = try #require(Bundle.module.url(forResource: script, withExtension: "js", subdirectory: "Fixtures"))
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["node", executable.path, repositoryRoot().path] + arguments
    let output = Pipe(), input = Pipe(); process.standardOutput = output; process.standardInput = input
    process.standardError = FileHandle.standardError; try process.run(); return (process, output, input)
}
private func line(_ pipe: Pipe) throws -> JSONValue {
    var data = Data()
    while let byte = try pipe.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
        if byte.first == 10 { break }; data.append(byte)
        guard data.count < 256 * 1024 else { throw CoreFailure(.tooLarge, "Fixture process returned too much output") }
    }
    return try JSONValue.decode(data)
}
@Suite("Actual Node server modules") struct NodeIntegrationTests {
    @Test func swiftNegotiatedIntentsAndCanonicalBoundariesAgreeWithRealNodeDispatcher() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nikcore-node-v2-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (process, output, input) = try nodeProcess("protocol-v2-server", arguments: [directory.path])
        defer { if process.isRunning { process.terminate() } }
        func post(_ value: JSONValue) throws {
            // readline also splits Unicode line separators; WebSocket frames do not.
            let line = value.text.replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
            try input.fileHandleForWriting.write(contentsOf: Data(line.utf8) + Data([10]))
        }
        let challenge = try line(output)["challenge"], pairing = try record()
        let proof = try await Handshake.authenticate(challenge: challenge, pairing: pairing, key: softwareKey())
        try post(proof.auth)
        var box = Box(sending: proof.keys.toServer, receiving: proof.keys.toClient)
        let authenticated = try JSONValue.decode(Data(box.open(line(output)).utf8))
        #expect(try proof.verifyWelcome(authenticated).id == pairing.deviceID)
        try post(box.seal(ProtocolSession.hello(clientID: V2Wire.randomID()).text))
        let welcome = try ProtocolWelcome(validating: JSONValue.decode(Data(box.open(line(output)).utf8)))
        let session = ProtocolSession(welcome: welcome), context = IntentContext(pairing: pairing, role: .conversation("instance-7"), session: session)
        let repository = PendingIntentRepository(store: ProtectedFileStore(directory: directory.appendingPathComponent("phone")))
        let ready = try await repository.prepare(.ready(), context: context, at: Date())
        try post(box.seal(ready.plaintext)); _ = try MutationAck(validating: JSONValue.decode(Data(box.open(line(output)).utf8)))
        let prompt = "Swift → Node ქართული 👋\n" + String(repeating: "full input ", count: 1000)
        let pending = try await repository.prepare(.send(text: prompt, attachments: PreviewFixtures.conversation.items[0].images, sent: "/snippet", snippets: ["snippet"]), context: context, at: Date())
        try post(box.seal(pending.plaintext))
        let ack = try MutationAck(validating: JSONValue.decode(Data(box.open(line(output)).utf8)))
        #expect(ack.outcome == .applied); #expect(ack.result?.data["operation"].stringValue == pending.mid)
        _ = try await repository.apply(.ack(ack), context: context)
        try post(box.seal(pending.plaintext))
        let duplicate = try MutationAck(validating: JSONValue.decode(Data(box.open(line(output)).utf8)))
        #expect(duplicate.status == .duplicate); #expect(duplicate.result == ack.result)
        try post(box.seal(JSONValue.object(["type": .string("receipt:get"), "scope": .string(pending.scope), "mid": .string(pending.mid)]).text))
        let lookup = try MutationAck(validating: JSONValue.decode(Data(box.open(line(output)).utf8)))
        #expect(lookup.status == .duplicate); #expect(lookup.result == ack.result)
        var numbers: [JSONValue] = [Double.leastNonzeroMagnitude, Double.leastNormalMagnitude, Double.greatestFiniteMagnitude, 1e-7, 1e-6, 1e20, 1e21, 1e23, -0.0, 333333333.3333333, 1_000_000_000_000_000_128].map(JSONValue.number)
        var bits: UInt64 = 0x123456789abcdef
        for _ in 0..<500 { bits = bits &* 6364136223846793005 &+ 1; let number = Double(bitPattern: bits); if number.isFinite { numbers.append(.number(number)) } }
        numbers.append(.object(["\u{10000}": .string("\n\t\u{1}\u{2028}👋"), "\u{e000}": .array([.null, .bool(false)]), "10": .number(1), "2": .number(2)]))
        try post(.object(["fixture": .string("canonical"), "values": .array(numbers)]))
        let expected = try line(output).arrayValue
        #expect(expected.count == numbers.count)
        for (value, reference) in zip(numbers, expected) { #expect(try IntentCanonicalJSON.text(value).utf8.elementsEqual(reference.stringValue!.utf8), "\(value)") }
        try post(.object(["fixture": .string("stop")]))
        let summary = try line(output); process.waitUntilExit()
        #expect(process.terminationStatus == 0); #expect(summary["sends"].intValue == 1)
    }
    @Test func swiftProofAndEnvelopeAcceptedByRealGateAndGuard() async throws {
        let v = try fixture(), key = try softwareKey()
        let proof = try await Handshake.authenticate(challenge: v["challenge"], pairing: record(v), key: key, clientNonce: v["clientNonce"].stringValue!, ephemeralRaw: unhex(v["clientEphemeralRaw"].stringValue!))
        var box = Box(sending: proof.keys.toServer, receiving: proof.keys.toClient)
        let packets = try v["messages"].arrayValue.map { try box.seal($0.stringValue!) }
        let signatureMessage = "Swift → Node • ქართული 👋\nNo trailing newline"
        let candidate = try SoftwareSigningKey(keyID: "candidate", rawRepresentation: unhex(v["candidateRaw"].stringValue!))
        let rekeyProof = try await Handshake.authenticate(challenge: v["challenge"], pairing: record(v), key: key, clientNonce: v["clientNonce"].stringValue!, ephemeralRaw: unhex(v["clientEphemeralRaw"].stringValue!), rekey: candidate)
        var payload = v
        payload["auth"] = proof.auth; payload["packets"] = .array(packets); payload["signatureMessage"] = .string(signatureMessage)
        payload["signature"] = .string(NikCrypto.base64URL(try await key.sign(message: Data(signatureMessage.utf8)))); payload["rekeyAuth"] = rekeyProof.auth
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: file) }; try payload.encoded().write(to: file)
        let (process, output, _) = try nodeProcess("verify-swift", arguments: [file.path])
        let result = try line(output); process.waitUntilExit(); #expect(process.terminationStatus == 0)
        #expect(result["signatureOK"].boolValue == true); #expect(result["opened"] == v["messages"])
        #expect(result["nativeGuard"].isNull); #expect(result["customGuard"]["status"].intValue == 403); #expect(result["localBearer"]["ok"].boolValue == false)
        #expect(result["normalized"].boolValue == true); #expect(result["spent"].boolValue == true); #expect(result["wrongCloses"].boolValue == true)
        #expect(result["rekey"]["ok"].boolValue == true); #expect(result["rekey"]["control"].boolValue == true)
        let welcome = try JSONValue.decode(Data(box.open(result["boxedWelcome"]).utf8)); #expect(try proof.verifyWelcome(welcome).id == "device1")
    }
    @Test(.enabled(if: ProcessInfo.processInfo.environment["NIKCORE_LOOPBACK_TESTS"] == "1", "Requires loopback listening; this workspace sandbox returns EPERM. Set NIKCORE_LOOPBACK_TESTS=1 outside the sandbox."))
    func urlSessionPairsAndUpgradesWithoutOriginAgainstRealRemoteServer() async throws {
        let (process, output, input) = try nodeProcess("native-server")
        defer { if process.isRunning { process.terminate() } }
        let config = try line(output)
        let invitation = try PairingInvitation.parse(config["link"].stringValue!)
        let key = try softwareKey(), store = MemoryKeyValueStore()
        let pairing = try await PairingService(key: key, store: store).pair(invitation)
        #expect(pairing.fingerprint == config["fingerprint"].stringValue)
        _ = try await PairingService(key: key, store: store).health(baseURL: pairing.baseURL)
        let recorder = UpdateRecorder(), connection = SocketConnection()
        let task = Task { await connection.run(pairing: pairing, key: key, role: .fleet) { await recorder.append($0) } }
        try await eventually { await recorder.isLive() }
        let verified = await recorder.updates
        #expect(verified.contains { if case .welcome(_, let seat, _) = $0 { return !seat.control }; return false })
        task.cancel(); await connection.close(); _ = await task.value
        var custom = URLRequest(url: pairing.baseURL.appendingPathComponent("health")); custom.setValue("nikui://native", forHTTPHeaderField: "Origin")
        #expect(try await URLSessionHTTPClient().send(custom).status == 403)
        try input.fileHandleForWriting.write(contentsOf: Data("observed\n".utf8)); let observed = try line(output)
        #expect(observed.arrayValue.contains { $0["method"].stringValue == "POST" && $0["origin"].isNull })
        #expect(observed.arrayValue.contains { $0["method"].stringValue == "UPGRADE" && $0["origin"].isNull })
        try input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8)); process.waitUntilExit()
    }
}
#endif
