import SwiftUI
import AppKit
import ServiceManagement
import NikMenuCore
import NikCore
import NikMacIdentity

struct EngineMenu: View {
    @ObservedObject var model: MenuViewModel
    let selection: AppSelection
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button("Open " + selection.flavour.appName, systemImage: "macwindow") {
            openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true)
        }.keyboardShortcut("0")
        Section {
            Label(model.state.label, systemImage: model.state.glyph.symbol)
                .accessibilityLabel(model.state.label)
            if let snapshot = model.snapshot {
                if let pending = snapshot.desktop?.pendingApprovals, !pending.isEmpty {
                    Label("\(pending.count) pending approvals", systemImage: "exclamationmark.bubble")
                }
                Text("Version \(snapshot.status.engine.version) · \(snapshot.status.generation.prefix(8))")
                    .accessibilityLabel("Version \(snapshot.status.engine.version), generation \(snapshot.status.generation)")
                Text("Codex · \(URL(fileURLWithPath: snapshot.status.account.home).lastPathComponent)")
                Text("Loopback \(snapshot.status.listener.port) · \(snapshot.status.bridge.editors) editors")
                ForEach(Array((snapshot.status.warnings ?? []).enumerated()), id: \.offset) { _, warning in
                    Label(warning.message, systemImage: "exclamationmark.triangle")
                }
            }
            if let problem = model.state.problem { Text(problem).foregroundStyle(.secondary) }
        }
        Section("Running instances") {
            if model.rows.isEmpty { Text(model.state.connected ? "No running instances" : "Connect to see instances") }
            ForEach(model.rows) { row in
                Menu {
                    Text("\(row.provider == .codex ? "Codex" : "Claude") · \(activity(row))")
                    Button("Open in Browser", systemImage: "arrow.up.forward.app") {
                        if let url = model.snapshot?.openURL(instance: row.id) { NSWorkspace.shared.open(url) }
                    }
                    .accessibilityLabel("Open \(row.label) in the default browser")
                } label: {
                    Label("\(row.label.isEmpty ? "Untitled" : row.label) · \(activity(row))", systemImage: row.provider == .codex ? "terminal" : "bubble.left")
                }
            }
            Button("Open in Browser…", systemImage: "safari") {
                if let url = model.snapshot?.openURL() { NSWorkspace.shared.open(url) }
            }.keyboardShortcut("o").disabled(!model.state.connected)
        }
        Divider()
        Button("Start Engine", systemImage: "play") { Task { await model.startEngine() } }
            .keyboardShortcut("s", modifiers: [.command, .option]).disabled(!model.canStart)
        Button("Stop Engine", systemImage: "stop") { Task { await model.stopEngine() } }
            .keyboardShortcut(".", modifiers: [.command, .option]).disabled(!model.canStop)
            .help("Drain this engine and exit successfully. It stays stopped until you choose Start.")
        Toggle("Open at Login", isOn: Binding(get: { model.login == .enabled || model.login == .requiresApproval },
                                               set: { value in Task { await model.setLogin(value) } }))
            .disabled(model.working).accessibilityLabel("Open " + selection.flavour.appName + " at login")
        Text("Login: \(loginLabel(model.login)) · Engine: \(loginLabel(model.agent))").font(.caption)
        if model.login == .requiresApproval || model.agent == .requiresApproval {
            Button("Allow in Login Items Settings…", systemImage: "checkmark.shield") { SMAppService.openSystemSettingsLoginItems() }
        }
        Divider()
        Menu("Tool Diagnostics", systemImage: "wrench.and.screwdriver") {
            ForEach(["claude", "codex", "node", "gh"], id: \.self) { name in
                Text("\(name): \(model.snapshot?.status.tools[name]?.path ?? "Not resolved")")
            }
            Divider()
            Button("Refresh Tools", systemImage: "arrow.clockwise") { Task { await model.refreshTools() } }
                .keyboardShortcut("r").disabled(!model.state.connected || model.working)
        }
        if let snapshot = model.snapshot {
            if !snapshot.updateBlockers.isEmpty {
                Menu("Update Blockers", systemImage: "exclamationmark.shield") {
                    ForEach(snapshot.updateBlockers, id: \.self) { Text($0) }
                }
            }
            Menu("Ownership & Availability", systemImage: "info.circle") {
                Text("Engine generation \(snapshot.status.generation.prefix(8))")
                Text(snapshot.status.account.borrowed ? "Codex connection borrowed" : "Codex account scoped to selected profile")
                Text("\(snapshot.status.bridge.pendingEditorRequests) pending editor requests")
                ForEach(Array(snapshot.status.blockers.enumerated()), id: \.offset) { _, blocker in Text(blocker.code + (blocker.tool.map { " · " + $0 } ?? "")) }
            }
        }
        Button("Review Engine Setup…", systemImage: "arrow.triangle.branch") {
            openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        SettingsLink { Label("Settings…", systemImage: "gearshape") }.keyboardShortcut(",")
        Menu("Open Logs", systemImage: "doc.text") {
            Button("Engine Output") { NSWorkspace.shared.open(URL(fileURLWithPath: selection.logDirectory + "/engine.stdout.log")) }
            Button("Engine Errors") { NSWorkspace.shared.open(URL(fileURLWithPath: selection.logDirectory + "/engine.stderr.log")) }
        }
        Button("Copy Diagnostics", systemImage: "doc.on.doc") {
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(model.diagnostics, forType: .string)
        }.keyboardShortcut("c", modifiers: [.command, .option])
        Button("About " + selection.flavour.appName + "…") {
            NSApp.activate(ignoringOtherApps: true)
            NSApp.orderFrontStandardAboutPanel(options: [.applicationName: selection.flavour.appName, .credits: NSAttributedString(string: "A quiet place for your work.\nmacOS 14+ · " + selection.flavour.rawValue)])
        }
        Divider()
        Button("Quit " + selection.flavour.appName, systemImage: "power") { model.stopMonitoring(); NSApp.terminate(nil) }
            .keyboardShortcut("q").help("The engine keeps running.")
    }
    private func activity(_ row: FleetRow) -> String {
        if row.status == .waiting { return "Waiting" }
        if row.status == .working { return "Busy" }
        if row.paused { return "Paused" }
        return "Ready"
    }
    private func loginLabel(_ value: LoginRegistration) -> String {
        switch value { case .enabled: "Enabled"; case .notRegistered: "Off"; case .requiresApproval: "Requires approval"
        case .notFound: "Not found"; case .unknown: "Unknown" }
    }
}
struct EngineSettingsView: View {
    @ObservedObject var model: MenuViewModel
    var body: some View {
        Form {
            Section {
                Text("Engine Settings").font(.title2.weight(.semibold))
                Text("Changes apply after you stop and start the engine.").foregroundStyle(.secondary)
            }
            Section("Tool paths") {
                TextField("Claude", text: $model.draft.claude, prompt: Text("Automatic"))
                TextField("Codex", text: $model.draft.codex, prompt: Text("Automatic"))
                TextField("GitHub CLI", text: $model.draft.gh, prompt: Text("Automatic"))
                LabeledContent("Node") { Text(model.snapshot?.status.tools["node"]?.path ?? "Bundled runtime").textSelection(.enabled).lineLimit(2) }
                Text("Use absolute executable paths, or leave blank for automatic resolution. Node uses the signed, pinned runtime.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Codex account") {
                TextField("Account home", text: $model.draft.codexHome)
                    .accessibilityHint("An absolute directory inside this engine's selected account profile")
                Text("Credentials are managed by Codex and are never shown here.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Local listener") {
                TextField("Port", text: $model.draft.port).accessibilityHint("0 selects an available port; maximum 65535")
                TextField("Bind address", text: $model.draft.bind)
                Text("127.0.0.1 only. Port 0 chooses an available port. Network exposure remains disabled.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if model.requiresRestart { Label("Saved changes need an engine restart", systemImage: "arrow.clockwise").foregroundStyle(.secondary) }
            if let message = model.settingsMessage { Text(message).font(.callout).textSelection(.enabled).accessibilityLabel(message) }
            HStack {
                Button("Reload") { Task { await model.loadSettings() } }.keyboardShortcut("r")
                Spacer()
                Button("Save Changes") { Task { await model.saveSettings() } }.keyboardShortcut(.defaultAction)
                    .disabled(!model.settingsLoaded || model.settingsUnknown || model.working || !model.state.connected)
            }
            .disabled(model.working || !model.state.connected)
        }
        .formStyle(.grouped).textFieldStyle(.roundedBorder)
        .padding(16).frame(width: 560, height: 650)
        .task { await model.loadSettings() }
    }
}
