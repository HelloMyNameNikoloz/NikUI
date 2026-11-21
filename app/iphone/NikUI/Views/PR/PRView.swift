import SwiftUI
import NikCore

/// The pull request linked to a conversation: conversation, threads, commits, checks and files.
struct PRView: View {
    let conversationID: String
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The tab lives in the core, per PR, so it survives leaving and coming back.
    private var tab: PRTab { PRTab(rawValue: pr.tab) ?? .conversation }
    private var tabBinding: Binding<PRTab> {
        Binding(get: { tab }, set: { client.setPRTab($0.rawValue, conversationID: conversationID) })
    }
    @State private var confirmUnlink = false
    @State private var busy = false

    private var pr: PRFeatureState { client.conversation(conversationID).pr }
    private var role: SocketRole { .conversation(conversationID) }

    var body: some View {
        Group {
            if let snapshot = pr.snapshot {
                content(snapshot)
            } else if pr.loading {
                ProgressView("Loading pull request").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView {
                    Label("No pull request", systemImage: "arrow.triangle.pull")
                } description: {
                    Text(pr.error ?? "This conversation has no pull request loaded.")
                } actions: {
                    Button("Refresh") { Task { await model.run(.prRefresh, on: role) } }
                }
            }
        }
        .navigationTitle(pr.snapshot?.number.map { "#\($0)" } ?? "Pull request")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let url = pr.snapshot?.url.flatMap(URL.init(string:)) {
                        Button("Open on GitHub", systemImage: "safari") { openURL(url) }
                    }
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.run(.prRefresh, on: role) } }
                    Button("Unlink pull request", systemImage: "link.badge.plus", role: .destructive) { confirmUnlink = true }
                        .needsControl(client.mayControlConversation(conversationID))
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("Unlink this pull request from the conversation?", isPresented: $confirmUnlink, titleVisibility: .visible) {
            Button("Unlink", role: .destructive) {
                Task {
                    let result = await model.run(.prUnlink, on: role)
                    if case .notSent = result { return }
                    dismiss()
                }
            }
        }
    }

    private func content(_ s: PRSnapshot) -> some View {
        List {
            Section { PRHeader(snapshot: s, unresolved: s.threads.filter { !$0.resolved }.count) }
            if pr.loading || pr.error != nil {
                Section {
                    if pr.loading { Label("Refreshing", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.secondary) }
                    if let error = pr.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                }
            }
            Section {
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        Picker("View", selection: tabBinding) {
                            ForEach(PRTab.allCases) { Text($0.title).tag($0) }
                        }.pickerStyle(.menu)
                    } else {
                        Picker("View", selection: tabBinding) {
                            ForEach(PRTab.allCases) { Text($0.short).tag($0).accessibilityLabel($0.title) }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            switch tab {
            case .conversation: PRConversationSections(snapshot: s, conversationID: conversationID)
            case .threads: PRThreadsSections(snapshot: s, conversationID: conversationID)
            case .commits: PRCommitsSections(snapshot: s)
            case .checks: PRChecksSections(snapshot: s, conversationID: conversationID)
            case .files: PRFilesSections(snapshot: s, conversationID: conversationID)
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.run(.prRefresh, on: role) }
    }
}

private enum PRTab: String, CaseIterable, Identifiable {
    case conversation, threads, commits, checks, files
    var id: String { rawValue }
    var title: String {
        switch self {
        case .conversation: "Conversation"
        case .threads: "Threads"
        case .commits: "Commits"
        case .checks: "Checks"
        case .files: "Files changed"
        }
    }
    var short: String {
        switch self {
        case .conversation: "Chat"
        case .files: "Files"
        default: title
        }
    }
}

// MARK: - Shared helpers

private struct Avatar: View {
    let url: String?
    var size: CGFloat = 24
    var body: some View {
        AsyncImage(url: url.flatMap(URL.init(string:))) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Image(systemName: "person.circle.fill").resizable().foregroundStyle(.secondary)
        }
        .frame(width: size, height: size)
        .clipShape(.circle)
        .accessibilityHidden(true)
    }
}

private func stateWords(_ s: PRSnapshot) -> (String, Color) {
    switch s.state?.uppercased() {
    case "MERGED": ("Merged", .purple)
    case "CLOSED": ("Closed", .red)
    default: s.isDraft ? ("Draft", .gray) : ("Open", .green)
    }
}

private func reviewWords(_ state: String?) -> (String, String, Color) {
    switch state?.uppercased() {
    case "APPROVED": ("Approved", "checkmark.circle.fill", .green)
    case "CHANGES_REQUESTED": ("Changes requested", "xmark.circle.fill", .red)
    case "COMMENTED": ("Commented", "text.bubble", .secondary)
    case "DISMISSED": ("Dismissed", "minus.circle", .secondary)
    case "PENDING": ("Pending", "clock", .orange)
    case let other?: (other.replacingOccurrences(of: "_", with: " ").capitalized, "circle", .secondary)
    case nil: ("Review", "circle", .secondary)
    }
}

private func durationText(_ from: Date?, _ to: Date?) -> String? {
    guard let from, let to, to > from else { return nil }
    return Duration.seconds(to.timeIntervalSince(from)).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 2))
}

