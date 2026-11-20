import SwiftUI
import UIKit
import UserNotifications
import NikCore

/// The app's own settings: the paired laptop, how the app looks, notifications,
/// the app lock and this device's key.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client

    var body: some View {
        List {
            Section {
                NavigationLink { LaptopPane() } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(client.pairedConnection?.laptopName ?? "Laptop")
                            Text(client.connection.words).font(.footnote).foregroundStyle(client.connection.isTrouble ? Theme.needsYou : .secondary)
                        }
                    } icon: { Image(systemName: "laptopcomputer") }
                }
            }
            Section {
                NavigationLink { AppearancePane() } label: { Label("Appearance", systemImage: "circle.lefthalf.filled") }
                NavigationLink { NotificationsPane() } label: { Label("Notifications", systemImage: "bell.badge") }
                NavigationLink { SecurityPane() } label: { Label("Security", systemImage: "lock") }
                Button { model.push(.slack); model.tab = .chats } label: {
                    Label("Slack", systemImage: "number").foregroundStyle(.primary)
                }
            }
            Section {
                NavigationLink { AdvancedPane() } label: { Label("Advanced", systemImage: "wrench.and.screwdriver") }
            }
        }
        .navigationTitle("Settings")
    }
}

// MARK: Laptop

private struct LaptopPane: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @State private var health = "Not checked"
    @State private var checkedAt: Date?
    @State private var checking = false

    var body: some View {
        List {
            Section {
                LabeledContent("Name", value: model.laptopName)
                if let url = client.pairedConnection?.baseURL {
                    LabeledContent("Address") { Text(url.absoluteString).textSelection(.enabled) }
                }
                LabeledContent("Authenticated connection", value: client.connection.words)
                LabeledContent("Reachability", value: health)
                if let checkedAt { Text("Checked " + checkedAt.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary) }
                Button { Task { await check(reconnect: true) } } label: {
                    HStack { Text("Check again"); Spacer(); if checking { ProgressView() } }
                }.disabled(checking)
                if let error = model.identityError { Text(error).foregroundStyle(Theme.needsYou) }
                if let seat = client.seat { LabeledContent("This iPhone", value: seat.control ? "Can control" : "Watching only") }
                if let version = client.extensionVersion { LabeledContent("NikUI on the laptop", value: version) }
            } footer: { Text("Reachability checks the HTTP health endpoint. It does not verify a sealed session or grant control.") }
            if needsPairing {
                Section {
                    if client.connection == .wrongLaptop {
                        Text("The laptop key does not match the saved fingerprint. Stop and compare it on the laptop before pairing again.").foregroundStyle(Theme.needsYou)
                        if let fingerprint = client.pairedConnection?.fingerprint {
                            Text(PairingView.grouped(fingerprint)).font(.body.monospaced()).textSelection(.enabled)
                        }
                    }
                    Button("Pair again…") { model.pendingInvitation = nil; model.showPairing = true }
                }
            }
            if client.awake.available || client.awake.supported {
                Section {
                    Toggle(isOn: Binding(get: { client.awake.on }, set: { model.requestPowerChange(.setAwake($0)) })) {
                        Label("Keep the laptop awake", systemImage: "cup.and.saucer")
                    }
                    .disabled(!client.awake.mayChange || !client.mayControl || model.power.busy)
                    LabeledContent("Awake requested", value: client.awake.on ? "On" : "Off")
                    LabeledContent("Awake assertion", value: client.awake.held ? "Held" : "Not held")
                    if let since = client.awake.since { Text("Awake since \(since.formatted(date: .omitted, time: .shortened)).") }
                    if let reason = client.awake.refused ?? client.awake.reason { Text(reason).font(.footnote).foregroundStyle(.secondary) }
                    if let lid = client.awake.lid, lid.supported {
                        Toggle(isOn: Binding(get: { lid.on }, set: { model.requestPowerChange(.setLid($0)) })) {
                            Label("Keep working with the lid closed", systemImage: "laptopcomputer.slash")
                        }
                        .disabled(!lid.approved || !client.mayControl || model.power.busy)
                        LabeledContent("Closed-lid assertion", value: lid.held ? "Held" : "Not held")
                        if lid.finishing { Label("Finishing current work before release", systemImage: "hourglass") }
                        if lid.lowBattery { Text("Low battery may release the closed-lid hold.").foregroundStyle(Theme.working) }
                        if !lid.approved { Text("Approve closed-lid work from NikUI on the laptop.") }
                        if let battery = lid.battery, let percent = battery.percent {
                            LabeledContent("Battery", value: Format.percent(percent > 1 ? percent / 100 : percent) + (battery.ac ? ", charging" : ""))
                        }
                        if let reason = lid.reason { Text(reason).font(.footnote).foregroundStyle(.secondary) }
                    }
                    if model.power.busy { ProgressView("Waiting for the laptop…") }
                }
            }
        }
        .navigationTitle("Laptop")
        .task { await check(reconnect: false) }
        .refreshable { await check(reconnect: true) }
    }

    private var needsPairing: Bool {
        switch client.connection { case .refused, .wrongLaptop: true; default: model.identityError != nil }
    }
    private func check(reconnect: Bool) async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        switch await client.health() {
        case .success(let seconds): health = "Reachable · \(Int((seconds * 1000).rounded())) ms round trip"
        case .failure(let failure): health = "Unreachable: " + failure.message
        }
        checkedAt = .now
        if reconnect, !client.connection.isLive, !needsPairing { await model.retryConnection() }
        if client.connection.isLive { _ = await client.perform(.awake) }
    }
}

