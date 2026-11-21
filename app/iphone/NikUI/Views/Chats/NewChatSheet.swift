import SwiftUI
import NikCore

/// Pick an agent and a project; tapping the project starts the chat.
struct NewChatSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @AppStorage("newChat.provider") private var providerRaw = Provider.claude.rawValue
    @State private var folderID: String?
    @State private var starting: String?

    private var provider: Provider { Provider(rawValue: providerRaw) ?? .claude }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Agent", selection: $providerRaw) {
                        Text("Claude").tag(Provider.claude.rawValue)
                        Text("Codex").tag(Provider.codex.rawValue)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if provider == .claude && !client.fleet.folders.isEmpty {
                    Section {
                        Picker("Group", selection: $folderID) {
                            Text("None").tag(String?.none)
                            ForEach(client.fleet.folders) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                }
                Section {
                    ForEach(projects, id: \.path) { project in
                        Button { start(project.path) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(project.name).foregroundStyle(.primary)
                                    Text(Format.shortPath(project.path)).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                                if starting == project.path { ProgressView() }
                            }
                        }
                        .disabled(starting != nil || !client.mayControl)
                    }
                } header: {
                    Text("Project")
                } footer: {
                    if let failure = model.creationFailed, starting == nil {
                        Text(failure).foregroundStyle(Theme.needsYou)
                    }
                }
            }
            .overlay {
                if projects.isEmpty {
                    EmptyState(title: "No projects", symbol: "folder.badge.questionmark",
                               message: "Open a project folder in VS Code on the laptop, then come back.")
                }
            }
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(starting != nil) } }
            .interactiveDismissDisabled(starting != nil)
            .onAppear { model.creationFailed = nil }
        }
        .presentationDetents([.large])
    }

    /// Offered projects (plus Codex folders for Codex), most recently used first.
    private var projects: [(path: String, name: String)] {
        var lastUsed: [String: Double] = [:]
        for row in client.fleet.rows { lastUsed[row.cwd] = max(lastUsed[row.cwd] ?? 0, row.activeAt ?? 0) }
        var seen = Set<String>(); var out: [(path: String, name: String)] = []
        var candidates = client.fleet.projects.map { ($0.path, $0.name) }
        if provider == .codex { candidates += client.fleet.codex.map { ($0.cwd, ($0.cwd as NSString).lastPathComponent) } }
        for (path, name) in candidates where !path.isEmpty && seen.insert(path).inserted { out.append((path, name)) }
        return out.sorted { (lastUsed[$0.path] ?? 0) > (lastUsed[$1.path] ?? 0) }
    }

    private func start(_ path: String) {
        guard client.mayControl else { model.show("This iPhone can only watch. Allow control from the laptop.", .warning); return }
        starting = path
        let id = UUID().uuidString
        let selectedProvider = provider
        let selectedFolder = provider == .claude ? folderID : nil
        Task {
            let ok = await model.create(.newInstance(id: id, cwd: path, provider: selectedProvider, folderID: selectedFolder), id: id)
            starting = nil
            if ok { Haptics.success(); dismiss() } else { Haptics.error() }
        }
    }
}
