import SwiftUI
import NikCore

/// One row in the chat list: a live instance, a Codex thread, or an earlier
/// Claude transcript that can be resumed.
struct ChatItem: Identifiable, Equatable {
    let id: String
    var title: String
    var provider: Provider
    var cwd: String
    var place: String
    var folderID: String?
    var date: Date?
    var row: FleetRow?
    var history: HistoryEntry?
    var searchText: String

    var isLive: Bool { row != nil }
    var unread: Bool { row?.unread == true }
    var needsYou: Bool { row?.status == .waiting || row?.status == .error }

    var words: String {
        guard let row else { return "Earlier" }
        if row.unread && row.status == .done { return "New reply" }
        if row.paused { return "Quota paused" }
        if row.readOnly { return "Open in ChatGPT" }
        if row.queued > 0 && row.status != .working { return "\(row.queued) queued" }
        switch row.status {
        case .waiting: return "Needs permission"
        case .error: return "Needs attention"
        case .working: return row.queued > 0 ? "Working · \(row.queued) queued" : "Working"
        case .done: return "Finished"
        case .stopped: return "Stopped"
        case .idle, .unknown: return "Ready"
        }
    }
}

struct ChatsView: View {
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    enum Scope: String, CaseIterable { case active = "Active", earlier = "Earlier" }
    @State private var scope: Scope = .active
    @State private var search = ""
    @State private var shown = 60
    @State private var newChat = false
    @State private var moving: ChatItem?
    @State private var organizing = false
    @State private var refreshing = false
    @AppStorage("chats.manualOrder") private var manualOrder = Data()
    @AppStorage("chats.provider") private var providerFilter = "all"
    @AppStorage("chats.project") private var projectFilter = ""
    @AppStorage("chats.sort") private var sort = "priority"

