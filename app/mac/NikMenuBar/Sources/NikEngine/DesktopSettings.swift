import SwiftUI
import AppKit
import NikCore
import NikMacCore
import NikMenuCore
import NikMacIdentity
import UserNotifications

struct DesktopSettings: View {
    @ObservedObject var model: MenuViewModel
    let session: MacAppSession
    let selection: AppSelection
    @AppStorage("nikui.appearance") private var appearance = "system"
    @AppStorage("nikui.reading.fontSize") private var fontSize = 15.0
    @AppStorage("nikui.reading.width") private var readingWidth = 840.0
    @AppStorage("nikui.reading.thinking") private var showThinking = true
    @AppStorage("nikui.notifications.enabled") private var notificationsEnabled = false
    @AppStorage("nikui.notifications.approvals") private var approvalNotifications = true
    @AppStorage("nikui.notifications.finished") private var finishedNotifications = true
    @AppStorage("nikui.notifications.errors") private var errorNotifications = true
    @AppStorage("nikui.notifications.previews") private var notificationPreviews = false
    @AppStorage("nikui.notifications.sound") private var notificationSound = true
    @State private var notificationStatus: String?
    private var projects: [Project] {
        let fleet = session.client?.fleet ?? Fleet()
        var projects = fleet.projects
        for row in fleet.rows where !row.cwd.isEmpty && !projects.contains(where: { $0.path == row.cwd }) {
            projects.append(Project(.object(["path": .string(row.cwd), "name": .string(URL(fileURLWithPath: row.cwd).lastPathComponent)])))
        }
        return projects.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    var body: some View {
        TabView {
            Form {
                Section("Appearance") {
                    Picker("Appearance", selection: $appearance) {
                        Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark")
                    }
                }
                Section("Reading") {
                    Slider(value: $fontSize, in: 13...21, step: 1) { Text("Text size: \(Int(fontSize)) pt") }
                    Slider(value: $readingWidth, in: 600...1000, step: 20) { Text("Transcript width: \(Int(readingWidth)) pt") }
                    Toggle("Show thinking blocks when available", isOn: $showThinking)
                    Text("Changes apply to open conversations immediately.").font(.caption).foregroundStyle(.secondary)
                }
            }.formStyle(.grouped).padding().tabItem { Label("Reading", systemImage: "textformat.size") }
            VStack(alignment: .leading) {
                HStack { Label(model.state.label, systemImage: model.state.glyph.symbol); Spacer()
                    Button("Open Logs") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: selection.logDirectory)]) }
                }.padding(.horizontal, 24)
                EngineSettingsView(model: model)
            }.tabItem { Label("Engine", systemImage: "server.rack") }
            Form {
                Section("Projects from your engine") {
                    if projects.isEmpty { Text("Connect to the engine to see its projects.").foregroundStyle(.secondary) }
                    ForEach(projects) { project in
                        LabeledContent(project.name) { Text(project.path).textSelection(.enabled) }
                    }
                }
                Section("Project approval · later round") { Text("Adding approved projects and changing their order will be available in a later round.") }
            }.formStyle(.grouped).padding().tabItem { Label("Projects", systemImage: "folder") }
            Form {
                Section("Desktop notifications") {
                    Toggle("Enable desktop notifications", isOn: $notificationsEnabled)
                    Button("Allow Notifications…") { Task {
                        do {
                            let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                            notificationStatus = allowed ? "Notifications allowed" : "Notifications are disabled in System Settings"
                        } catch { notificationStatus = "NOTIFICATION_AUTHORIZATION_UNAVAILABLE" }
                    } }
                    Toggle("Pending approvals", isOn: $approvalNotifications)
                    Toggle("Finished turns", isOn: $finishedNotifications)
                    Toggle("Errors", isOn: $errorNotifications)
                    Toggle("Show private previews while unlocked", isOn: $notificationPreviews)
                    Toggle("Play notification sound", isOn: $notificationSound)
                    Text("Banners follow macOS notification and Focus settings. Clicking opens the issuing conversation. Dock and menu counts show pending approvals.").font(.caption).foregroundStyle(.secondary)
                    if let notificationStatus { Text(notificationStatus).font(.caption) }
                    if let problem = session.desktopNotifications.problem { Text(problem).font(.caption) }
                }
                Section("Later rounds") {
                    LabeledContent("Exposure and cutover", value: "Production source handoff")
                    LabeledContent("Updates", value: "Whole-app update coordinator")
                    LabeledContent("Keyboard commands", value: "New conversation, focus and command picker")
                }
            }.formStyle(.grouped).padding().tabItem { Label("Notifications", systemImage: "bell") }
        }.frame(width: 620, height: 740)
    }
}
