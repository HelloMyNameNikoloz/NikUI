import SwiftUI
import UIKit
import NikCore

// MARK: Tools

/// Model, effort, plan mode and the agent's own commands, as native controls.
/// Everything here is sent as the slash command the laptop already understands.
struct ToolsSheet: View {
    let conversationID: String
    let provider: Provider
    let find: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUndo = false
    @State private var goal = ""
    @State private var editingGoal = false
    @State private var running = false

    private var state: ConversationState { client.conversation(conversationID) }
    private var config: RenderConfiguration { state.configuration }
    private func has(_ name: String) -> Bool { config.slashCommands.contains(name) }

    var body: some View {
        NavigationStack {
            Form {
                Section("Agent") {
                    choice("model", title: "Model", symbol: "cpu", current: state.meta.model)
                    choice("effort", title: "Effort", symbol: "gauge.with.dots.needle.50percent", current: state.meta.effort)
                    if provider == .claude {
                        LabeledContent {
                            Text(permissionWords).foregroundStyle(.secondary)
                        } label: { Label("Permissions", systemImage: "lock.shield") }
                    }
                    if has("plan") {
                        Button { run("/plan") } label: {
                            Label(planOn ? "Leave plan mode" : "Plan first", systemImage: "list.bullet.clipboard")
                        }
                    }
                }
                .disabled(!client.mayControlConversation(conversationID))
                if provider == .codex {
                    Section {
                        if has("goal") {
                            Button { goal = state.meta.goal?.objective ?? ""; editingGoal = true } label: {
                                Label(state.meta.goal == nil ? "Set a goal" : "Change the goal", systemImage: "flag")
                            }
                            if let current = state.meta.goal {
                                if current.status == "paused" {
                                    Button { run("/goal resume") } label: { Label("Resume the goal", systemImage: "play") }
                                } else if current.status == "active" {
                                    Button { run("/goal pause") } label: { Label("Pause the goal", systemImage: "pause") }
                                }
                                if current.status == "active" || current.status == "paused" {
                                    Button { run("/goal done") } label: { Label("Mark the goal reached", systemImage: "checkmark.seal") }
                                }
                                Button(role: .destructive) { run("/goal clear") } label: { Label("Clear the goal", systemImage: "flag.slash") }
                            }
                        }
                        if has("review") { Button { run("/review") } label: { Label("Review changes", systemImage: "checklist") }.disabled(busy || externallyOwned) }
                        if has("fork") { Button { run("/fork") } label: { Label("Fork this chat", systemImage: "arrow.triangle.branch") } }
                        if has("undo") {
                            Button(role: .destructive) { confirmUndo = true } label: { Label("Undo last turn", systemImage: "arrow.uturn.backward") }.disabled(busy || externallyOwned)
                        }
                    } header: { Text("Codex") } footer: {
                        Text(externallyOwned ? "Review and Undo are unavailable while another app owns changes to this chat." : busy ? "Review and Undo wait until Codex finishes this turn. Steer from the + menu by the message field." : "Steer from the + menu by the message field while Codex is working.")
                    }
                    .disabled(!client.mayControlConversation(conversationID))
                }
                Section {
                    Button { dismiss(); find() } label: { Label("Find in chat", systemImage: "magnifyingglass") }
                    Button { dismiss(); model.follow(.report) } label: { Label("Status report", systemImage: "chart.bar.doc.horizontal") }
                    Button { dismiss(); model.push(.commands(conversationID)) } label: { Label("Commands and snippets", systemImage: "command") }
                    Button { dismiss(); model.push(.laptopSettings(conversationID)) } label: { Label("Laptop settings", systemImage: "gearshape.2") }
                }
                if !client.mayControlConversation(conversationID) {
                    Section { Text("Changes need a live chat connection and control from the laptop.").foregroundStyle(.secondary) }
                }
            }
            .disabled(running)
            .navigationTitle("Tools")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Undo the last turn?", isPresented: $confirmUndo, titleVisibility: .visible) {
                Button("Undo", role: .destructive) { run("/undo") }
            } message: { Text("Codex forgets its last turn. Files it changed on disk stay as they are.") }
            .alert("Goal", isPresented: $editingGoal) {
                TextField("What should Codex achieve?", text: $goal)
                Button("Set") { let g = goal.trimmingCharacters(in: .whitespacesAndNewlines); if !g.isEmpty { run("/goal " + g) } }
                Button("Cancel", role: .cancel) {}
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip(conversationID: conversationID) }
        .presentationDetents([.medium, .large])
    }

