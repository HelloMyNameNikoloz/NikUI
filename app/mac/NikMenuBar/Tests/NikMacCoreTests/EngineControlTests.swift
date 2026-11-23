import Foundation
import Darwin
import Testing
import NikCore
import NikMenuCore
@testable import NikMacCore

@Suite("Controller status and portable KeepAlive lifecycle") struct EngineControlTests {
    @Test func claimedPIDCannotReplaceTheControlSocketsKernelPeerPID() throws {
        let root = "/private/tmp/nik-peer-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(atPath: root) }
        let child = Process(), output = Pipe()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        child.arguments = ["node", "-e", #"""
        const fs = require('fs'), net = require('net'), root = process.argv[1];
        net.createServer(socket => socket.once('data', () => socket.end(JSON.stringify({
          ok: true, root, state: 'running', pid: process.pid + 1, generation: 'claimed', controlPeerPID: process.pid + 1
        }) + '\n'))).listen(root + '/c.sock', () => { fs.chmodSync(root + '/c.sock', 0o600); console.log('ready'); });
        """#, root]
        child.standardOutput = output; child.standardError = FileHandle.standardError
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        _ = try output.fileHandleForReading.read(upToCount: 6)
        #expect(throws: MenuFailure.refused("SERVICE_BUNDLE_MISMATCH")) { _ = try EngineControl.status(root: root) }
    }
    @Test func successfulStatusRetryRetainsTheOriginalReadErrno() throws {
        let root = "/private/tmp/nik-read-error-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(atPath: root) }
        let child = Process(), output = Pipe()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        child.arguments = ["node", "-e", #"""
        const fs = require('fs'), net = require('net'), root = process.argv[1];
        let attempts = 0;
        net.createServer(socket => socket.once('data', () => {
          if (++attempts === 1) return; // Force a real SO_RCVTIMEO before recovery.
          socket.end(JSON.stringify({ ok: true, root, state: 'running', pid: process.pid, generation: 'recovered' }) + '\n');
        })).listen(root + '/c.sock', () => { fs.chmodSync(root + '/c.sock', 0o600); console.log('ready'); });
        """#, root]
        child.standardOutput = output; child.standardError = FileHandle.standardError
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        _ = try output.fileHandleForReading.read(upToCount: 6)
        var failures: [ControlReadEvidence] = []
        let status = try EngineControl.status(root: root, onReadError: { failures.append($0) })
        #expect(status["generation"] as? String == "recovered")
        #expect(failures.count == 1)
        #expect(failures.first?.code == "CONTROL_TIMEOUT" && failures.first?.operation == "read")
        #expect(failures.first?.errno == EAGAIN || failures.first?.errno == EWOULDBLOCK)
        #expect(failures.first?.fields["errno"] as? Int32 == EAGAIN)
    }
    @Test func realStatusAcrossSIGKILLRecoveryAndAnExplicitRestart() throws {
        let root = "/private/tmp/nik-controller-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(atPath: root) }
        var repo = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { repo.deleteLastPathComponent() }
        func start() throws -> (Process, [String: Any]) {
            let child = Process(), output = Pipe()
            child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            child.arguments = ["node", repo.appendingPathComponent("src/nikd.js").path, "--root", root]
            child.standardOutput = output; child.standardError = FileHandle.standardError
            try child.run()
            var bytes = Data()
            while let data = try output.fileHandleForReading.read(upToCount: 1), !data.isEmpty {
                if data.first == 10 { break }; bytes.append(data)
                guard bytes.count <= 262144 else { child.terminate(); throw MenuFailure.invalid }
            }
            guard let status = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw MenuFailure.invalid }
            return (child, status)
        }
        let (first, firstStatus) = try start()
        defer { if first.isRunning { first.terminate(); first.waitUntilExit() } }
        let a = try EngineControl.status(root: root)
        #expect(a["generation"] as? String == firstStatus["generation"] as? String)
        #expect(a["pid"] as? Int == Int(first.processIdentifier))
        #expect(kill(first.processIdentifier, SIGKILL) == 0); first.waitUntilExit()
        #expect(first.terminationReason == .uncaughtSignal && first.terminationStatus == SIGKILL)
        let (replacement, replacementStatus) = try start()
        defer { if replacement.isRunning { replacement.terminate(); replacement.waitUntilExit() } }
        let b = try EngineControl.status(root: root)
        #expect(b["generation"] as? String == replacementStatus["generation"] as? String)
        #expect(b["generation"] as? String != a["generation"] as? String)
        #expect(b["pid"] as? Int != a["pid"] as? Int)
        #expect((b["engine"] as? [String: Any])?["id"] as? String == (a["engine"] as? [String: Any])?["id"] as? String)
        #expect((b["engine"] as? [String: Any])?["boot"] as? String != (a["engine"] as? [String: Any])?["boot"] as? String)
        replacement.terminate(); replacement.waitUntilExit()
        #expect(replacement.terminationStatus == 0)
        #expect(throws: MenuFailure.unavailable) { _ = try EngineControl.status(root: root) }
        let (explicit, _) = try start()
        defer { if explicit.isRunning { explicit.terminate(); explicit.waitUntilExit() } }
        let c = try EngineControl.status(root: root)
        #expect(c["generation"] as? String != b["generation"] as? String)
        explicit.terminate(); explicit.waitUntilExit(); #expect(explicit.terminationStatus == 0)
    }
    @Test func startupFailureIsFreshCodeOnlyAndBoundToTheMove() throws {
        let root = "/private/tmp/nik-startup-" + UUID().uuidString.prefix(8)
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(atPath: root) }
        let started = Date(), file = root + "/engine-startup-failure.json"
        func write(_ code: String, at: Date = Date(), transition: String? = nil) throws {
            try? FileManager.default.removeItem(atPath: file)
            var fields: [String: Any] = ["version": 1, "root": root, "pid": 123, "at": at.timeIntervalSince1970 * 1000, "code": code]
            fields["transition"] = transition
            try PrivateFiles.create(file, data: JSONSerialization.data(withJSONObject: fields))
        }
        try write("EADDRINUSE"); #expect(EngineControl.startupFailure(root: root, since: started) == "EADDRINUSE")
        try write("private credentials"); #expect(EngineControl.startupFailure(root: root, since: started) == nil)
        try write("EADDRINUSE", at: started.addingTimeInterval(-60)); #expect(EngineControl.startupFailure(root: root, since: started) == nil)
        try write("EADDRINUSE", transition: "old-move"); #expect(EngineControl.startupFailure(root: root, since: started) == nil)
        try PrivateFiles.create(root + "/production-owner.json", data: Data(#"{"transition":"current-move"}"#.utf8))
        try write("EADDRINUSE", transition: "current-move"); #expect(EngineControl.startupFailure(root: root, since: started) == "EADDRINUSE")
    }
}