// MARK: Appearance

private struct AppearancePane: View {
    @Environment(NikClient.self) private var client

    var body: some View {
        Form {
            Section("Look") {
                Picker("Appearance", selection: binding(\.appearance)) {
                    Text("Match iPhone").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.inline).labelsHidden()
            }
            Section {
                Picker("Text size", selection: binding(\.textSize)) {
                    Text("Follow iPhone").tag("default")
                    Text("Smaller").tag("small")
                    Text("Larger").tag("large")
                }
                .pickerStyle(.inline).labelsHidden()
            } header: { Text("Text size") } footer: {
                Text("NikUI follows the iPhone's Dynamic Type settings, including accessibility sizes.")
            }
        }
        .navigationTitle("Appearance")
    }

    private func binding(_ key: WritableKeyPath<LocalPreferences, String>) -> Binding<String> {
        Binding(get: { client.preferences[keyPath: key] }, set: { value in
            var prefs = client.preferences; prefs[keyPath: key] = value
            Task { await client.updatePreferences(prefs) }
        })
    }
}

// MARK: Notifications

private struct NotificationsPane: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.openURL) private var openURL
    @State private var settingUp = false
    private var prefs: NotificationPreferences { client.preferences.notifications }
    private var access: NotificationAccess { model.notificationAccess }

    var body: some View {
        Form {
            Section {
                Toggle("Live-app notifications", isOn: Binding(get: { prefs.on }, set: { on in Task { await turn(on) } }))
                    .disabled(settingUp)
                Button("iPhone notification settings") { openSystemSettings() }
            } footer: {
                Text("These switches filter socket notifications and alerts while NikUI is running. Once Apple registration is set up, the laptop can still send remote alerts, including full message text, while NikUI is closed. Use iPhone notification settings to turn those alerts or their previews off.")
            }
            if prefs.on {
                Section("Live-app alerts") {
                    ForEach(NotificationKind.allCases, id: \.self) { kind in
                        Toggle(words(kind), isOn: Binding(get: { prefs.enabledKinds.contains(kind) }, set: { on in
                            update { if on { $0.enabledKinds.insert(kind) } else { $0.enabledKinds.remove(kind) } }
                        }))
                    }
                }
                Section {
                    Toggle("Live-app message previews", isOn: Binding(get: { prefs.showPreviews }, set: { on in update { $0.showPreviews = on } }))
                } footer: { Text("Hides text in local alerts. This does not change remote alert previews while the app is closed. Locked NikUI never presents foreground message previews.") }
            }
            Section {
                LabeledContent("iPhone permission", value: access.authorizationWords)
                LabeledContent("Apple registration", value: access.registrationWords)
                LabeledContent("Laptop token submission", value: access.submissionWords)
                LabeledContent("Remote delivery", value: "Unknown; no delivery receipt")
                if let error = access.storageError { Text(error).foregroundStyle(Theme.needsYou) }
                if access.authorization == .denied {
                    Button("Allow in iPhone Settings") { openSystemSettings() }
                } else {
                    Button(access.authorized ? "Retry Apple registration" : "Set up notifications…") { Task { await setup() } }
                        .disabled(settingUp)
                }
                Button("Send me one now") {
                    Task {
                        do { try await access.localTest() }
                        catch { model.show("The local test could not be shown: \(error.localizedDescription)", .error) }
                    }
                }.disabled(!access.authorized)
            } header: { Text("While closed: setup and status") } footer: {
                Text("The local test checks this iPhone only. A saved or submitted OS token does not prove laptop push delivery. This build needs Apple's Push Notifications entitlement and provisioning, and the laptop needs APNs configuration. The current server has no push opt-out, preview preferences, or receipt. Apple receives remote alert text. Slack remote alerts currently open Chats because the server omits the Slack destination and tag. Duplicate remote and socket alerts can occur.")
            }
        }
        .navigationTitle("Notifications")
        .task { await access.refresh() }
    }

    private func openSystemSettings() { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }
    private func words(_ kind: NotificationKind) -> String {
        switch kind {
        case .needsYou: "A chat needs me"
        case .failed: "A chat fails"
        case .quota: "Usage is running out"
        case .ci: "Checks finish"
        case .turnFinished: "A turn finishes"
        case .slack: "Slack messages"
        }
    }
    private func setup() async {
        settingUp = true
        defer { settingUp = false }
        if await access.request() { await model.offerAppleToken() }
    }
    private func turn(_ on: Bool) async {
        if on, !access.authorized {
            await setup()
            guard access.authorized else { model.show("Allow notifications for NikUI in iPhone Settings.", .warning); return }
        }
        var all = client.preferences; all.notifications.on = on
        await client.updatePreferences(all)
        if on { await model.offerAppleToken() }
    }
    private func update(_ change: (inout NotificationPreferences) -> Void) {
        var all = client.preferences; change(&all.notifications)
        Task { await client.updatePreferences(all) }
    }
}

