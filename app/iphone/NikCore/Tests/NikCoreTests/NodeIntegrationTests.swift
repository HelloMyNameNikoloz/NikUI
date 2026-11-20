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
