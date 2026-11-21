import Foundation
import SwiftUI
import AppKit
import ServiceManagement
import NikMenuCore

struct TestSelection: Sendable {
    let home: String, root: String
    static func selected(requireEnvironment: Bool = true) throws -> Self {
        guard Bundle.main.bundleIdentifier == "com.nikui.engine.dev",
              let home = Bundle.main.object(forInfoDictionaryKey: "NikEngineTestHome") as? String,
              let root = Bundle.main.object(forInfoDictionaryKey: "NikEngineTestRoot") as? String,
              home.hasPrefix("/private/tmp/nik-mac/build/"), root.hasPrefix(home + "/"),
              !requireEnvironment || ProcessInfo.processInfo.environment["HOME"] == home else { throw MenuFailure.refused("EXPLICIT_TEST_HOME_REQUIRED") }
        try PrivateFiles.directory(home); try PrivateFiles.directory(root)
        return Self(home: home, root: root)
    }
}
@MainActor final class SystemEngineService: EngineService {
    private let selection: TestSelection
    private let agent = SMAppService.agent(plistName: "com.nikui.engine.dev.plist")
    init(_ selection: TestSelection) { self.selection = selection }
    private func registration(_ value: SMAppService.Status) -> LoginRegistration {
        switch value {
        case .notRegistered: .notRegistered; case .enabled: .enabled; case .requiresApproval: .requiresApproval
        case .notFound: .notFound; @unknown default: .unknown
        }
    }
    var loginStatus: LoginRegistration { registration(SMAppService.mainApp.status) }
    var agentStatus: LoginRegistration { registration(agent.status) }
    func setLogin(enabled: Bool) async throws {
        do {
            if enabled {
                if SMAppService.mainApp.status == .notRegistered { try SMAppService.mainApp.register() }
            } else if SMAppService.mainApp.status != .notRegistered { try await SMAppService.mainApp.unregister() }
        } catch { throw MenuFailure.refused("LOGIN_REGISTRATION_FAILED") }
        if enabled && loginStatus == .requiresApproval { throw MenuFailure.refused("LOGIN_REQUIRES_APPROVAL") }
        guard enabled ? loginStatus == .enabled : loginStatus == .notRegistered else { throw MenuFailure.refused("LOGIN_REGISTRATION_FAILED") }
    }
    func start() async throws {
        do { if agent.status == .notRegistered || agent.status == .notFound { try agent.register() } }
        catch { throw MenuFailure.refused("SERVICE_REGISTRATION_FAILED") }
        guard agentStatus == .enabled else { throw MenuFailure.refused(agentStatus == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_UNAVAILABLE") }
        try await controller("start")
    }
    func stop() async throws { try await controller("intentional-stop") }
    private func controller(_ action: String) async throws {
        guard let executable = Bundle.main.executableURL else { throw MenuFailure.unsafe }
        let home = selection.home
        try await Task.detached(priority: .userInitiated) {
            let process = Process(), pipe = Pipe()
            process.executableURL = executable; process.arguments = [action]
            process.environment = ["HOME": home, "USERPROFILE": home, "ZDOTDIR": home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
            process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
            let answer = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard process.terminationStatus == 0, answer?["ok"] as? Bool == true else {
                throw MenuFailure.refused(answer?["code"] as? String ?? "SERVICE_OPERATION_FAILED")
            }
        }.value
    }
}
@MainActor final class MenuAppDelegate: NSObject, NSApplicationDelegate {
    var model: MenuViewModel?
    func applicationWillTerminate(_ notification: Notification) { model?.stopMonitoring() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
struct NikMenuApp: App {
    @NSApplicationDelegateAdaptor(MenuAppDelegate.self) private var delegate
    @StateObject private var model: MenuViewModel
    private let selection: TestSelection
    init() {
        do { selection = try TestSelection.selected() }
        catch { output(["ok": false, "code": "EXPLICIT_TEST_HOME_REQUIRED"], 1) }
        let model = MenuViewModel(root: selection.root, client: LocalControlClient(root: selection.root), service: SystemEngineService(selection))
        let selected = selection
        model.onSnapshot = { value in
            // Native gate evidence is deliberately small and secret-free. No
            // provider/control credentials, browser URL, or prompts are stored.
            let file = selected.root + "/menu-state.json", temp = selected.root + "/menu-state-" + UUID().uuidString + ".json"
            do {
                let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "pid": Int(getpid()), "home": selected.home,
                    "root": selected.root, "generation": value.status.generation, "state": value.status.state, "connected": true])
                try PrivateFiles.create(temp, data: bytes)
                if FileManager.default.fileExists(atPath: file) { try PrivateFiles.entry(file, kind: S_IFREG, mode: 0o600) }
                guard rename(temp, file) == 0 else { throw MenuFailure.unsafe }
            } catch { try? FileManager.default.removeItem(atPath: temp) }
        }
        _model = StateObject(wrappedValue: model)
        model.startMonitoring()
    }
    var body: some Scene {
        MenuBarExtra {
            EngineMenu(model: model, selection: selection)
                .onAppear { delegate.model = model; model.refreshRegistration() }
        } label: {
            Image(systemName: model.state.glyph.symbol)
                .accessibilityLabel("NikEngine: " + model.state.label)
                .help(model.state.label)
        }
        .menuBarExtraStyle(.menu)
        Settings { EngineSettingsView(model: model).onAppear { NSApp.activate(ignoringOtherApps: true) } }
    }
}
@main struct NikEngineEntry {
    @MainActor static func main() {
        if CommandLine.arguments.dropFirst().contains(where: { !$0.hasPrefix("-psn_") }) { runController() }
        // SMAppService.mainApp launches without a shell's --env. The signed
        // bundle itself explicitly selects the TEST HOME; establish it before
        // SwiftUI/Foundation creates client state, never discover a live home.
        do {
            let selection = try TestSelection.selected(requireEnvironment: false)
            for (key, value) in ["HOME": selection.home, "USERPROFILE": selection.home, "ZDOTDIR": selection.home,
                                 "TMPDIR": selection.home + "/tmp", "CODEX_HOME": selection.root + "/home/.codex-work"] {
                setenv(key, value, 1)
            }
            umask(0o077)
        } catch { output(["ok": false, "code": "EXPLICIT_TEST_HOME_REQUIRED"], 1) }
        NikMenuApp.main()
    }
}