    private var externallyOwned: Bool { client.fleet.rows.first(where: { $0.id == conversationID })?.readOnly == true }
    private var busy: Bool { state.status == .working || state.status == .waiting }
    private var planOn: Bool { (state.meta.permissionMode ?? state.meta.mode ?? "") == "plan" }

    private var permissionWords: String {
        switch state.meta.permissionMode ?? "" {
        case "plan": "Plan only"
        case "acceptEdits": "Accept edits"
        case "bypassPermissions": "Ask nothing"
        case "default", "": "Ask each time"
        case let other: other
        }
    }

    @ViewBuilder
    private func choice(_ command: String, title: String, symbol: String, current: String?) -> some View {
        let options = config.commandArgs[command] ?? []
        if !options.isEmpty {
            Menu {
                ForEach(options) { option in
                    Button { run("/\(command) \(option.value)") } label: {
                        if option.value.lowercased() == current?.lowercased() { Label(option.label, systemImage: "checkmark") }
                        else { Text(option.label) }
                        if let detail = option.detail { Text(detail) }
                    }
                }
            } label: {
                LabeledContent {
                    Text(label(for: current, in: options)).foregroundStyle(.secondary)
                } label: { Label(title, systemImage: symbol).foregroundStyle(.primary) }
            }
        } else if let current {
            LabeledContent { Text(current).foregroundStyle(.secondary) } label: { Label(title, systemImage: symbol) }
        }
    }

    private func label(for value: String?, in options: [CommandOption]) -> String {
        guard let value else { return "Default" }
        return options.first { $0.value.lowercased() == value.lowercased() }?.label ?? value
    }

    /// Controls never replace or relabel the private composer draft.
    private func run(_ command: String) {
        guard client.mayControlConversation(conversationID), !running else {
            if !client.mayControlConversation(conversationID) { model.show("Changes need a live chat connection and control from the laptop.", .warning) }
            return
        }
        running = true
        Task {
            guard model.mayPresentContent else { running = false; return }
            let result = await client.sendControlCommand(command, conversationID: conversationID)
            model.report(result)
            running = false
            switch result {
            case .submitted, .accepted:
                Haptics.tap()
                dismiss()
            case .ambiguous, .notSent, .local:
                break
            }
        }
    }
}

// MARK: Queue

/// Messages waiting for the agent to finish its turn.
struct QueueSheet: View {
    let conversationID: String
    let provider: Provider
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var confirmClear = false
    @State private var editingWithImages: QueueEntry?
    @State private var expandedEntries: Set<String> = []

    private var state: ConversationState { client.conversation(conversationID) }