// MARK: Security

private struct SecurityPane: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @State private var pinPurpose: PinSetupView.Purpose?
    @State private var removing: Removal?
    @State private var removingNow = false
    @State private var confirmLocalForget = false
    @State private var removalError: String?

    private struct Removal { let id: String; let name: String; let me: Bool }

    var body: some View {
        let lock = model.lock
        Form {
            Section {
                if lock.isOn {
                    Button("Change PIN") { pinPurpose = .change }
                    Button("Turn off app lock", role: .destructive) { pinPurpose = .turnOff }
                    if lock.faceIDAvailable {
                        Toggle("Unlock with \(lock.biometryName)", isOn: Binding(get: { lock.usesFaceID }, set: { on in Task { await lock.setFaceID(on) } }))
                            .disabled(lock.busy)
                    }
                } else { Button("Turn on app lock") { pinPurpose = .turnOn } }
            } header: { Text("App lock") } footer: {
                Text("Asks for a PIN\(lock.faceIDAvailable ? " or \(lock.biometryName)" : "") at launch and after five minutes away. Your PIN stays when a laptop is forgotten.")
            }
            if let paired = client.pairedConnection {
                Section {
                    LabeledContent("Key protection", value: protection(paired.protection))
                    LabeledContent("Key ID") { Text(paired.keyID).font(.footnote.monospaced()).textSelection(.enabled) }
                    LabeledContent("Paired", value: paired.pairedAt.formatted(date: .abbreviated, time: .shortened))
                    Text("Paired " + paired.pairedAt.formatted(.relative(presentation: .named))).font(.footnote).foregroundStyle(.secondary)
                    LabeledContent("Session", value: !client.isPreview && client.connection.isLive ? "Verified and sealed" : "No verified live session")
                    LabeledContent("Control", value: client.connection.isLive ? (client.seat?.control == true ? "Can control" : "Watching only") : "Unverified while disconnected")
                    Text("Laptop fingerprint").font(.subheadline)
                    Text(PairingView.grouped(paired.fingerprint)).font(.body.monospaced()).textSelection(.enabled)
                        .contextMenu { Button { UIPasteboard.general.string = paired.fingerprint } label: { Label("Copy fingerprint", systemImage: "doc.on.doc") } }
                } header: { Text("This iPhone") } footer: {
                    Text(paired.protection == .secureEnclave
                         ? "This identity uses the Secure Enclave. Compare the complete fingerprint with the laptop before trusting a changed connection."
                         : "This identity uses \(protection(paired.protection)). It does not have Secure Enclave protection. Compare the complete fingerprint with the laptop.")
                }
            }
            Section {
                ForEach(client.devices.devices) { device in
                    HStack {
                        Image(systemName: device.name.localizedCaseInsensitiveContains("iphone") ? "iphone" : device.name.localizedCaseInsensitiveContains("ipad") ? "ipad" : "desktopcomputer")
                            .foregroundStyle(.secondary).frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.name + (device.me ? " (this iPhone)" : ""))
                            Text(detail(device)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .swipeActions {
                        if !device.me, client.devices.mayManage, client.mayControl {
                            Button("Remove", role: .destructive) { removing = Removal(id: device.id, name: device.name, me: false) }
                                .disabled(removingNow)
                        }
                    }
                }
                if let paired = client.pairedConnection {
                    Button("Remove this iPhone from \(paired.laptopName)…", role: .destructive) {
                        removing = Removal(id: client.seat?.id ?? paired.deviceID, name: "this iPhone", me: true)
                    }.disabled(removingNow)
                    if !client.connection.isLive || removalError != nil {
                        Button("Forget on this iPhone only…", role: .destructive) { confirmLocalForget = true }.disabled(removingNow)
                    }
                }
                if removingNow { ProgressView("Waiting for removal confirmation…") }
                if let removalError { Text(removalError).foregroundStyle(Theme.needsYou) }
            } header: { Text("Paired devices") } footer: {
                if let refused = client.devices.refused { Text(refused) }
                Text("This iPhone can remove itself even while watch-only. Removing another device requires management permission. Local-only forgetting leaves the remote device record and push subscription on the laptop.")
            }
        }
        .navigationTitle("Security")
        .task { _ = await client.perform(.devices) }
        .sheet(item: Binding(get: { pinPurpose.map(PurposeBox.init) }, set: { pinPurpose = $0?.purpose })) { box in
            NavigationStack { PinSetupView(purpose: box.purpose) }
        }
        .confirmationDialog(removing?.me == true ? "Remove this iPhone from \(model.laptopName)?" : "Remove \(removing?.name ?? "this device")?",
                            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button(removing?.me == true ? "Remove this iPhone" : "Remove device", role: .destructive) {
                if let target = removing { Task { await remove(target) } }
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("It loses remote access and its push subscription. This iPhone's local pairing and saved drafts are deleted only after the laptop confirms self-removal. Your PIN and preferences stay.")
        }
        .confirmationDialog("Forget \(model.laptopName) on this iPhone only?", isPresented: $confirmLocalForget, titleVisibility: .visible) {
            Button("Forget locally", role: .destructive) { Task { _ = await model.forgetLocally() } }
        } message: {
            Text("The laptop has not confirmed removal. Its device record and remote notification subscription remain. Remove this iPhone from NikUI on the laptop when you can. Your local PIN and preferences stay.")
        }
    }

    private func remove(_ target: Removal) async {
        removing = nil; removingNow = true; removalError = nil
        defer { removingNow = false }
        let result = await client.perform(.forget(id: target.id))
        switch result {
        case .accepted:
            if target.me { _ = await model.forgetLocally() }
            else { _ = await client.perform(.devices) }
        case .notSent(let failure): removalError = failure.message
        case .ambiguous, .submitted:
            removalError = "Removal is unconfirmed. Check the device list on the laptop before retrying, or explicitly forget locally."
        case .local: removalError = "The laptop did not confirm removal."
        }
    }
    private func protection(_ value: KeyProtection) -> String {
        switch value {
        case .secureEnclave: "Secure Enclave"
        case .software: "Software key in ThisDeviceOnly Keychain"
        case .keychain: "ThisDeviceOnly Keychain"
        default: value.rawValue
        }
    }
    private func detail(_ device: DeviceRow) -> String {
        var parts = [device.control ? "Can control" : "Watching only"]
        if device.here { parts.append("connected now") }
        else if let seen = device.lastSeenAt { parts.append("seen " + seen.formatted(.relative(presentation: .named))) }
        return parts.joined(separator: " · ")
    }
    private struct PurposeBox: Identifiable {
        let purpose: PinSetupView.Purpose
        var id: String { "\(purpose)" }
    }
}

// MARK: Advanced

private struct AdvancedPane: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @State private var confirmForget = false
    @State private var forgetting = false

    var body: some View {
        Form {
            Section("Versions") {
                LabeledContent("NikUI for iPhone", value: Bundle.main.version)
                if let version = client.extensionVersion { LabeledContent("NikUI on the laptop", value: version) }
            }
            Section {
                Button("Copy diagnostics") {
                    UIPasteboard.general.string = client.diagnostics() + "\napp " + Bundle.main.version
                    model.show("Diagnostics copied. They hold no messages or keys.")
                }
            } footer: { Text("Connection details to paste into a bug report. No messages, code or keys.") }
            Section {
                Button("Pair with another laptop") { model.showPairing = true }
                Button(role: .destructive) { confirmForget = true } label: {
                    if forgetting { ProgressView() } else { Text("Forget this laptop locally…") }
                }
                .disabled(forgetting)
            } footer: { Text("Local-only forgetting removes this laptop's saved drafts, pairing, and signing key. It preserves your PIN and preferences. The laptop's device record and push subscription remain; use Remove this iPhone in Security to revoke them.") }
        }
        .navigationTitle("Advanced")
        .confirmationDialog("Forget \(client.pairedConnection?.laptopName ?? "this laptop")?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget laptop", role: .destructive) {
                forgetting = true
                Task {
                    let result = await model.forgetLocally()
                    forgetting = false
                    if case .notSent(let failure) = result { model.show(failure.message, .error) }
                    else { model.chatsPath = []; model.tab = .chats }
                }
            }
        } message: { Text("This only removes local data. The remote device record and push subscription remain until removed on the laptop. Your PIN and preferences stay. You will need a new pairing link.") }
    }
}

extension Bundle {
    var version: String {
        let short = infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}
