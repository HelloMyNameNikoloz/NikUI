import SwiftUI
import Observation
import NikCore

/// Slash commands and snippets: see what each does, edit, add, remove, restore.
struct CommandsView: View {
    let conversationID: String
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @State private var editing: Editing?
    @State private var search = ""
    @State private var removing: CommandDescription?

    private var snapshot: CommandsSnapshot { client.conversation(conversationID).commands }
    private var mayChange: Bool { snapshot.mayChange && client.mayControlConversation(conversationID) }

    private var shown: [CommandDescription] {
        let q = search.trimmingCharacters(in: .whitespaces)
        let all = snapshot.commands.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        return q.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(q) || $0.description.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        List {
            ForEach(kinds, id: \.self) { kind in
                Section(title(kind)) {
                    ForEach(shown.filter { $0.kind == kind }) { command in
                        Button { editing = Editing(command: command, draft: model.commandEdit(conversationID: conversationID, command: command)) } label: { CommandRow(command: command) }
                            .foregroundStyle(.primary)
                            .swipeActions {
                                if mayChange && !command.off {
                                    Button(command.shipped ? "Turn Off" : "Remove", role: .destructive) { removing = command }
                                }
                                if mayChange && command.shipped && (command.edited || command.off) {
                                    Button("Restore") { act(.restoreCommand(command.name)) }.tint(Theme.accent)
                                }
                            }
                    }
                }
            }
            if let refused = snapshot.refused {
                Section { Label(refused, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.needsYou) }
            }
        }
        .overlay {
            if !snapshot.available { ProgressView("Asking the laptop…") }
            else if shown.isEmpty { ContentUnavailableView.search(text: search) }
        }
        .searchable(text: $search, prompt: "Search commands")
        .navigationTitle("Commands")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editing = Editing(command: nil, draft: model.commandEdit(conversationID: conversationID, command: nil)) } label: { Label("New command", systemImage: "plus") }
                    .disabled(!mayChange)
            }
        }
        .sheet(item: $editing) { editing in
            CommandEditor(command: editing.command, draft: editing.draft, mayChange: mayChange, cancel: {
                model.discardCommandEdit(conversationID: conversationID, command: editing.command)
            }) { was, name, prompt, description in
                let scope = client.pairedConnection?.scope
                let result = await model.run(.saveCommand(was: was, name: name, prompt: prompt, description: description), on: .conversation(conversationID))
                if case .accepted = result, client.pairedConnection?.scope == scope { model.discardCommandEdit(conversationID: conversationID, command: editing.command) }
                return result
            }
            .safeAreaInset(edge: .top, spacing: 0) { ConnectionStrip(conversationID: conversationID) }
        }
        .confirmationDialog(removing?.shipped == true ? "Turn off /\(removing?.name ?? "")?" : "Remove /\(removing?.name ?? "")?",
                            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { command in
            Button(command.shipped ? "Turn Off" : "Remove", role: .destructive) { act(.removeCommand(command.name)) }
        } message: { command in
            Text(command.shipped ? "It stops working until you restore it." : "This custom command is deleted from the laptop.")
        }
        .refreshable { _ = await model.run(.commands, on: .conversation(conversationID)) }
        .onChange(of: snapshot.done) { _, done in if let done, !done.isEmpty { model.show(done) } }
    }

    private var kinds: [String] {
        var seen = Set<String>()
        return shown.map(\.kind).filter { seen.insert($0).inserted }
    }

    private func title(_ kind: String) -> String {
        switch kind {
        case "snippet": "Snippets"
        case "command", "prompt": "Commands"
        case "builtin", "agent": "Built in"
        case "": "Other"
        default: kind.capitalized
        }
    }

    private func act(_ action: ClientAction) {
        Task { _ = await model.run(action, on: .conversation(conversationID)) }
    }

    struct Editing: Identifiable {
        let command: CommandDescription?
        let draft: CommandEditDraft
        var id: String { command.map { "existing:" + $0.name } ?? "new" }
    }
}

private struct CommandRow: View {
    let command: CommandDescription
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text("/" + command.name).font(.body.monospaced())
                if command.off { tag("Off") }
                else if command.edited { tag("Edited") }
            }
            let detail = command.description.isEmpty ? command.summary : command.description
            if !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
        }
        .opacity(command.off ? 0.6 : 1)
    }
    private func tag(_ text: String) -> some View {
        Text(text).font(.caption2.weight(.medium)).padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color(uiColor: .tertiarySystemFill), in: .capsule)
    }
}

/// Kept by AppModel while the lock removes presentations. Explicit Cancel discards it.
@MainActor @Observable final class CommandEditDraft {
    var name: String
    var description: String
    var prompt: String
    init(command: CommandDescription?) {
        name = command?.name ?? ""; description = command?.description ?? ""; prompt = command?.prompt ?? ""
    }
}

private struct CommandEditor: View {
    let command: CommandDescription?
    @Bindable var draft: CommandEditDraft
    let mayChange: Bool
    let cancel: () -> Void
    let save: (String?, String, String, String) async -> ActionResult
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var problem: String?
    private var name: String { draft.name }
    private var description: String { draft.description }
    private var prompt: String { draft.prompt }

    private var editable: Bool { mayChange && (command == nil || !command!.prompt.isEmpty || command!.kind == "snippet" || command!.kind == "command") }
    private var validName: Bool { name.count <= 40 && name.range(of: #"^[a-zA-Z][a-zA-Z0-9_-]*$"#, options: .regularExpression) != nil }
    private var fits: Bool { description.utf16.count <= 300 && prompt.utf16.count <= 20_000 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 2) {
                        Text("/").foregroundStyle(.secondary)
                        TextField("name", text: $draft.name).textInputAutocapitalization(.never).autocorrectionDisabled().font(.body.monospaced())
                    }
                    TextField("What it does", text: $draft.description)
                } footer: {
                    if !name.isEmpty && !validName { Text("Up to 40 letters, numbers, - and _. Start with a letter.").foregroundStyle(Theme.needsYou) }
                    else if let usage = command?.usage, !usage.isEmpty { Text(usage).font(.footnote.monospaced()) }
                }
                Section {
                    TextEditor(text: $draft.prompt).frame(minHeight: 200).font(.body.monospaced()).accessibilityLabel("Command prompt")
                } header: { Text("Prompt") } footer: {
                    if prompt.utf16.count > 20_000 { Text("The prompt is \(prompt.utf16.count) UTF-16 units; the limit is 20,000.").foregroundStyle(Theme.needsYou) }
                    else { Text("Put /\(name.isEmpty ? "name" : name) at the start or end of a message to add this text when it sends.") }
                }
                if let problem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.needsYou) }
                }
            }
            .disabled(!editable || saving)
            .interactiveDismissDisabled(saving)
            .navigationTitle(command == nil ? "New command" : "/" + (command?.name ?? ""))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { cancel(); dismiss() }.disabled(saving) }
                if editable {
                    ToolbarItem(placement: .confirmationAction) {
                        if saving { ProgressView() } else {
                            Button("Save") { Task { await commit() } }
                                .disabled(!validName || !fits || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                    }
                }
            }

        }
    }

    /// The editor stays open, with everything typed, until the laptop confirms.
    private func commit() async {
        saving = true; problem = nil
        let result = await save(command?.name, name, prompt, description)
        saving = false
        switch result {
        case .accepted: Haptics.success(); dismiss()
        case .notSent(let failure): problem = failure.message
        case .ambiguous: problem = "The laptop did not confirm the save. Check the list before saving again."
        case .submitted, .local: problem = "The laptop has not confirmed the save yet."
        }
    }
}
