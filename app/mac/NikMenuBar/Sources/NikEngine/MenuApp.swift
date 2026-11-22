import Foundation
import SwiftUI
import AppKit
import ServiceManagement
import NikMenuCore
import NikMacIdentity
import NikMacCore
import NikCore

@MainActor final class SystemEngineService: EngineService, CutoverService {
    private let selection: AppSelection
    private let agent: SMAppService
    private var createdCutoverRegistration = false
    init(_ selection: AppSelection) {
        self.selection = selection
        agent = SMAppService.agent(plistName: selection.agentPlist)
    }
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
        try BuildFlavour.current.validateRegistration(label: selection.flavour.engineLabel)
        if selection.flavour == .production {
            guard Bundle.main.bundleURL.path == "/Applications/NikUI.app" else { throw MenuFailure.refused("INSTALL_IN_APPLICATIONS_REQUIRED") }
            try selection.validateCommittedProduction()
        }
        do { if agent.status == .notRegistered || agent.status == .notFound { try agent.register() } }
        catch { throw MenuFailure.refused("SERVICE_REGISTRATION_FAILED") }
        guard agentStatus == .enabled else { throw MenuFailure.refused(agentStatus == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_UNAVAILABLE") }
        try await controller("start")
    }
    func stop() async throws {
        if agentStatus == .notRegistered || agentStatus == .notFound { return }
        try await controller("intentional-stop")
    }
    func registerForCutover() async throws {
        guard selection.isCutoverRehearsal || selection.flavour == .production && Bundle.main.bundleURL.path == "/Applications/NikUI.app" else { throw IdentityFailure("INSTALL_IN_APPLICATIONS_REQUIRED") }
        if agent.status == .notRegistered || agent.status == .notFound { createdCutoverRegistration = true; try agent.register() }
        guard agentStatus == .enabled else { throw IdentityFailure(agentStatus == .requiresApproval ? "SERVICE_REQUIRES_APPROVAL" : "SERVICE_UNAVAILABLE") }
    }
    func unregisterAfterHandback() async throws {
        // The bundled coordinator proved current-state import and window
        // ownership before calling this native final step.
        if agent.status != .notRegistered { try await agent.unregister() }
        guard agentStatus == .notRegistered else { throw IdentityFailure("SERVICE_UNREGISTER_FAILED") }
    }
    func cancelCutoverRegistration() async throws {
        if createdCutoverRegistration { try await unregisterAfterHandback(); createdCutoverRegistration = false }
    }
    private func controller(_ action: String) async throws {
        guard let executable = Bundle.main.executableURL else { throw MenuFailure.unsafe }
        let home = selection.home
        let data = try await BoundedProcess().run(executable: executable, arguments: [action],
            environment: ["HOME": home, "USERPROFILE": home, "ZDOTDIR": home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"], timeout: 40)
            let answer = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard answer?["ok"] as? Bool == true else {
                throw MenuFailure.refused(answer?["code"] as? String ?? "SERVICE_OPERATION_FAILED")
            }
    }
}
@MainActor final class MenuAppDelegate: NSObject, NSApplicationDelegate {
    var model: MenuViewModel?
    var session: MacAppSession?
    func applicationWillTerminate(_ notification: Notification) { BoundedProcess.cancelAll(); model?.stopMonitoring() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let client = session?.client else { return .terminateNow }
        Task {
            guard await client.flushPersistence() else {
                sender.reply(toApplicationShouldTerminate: false)
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert(); alert.messageText = "Drafts could not be saved"
                alert.informativeText = client.lastFailure?.message ?? "Your drafts remain open. Restore available storage and try again."
                alert.addButton(withTitle: "Keep NikUI Open"); alert.runModal()
                return
            }
            await client.disconnect()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
struct NikMenuApp: App {
    @NSApplicationDelegateAdaptor(MenuAppDelegate.self) private var delegate
    @StateObject private var model: MenuViewModel
    @State private var session: MacAppSession
    @State private var notificationPresenter: MacNotificationPresenter
    @State private var cutover: MacCutoverCoordinator
    @AppStorage("nikui.appearance") private var appearance = "system"
    private let selection: AppSelection
    init() {
        do {
            selection = try AppSelection.selected()
            if selection.flavour == .development { try selection.validateExistingRoot() }
        } catch { output(["ok": false, "code": (error as? IdentityFailure)?.code ?? "PACKAGE_CONFIGURATION"], 1) }
        let service = SystemEngineService(selection)
        let model = MenuViewModel(root: selection.root, client: LocalControlClient(root: selection.root,
            privateHome: selection.flavour == .production || selection.isCutoverRehearsal ? selection.home : nil), service: service,
            privateHome: selection.flavour == .production || selection.isCutoverRehearsal ? selection.home : nil)
        _cutover = State(initialValue: MacCutoverCoordinator(backend: BundledCutoverBackend(selection: selection), service: service,
            installed: Bundle.main.bundleURL.path == "/Applications/NikUI.app" || selection.isCutoverRehearsal))
        let selected = selection
        if selection.flavour == .development { model.onSnapshot = { value in
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
        } }
        let appSession = MacAppSession(selection: selection), presenter = MacNotificationPresenter(session: appSession)
        let evidence = model.onSnapshot
        model.onSnapshot = { value in
            evidence?(value)
            guard let snapshot = value.desktop else { return }
            Task {
                await appSession.desktopNotifications.receive(snapshot, preferences: MacNotificationPresenter.preferences(), presenter: presenter)
                let count = appSession.desktopNotifications.pendingApprovals.count
                NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
            }
        }
        _model = StateObject(wrappedValue: model)
        _session = State(initialValue: appSession)
        _notificationPresenter = State(initialValue: presenter)
        // No registration/start/enrollment on first-run production launch.
        // Development observers preserve P2's native menu acceptance path.
        model.refreshRegistration()
        if selection.flavour == .development || model.agent == .enabled { model.startMonitoring() }
        else { model.showUnregistered() }
    }
    var body: some Scene {
        WindowGroup(selection.flavour.appName, id: "main") {
            MacMainWindow(model: model, session: session, selection: selection, cutover: cutover)
                .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
                .onAppear { delegate.model = model; delegate.session = session; model.refreshRegistration() }
        }
        .defaultSize(width: 1120, height: 760)
        .windowStyle(.titleBar)
        .commands { MacWindowCommands() }
        MenuBarExtra {
            EngineMenu(model: model, selection: selection)
                .onAppear { delegate.model = model; delegate.session = session; model.refreshRegistration() }
        } label: {
            HStack {
                Image(systemName: session.desktopNotifications.pendingApprovals.isEmpty ? model.state.glyph.symbol : "exclamationmark.bubble.fill")
                if !session.desktopNotifications.pendingApprovals.isEmpty { Text(String(session.desktopNotifications.pendingApprovals.count)) }
            }
                .accessibilityLabel(selection.flavour.appName + ": " + model.state.label)
                .help(model.state.label)
        }
        .menuBarExtraStyle(.menu)
        Settings { DesktopSettings(model: model, session: session, selection: selection)
                .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
                .onAppear { NSApp.activate(ignoringOtherApps: true) } }
    }
}
@main struct NikEngineEntry {
    @MainActor static func main() {
        if CommandLine.arguments.dropFirst().contains(where: { !$0.hasPrefix("-psn_") }) { runController() }
        // Selection comes from the executable's compiled flavour, checked
        // against signed metadata. Production ignores inherited test HOMEs.
        do {
            let selection = try AppSelection.selected()
            let environment = selection.flavour == .development
                ? ["HOME": selection.home, "USERPROFILE": selection.home, "ZDOTDIR": selection.home,
                   "TMPDIR": selection.temporaryDirectory, "CODEX_HOME": selection.root + "/home/.codex-work"]
                : ["HOME": selection.home, "USERPROFILE": selection.home, "ZDOTDIR": selection.home]
            if selection.flavour == .production {
                for key in ["CODEX_HOME", "NIKUI_KEEPER_DIR", "NIKUI_SIGNED_TEST_ROOT", "NIKUI_NATIVE_TESTS"] { unsetenv(key) }
            }
            for (key, value) in environment {
                setenv(key, value, 1)
            }
            umask(0o077)
        } catch { output(["ok": false, "code": (error as? IdentityFailure)?.code ?? "PACKAGE_CONFIGURATION"], 1) }
        NikMenuApp.main()
    }
}