    var body: some View {
        NavigationStack {
            List {
                if let drainAt = state.drainAt, drainAt > .now {
                    Section {
                        Label {
                            Text("The next message sends \(Text(drainAt, style: .relative)) from now.")
                        } icon: { Image(systemName: "timer") }
                        .foregroundStyle(.secondary)
                    }
                }
                Section {
                    ForEach(Array(state.queue.enumerated()), id: \.element.id) { index, entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.text.isEmpty ? "Images only" : entry.text).lineLimit(expandedEntries.contains(entry.id) ? nil : 4)
                            if entry.text.count > 180 || entry.text.filter({ $0 == "\n" }).count > 3 {
                                Button(expandedEntries.contains(entry.id) ? "Show less" : "Show full message") {
                                    if expandedEntries.contains(entry.id) { expandedEntries.remove(entry.id) } else { expandedEntries.insert(entry.id) }
                                }.font(.footnote).frame(minHeight: 44)
                            }
                            if entry.images > 0 || entry.lostImages > 0 {
                                HStack(spacing: 10) {
                                    if entry.images > 0 { Label("\(entry.images)", systemImage: "photo").accessibilityLabel("\(entry.images) images") }
                                    if entry.lostImages > 0 {
                                        Label("\(entry.lostImages) image\(entry.lostImages == 1 ? "" : "s") lost", systemImage: "exclamationmark.triangle")
                                            .foregroundStyle(Theme.working)
                                    }
                                }
                                .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { act(.unqueue(entry.id)) } label: { Label("Remove", systemImage: "trash") }.disabled(!client.mayControlConversation(conversationID))
                            Button { edit(entry) } label: { Label("Edit", systemImage: "pencil") }.tint(.blue).disabled(!client.mayControlConversation(conversationID))
                        }
                        .swipeActions(edge: .leading) {
                            if index > 0 {
                                Button { act(.promoteQueued(entry.id)) } label: { Label(promoteTitle, systemImage: "arrow.up.to.line") }.tint(Theme.accent).disabled(!client.mayControlConversation(conversationID))
                            }
                        }
                        .contextMenu {
                            if index > 0 { Button { act(.promoteQueued(entry.id)) } label: { Label(promoteTitle, systemImage: "arrow.up.to.line") }.disabled(!client.mayControlConversation(conversationID)) }
                            Button { edit(entry) } label: { Label("Edit", systemImage: "pencil") }.disabled(!client.mayControlConversation(conversationID))
                            Button(role: .destructive) { act(.unqueue(entry.id)) } label: { Label("Remove", systemImage: "trash") }.disabled(!client.mayControlConversation(conversationID))
                        }
                    }
                } footer: {
                    Text("Queued messages send in order when \(provider.name) finishes. Swipe to edit, remove or send one next.")
                }
            }
            .overlay {
                if state.queue.isEmpty {
                    EmptyState(title: "Nothing queued", symbol: "tray", message: "Messages you send while the agent works wait here.")
                }
            }
            .navigationTitle("Queued")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Clear", role: .destructive) { confirmClear = true }.disabled(state.queue.isEmpty || !client.mayControlConversation(conversationID))
                }
            }
            .confirmationDialog("Edit this message?", isPresented: Binding(get: { editingWithImages != nil }, set: { if !$0 { editingWithImages = nil } }), titleVisibility: .visible, presenting: editingWithImages) { entry in
                Button("Edit text, drop images") { reclaim(entry) }
            } message: { entry in
                Text("Only the text comes back to the field. The \(entry.images == 1 ? "image" : "\(entry.images) images") attached to it will be dropped.")
            }
            .confirmationDialog("Remove all queued messages?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear queue", role: .destructive) { act(.clearQueue) }
            }
            .onChange(of: state.queue.isEmpty) { _, empty in if empty { dismiss() } }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip(conversationID: conversationID) }
        .presentationDetents([.medium, .large])
    }

    /// Promoting a queued message while Codex works steers it into the current turn.
    private var promoteTitle: String {
        provider == .codex && (state.status == .working || state.status == .waiting) ? "Steer into this turn" : "Send next"
    }

    private func act(_ action: ClientAction) {
        Task { if case .notSent = await model.run(action, on: .conversation(conversationID)) { return }; Haptics.tap() }
    }

    /// Takes the message out of the queue; the laptop sends its text back and the
    /// core puts it in the field, so nothing is copied here (that would double it).
    private func edit(_ entry: QueueEntry) {
        if entry.images > 0 { editingWithImages = entry; return }
        reclaim(entry)
    }

    private func reclaim(_ entry: QueueEntry) {
        Task {
            let result = await model.run(.editQueued(entry.id), on: .conversation(conversationID))
            if case .notSent = result { return }
            // Close once the laptop has handed the text back (the entry leaves the queue).
            for _ in 0..<40 where client.conversation(conversationID).queue.contains(where: { $0.id == entry.id }) {
                try? await Task.sleep(for: .milliseconds(150))
            }
            if client.conversation(conversationID).queue.contains(where: { $0.id == entry.id }) {
                model.show("The laptop has not handed that message back yet. Check the queue again.", .warning)
            } else {
                dismiss()
            }
        }
    }
}

// MARK: Info