private struct DateText: View {
    let date: Date?
    var body: some View {
        if let date { Text(date, style: .relative) }
    }
}

// MARK: - Header

private struct PRHeader: View {
    let snapshot: PRSnapshot
    let unresolved: Int

    var body: some View {
        let (word, color) = stateWords(snapshot)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(word).font(.caption.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(color, in: .capsule)
                if let number = snapshot.number { Text("#\(number)").font(.subheadline).foregroundStyle(.secondary) }
                if let repo = snapshot.repo { Text(repo).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
            }
            Text(snapshot.title ?? "Untitled pull request").font(.headline)
            if let head = snapshot.headRef, let base = snapshot.baseRef {
                HStack(spacing: 4) {
                    Text(head).lineLimit(1)
                    Image(systemName: "arrow.right").accessibilityLabel("into")
                    Text(base).lineLimit(1)
                }
                .font(.footnote.monospaced()).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Text("+\(snapshot.additions ?? 0)").foregroundStyle(.green)
                Text("\u{2212}\(snapshot.deletions ?? 0)").foregroundStyle(.red)
                Text("\(snapshot.changedFiles ?? 0) files").foregroundStyle(.secondary)
            }
            .font(.footnote.monospacedDigit())
            HStack(spacing: 6) {
                Avatar(url: snapshot.authorAvatar, size: 20)
                Text(snapshot.author ?? "unknown").font(.footnote)
                if snapshot.createdAt != nil { Text("opened").font(.footnote).foregroundStyle(.secondary); DateText(date: snapshot.createdAt).font(.footnote).foregroundStyle(.secondary) }
            }
            if snapshot.mergeable == "CONFLICTING" {
                Label("Has merge conflicts", systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
            }
            if unresolved > 0 {
                Label("\(unresolved) unresolved thread\(unresolved == 1 ? "" : "s")", systemImage: "text.bubble").font(.footnote).foregroundStyle(.secondary)
            }
            if !snapshot.labels.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(snapshot.labels) { label in
                            let tint = Color(hex: label.color) ?? .accentColor
                            Text(label.name ?? "").font(.caption)
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .background(tint.opacity(0.2), in: .capsule)
                                .overlay(Capsule().stroke(tint.opacity(0.6)))
                        }
                    }
                }
            }
            if !snapshot.reviewers.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(snapshot.reviewers) { reviewer in
                        let (words, symbol, tint) = reviewWords(reviewer.state)
                        HStack(spacing: 6) {
                            Avatar(url: reviewer.avatar, size: 20)
                            Text(reviewer.login).font(.footnote)
                            Spacer()
                            if reviewer.stale { Text("stale").font(.caption).foregroundStyle(.secondary) }
                            if reviewer.rerequested { Text("re-requested").font(.caption).foregroundStyle(.secondary) }
                            Label(words, systemImage: symbol).font(.caption).foregroundStyle(tint)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

private extension Color {
    init?(hex: String?) {
        guard let hex, hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }
}

// MARK: - Composer with @mention autocomplete

private struct PRComposer: View {
    let conversationID: String
    let key: String
    let placeholder: String
    let sendTitle: String
    let send: (String) async -> Bool
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @State private var sending = false
    @State private var mentionTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    private var text: String { client.conversation(conversationID).pr.drafts[key] ?? "" }
    private var binding: Binding<String> {
        Binding(get: { text }, set: { value in
            client.setPRDraft(value, key: key, conversationID: conversationID)
            queryMentions(value)
        })
    }
    private var activeMention: String? {
        guard let token = text.split(separator: " ", omittingEmptySubsequences: false).last, token.hasPrefix("@"), !text.hasSuffix(" ") else { return nil }
        return String(token.dropFirst())
    }
    private var suggestions: [PRMention] {
        guard focused, let query = activeMention, let mentions = client.conversation(conversationID).pr.mentions, mentions.query == query else { return [] }
        return Array((mentions.users + mentions.teams).prefix(5))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            composerField
        }
        .onDisappear { mentionTask?.cancel(); mentionTask = nil }
        .onChange(of: client.conversation(conversationID).pr.url) { mentionTask?.cancel(); mentionTask = nil }
    }

    @ViewBuilder private var composerField: some View {
            TextField(placeholder, text: binding, axis: .vertical)
                .focused($focused)
                .lineLimit(1...8)
                .textInputAutocapitalization(.sentences)
            ForEach(suggestions) { mention in
                Button {
                    insert(mention)
                } label: {
                    HStack {
                        Avatar(url: mention.avatar, size: 20)
                        Text("@" + mention.login).font(.subheadline)
                        if let name = mention.name { Text(name).font(.footnote).foregroundStyle(.secondary) }
                        if mention.team { Text("team").font(.caption).foregroundStyle(.secondary) }
                    }
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            HStack {
                Spacer()
                Button(sendTitle) {
                    let body = text
                    guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                    sending = true
                    Task {
                        // The core clears the draft itself, and only if it still holds this exact text.
                        _ = await send(body)
                        sending = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(sending || client.conversation(conversationID).pr.pending != nil || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .needsControl(client.mayControlConversation(conversationID))
            }
    }

    private func queryMentions(_ value: String) {
        mentionTask?.cancel()
        guard focused else { return }
        guard let token = value.split(separator: " ", omittingEmptySubsequences: false).last, token.hasPrefix("@"), !value.hasSuffix(" ") else { return }
        let query = String(token.dropFirst())
        mentionTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            _ = await client.perform(.prMentions(query), on: .conversation(conversationID))
        }
    }

    private func insert(_ mention: PRMention) {
        var parts = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty else { return }
        parts[parts.count - 1] = "@" + mention.login
        client.setPRDraft(parts.joined(separator: " ") + " ", key: key, conversationID: conversationID)
    }
}

/// Runs a mutation and reports whether GitHub confirmed it.
@MainActor private func submit(_ model: AppModel, _ action: ClientAction, _ id: String) async -> Bool {
    switch await model.run(action, on: .conversation(id)) {
    case .accepted: true
    case .submitted, .local, .notSent, .ambiguous: false
    }
}

/// Asks the laptop for an editable prompt and puts it into the conversation draft.
/// The laptop answers with an editPrompt event, which the core already puts in the draft.
@MainActor private func ask(_ model: AppModel, _ client: NikClient, _ action: ClientAction, _ id: String) async {
    guard !model.askingPR.contains(id), model.mayPresentContent else { return }
    model.askingPR.insert(id)
    defer { model.askingPR.remove(id) }
    let before = client.conversation(id).editPromptRevision
    let url = client.conversation(id).pr.url
    let scope = client.pairedConnection?.scope
    let result = await model.run(action, on: .conversation(id))
    switch result {
    case .submitted, .accepted:
        for _ in 0..<50 {
            guard !Task.isCancelled, model.mayPresentContent, client.pairedConnection?.scope == scope,
                  client.conversation(id).pr.url == url else { return }
            if client.conversation(id).editPromptRevision != before {
                guard model.tab == .chats, model.chatsPath.last == .pr(id) else { return }
                Haptics.success(); model.openConversation(id)
                model.show("Prompt added to the message field. Review it before sending.")
                return
            }
            do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
        }
        model.show("The laptop did not send a prompt back. Try again.", .warning)
    default: break
    }
}

private struct AskButton: View {
    let title: String
    let action: ClientAction
    let conversationID: String
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    var body: some View {
        // Watch-only devices may still draft an Ask prompt (spec 6.3).
        Button(title, systemImage: "sparkles") {
            Task { await ask(model, client, action, conversationID) }
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(!client.conversation(conversationID).connection.isLive || model.askingPR.contains(conversationID))
    }
}

// MARK: - Conversation

private struct PRConversationSections: View {
    let snapshot: PRSnapshot
    let conversationID: String
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section("Description") {
            if let body = snapshot.body, !body.isEmpty { MarkdownView(body) }
            else { Text("No description provided.").foregroundStyle(.secondary) }
        }
        Section("Activity") {
            if let total = snapshot.timelineTotal, total > snapshot.timeline.count, let url = snapshot.url.flatMap(URL.init(string:)) {
                Button("Earlier activity is not shown. Open on GitHub", systemImage: "safari") { openURL(url) }
            }
            ForEach(snapshot.timeline) { item in TimelineRow(item: item) }
            if snapshot.timeline.isEmpty { Text("No activity yet.").foregroundStyle(.secondary) }
        }
        Section("Add a comment") {
            PRComposer(conversationID: conversationID, key: "comment", placeholder: "Leave a comment", sendTitle: "Comment") { body in
                await submit(model, .prComment(body), conversationID)
            }
        }
    }
}

private struct TimelineRow: View {
    let item: PRTimelineItem
    var body: some View {
        switch item.kind {
        case "comment":
            VStack(alignment: .leading, spacing: 6) {
                byline(item.author, item.avatar, item.at, suffix: item.edited ? "edited" : nil)
                if let body = item.body, !body.isEmpty { MarkdownView(body, compact: true) }
            }
        case "review":
            let (words, symbol, tint) = reviewWords(item.state)
            VStack(alignment: .leading, spacing: 6) {
                byline(item.author, item.avatar, item.at, suffix: nil)
                Label(words, systemImage: symbol).font(.subheadline).foregroundStyle(tint)
                if let body = item.body, !body.isEmpty { MarkdownView(body, compact: true) }
            }
        case "commits":
            VStack(alignment: .leading, spacing: 4) {
                Label("\(item.commits.count) commit\(item.commits.count == 1 ? "" : "s")", systemImage: "arrow.triangle.branch").font(.footnote).foregroundStyle(.secondary)
                ForEach(item.commits) { commit in
                    HStack {
                        Text(commit.headline ?? "").font(.subheadline).lineLimit(2)
                        Spacer()
                        Text(commit.short ?? "").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
            }
        default:
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(.secondary).accessibilityHidden(true)
                Text(eventText).font(.footnote).foregroundStyle(.secondary)
                Spacer()
                DateText(date: item.at).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var eventText: String {
        let who = item.actor.map { $0 + " " } ?? ""
        if !item.text.isEmpty { return who + item.text }
        return who + (item.type?.replacingOccurrences(of: "_", with: " ") ?? "updated")
    }

    private func byline(_ author: String?, _ avatar: String?, _ at: Date?, suffix: String?) -> some View {
        HStack(spacing: 6) {
            Avatar(url: avatar, size: 22)
            Text(author ?? "unknown").font(.subheadline.weight(.semibold))
            DateText(date: at).font(.caption).foregroundStyle(.secondary)
            if let suffix { Text(suffix).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

// MARK: - Threads

private struct PRThreadsSections: View {
    let snapshot: PRSnapshot
    let conversationID: String
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    private var showResolved: Binding<Bool> {
        let key = "pr:" + client.conversation(conversationID).pr.url
        return Binding(get: { model.reading(key).expandedItemIDs.contains("resolved") }, set: { expanded in
            var reading = model.reading(key)
            if expanded { reading.expandedItemIDs.insert("resolved") } else { reading.expandedItemIDs.remove("resolved") }
            model.saveReading(reading, key: key)
        })
    }

    var body: some View {
        let open = snapshot.threads.filter { !$0.resolved }
        let resolved = snapshot.threads.filter(\.resolved)
        if snapshot.threads.isEmpty {
            Section { ContentUnavailableView("No review threads", systemImage: "text.bubble") }
        }
        ForEach(open) { thread in ThreadSection(thread: thread, conversationID: conversationID) }
        if !resolved.isEmpty {
            Section {
                DisclosureGroup("Resolved (\(resolved.count))", isExpanded: showResolved) {
                    EmptyView()
                }
            }
            if showResolved.wrappedValue {
                ForEach(resolved) { thread in ThreadSection(thread: thread, conversationID: conversationID) }
            }
        }
    }
}

private struct ThreadSection: View {
    let thread: PRThread
    let conversationID: String
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model

    var body: some View {
        Section {
            if let hunk = thread.diffHunk, !hunk.isEmpty {
                CodeBlockView(code: lastLines(hunk, 8), language: "diff")
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            }
            ForEach(thread.comments) { comment in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Avatar(url: comment.avatar, size: 22)
                        Text(comment.author ?? "unknown").font(.subheadline.weight(.semibold))
                        DateText(date: comment.at).font(.caption).foregroundStyle(.secondary)
                    }
                    if let body = comment.body { MarkdownView(body, compact: true) }
                }
            }
            PRComposer(conversationID: conversationID, key: thread.id, placeholder: "Reply", sendTitle: "Reply") { body in
                await submit(model, .prReply(threadID: thread.id, body: body), conversationID)
            }
            HStack {
                Button(thread.resolved ? "Unresolve" : "Resolve", systemImage: thread.resolved ? "arrow.uturn.backward.circle" : "checkmark.circle") {
                    Task { _ = await submit(model, .prResolve(threadID: thread.id, resolved: !thread.resolved), conversationID) }
                }
                .buttonStyle(.bordered).controlSize(.large)
                .needsControl(client.mayControlConversation(conversationID))
                Spacer()
                AskButton(title: "Ask agent", action: .prAskThread(thread.id), conversationID: conversationID)
            }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.path ?? "Thread").font(.footnote.monospaced()).textCase(nil).lineLimit(2)
                HStack(spacing: 8) {
                    if let line = thread.line { Text("Line \(line)") }
                    if thread.outdated { Text("Outdated") }
                    if thread.resolved { Text("Resolved") }
                }
                .font(.caption)
            }
        }
    }

    private func lastLines(_ text: String, _ count: Int) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false).suffix(count).joined(separator: "\n")
    }
}

// MARK: - Commits

private struct PRCommitsSections: View {
    let snapshot: PRSnapshot

    var body: some View {
        let calendar = Calendar.current
        let groups = Dictionary(grouping: snapshot.commits) { calendar.startOfDay(for: $0.at ?? .distantPast) }
        if snapshot.commits.isEmpty {
            Section { ContentUnavailableView("No commits", systemImage: "arrow.triangle.branch") }
        }
        ForEach(groups.keys.sorted(by: >), id: \.self) { day in
            Section(day == .distantPast ? "Unknown date" : day.formatted(date: .abbreviated, time: .omitted)) {
                ForEach(groups[day] ?? []) { commit in
                    HStack(alignment: .top, spacing: 10) {
                        Avatar(url: commit.avatar)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(commit.headline ?? "").font(.subheadline)
                            HStack(spacing: 6) {
                                Text(commit.author ?? "")
                                if let at = commit.at { Text(at, style: .time) }
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(commit.short ?? String((commit.oid ?? "").prefix(7))).font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

// MARK: - Checks

private struct PRChecksSections: View {
    let snapshot: PRSnapshot
    let conversationID: String
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var confirmRerun = false

    private func rank(_ status: String) -> Int {
        switch status { case "fail": 0; case "pending": 1; case "pass": 3; default: 2 }
    }

    var body: some View {
        let summary = snapshot.checkSummary
        let checks = snapshot.checks.sorted { rank($0.status) < rank($1.status) }
        Section {
            Text("\(summary.pass) passing, \(summary.fail) failing, \(summary.pending) pending")
            if summary.fail > 0 {
                Button("Rerun failed checks", systemImage: "arrow.clockwise") { confirmRerun = true }
                    .needsControl(client.mayControlConversation(conversationID))
            }
            if snapshot.mergeable == "CONFLICTING" {
                VStack(alignment: .leading, spacing: 8) {
                    Label("This pull request has merge conflicts.", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    AskButton(title: "Ask agent to resolve conflicts", action: .prAskConflicts, conversationID: conversationID)
                }
            } else if let mergeable = snapshot.mergeable {
                Label(mergeable == "MERGEABLE" ? "No conflicts with the base branch" : "Mergeability unknown", systemImage: mergeable == "MERGEABLE" ? "checkmark.circle" : "questionmark.circle")
                    .foregroundStyle(.secondary)
            }
        }
        .confirmationDialog("Rerun failed workflow runs?", isPresented: $confirmRerun, titleVisibility: .visible) {
            Button("Rerun") { Task { _ = await submit(model, .prRerun, conversationID) } }
        }
        Section("Checks") {
            if checks.isEmpty { Text("No checks reported.").foregroundStyle(.secondary) }
            ForEach(checks) { check in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        icon(check.status)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(check.name ?? "Check").font(.subheadline)
                            HStack(spacing: 6) {
                                if let workflow = check.workflow { Text(workflow) }
                                if let d = durationText(check.startedAt, check.completedAt) { Text(d) }
                            }
                            .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let url = check.url.flatMap(URL.init(string:)) {
                            Button { openURL(url) } label: {
                                Image(systemName: "arrow.up.right.square").frame(width: 44, height: 44).contentShape(.rect)
                            }
                            .buttonStyle(.plain).foregroundStyle(.secondary)
                            .accessibilityLabel("Open \(check.name ?? "check") on GitHub")
                        }
                    }
                    if check.status == "fail", let run = check.runId {
                        AskButton(title: "Ask agent to fix", action: .prAskCheck(runID: String(run), name: check.name), conversationID: conversationID)
                    }
                }
            }
        }
    }

    @ViewBuilder private func icon(_ status: String) -> some View {
        switch status {
        case "pass": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("Passed")
        case "fail": Image(systemName: "xmark.circle.fill").foregroundStyle(.red).accessibilityLabel("Failed")
        case "pending": Image(systemName: "clock.fill").foregroundStyle(.orange).accessibilityLabel("Pending")
        default: Image(systemName: "minus.circle").foregroundStyle(.secondary).accessibilityLabel(status.capitalized)
        }
    }
}

// MARK: - Files

private struct PRFilesSections: View {
    let snapshot: PRSnapshot
    let conversationID: String
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model

    private var pr: PRFeatureState { client.conversation(conversationID).pr }

    var body: some View {
        let diffs = Dictionary(UnifiedDiffParser.parse(pr.diff ?? "").map { ($0.path, $0.lines) }, uniquingKeysWith: { a, _ in a })
        Section {
            if snapshot.files.isEmpty { Text("No changed files.").foregroundStyle(.secondary) }
            ForEach(snapshot.files) { file in
                DisclosureGroup(isExpanded: expandedFile(file.path ?? "")) {
                    if pr.diff == nil {
                        if pr.pending != nil { ProgressView() } else { Text("Loading diff").foregroundStyle(.secondary) }
                    } else if let lines = diffs[file.path ?? ""] {
                        DiffLines(lines: lines)
                    } else {
                        Text(pr.diffTruncated ? "This file is past the truncated diff." : "No diff available for this file.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } label: {
                    HStack {
                        Text(file.path ?? "").font(.footnote.monospaced()).lineLimit(2)
                        Spacer()
                        Text("+\(file.additions ?? 0)").foregroundStyle(.green)
                        Text("\u{2212}\(file.deletions ?? 0)").foregroundStyle(.red)
                    }
                    .font(.caption.monospacedDigit())
                }
            }
        } footer: {
            if pr.diffTruncated { Text("The diff was truncated because it is large. Open on GitHub to see all of it.") }
        }
        .task(id: "\(conversationID)-\(client.conversation(conversationID).connection.isLive)") {
            if client.conversation(conversationID).connection.isLive, pr.diff == nil {
                await model.run(.prDiff, on: .conversation(conversationID))
            }
        }
    }

    private func expandedFile(_ path: String) -> Binding<Bool> {
        let key = "prfiles:" + pr.url
        return Binding(get: { model.reading(key).expandedItemIDs.contains(path) }, set: { expanded in
            var reading = model.reading(key)
            if expanded { reading.expandedItemIDs.insert(path) } else { reading.expandedItemIDs.remove(path) }
            model.saveReading(reading, key: key)
        })
    }

}

private struct DiffLines: View {
    let lines: [DiffLine]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 8) {
                        Text(line.oldLine.map(String.init) ?? "").frame(minWidth: 30, alignment: .trailing).foregroundStyle(.secondary)
                        Text(line.newLine.map(String.init) ?? "").frame(minWidth: 30, alignment: .trailing).foregroundStyle(.secondary)
                        Text(line.text.isEmpty ? " " : line.text)
                    }
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(foreground(line.text))
                        .padding(.horizontal, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(background(line.text))
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
        }
    }

    private func isMeta(_ l: String) -> Bool {
        l.hasPrefix("+++") || l.hasPrefix("---") || l.hasPrefix("index ") || l.hasPrefix("new file") || l.hasPrefix("deleted file") || l.hasPrefix("similarity") || l.hasPrefix("rename ")
    }
    private func foreground(_ l: String) -> Color {
        if l.hasPrefix("@@") { return .blue }
        if isMeta(l) { return .secondary }
        return .primary
    }
    private func background(_ l: String) -> Color {
        if isMeta(l) || l.hasPrefix("@@") { return .clear }
        if l.hasPrefix("+") { return .green.opacity(0.18) }
        if l.hasPrefix("-") { return .red.opacity(0.18) }
        return .clear
    }
}
