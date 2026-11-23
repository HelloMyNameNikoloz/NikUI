import SwiftUI
import AppKit
import NikCore
import NikMenuCore
import NikMacIdentity
import NikMacCore
import UniformTypeIdentifiers
import ServiceManagement

struct MacMainWindow: View {
    @ObservedObject var model: MenuViewModel
    @Bindable var session: MacAppSession
    let selection: AppSelection
    @Bindable var cutover: MacCutoverCoordinator
    @SceneStorage("nikui.window.token") private var windowToken = UUID().uuidString
    @State private var window = MacWindowModel()
    @State private var review: SetupReview?
    @State private var search = ""
    @State private var inspector = false
    @State private var importingImages = false
    @State private var imageTarget: String?
    @FocusState private var findFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openWindow) private var openWindow
    private var projects: [Project] {
        let fleet = session.client?.fleet ?? model.snapshot?.fleet ?? Fleet()
        var result = fleet.projects
        for row in fleet.rows where !row.cwd.isEmpty && !result.contains(where: { $0.path == row.cwd }) {
            result.append(Project(.object(["path": .string(row.cwd), "name": .string(URL(fileURLWithPath: row.cwd).lastPathComponent)])))
        }
        return result.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private var rows: [FleetRow] {
        (session.client?.fleet.rows ?? []).filter { row in
            (window.project == nil || row.cwd == window.project) && (search.isEmpty || (row.label + " " + row.provider.rawValue).localizedCaseInsensitiveContains(search))
        }.sorted { ($0.activeAt ?? 0) > ($1.activeAt ?? 0) }
    }
    var body: some View {
        NavigationSplitView {
            List(selection: $window.project) {
                Label("All Projects", systemImage: "square.grid.2x2").tag(Optional<String>.none)
                Section("Projects") {
                    ForEach(projects) { project in Label(project.name, systemImage: "folder").tag(Optional(project.path)) }
                }
            }
            .listStyle(.sidebar).navigationTitle(selection.flavour.appName)
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 300)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 8) {
                    Image(systemName: model.state.glyph.symbol)
                    Text(session.client?.connection.isLive == true ? "Connected · sealed" : model.state.label)
                    Spacer()
                }.font(.caption).foregroundStyle(.secondary).padding(16)
            }
        } content: {
            List(selection: Binding(get: { window.conversationID }, set: { id in
                if let client = session.client { Task { await window.select(id, client: client) } }
            })) {
                Section("Conversations") {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(row.label.isEmpty ? "Untitled" : row.label).lineLimit(2)
                            Label(providerState(row), systemImage: row.provider == .codex ? "terminal" : "bubble.left")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag(Optional(row.id))
                    }
                }
                Section("History") {
                    ForEach(window.history.filter { search.isEmpty || $0.label.localizedCaseInsensitiveContains(search) }) { entry in
                        Button { Task { await window.resume(entry, session: session) } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.label.isEmpty ? "Untitled conversation" : entry.label).lineLimit(2)
                                Text("\(entry.provider == .codex ? "Codex" : "Claude") · Resume…").font(.caption).foregroundStyle(.secondary)
                            }
                        }.buttonStyle(.plain)
                    }
                    if window.historyHasMore {
                        Button("Load More History") { Task { await window.loadHistory(session.management) } }
                            .disabled(window.loadingHistory || session.client == nil)
                    }
                }
            }
            .searchable(text: $search, prompt: "Find a conversation")
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
            .navigationTitle("Conversations")
            .task(id: (session.generation ?? "") + ":" + (window.project ?? "")) { if session.client != nil { await window.loadHistory(session.management, reset: true) } }
        } detail: {
            if let client = session.client, let id = window.conversationID {
                conversation(client, id: id)
            } else { setup }
        }
        .frame(minWidth: 960, minHeight: 620)
        .background(NotificationWindowCapture { native in
            window.restoreToken(windowToken)
            session.openNotificationWindow = { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }
            session.registerNotificationWindow(window, native: native)
        }.frame(width: 0, height: 0))
        .focusedSceneValue(\.nikWindowActions, MacWindowActions(find: { window.find.visible = true; findFocused = true },
            next: { window.find.move(1) }, previous: { window.find.move(-1) }))
        .sheet(item: $review) { kind in CutoverReview(coordinator: cutover, session: session, model: model, kind: kind) }
        .task {
            window.restoreToken(windowToken)
            await session.connect(explicit: false)
            if selection.flavour == .production && session.client == nil { review = .cutover }
            await MacNativeE2E.runIfRequested(window: window, session: session)
            await MacNativeCutover.runIfRequested(window: window, session: session, coordinator: cutover)
        }
        .onChange(of: model.snapshot?.status.generation) { _, value in Task { await session.engineChanged(value) } }
        .task(id: session.generation) {
            if window.conversationID == nil, let client = session.client,
               let id = client.viewSessions[window.token]?.lastConversationID { await window.select(id, client: client) }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { Task { await session.client?.flushPersistence() } } }
        .onDisappear { session.unregisterNotificationWindow(window.token); Task { await window.close(client: session.client) } }
    }
    private func providerState(_ row: FleetRow) -> String {
        [row.provider == .codex ? "Codex" : "Claude", row.readOnly ? "Read only" : row.asleep ? "Asleep" : row.status.rawValue.capitalized].joined(separator: " · ")
    }
    private var setup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text(selection.flavour.appName).font(.system(size: 36, weight: .semibold, design: .rounded))
                Text("A quiet place for your work.").font(.title3).foregroundStyle(.secondary)
                GroupBox {
                    VStack(alignment: .leading, spacing: 16) {
                        Label(model.state.connected ? "Your engine is ready" : "Make yourself at home", systemImage: "sparkle").font(.headline)
                        Text(selection.flavour == .development
                             ? "Connect this Mac to its development engine to read and continue your conversations. Your projects and both providers appear together."
                             : "Review the source and any work in progress before moving your conversations to the NikUI engine.")
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            if selection.flavour == .development {
                                if !model.state.connected {
                                    Button("Start Development Engine") { Task { await model.startEngine() } }
                                        .disabled(model.working)
                                }
                                Button(session.connecting ? "Connecting…" : "Connect This Mac") { Task { await session.connect() } }
                                    .buttonStyle(.borderedProminent).disabled(!model.state.connected || session.connecting)
                            } else {
                                Button("Review Cutover…") { review = .cutover }.buttonStyle(.borderedProminent)
                            }
                            Button("Review Rollback…") { review = .rollback }
                        }
                        Text("Quitting NikUI leaves the engine running.").font(.caption).foregroundStyle(.secondary)
                    }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                }
                if session.client != nil { Text("Choose a conversation to begin.").foregroundStyle(.secondary) }
                if let client = session.client {
                    let saved = client.viewSessions.sorted { $0.key < $1.key }.filter { $0.value.conversationID == nil }
                    ForEach(saved, id: \.key) { token, view in
                        ForEach(view.drafts.keys.sorted(), id: \.self) { id in
                            if let draft = view.drafts[id], !draft.text.isEmpty || !draft.attachments.isEmpty {
                                Button {
                                    Task {
                                        await window.restoreDraft(windowToken: token, conversationID: id, client: client)
                                        windowToken = window.token
                                    }
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Label("Restore saved draft · \(id)", systemImage: "doc.text")
                                        Text(draft.text.isEmpty ? "\(draft.attachments.count) retained images" : draft.text).lineLimit(2).font(.caption).foregroundStyle(.secondary)
                                    }
                                }.buttonStyle(.bordered)
                            }
                        }
                    }
                }
                if let problem = session.problem ?? window.problem ?? session.client?.lastFailure?.message ?? model.state.problem { problemView(problem) }
            }.frame(maxWidth: 660, alignment: .leading).padding(40).frame(maxWidth: .infinity)
        }
        .navigationTitle("Workspace")
        .toolbar { ToolbarItem { SettingsLink { Label("Settings", systemImage: "gearshape") } } }
    }
    private func conversation(_ client: NikClient, id: String) -> some View {
        let state = client.conversation(id)
        let draft = client.viewDraft(window.token, conversationID: id)
        let busy = state.status == .working || state.status == .waiting
        let canControl = client.mayControl && state.connection.isLive && state.controlSnapshotFresh
        let unresolved = client.pendingIntents.values.contains { $0.viewToken == window.token && $0.target == "session:" + id && $0.draft?.compositionID == draft.compositionID && ($0.state == .pending || $0.isQuarantined) }
        let stop = window.capture(.stop, client: client)
        let steer = window.capture(.steer, client: client)
        return VStack(spacing: 0) {
            if window.find.visible {
                HStack {
                    TextField("Find in loaded transcript", text: Binding(get: { window.find.query }, set: { window.find.query = String($0.prefix(300)) }))
                        .textFieldStyle(.roundedBorder).focused($findFocused)
                        .onSubmit { window.find.move(1) }
                    Text(window.find.count == 0 ? "No matches" : "\(window.find.index + 1) of \(window.find.count)\(window.find.limited ? "+" : "")").font(.caption).monospacedDigit()
                    Button { window.find.move(-1) } label: { Image(systemName: "chevron.up").accessibilityLabel("Previous match") }
                    Button { window.find.move(1) } label: { Image(systemName: "chevron.down").accessibilityLabel("Next match") }
                    Button("Done") { window.find.visible = false }.keyboardShortcut(.cancelAction)
                }.padding(10)
                Text(state.dropped > 0 ? "Loaded transcript only · \(state.dropped) earlier items are outside this window" : "Searches the loaded transcript")
                    .font(.caption).foregroundStyle(.secondary).padding(.bottom, 6)
                Divider()
            }
            MacTranscript(state: state, reading: client.viewSessions[window.token]?.reading[id] ?? ReadingState(), find: window.find, onReading: { reading in
                client.setViewReading(reading, forView: window.token, conversationID: id)
            }, onRendered: { conversation, ids, streaming in session.recordRender(conversationID: conversation, itemIDs: ids, streamingIDs: streaming) })
            if !state.permissions.isEmpty || state.activeQuestion != nil {
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(state.permissions) { item in
                            if let control = window.capture(.approval, client: client, item: item) {
                                ApprovalCard(item: item, pending: window.consumed(control, client: client)) { allow in
                                    Task { await window.act(control, client: client, allow: allow) }
                                }
                            }
                        }
                        if let question = state.items.last(where: { $0.answerTo == state.activeQuestion && $0.answerTo != nil }),
                           let control = window.capture(.question, client: client, item: question) {
                            QuestionCard(item: question, pending: window.consumed(control, client: client)) { answer in
                                Task { await window.act(control, client: client, answer: answer) }
                            }.id(control.identity)
                        }
                    }.padding(14).disabled(!canControl)
                }.frame(maxHeight: 240).background(.bar)
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                if let problem = window.problem ?? session.problem ?? client.lastFailure?.message { problemView(problem) }
                if !draft.attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(Array(draft.attachments.enumerated()), id: \.offset) { index, image in
                                VStack {
                                    if let bytes = Data(base64Encoded: image.data), let preview = NSImage(data: bytes) {
                                        Image(nsImage: preview).resizable().scaledToFit().frame(width: 64, height: 48)
                                    }
                                    Button("Remove image \(index + 1)") { window.removeAttachment(index, client: client) }.font(.caption)
                                }.accessibilityLabel(image.name)
                            }
                        }
                    }
                }
                NativeComposer(text: Binding(get: { window.text(client) }, set: { window.edit($0, client: client) }), enabled: true,
                    attach: { sources in Task { await window.attach(sources, to: id, client: client) } }, attachmentProblem: { window.problem = $0 }) {
                    guard canControl, !unresolved, !window.submitting, state.activeQuestion == nil else { return }
                    Task { await window.send(client: client) }
                }.frame(minHeight: 90, idealHeight: 110, maxHeight: 180)
                    .clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator))
                HStack {
                    Button { imageTarget = id; importingImages = true } label: { Label("Attach Images…", systemImage: "paperclip") }
                        .disabled(draft.attachments.count >= 6)
                    Text(state.meta.provider == .codex ? "Codex" : "Claude").font(.caption.weight(.medium))
                    if let model = state.meta.model { Text(model).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    if busy, state.meta.provider == .codex, state.configuration.slashCommands.contains("steer"), let steer {
                        Button("Steer") { Task { await window.send(client: client, steer: steer) } }
                            .disabled(!canControl || unresolved || window.submitting || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    Button(busy ? "Queue" : "Send") { Task { await window.send(client: client) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canControl || unresolved || window.submitting || state.activeQuestion != nil || draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.attachments.isEmpty)
                }
                HStack {
                    Text(unresolved ? "Awaiting the original receipt · draft retained" : "⌘ Return to send · Return for a new line")
                    Spacer()
                    if !canControl { Text(state.connection.isLive ? "Read only" : "Connecting…") }
                }.font(.caption2).foregroundStyle(.secondary)
            }.padding(16)
        }
        .navigationTitle(state.meta.label.isEmpty ? "Conversation" : state.meta.label)
        .fileImporter(isPresented: $importingImages, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            guard let target = imageTarget else { return }; imageTarget = nil
            switch result {
            case .success(let urls): Task { await window.attach(urls.map(MacImageSource.file), to: target, client: client) }
            case .failure: window.problem = "IMAGE_PICKER_UNAVAILABLE"
            }
        }
        .onChange(of: window.find.query) { _, query in
            var reading = client.viewSessions[window.token]?.reading[id] ?? ReadingState(); reading.findQuery = query
            client.setViewReading(reading, forView: window.token, conversationID: id)
        }
        .navigationSubtitle("\(state.meta.provider == .codex ? "Codex" : "Claude") · \(state.status.rawValue.capitalized)")
        .toolbar {
            ToolbarItem {
                Menu {
                    Button("Open in Editor") { Task { await window.openInEditor(id, client: client) } }
                        .keyboardShortcut("o", modifiers: [.command, .shift]).disabled(!canControl)
                    Button("Reveal in Finder") {
                        do { NSWorkspace.shared.activateFileViewerSelecting([try MacLocalResource.directory(state.meta.cwd)]) }
                        catch { window.problem = MacAppSession.code(error) }
                    }
                    Button("Open Terminal") {
                        do {
                            let resource = try MacLocalResource.directory(state.meta.cwd)
                            guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { throw IdentityFailure("TERMINAL_UNAVAILABLE") }
                            NSWorkspace.shared.open([resource], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                                if error != nil { Task { @MainActor in window.problem = "TERMINAL_HANDOFF_FAILED" } }
                            }
                        } catch { window.problem = MacAppSession.code(error) }
                    }
                } label: { Label("Project", systemImage: "folder") }
            }
            ToolbarItem {
                Button { inspector.toggle() } label: { Label("Queue", systemImage: "sidebar.right") }
            }
            ToolbarItem {
                Button("Stop", systemImage: "stop.fill") {
                    if let stop { Task { await window.act(stop, client: client) } }
                }.keyboardShortcut(".", modifiers: .command).disabled(!canControl || !busy || stop?.run?.turn == nil)
            }
        }
        .inspector(isPresented: $inspector) { QueueInspector(state: state, client: client, window: window).inspectorColumnWidth(min: 260, ideal: 320, max: 440) }
    }
    private func problemView(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
    }
}

