import Foundation
import Darwin
import Testing
import NikMacIdentity
@testable import NikMacCore

private struct PreflightFixture {
    let directory: String
    let contents: URL
    let node: String
    init() throws {
        directory = "/private/tmp/nik-preflight-" + UUID().uuidString
        contents = URL(fileURLWithPath: directory + "/NikUI Dev.app/Contents")
        node = contents.appendingPathComponent("Resources/engine/node").path
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: contents.appendingPathComponent("Resources/engine"), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: node, contents: Data())
    }
    func close() { try? FileManager.default.removeItem(atPath: directory) }
    func launcher(executable: String? = nil, status: Int = 0, script: String? = nil) throws {
        let reply: [String: Any] = ["ok": true, "mode": "idle-preflight", "appID": "com.nikui.app.dev",
                                  "label": "com.nikui.engine.development", "pid": 123, "executable": executable ?? node]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: reply), as: UTF8.self)
        let code = script ?? "test \"$HOME\" = \"\(directory)\" && test \"$PATH\" = /usr/bin:/bin && test \"$1\" = --preflight || exit 83\nprintf '%s\\n' '\(json)'\nexit \(status)\n"
        let file = contents.appendingPathComponent("MacOS/nikd").path
        try ("#!/bin/sh\n" + code).write(toFile: file, atomically: false, encoding: .utf8)
        guard chmod(file, 0o700) == 0 else { throw IdentityFailure("FIXTURE_MODE") }
    }
    func check(contents: URL? = nil) async throws {
        try await EngineControl.preflight(contents: contents ?? self.contents, home: directory,
            appID: "com.nikui.app.dev", label: "com.nikui.engine.development")
    }
}

extension BoundedProcessTests {
@Suite("R47 idle preflight path and failure evidence") struct PreflightTests {
    @Test func canonicalNodeOutputMatchesBothPackageSpellingsWithTheAppEnvironment() async throws {
        let f = try PreflightFixture(); defer { f.close() }; try f.launcher()
        try await f.check()
        try await f.check(contents: URL(fileURLWithPath: f.contents.path.replacingOccurrences(of: "/private/tmp/", with: "/tmp/")))
    }
    @Test func reportedSymlinkIsComparedUsingRealpathOnBothSides() async throws {
        let f = try PreflightFixture(); defer { f.close() }
        let alias = f.directory + "/node-alias"
        try FileManager.default.createSymbolicLink(atPath: alias, withDestinationPath: f.node)
        try f.launcher(executable: alias); try await f.check()
    }
    @Test func validJSONCannotHideAFailingExitStatus() async throws {
        let f = try PreflightFixture(); defer { f.close() }
        try f.launcher(executable: f.node.replacingOccurrences(of: "/private/tmp/", with: "/tmp/"), status: 42)
        do { try await f.check(); Issue.record("A nonzero preflight exit was accepted") }
        catch let error as IdentityFailure {
            #expect(error.code == "ENGINE_PREFLIGHT_FAILED")
            #expect(error.diagnostics["exitStatus"] == "42")
            #expect(error.diagnostics["output"]?.contains("idle-preflight") == true)
            #expect(error.diagnostics["home"] == f.directory && error.diagnostics["timeoutSeconds"] == "15")
        }
    }
    @Test func actualStderrAndExitStatusSurviveInvalidOutput() async throws {
        let f = try PreflightFixture(); defer { f.close() }
        try f.launcher(script: "printf 'loader failed\\n' >&2\nexit 27\n")
        do { try await f.check(); Issue.record("Invalid preflight output was accepted") }
        catch let error as IdentityFailure {
            #expect(error.code == "ENGINE_PREFLIGHT_FAILED")
            #expect(error.diagnostics["exitStatus"] == "27" && error.diagnostics["output"] == "loader failed\n")
        }
    }
    @Test func anotherExistingExecutableRefusesWithTheActualReply() async throws {
        let f = try PreflightFixture(); defer { f.close() }; try f.launcher(executable: "/bin/sh")
        do { try await f.check(); Issue.record("A different executable was accepted") }
        catch let error as IdentityFailure {
            #expect(error.code == "ENGINE_PREFLIGHT_FAILED")
            #expect(error.diagnostics["expectedExecutable"] == f.node)
            let output = Data((error.diagnostics["output"] ?? "").utf8)
            #expect((try JSONSerialization.jsonObject(with: output) as? [String: Any])?["executable"] as? String == "/bin/sh")
        }
    }
    @Test func timedOutProcessRetainsPartialDiagnosticOutput() async throws {
        do {
            _ = try await BoundedProcess().runResult(executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "printf 'preflight started\\n' >&2; while :; do :; done"], environment: [:], timeout: 0.15)
            Issue.record("A hung preflight escaped its deadline")
        } catch let error as IdentityFailure {
            #expect(error.code == "CUTOVER_TIMEOUT")
            #expect(error.diagnostics["output"] == "preflight started\n" && error.diagnostics["exitStatus"] == "running")
        }
    }
}
}