    var body: some View {
        List {
            freshnessNotice
            if search.isEmpty {
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        Picker("Show", selection: $scope) {
                            ForEach(Scope.allCases, id: \.self) { Text($0.rawValue) }
                        }.pickerStyle(.menu)
                    } else {
                        Picker("Show", selection: $scope) {
                            ForEach(Scope.allCases, id: \.self) { Text($0.rawValue) }
                        }.pickerStyle(.segmented)
                    }
                }
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
            }
            if !search.isEmpty || scope == .earlier {
                flatSection(items: Array(filtered.prefix(shown)))
                if filtered.count > shown {
                    Button("Show more") { shown += 60 }
                }
            } else if sort == "folders" {
                ForEach(groups, id: \.key) { group in
                    Section(group.name) {
                        ForEach(group.items) { row($0) }
                            .onMove { source, destination in reorder(group.items, source: source, destination: destination) }
                            .moveDisabled(!organizing)
                    }
                }
            } else {
                prioritySections(filtered)
            }
        }
        .listStyle(.plain)
        .overlay { emptyState }
        .navigationTitle("Chats")
        .searchable(text: $search, prompt: "Search all chats")
        .safeAreaInset(edge: .bottom, spacing: 0) { ConnectionStrip() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                if organizing { Button("Done") { organizing = false } } else { filterMenu }
            }
            ToolbarItem(placement: .primaryAction) {
                Button { newChat = true } label: { Label("New chat", systemImage: "square.and.pencil") }
                    .needsControl(client.mayControl)
            }
        }
        .refreshable { await refresh() }
        .environment(\.editMode, Binding(get: { organizing ? .active : .inactive }, set: { organizing = $0 == .active }))
        .onChange(of: scope) { shown = 60 }
        .onChange(of: search) { shown = 60 }
        .sheet(isPresented: $newChat) { NewChatSheet() }
        .sheet(item: $moving) { item in MoveSheet(item: item) }
    }

    // MARK: Rows

    @ViewBuilder private func prioritySections(_ items: [ChatItem]) -> some View {
        let urgent: [ChatItem] = sort == "priority" ? items.filter { $0.needsYou } : []
        let urgentIDs = Set(urgent.map(\.id))
        let rest: [ChatItem] = items.filter { !urgentIDs.contains($0.id) }
        if !urgent.isEmpty {
            Section("Needs you") { ForEach(urgent) { row($0) } }
            Section("Everything else") { ForEach(rest) { row($0) } }
        } else {
            Section { ForEach(rest) { row($0) } }
        }
    }

    @ViewBuilder private func flatSection(items: [ChatItem]) -> some View {
        ForEach(items) { row($0) }
    }

    private func row(_ item: ChatItem) -> some View {
        Button { open(item) } label: { ChatRow(item: item, stale: !client.isPreview && (!client.connection.isLive || client.fleetStatus.receivedAt == nil || client.fleetStatus.error != nil), opening: model.creating.contains("resume:" + item.id)) }
            .contextMenu {
                if let row = item.row, row.provider == .claude, client.mayControl {
                    Button { moving = item } label: { Label("Move to group…", systemImage: "folder") }
                }
                if let path = item.cwd.nilIfEmpty {
                    Button { UIPasteboard.general.string = path } label: { Label("Copy folder path", systemImage: "doc.on.doc") }
                }
            }
    }

    private func open(_ item: ChatItem) {
        if let row = item.row { model.push(.conversation(row.id)); return }
        guard let entry = item.history else { return }
        // Already running on the laptop: open that chat instead of resuming a second copy.
        if let live = client.fleet.rows.first(where: { $0.provider == entry.provider && $0.sessionId == entry.sessionId }) {
            model.push(.conversation(live.id)); return
        }
        if entry.provider == .codex {
            model.push(.conversation(entry.sessionId.hasPrefix("cx-") ? entry.sessionId : "cx-" + entry.sessionId))
            return
        }
        guard client.mayControl else { model.show("This iPhone can only watch, so it cannot reopen earlier chats.", .warning); return }
        let id = "resume:" + item.id
        Task {
            if !(await model.create(.resume(id: id, sessionID: entry.sessionId), id: id)), let why = model.creationFailed {
                model.show(why, .warning)
            }
        }
    }

    // MARK: Data

    private var merged: [ConversationSummary] { FleetLogic.merge(active: client.fleet.rows, history: client.history.entries) }

    private func item(_ summary: ConversationSummary) -> ChatItem {
        let row = summary.past ? nil : FleetRow(summary.raw)
        let entry = summary.past ? HistoryEntry(summary.raw) : nil
        let place = row?.folder?.name ?? row?.project?.name ?? (summary.cwd as NSString).lastPathComponent
        let fields = ["label", "title", "customTitle", "autoLabel", "cwd", "branch", "sessionId", "id", "provider", "ticket", "model"]
        let searchText = fields.compactMap { summary.raw[$0].stringValue }.joined(separator: " ").lowercased()
        return ChatItem(id: summary.identity, title: summary.raw["customTitle"].stringValue?.nilIfEmpty ?? summary.label.nilIfEmpty ?? "Untitled",
                        provider: summary.provider, cwd: summary.cwd, place: place, folderID: row?.folder?.id,
                        date: summary.activeAt > 0 ? Date(timeIntervalSince1970: summary.activeAt / 1000) : nil,
                        row: row, history: entry, searchText: searchText)
    }

    private var filtered: [ChatItem] {
        let historyKeys = Set(FleetLogic.merge(active: [], history: client.history.entries).map(\.identity))
        var items = merged.filter { summary in
            if !search.isEmpty { return true }
            return scope == .active ? !summary.past : summary.provider == .codex || historyKeys.contains(summary.identity)
        }.map(item)
        if !search.isEmpty {
            let terms = search.lowercased().split(whereSeparator: \.isWhitespace)
            items = items.filter { item in terms.allSatisfy { item.searchText.contains($0) } }
        }
        if providerFilter != "all" { items = items.filter { $0.provider.rawValue == providerFilter } }
        if !projectFilter.isEmpty { items = items.filter { $0.cwd == projectFilter } }
        return items.sorted { a, b in
            if sort == "priority" && search.isEmpty && scope == .active {
                if a.needsYou != b.needsYou { return a.needsYou }
                if a.needsYou && a.unread != b.unread { return a.unread }
            }
            return (a.date ?? .distantPast) > (b.date ?? .distantPast)
        }
    }

    /// Groups keyed by folder ID or exact project path; names are only labels,
    /// so two projects both called "api" stay apart.
    private var groups: [(key: String, name: String, items: [ChatItem])] {
        var folders: [String: (String, [ChatItem])] = [:], projects: [String: (String, [ChatItem])] = [:], rest: [ChatItem] = []
        for item in ordered(filtered) {
            if let folder = item.row?.folder {
                folders["f:" + folder.id, default: (folder.name, [])].1.append(item)
            } else if let path = (item.row?.project?.path).flatMap({ $0.nilIfEmpty }) ?? item.cwd.nilIfEmpty {
                let name = item.row?.project?.name.nilIfEmpty ?? (path as NSString).lastPathComponent
                projects["p:" + path, default: (name, [])].1.append(item)
            } else { rest.append(item) }
        }
        let ordered = { (d: [String: (String, [ChatItem])]) in
            d.sorted { $0.value.0.localizedStandardCompare($1.value.0) == .orderedAscending }.map { (key: $0.key, name: $0.value.0, items: $0.value.1) }
        }
        return ordered(folders) + ordered(projects) + (rest.isEmpty ? [] : [(key: "loose", name: "Everything else", items: rest)])
    }

    private var projectChoices: [(path: String, name: String)] {
        var seen = Set<String>(); var out: [(String, String)] = []
        let paths = client.fleet.projects.map { ($0.path, $0.name) }
            + client.fleet.rows.map { ($0.cwd, ($0.cwd as NSString).lastPathComponent) }
            + client.history.entries.compactMap { e in e.cwd.map { ($0, ($0 as NSString).lastPathComponent) } }
        for (path, name) in paths where !path.isEmpty && seen.insert(path).inserted { out.append((path, name)) }
        return out.sorted { $0.1.localizedStandardCompare($1.1) == .orderedAscending }
    }

    // MARK: Chrome

    private var filterMenu: some View {
        Menu {
            Picker("Agent", selection: $providerFilter) {
                Text("Claude and Codex").tag("all")
                Label("Claude", systemImage: Provider.claude.symbol).tag("claude")
                Label("Codex", systemImage: Provider.codex.symbol).tag("codex")
            }
            Picker("Project", selection: $projectFilter) {
                Text("All projects").tag("")
                ForEach(projectChoices, id: \.path) { Text($0.name).tag($0.path) }
            }
            .pickerStyle(.menu)
            Picker("Sort", selection: $sort) {
                Label("Priority", systemImage: "exclamationmark.circle").tag("priority")
                Label("Recent", systemImage: "clock").tag("recent")
                Label("Groups", systemImage: "folder").tag("folders")
            }
            if search.isEmpty, scope == .active {
                Button("Organize groups") { sort = "folders"; organizing = true }
            }
            if isFiltered {
                Button("Clear filters", role: .destructive) { providerFilter = "all"; projectFilter = "" }
            }
        } label: {
            Label("Filter", systemImage: isFiltered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
    }

    private var isFiltered: Bool { providerFilter != "all" || !projectFilter.isEmpty }

    @ViewBuilder private var emptyState: some View {
        if filtered.isEmpty {
            if !search.isEmpty {
                ContentUnavailableView.search(text: search)
            } else if isFiltered {
                ContentUnavailableView {
                    Label("Nothing matches", systemImage: "line.3.horizontal.decrease.circle")
                } actions: {
                    Button("Clear filters") { providerFilter = "all"; projectFilter = "" }
                }
            } else if scope == .earlier {
                if !client.connection.isLive, !client.isPreview, client.historyStatus.receivedAt == nil {
                    EmptyState(title: "Connect to load earlier chats", symbol: "wifi.slash", message: client.connection.words)
                } else if client.historyStatus.isLoading || client.historyStatus.receivedAt == nil && client.historyStatus.error == nil {
                    ProgressView("Loading earlier chats…")
                } else if let error = client.historyStatus.error ?? client.history.trouble {
                    VStack {
                        EmptyState(title: "History unavailable", symbol: "exclamationmark.triangle", message: error)
                        Button("Retry") { Task { await refresh() } }.buttonStyle(.bordered)
                    }
                } else if !client.history.available {
                    EmptyState(title: "No earlier chats", symbol: "clock.arrow.circlepath", message: client.history.trouble ?? "The laptop does not offer chat history.")
                } else {
                    EmptyState(title: "No earlier chats", symbol: "clock.arrow.circlepath")
                }
            } else if !client.isPreview, client.fleetStatus.receivedAt == nil, client.fleetStatus.error == nil, client.connection.isLive {
                ProgressView("Loading chats…")
            } else if client.connection.isLive || client.isPreview {
                ContentUnavailableView {
                    Label("No chats running", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Start one here, or from NikUI on the laptop.")
                } actions: {
                    Button("New chat") { newChat = true }.buttonStyle(.borderedProminent).needsControl(client.mayControl)
                }
            } else {
                ContentUnavailableView {
                    Label(client.connection.words, systemImage: "wifi.slash")
                } actions: {
                    Button("Try again") { Task { await model.retryConnection() } }
                }
            }
        }
    }

    @ViewBuilder private var freshnessNotice: some View {
        if !client.isPreview, !client.connection.isLive || client.fleetStatus.receivedAt == nil || client.fleetStatus.error != nil {
            Section {
                if let stamp = client.fleet.at {
                    Label {
                        Text("Saved list · ") + Text(Date(timeIntervalSince1970: stamp / 1000), style: .relative) + Text(" ago")
                    } icon: { Image(systemName: "clock.arrow.circlepath") }
                }
                if let error = client.fleetStatus.error { Text(error).foregroundStyle(Theme.needsYou) }
            }.font(.footnote).foregroundStyle(.secondary)
        }
        if (scope == .earlier || !search.isEmpty), !client.history.available, !filtered.isEmpty {
            Section { Text("History is unavailable on this laptop. Showing the last saved entries.") }.font(.footnote).foregroundStyle(.secondary)
        }
        if (scope == .earlier || !search.isEmpty), !filtered.isEmpty,
           let error = client.historyStatus.error ?? client.history.trouble {
            Section {
                Label(error, systemImage: "exclamationmark.triangle")
                Button("Retry history") { Task { await refresh() } }
            }.font(.footnote)
        }
    }

    private func refresh() async {
        guard !refreshing else { return }
        guard client.connection.isLive else { await model.retryConnection(); return }
        refreshing = true
        defer { refreshing = false }
        let fleetRevision = client.fleetStatus.revision
        let historyRevision = client.historyStatus.revision
        async let fleet: ActionResult = client.perform(.ready())
        async let history: ActionResult = client.perform(.history(limit: 200))
        _ = await (fleet, history)
        if client.isPreview { return }
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline, !Task.isCancelled, client.connection.isLive {
            if client.fleetStatus.revision != fleetRevision && client.historyStatus.revision != historyRevision { return }
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        }
    }

    private var orderKey: String { client.pairedConnection?.scope ?? "preview" }
    private var savedOrders: [String: [String]] { (try? JSONDecoder().decode([String: [String]].self, from: manualOrder)) ?? [:] }
    private func ordered(_ items: [ChatItem]) -> [ChatItem] {
        let ranks = Dictionary((savedOrders[orderKey] ?? []).enumerated().map { ($0.element, $0.offset) }, uniquingKeysWith: { a, _ in a })
        return items.enumerated().sorted { a, b in
            let ar = ranks[a.element.id] ?? Int.max, br = ranks[b.element.id] ?? Int.max
            return ar == br ? a.offset < b.offset : ar < br
        }.map(\.element)
    }
    private func reorder(_ items: [ChatItem], source: IndexSet, destination: Int) {
        var moved = items; moved.move(fromOffsets: source, toOffset: destination)
        var orders = savedOrders
        let movedIDs = Set(moved.map(\.id))
        orders[orderKey] = moved.map(\.id) + (orders[orderKey] ?? []).filter { !movedIDs.contains($0) }
        if let data = try? JSONEncoder().encode(orders) { manualOrder = data }
    }

}

struct ChatRow: View {
    let item: ChatItem
    var stale = false
    var opening = false

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Group {
                if opening { ProgressView().controlSize(.small) }
                else if let row = item.row { StatusDot(state: stale && row.dot == .working ? .idle : row.dot) }
                else { Color.clear }
            }
            .frame(width: 12)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item.title)
                        .font(.body.weight(item.unread ? .semibold : .regular))
                        .lineLimit(nil)
                    Spacer(minLength: 8)
                    if let date = item.date, date.timeIntervalSince1970 > 0 {
                        RelativeTime(date: date).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 6) {
                    Image(systemName: item.provider.symbol)
                        .font(.caption2.weight(.semibold)).foregroundStyle(item.provider.color)
                    Text((stale ? "Saved · " : "") + (item.place.isEmpty ? item.words : "\(item.place) · \(item.words)"))
                        .font(.subheadline)
                        .foregroundStyle(item.needsYou ? Theme.needsYou : .secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.title), \(item.provider.name), \(stale ? "Saved, " : "")\(item.words)\(item.place.isEmpty ? "" : ", \(item.place)")")
        .accessibilityAddTraits(.isButton)
    }
}

/// Moves a Claude chat into one of the laptop's groups.
private struct MoveSheet: View {
    let item: ChatItem
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                choice(nil, "No group")
                ForEach(client.fleet.folders) { choice($0.id, $0.name) }
            }
            .navigationTitle("Move to group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func choice(_ id: String?, _ name: String) -> some View {
        Button {
            busy = true
            Task {
                let result = await model.run(.place(id: UUID().uuidString, instance: item.row?.id ?? item.id, folderID: id))
                busy = false
                if case .accepted = result { dismiss() }
            }
        } label: {
            HStack {
                Text(name).foregroundStyle(.primary)
                Spacer()
                if item.folderID == id { Image(systemName: "checkmark").foregroundStyle(.tint) }
            }
        }
        .disabled(busy)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