/// Everything about the run at a glance: tokens, context, cost, shells, CI, who is here.
struct ConversationInfoSheet: View {
    let conversationID: String
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.dismiss) private var dismiss

    private var state: ConversationState { client.conversation(conversationID) }
    private var stats: Stats { state.stats }
    private var provider: Provider { state.meta.provider }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Agent", value: provider.name)
                    if let model = state.meta.model { LabeledContent("Model", value: model) }
                    if let effort = state.meta.effort { LabeledContent("Effort", value: effort) }
                    LabeledContent("Status", value: state.status.words)
                    if !state.meta.cwd.isEmpty {
                        LabeledContent("Folder") {
                            Text(Format.shortPath(state.meta.cwd, home: state.meta.home)).lineLimit(1).truncationMode(.middle)
                        }
                        .contextMenu { Button { UIPasteboard.general.string = state.meta.cwd } label: { Label("Copy path", systemImage: "doc.on.doc") } }
                    }
                    if let ticket = state.meta.ticket { LabeledContent("Ticket", value: ticket) }
                    if let goal = state.meta.goal {
                        LabeledContent("Goal") { Text(goal.objective).multilineTextAlignment(.trailing) }
                    }
                }

                if let window = stats.contextWindow, window > 0, let used = stats.contextTokens {
                    Section("Context") {
                        let fraction = min(1, Double(used) / Double(window))
                        Gauge(value: fraction) {
                            Text("\(Format.tokens(used)) of \(Format.tokens(window)) tokens")
                        } currentValueLabel: { Text(Format.percent(fraction)) }
                        .tint(fraction > 0.85 ? Theme.needsYou : fraction > 0.6 ? Theme.working : Theme.done)
                    }
                }

                Section("This chat") {
                    LabeledContent("Turns", value: stats.turns.formatted())
                    if stats.elapsedMs > 0 { LabeledContent("Working time", value: Format.duration(ms: stats.elapsedMs)) }
                    LabeledContent("Tokens in", value: Format.tokens(stats.input))
                    LabeledContent("Tokens out", value: Format.tokens(stats.output))
                    if stats.cacheRead > 0 { LabeledContent("Read from cache", value: Format.tokens(stats.cacheRead)) }
                    if provider == .claude, let cost = stats.cost ?? state.meta.cost, cost > 0 {
                        LabeledContent("Cost", value: Format.cost(cost))
                    }
                    if let at = state.statsReceivedAt {
                        Text("Updated \(at, style: .relative) ago").font(.footnote).foregroundStyle(.secondary)
                    }
                }

                if !stats.shellList.isEmpty {
                    Section("Background shells") {
                        ForEach(stats.shellList) { shell in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(shell.command).font(.callout.monospaced()).lineLimit(2)
                                    if let started = shell.startedAt {
                                        Text("Started \(started, style: .relative) ago").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if shell.stopping { ProgressView() }
                                else {
                                    Button("Stop", role: .destructive) {
                                        Task { _ = await model.run(.stopTask(shell.id), on: .conversation(conversationID)) }
                                    }
                                    .buttonStyle(.bordered).controlSize(.large)
                                    .disabled(!client.mayControlConversation(conversationID))
                                }
                            }
                        }
                    }
                }

                if let ci = stats.ci { CISection(ci: ci) }

                if !state.presence.isEmpty {
                    Section("Also here") {
                        ForEach(state.presence) { person in
                            Label {
                                HStack {
                                    Text(person.name.isEmpty ? person.kind.capitalized : person.name)
                                    Spacer()
                                    Text(person.control ? "Can control" : "Watching").font(.footnote).foregroundStyle(.secondary)
                                }
                            } icon: { Image(systemName: person.kind == "phone" ? "iphone" : person.kind == "web" ? "safari" : "laptopcomputer") }
                        }
                    }
                }
            }
            .navigationTitle(state.meta.label.isEmpty ? "Chat" : state.meta.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip(conversationID: conversationID) }
        .presentationDetents([.medium, .large])
    }
}

private struct CISection: View {
    let ci: CIState
    var body: some View {
        Section("Checks") {
            HStack {
                Label(title, systemImage: symbol).foregroundStyle(color)
                Spacer()
                if let done = ci.done, let total = ci.total, total > 0 {
                    Text("\(done) of \(total)").monospacedDigit().foregroundStyle(.secondary)
                }
            }
            if !ci.finished, let total = ci.total, total > 0 {
                ProgressView(value: Double(ci.done ?? 0), total: Double(total))
            }
            ForEach(ci.failing, id: \.self) { name in
                Label(name, systemImage: "xmark.circle").foregroundStyle(Theme.needsYou).font(.callout)
            }
            if let message = ci.message, !message.isEmpty { Text(message).font(.footnote).foregroundStyle(.secondary) }
            if let link = ci.url, let url = URL(string: link) { Link("Open on GitHub", destination: url) }
        }
    }
    private var title: String {
        if !ci.failing.isEmpty { return "Failing" }
        if ci.finished { return "Passed" }
        return ci.phase.isEmpty ? "Running" : ci.phase.capitalized
    }
    private var symbol: String { !ci.failing.isEmpty ? "xmark.octagon" : ci.finished ? "checkmark.seal" : "clock" }
    private var color: Color { !ci.failing.isEmpty ? Theme.needsYou : ci.finished ? Theme.done : .secondary }
}