private struct ApprovalCard: View {
    let item: TranscriptItem
    let pending: Bool
    let answer: (Bool) -> Void
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Label("Allow \(item.name)?", systemImage: "hand.raised").font(.headline)
                Text(item.input.text).font(.system(.callout, design: .monospaced)).textSelection(.enabled).lineLimit(8)
                HStack {
                    Text(pending ? "Answer submitted" : "Needs your approval").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Deny") { answer(false) }
                    Button("Allow") { answer(true) }.buttonStyle(.borderedProminent)
                }.disabled(pending)
            }.padding(10)
        }
    }
}
private struct QuestionCard: View {
    let item: TranscriptItem
    let pending: Bool
    let answer: (String) -> Void
    @State private var text = ""
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Label("A question for you", systemImage: "questionmark.bubble").font(.headline)
                Text(item.text).textSelection(.enabled)
                TextField("Your answer", text: $text, axis: .vertical).textFieldStyle(.roundedBorder)
                HStack { Spacer(); Button(pending ? "Answer submitted" : "Answer") { answer(text) }.buttonStyle(.borderedProminent)
                    .disabled(pending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }.padding(10)
        }
    }
}
private struct QueueInspector: View {
    let state: ConversationState
    let client: NikClient
    let window: MacWindowModel
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Queue").font(.title2.weight(.semibold))
                if let date = state.drainAt { Text("Scheduled \(date, style: .relative)").font(.caption).foregroundStyle(.secondary) }
                if state.visibleQueue.isEmpty { Text("No queued messages").foregroundStyle(.secondary) }
                ForEach(Array(state.visibleQueue.enumerated()), id: \.element.id) { index, row in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(index + 1) · \(row.raw["state"].stringValue ?? "Queued")").font(.caption.weight(.medium))
                        Text(row.text).textSelection(.enabled)
                        if row.images > 0 { Text("\(row.images) retained images").font(.caption) }
                        DisclosureGroup("Full payload") { Text(row.raw.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                        HStack {
                            if row.raw["actions"].arrayValue.contains(.string("promoteQueued")), let control = window.capture(.promote, client: client, queue: row) {
                                Button("Send Next") { Task { await window.act(control, client: client) } }
                            }
                            if row.raw["actions"].arrayValue.contains(.string("unqueue")), let control = window.capture(.unqueue, client: client, queue: row) {
                                Button("Remove") { Task { await window.act(control, client: client) } }
                            }
                        }
                        Divider()
                    }
                }
                ForEach(client.pendingIntents.values.filter { $0.target == "session:" + state.id && $0.isQuarantined }.sorted { $0.localOrder < $1.localOrder }) { intent in
                    Label("Unresolved delivery · \(intent.mid.prefix(8))", systemImage: "exclamationmark.circle").font(.caption)
                    Text(intent.draft?.text ?? "Retained operation").textSelection(.enabled)
                }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private enum SetupReview: String, Identifiable { case cutover, rollback; var id: String { rawValue } }
private struct CutoverReview: View {
    @Bindable var coordinator: MacCutoverCoordinator
    let session: MacAppSession
    @ObservedObject var model: MenuViewModel
    let kind: SetupReview
    @Environment(\.dismiss) private var dismiss
    @State private var profile: String?
    @State private var forgottenReturn: JSONValue?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Label(kind == .cutover ? "Move to the NikUI engine" : "Return to the editor engine",
                  systemImage: "arrow.triangle.branch").font(.title2.weight(.semibold))
            Text(kind == .cutover
                 ? "Your existing work must be saved and every source window accounted for before NikUI can take ownership."
                 : "Rollback needs the engine’s current state, including work completed since cutover.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if kind == .cutover {
                let choices = Array(Set(coordinator.review["sources"].arrayValue.compactMap { $0["profile"].stringValue })).sorted()
                if choices.count > 1 {
                    Picker("Editor profile", selection: $profile) {
                        Text("Choose a profile…").tag(Optional<String>.none)
                        ForEach(choices, id: \.self) { value in
                            Text(coordinator.review["sources"].arrayValue.filter { $0["profile"].stringValue == value }
                                .compactMap { $0["workspace"].stringValue.map { URL(fileURLWithPath: $0).lastPathComponent } }.joined(separator: ", "))
                                .tag(Optional(value))
                        }
                    }.onChange(of: profile) { _, value in Task { await coordinator.refresh(profile: value) } }
                }
            }
            if let fingerprint = coordinator.review["fingerprint"].stringValue {
                LabeledContent("Host", value: fingerprint).font(.caption.monospaced())
                Text("\(coordinator.review["windows"].intValue ?? 0) source windows · \(coordinator.review["conversations"].intValue ?? 0) conversations · \(coordinator.review["queues"].intValue ?? 0) queued inputs")
                    .font(.callout)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(coordinator.review["sources"].arrayValue, id: \.self) { source in
                        Text(source["workspace"].stringValue ?? "Editor window").font(.callout)
                        if source["mode"].stringValue == "reloading" || source["blockers"].arrayValue.contains(.string("SOURCE_RELOADING")) {
                            Text("Reload window “\(source["workspace"].stringValue ?? "Editor window")” in VS Code, then refresh this review.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                        Text((source["install"].stringValue ?? "") + " · " + (source["sourceVersion"].stringValue ?? source["build"].stringValue ?? ""))
                            .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 160)
            Text("The engine runs independently at login. Your editor profile and its backup remain available. Open at Login for this window is a separate setting.")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(coordinator.review["warnings"].arrayValue + coordinator.review["sources"].arrayValue.flatMap { $0["warnings"].arrayValue }, id: \.self) { warning in
                Label(warning["message"].stringValue ?? "Phone route was not transferred.", systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange)
            }
            ForEach(coordinator.blockers, id: \.self) { code in
                VStack(alignment: .leading, spacing: 4) {
                    Label(explanation(code), systemImage: "exclamationmark.circle")
                    if code.hasPrefix("KEEPER_RESCUE_SUPERVISION_") {
                        Button("Retry Custody") { Task { await coordinator.retryCustody() } }.disabled(coordinator.working)
                    }
                    if code == "ROUTE_OWNER_MISMATCH" {
                        ForEach(coordinator.review["sources"].arrayValue.filter { source in
                            source["blockerDetails"].arrayValue.contains { $0["action"].stringValue == "record-phone-route" }
                        }, id: \.self) { source in
                            Button("Record this window’s phone route") {
                                Task { await coordinator.recordPhoneRoute(sourceID: source["id"].stringValue ?? "") }
                            }.disabled(coordinator.working)
                        }
                    }
                    if code == "PORT_IN_USE" {
                        let port = coordinator.review["listener"]["port"].intValue ?? 4517
                        Text("Port \(port) is occupied.").font(.callout)
                        ForEach(coordinator.review["listener"]["holders"].arrayValue, id: \.self) { holder in
                            Text("PID \(holder["pid"].intValue ?? 0) · \(holder["command"].stringValue ?? "Unknown process")")
                                .font(.caption).textSelection(.enabled)
                        }
                    }
                    if code == "PENDING_FOLDER_RETURNS" {
                        ForEach(coordinator.review["pendingReturns"].arrayValue, id: \.self) { saved in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(saved["workspace"].stringValue ?? "Saved folder").font(.caption).textSelection(.enabled)
                                if saved["missing"].boolValue == true { Text("Folder or workspace is missing.").font(.caption).foregroundStyle(.secondary) }
                                Button("Forget This Folder’s Return…") { forgottenReturn = saved }.disabled(coordinator.working)
                            }
                        }
                    }
                    Text(code).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if let problem = coordinator.problem {
                if problem == "SOURCE_RETURN_TARGET_REQUIRED" { Text(explanation(problem)).foregroundStyle(.secondary) }
                Text(problem).font(.caption.monospaced()).foregroundStyle(.red).textSelection(.enabled)
            }
            if let recovery = coordinator.recoveryProblem {
                Text("Recovery: " + recovery).font(.caption.monospaced()).foregroundStyle(.red).textSelection(.enabled)
            }
            if coordinator.problem == "SERVICE_REQUIRES_APPROVAL" {
                Button("Open Login Items Settings…") { SMAppService.openSystemSettingsLoginItems() }
            }
            if coordinator.working { ProgressView(coordinator.stage) }
            HStack {
                Spacer()
                Button("Not Now") { dismiss() }.keyboardShortcut(.cancelAction)
                if coordinator.working { Button("Cancel Operation") { Task { await coordinator.cancelOperation() } } }
                Button("Refresh") { Task { await coordinator.refresh(rollback: kind == .rollback) } }.disabled(coordinator.working)
                Button("Restore VS Code") { Task { await coordinator.restoreVSCode(); model.refreshRegistration() } }
                    .disabled(coordinator.working)
                Button(kind == .cutover ? "Move NikUI to the Mac app" : "Hand back to VS Code") { Task {
                    if kind == .cutover {
                        await coordinator.move {
                            try await session.connectAfterEngineStarts()
                        }
                        if coordinator.stage == "ready" { model.startMonitoring(); dismiss() }
                    } else { await coordinator.handBack(); model.refreshRegistration() }
                } }
                    .disabled(kind == .cutover ? !coordinator.mayMove : coordinator.working || !coordinator.blockers.isEmpty)
                    .keyboardShortcut(.defaultAction)
            }
        }.padding(28).frame(width: 600)
            .task { await coordinator.refresh(rollback: kind == .rollback) }
            .alert("Forget this folder’s saved return?", isPresented: Binding(get: { forgottenReturn != nil }, set: { if !$0 { forgottenReturn = nil } })) {
                Button("Cancel", role: .cancel) { forgottenReturn = nil }
                Button("Save Archive and Forget", role: .destructive) {
                    if let saved = forgottenReturn { Task { await coordinator.forgetReturn(saved) } }
                    forgottenReturn = nil
                }
            } message: {
                Text((forgottenReturn?["workspace"].stringValue ?? "") + "\nCurrent editor work will be kept. The saved return will be removed from automatic recovery after an encrypted archive is saved in the editor profile.")
            }
    }
    private func explanation(_ code: String) -> String {
        CutoverBlockerText.message(code, review: coordinator.review)
    }
}
