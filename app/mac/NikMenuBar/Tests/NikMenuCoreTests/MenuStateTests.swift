import Foundation
import Testing
import NikCore
@testable import NikMenuCore

@Suite("Menu state and view models") struct MenuStateTests {
    @Test func glyphsAndIntentionalStop() throws {
        var state = MenuState(); #expect(state.glyph == .starting)
        state.lost(MenuFailure.unavailable, hadConnection: false); #expect(state.glyph == .stopped)
        state.beginning(start: true); #expect(state.glyph == .starting)
        let value = try fixture("/fixture")
        state.received(value); #expect(state.glyph == .running); #expect(state.connected)
        state.lost(MenuFailure.unavailable, hadConnection: true)
        #expect(state.glyph == .attention); #expect(!state.connected)
        state.received(value, approval: true); #expect(state.problem == "SERVICE_REQUIRES_APPROVAL")
        state.intentionallyStopped(); #expect(state.glyph == .stopped); #expect(state.problem == nil)
    }
    @Test func unknownWorkNeedsAttention() throws {
        var raw = fixtureJSON("/fixture"); raw["updateBlockers"] = .array([.string("UNSAFE_OPERATION_PENDING")])
        let value = try JSONDecoder().decode(MenuSnapshot.self, from: raw.encoded())
        var state = MenuState(); state.received(value)
        #expect(state.glyph == .attention); #expect(state.problem == "UNSAFE_OPERATION_PENDING")
    }
    @Test func backoffIsBoundedAndResets() {
        var backoff = ReconnectBackoff()
        #expect((0..<9).map { _ in backoff.next() } == [1, 2, 4, 8, 16, 30, 30, 30, 30])
        backoff.reset(); #expect(backoff.next() == 1)
    }
    @Test func draftValidationKeepsTestProfileAndLoopback() throws {
        var draft = SettingsDraft(try fixture("/fixture").settings)
        #expect(try draft.settings(privateHome: "/fixture/home").tools.claude == nil)
        draft.port = "abc"; #expect(throws: MenuFailure.refused("PORT_INVALID")) { try draft.settings(privateHome: "/fixture/home") }
        draft.port = "65536"; #expect(throws: MenuFailure.refused("CONFIG_INVALID")) { try draft.settings(privateHome: "/fixture/home") }
        draft.port = "0"; draft.bind = "0.0.0.0"
        #expect(throws: MenuFailure.refused("BIND_LOOPBACK_REQUIRED")) { try draft.settings(privateHome: "/fixture/home") }
        draft.bind = "127.0.0.1"; draft.codexHome = "/Users/live/.codex"
        #expect(throws: MenuFailure.refused("CODEX_HOME_OUTSIDE_TEST_PROFILE")) { try draft.settings(privateHome: "/fixture/home") }
        draft.codexHome = "/fixture/home/../escape"
        #expect(throws: MenuFailure.refused("CODEX_HOME_OUTSIDE_TEST_PROFILE")) { try draft.settings(privateHome: "/fixture/home") }
    }
    @Test @MainActor func loginUsesReportedStatusAndQuitDoesNotStop() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let service = FakeService(), client = LocalControlClient(root: server.root, store: MemoryEnrollmentStore())
        let model = MenuViewModel(root: server.root, client: client, service: service)
        model.startMonitoring()
        try await eventually { await MainActor.run { model.state.connected } }
        #expect(model.state.glyph == .running); #expect(model.canStop); #expect(!model.canStart)
        service.approval = true; await model.setLogin(true)
        #expect(model.login == .requiresApproval); #expect(service.logins == 1)
        await model.setLogin(false); #expect(model.login == .notRegistered)
        model.stopMonitoring()
        try await eventually { server.activeClients == 0 }
        #expect(service.stops == 0); #expect(service.starts == 0)
    }
    @Test @MainActor func intentionalStopAndFailureAreDistinct() async throws {
        let server = try FakeSocketServer(); defer { server.cleanup() }
        let service = FakeService()
        let model = MenuViewModel(root: server.root, client: LocalControlClient(root: server.root, store: MemoryEnrollmentStore()), service: service)
        model.accept(try fixture(server.root)); await model.stopEngine()
        #expect(service.stops == 1); #expect(model.state.glyph == .stopped); #expect(!model.state.connected)
        #expect(model.canStart); #expect(model.rows.isEmpty)
        model.accept(try fixture(server.root)); service.stopFailure = .refused("SERVICE_OWNER_MISMATCH")
        await model.stopEngine()
        #expect(model.state.glyph == .attention); #expect(model.state.problem == "SERVICE_OWNER_MISMATCH")
    }
    @Test @MainActor func unregisteredFirstRunHasNoServiceEffects() {
        let service = FakeService()
        service.agentStatus = .notRegistered
        let model = MenuViewModel(root: "/unconfigured", client: LocalControlClient(root: "/unconfigured"), service: service)
        model.showUnregistered()
        #expect(model.state.glyph == .stopped); #expect(model.agent == .notRegistered)
        #expect(service.starts == 0); #expect(service.stops == 0); #expect(service.logins == 0)
    }
    @Test @MainActor func copyDiagnosticsAreWhitelistedAndRedacted() throws {
        let service = FakeService()
        let model = MenuViewModel(root: "/fixture", client: LocalControlClient(root: "/fixture"), service: service)
        model.accept(try fixture("/fixture"))
        let text = model.diagnostics
        for secret in ["SECRET-TITLE", "SECRET-PROJECT", "SECRET-BROWSER-KEY", "private-owner", "/fixture", testEnrollment.key] { #expect(!text.contains(secret)) }
        #expect(text.contains("1.2.3")); #expect(text.contains("generation-1")); #expect(text.contains("Running Codex: 1"))
        #expect(text.contains("PRODUCTION_CUTOVER_DISABLED")); #expect(text.contains("<user-home>"))
    }
    @Test @MainActor func unknownSaveRequiresExplicitReload() async throws {
        let server = try FakeSocketServer { request, root in
            if request["request"]["op"].stringValue == "engine.settings.update" { return .init(frames: []) }
            return try FakeSocketServer.standard(request, root: root)
        }; defer { server.cleanup() }
        let model = MenuViewModel(root: server.root, client: LocalControlClient(root: server.root, store: MemoryEnrollmentStore()), service: FakeService())
        model.accept(try fixture(server.root)); await model.loadSettings(); #expect(model.settingsLoaded)
        model.draft.port = "43000"; await model.saveSettings()
        #expect(model.settingsUnknown); #expect(model.settingsMessage?.contains("unknown") == true)
        await model.saveSettings()
        #expect(server.requests.filter { $0["request"]["op"].stringValue == "engine.settings.update" }.count == 1)
        await model.loadSettings(); #expect(!model.settingsUnknown); #expect(model.draft.port == "0")
    }
    @Test @MainActor func reconnectsAndRecoversNewGeneration() async throws {
        let counts = Counter()
        let server = try FakeSocketServer { request, root in
            if request["op"].stringValue == "menu-observe", counts.increment() == 1 { return .init(frames: []) }
            if counts.value >= 1 && request["op"].stringValue == "status" {
                return .init(frames: [try fixtureJSON(root, generation: "generation-2")["status"].encoded()])
            }
            if counts.value >= 2 && request["op"].stringValue == "menu-observe" {
                return .init(frames: [try JSONValue.object(["type": .string("menu:snapshot"), "version": .number(1),
                    "data": fixtureJSON(root, generation: "generation-2")]).encoded()], hold: true)
            }
            return try FakeSocketServer.standard(request, root: root)
        }; defer { server.cleanup() }
        let service = FakeService()
        let model = MenuViewModel(root: server.root, client: LocalControlClient(root: server.root, store: MemoryEnrollmentStore()), service: service,
                                  sleep: { _ in try await Task.sleep(for: .milliseconds(10)) })
        model.startMonitoring(); defer { model.stopMonitoring() }
        try await eventually { await MainActor.run { model.state.connected } }
        #expect(counts.value >= 2); #expect(model.state.glyph == .running)
        #expect(model.snapshot?.status.generation == "generation-2")
        #expect(service.starts == 0) // observing never auto-starts a stopped engine
    }
}
private final class Counter: @unchecked Sendable {
    private let lock = NSLock(); private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() -> Int { lock.lock(); defer { lock.unlock() }; count += 1; return count }
}
