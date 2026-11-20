import SwiftUI
import NikCore

/// One chat: transcript, live strips, composer.
struct ConversationView: View {
    let id: String
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var scrollID: String?
    @State private var restoredReading = false
    @State private var restoringOffset: ReadingState?
    @State private var viewport = ReadingViewport()
    @State private var atBottom = true
    @State private var finding = false
    @State private var findQuery = ""
    /// The selected occurrence, by stable ID, so streaming text does not move it.
    @State private var selectedMatch: String?
    @State private var searchResults: [TranscriptMatch] = []
    private struct SearchRequest: Equatable { let query: String; let items: [TranscriptItem] }
    @State private var showInfo = false
    @State private var showTools = false
    @State private var showQueue = false
    @State private var confirmStop = false
    @State private var lastStatus: ConversationStatus?

    private var state: ConversationState { client.conversation(id) }
    private var row: FleetRow? { client.fleet.rows.first { $0.id == id } }
    private var provider: Provider { row?.provider ?? state.meta.provider }
    private var title: String { state.meta.label.nilIfEmpty ?? row?.label.nilIfEmpty ?? "Chat" }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if state.dropped > 0 {
                        Label("\(state.dropped) earlier items are not on the phone. The laptop keeps the full chat.", systemImage: "clock.arrow.circlepath")
                            .font(.footnote).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                    if !state.initialized && state.items.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
                    }
                    ForEach(visibleItems) { item in
                        TranscriptItemView(item: item, conversationID: id, provider: provider,
                                           expanded: expandedBinding(item.id),
                                           highlighted: currentMatch == item.id, searchMatch: currentOccurrence?.itemID == item.id ? currentOccurrence : nil)
                            .id(item.id)
                            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView).minY } action: { y in
                                rememberOffset(item.id, y: y)
                            }
                    }
                    if let suggestions = replySuggestions, !suggestions.isEmpty {
                        ReplyChips(suggestions: suggestions) { send($0) }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .background(ReadingViewportProbe(viewport: viewport).frame(width: 0, height: 0))
                .scrollTargetLayout()
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollPosition(id: $scrollID, anchor: .top)
            .task(id: state.initialized) {
                guard state.initialized, !restoredReading else { return }
                var saved = state.reading
                if saved.anchorID == nil || !visibleItems.contains(where: { $0.id == saved.anchorID }) { saved.followsLatest = true }
                atBottom = saved.followsLatest
                findQuery = saved.findQuery
                selectedMatch = saved.selectedMatch
                finding = !saved.findQuery.isEmpty
                restoringOffset = saved.followsLatest ? nil : saved
                scrollID = saved.followsLatest ? "bottom" : saved.anchorID
                restoredReading = true
            }
            .onChange(of: scrollID) { _, value in
                guard restoredReading, let value else { return }
                var reading = state.reading
                reading.anchorID = value
                if restoringOffset == nil { reading.offset = 0 }
                client.setReading(reading, conversationID: id)
            }
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: ReadingGeometry.self) { ReadingGeometry($0) } action: { old, new in
                guard restoringOffset == nil else { return }
                if restoredReading, atBottom, !finding, old.extent != new.extent {
                    proxy.scrollTo("bottom", anchor: .bottom)
                    return
                }
                atBottom = new.bottom
                guard restoredReading else { return }
                var reading = state.reading; reading.followsLatest = new.bottom
                client.setReading(reading, conversationID: id)
            }
            .onChange(of: state.items.last) { _, _ in
                if atBottom && !finding { withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .task(id: currentOccurrence?.id) {
                guard let match = currentOccurrence else { return }
                proxy.scrollTo(match.itemID, anchor: .top)
                do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
                guard currentOccurrence?.id == match.id else { return }
                withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("find:" + match.id, anchor: .center) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom {
                    Button {
                        withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down").font(.body.weight(.semibold))
                            .frame(width: 44, height: 44)
                            .background(reduceTransparency ? AnyShapeStyle(Color(uiColor: .systemBackground)) : AnyShapeStyle(.regularMaterial), in: .circle)
                            .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
                    }
                    .buttonStyle(.plain)
                    .padding(16)
                    .accessibilityLabel("Jump to latest")
                    .transition(.scale.combined(with: .opacity))
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if finding { findBar }
                GoalBar(goal: state.meta.goal)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                WorkingStrip(state: state, onStop: stop)
                if !state.queue.isEmpty {
                    QueueChip(queue: state.queue, drainAt: state.drainAt) { showQueue = true }
                }
                Composer(conversationID: id, provider: provider, showTools: $showTools, dismissFind: {
                    guard finding else { return false }
                    finding = false; findQuery = ""; return true
                })
            }
            .background(.bar)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { showInfo = true } label: {
                    VStack(spacing: 1) {
                        Text(title).font(.headline).lineLimit(1)
                        HStack(spacing: 5) {
                            StatusDot(state: state.status.dot)
                            Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: 260, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(title), \(state.status.words). Details")
            }
            ToolbarItem(placement: .primaryAction) { menu }
        }
        .sheet(isPresented: $showInfo) { ConversationInfoSheet(conversationID: id) }
        .sheet(isPresented: $showTools) { ToolsSheet(conversationID: id, provider: provider, find: { finding = true }) }
        .sheet(isPresented: $showQueue) { QueueSheet(conversationID: id, provider: provider) }
        .onChange(of: findQuery) { _, query in
            var reading = state.reading; reading.findQuery = query
            client.setReading(reading, conversationID: id)
        }
        .onChange(of: selectedMatch) { _, match in
            var reading = state.reading; reading.selectedMatch = match
            client.setReading(reading, conversationID: id)
        }
        .onChange(of: state.status) { old, new in
            if old == .working && new == .done { Haptics.success() }
            if new == .waiting && old != .waiting { Haptics.warning() }
        }
        .environment(\.openURL, OpenURLAction { url in handle(url) })
        .environment(\.runCommand, { command in
            model.terminalCommand = TerminalHandoff(command: command, conversationID: id, provider: provider)
            model.tab = .terminal
        })
        .task(id: searchRequest) {
            let request = searchRequest
            let result = await Task.detached(priority: .userInitiated) {
                TranscriptSearch.matches(request.query, items: request.items)
            }.value
            guard !Task.isCancelled else { return }
            searchResults = result
        }
        .environment(\.fileLinks, true)
        .onKeyPress(.escape) {
            if finding { finding = false; findQuery = ""; return .handled }
            return .ignored
        }
    }

    // MARK: Header

    private var subtitle: String {
        var parts = [state.status.words]
        if let model = state.meta.model?.nilIfEmpty { parts.append(Self.shortModel(model)) }
        if let window = state.stats.contextWindow, window > 0, let used = state.stats.contextTokens {
            parts.append(Format.percent(Double(used) / Double(window)) + " context")
        }
        return parts.joined(separator: " · ")
    }

    static func shortModel(_ id: String) -> String {
        id.replacingOccurrences(of: "claude-", with: "").replacingOccurrences(of: "-", with: " ").capitalized
    }

    private var menu: some View {
        Menu {
            Button { finding = true } label: { Label("Find in chat", systemImage: "magnifyingglass") }.keyboardShortcut("f", modifiers: .command)
            Button { model.push(.report(id)) } label: { Label("Status report", systemImage: "chart.bar.xaxis") }
            if let pr = state.meta.prUrl?.nilIfEmpty {
                Button { model.push(.pr(id)) } label: { Label("Pull request", systemImage: "arrow.triangle.pull") }
                    .help(pr)
            }
            Button { showTools = true } label: { Label("Tools", systemImage: "slider.horizontal.3") }
            Divider()
            Button { model.push(.laptopSettings(id)) } label: { Label("Laptop settings", systemImage: "gearshape.2") }
            Button { model.push(.commands(id)) } label: { Label("Commands and snippets", systemImage: "command") }
            Divider()
            Button {
                UIPasteboard.general.string = state.items.map(TranscriptText.plain).filter { !$0.isEmpty }.joined(separator: "\n\n")
                model.show("Copied the chat.")
            } label: { Label("Copy chat", systemImage: "doc.on.doc") }
            if state.status == .working || state.status == .waiting {
                Button(role: .destructive) { stop() } label: { Label("Stop", systemImage: "stop.circle") }
                    .needsControl(client.mayControlConversation(id))
            }
        } label: {
            Label("More", systemImage: "ellipsis.circle")
        }
    }

    // MARK: Transcript

    private var visibleItems: [TranscriptItem] {
        state.items.filter { item in
            if item.kind == "thinking" { return state.configuration.showThinking && !item.text.isEmpty }
            return true
        }
    }

    private func rememberOffset(_ itemID: String, y: CGFloat) {
        guard restoredReading else { return }
        if let saved = restoringOffset, saved.anchorID == itemID, viewport.scrollView != nil {
            restoringOffset = nil
            viewport.restore(offset: saved.offset, observedY: y)
        } else if restoringOffset == nil, state.reading.anchorID == itemID, !atBottom,
                  abs(state.reading.offset - Double(y)) > 0.5 {
            var reading = state.reading; reading.offset = Double(y)
            client.setReading(reading, conversationID: id)
        }
    }

    private func expandedBinding(_ itemID: String) -> Binding<Bool> {
        Binding(
            get: { client.conversation(id).reading.expandedItemIDs.contains(itemID) || matches.contains(itemID) && currentMatch == itemID },
            set: { on in
                var reading = client.conversation(id).reading
                if on { reading.expandedItemIDs.insert(itemID) } else { reading.expandedItemIDs.remove(itemID) }
                client.setReading(reading, conversationID: id)
            })
    }

    private var replySuggestions: [String]? {
        guard state.queue.isEmpty, client.mayControlConversation(id) else { return nil }
        let replies = client.suggestedReplies(conversationID: id)
        return replies.isEmpty ? nil : replies
    }

    // MARK: Find

    /// Every occurrence in the rendered text (Markdown stripped, tool arguments included).
    private var searchRequest: SearchRequest {
        let query = finding ? findQuery.trimmingCharacters(in: .whitespaces) : ""
        return SearchRequest(query: query, items: query.isEmpty ? [] : visibleItems)
    }
    private var occurrences: [TranscriptMatch] { finding ? searchResults : [] }
    private var matches: [String] { occurrences.map(\.itemID) }
    private var findIndex: Int {
        let all = occurrences
        return all.firstIndex { $0.id == selectedMatch } ?? 0
    }

    private var currentOccurrence: TranscriptMatch? {
        let all = occurrences
        guard !all.isEmpty else { return nil }
        return all[min(findIndex, all.count - 1)]
    }
    private var currentMatch: String? { currentOccurrence?.itemID }

    private var findBar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Find in chat", text: $findQuery)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit { step(1) }
                    .onChange(of: findQuery) { selectedMatch = nil }
            }
            HStack(spacing: 8) {
                if !findQuery.isEmpty {
                    Text(occurrences.isEmpty ? "None" : "\(findIndex + 1) of \(occurrences.count)")
                        .font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button { step(-1) } label: { Image(systemName: "chevron.up").frame(width: 44, height: 44) }.disabled(matches.isEmpty).accessibilityLabel("Previous match")
                Button { step(1) } label: { Image(systemName: "chevron.down").frame(width: 44, height: 44) }.disabled(matches.isEmpty).accessibilityLabel("Next match")
                Button("Done") { finding = false; findQuery = "" }.frame(minWidth: 44, minHeight: 44)
            }
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 16).padding(.top, 8)
        .background(.bar)
    }

    private func step(_ delta: Int) {
        let all = occurrences
        guard !all.isEmpty else { return }
        selectedMatch = all[(findIndex + delta + all.count) % all.count].id
    }

    // MARK: Actions

    private func stop() {
        Task { await model.run(.interrupt, on: .conversation(id)); Haptics.tap() }
    }

    private func send(_ text: String) {
        guard client.mayControlConversation(id) else { return }
        // Install the chip synchronously, so a delayed task cannot replace a new composition.
        guard state.draft.text.isEmpty, state.draft.attachments.isEmpty else { return }
        client.setDraft(Draft(text: text), conversationID: id)
        let composition = client.conversation(id).draft
        Task {
            guard client.conversation(id).draft == composition, model.mayPresentContent else { return }
            let result = await client.send(conversationID: id)
            model.report(result)
            if case .submitted = result { Haptics.tap() }
        }
    }

    private func handle(_ url: URL) -> OpenURLAction.Result {
        guard url.scheme == FileLink.scheme else { return .systemAction }
        guard let (path, line) = FileLink.decode(url) else { return .discarded }
        guard client.mayControlConversation(id) else { model.show("Opening files needs a live chat connection and control from the laptop.", .warning); return .handled }
        Task {
            let result = await model.run(.openFile(path: path, line: line), on: .conversation(id))
            if case .notSent = result { return }
            model.show("Opened \((path as NSString).lastPathComponent) on the laptop.")
        }
        return .handled
    }
}

/// "Working" or "Using your Mac", the run time, and Stop.
private struct WorkingStrip: View {
    let state: ConversationState
    let onStop: () -> Void
    @Environment(NikClient.self) private var client

    var body: some View {
        if state.status == .working || state.status == .waiting {
            HStack(spacing: 10) {
                if state.status == .working {
                    ProgressView().controlSize(.small)
                    Text(state.meta.usingMac != nil ? "Using your Mac" : "Working").font(.subheadline.weight(.medium))
                } else {
                    Image(systemName: "hand.raised.fill").foregroundStyle(Theme.needsYou)
                    Text("Needs you").font(.subheadline.weight(.medium))
                }
                if state.stats.running, let at = state.statsReceivedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let ms = state.stats.elapsedMs + (client.connection.isLive ? context.date.timeIntervalSince(at) * 1000 : 0)
                        Text(Format.duration(ms: ms)).font(.subheadline).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                if state.stats.shells > 0 {
                    Label("\(state.stats.shells)", systemImage: "terminal").font(.footnote).foregroundStyle(.secondary)
                        .accessibilityLabel("\(state.stats.shells) background shells")
                }
                Spacer()
                Button(role: .destructive, action: onStop) {
                    Label("Stop", systemImage: "stop.fill").font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.bordered).controlSize(.large).tint(Theme.needsYou)
                .needsControl(client.mayControlConversation(state.id))
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }
}

private struct GoalBar: View {
    let goal: Goal?
    var body: some View {
        if let goal, !goal.objective.isEmpty, goal.status == "active" || goal.status == "paused" {
            HStack(spacing: 8) {
                Image(systemName: goal.status == "paused" ? "pause.circle" : "target").foregroundStyle(Theme.accent)
                Text(goal.objective).font(.footnote).lineLimit(2)
                Spacer(minLength: 0)
                if goal.status == "paused" { Text("Paused").font(.caption).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(.bar)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Goal: \(goal.objective)\(goal.status == "paused" ? ", paused" : "")")
        }
    }
}

private struct QueueChip: View {
    let queue: [QueueEntry]
    let drainAt: Date?
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "tray.full")
                Text("\(queue.count) queued").font(.subheadline.weight(.medium))
                if let drainAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let left = Int(drainAt.timeIntervalSince(context.date).rounded(.up))
                        Text(left > 0 ? "sends in \(left)s" : "sending…").font(.footnote).foregroundStyle(.secondary).monospacedDigit()
                    }
                } else {
                    Text("after this turn").font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.up").font(.footnote).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

private struct ReplyChips: View {
    let suggestions: [String]
    let send: (String) -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { text in
                    Button(text) { send(text) }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule)
                }
            }
        }
        .accessibilityLabel("Suggested replies")
    }
}

// MARK: Environment

private struct RunCommandKey: EnvironmentKey { static let defaultValue: (@MainActor (String) -> Void)? = nil }
private struct FileLinksKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// Set inside a chat: code blocks that look like shell commands offer Run in Terminal.
    var runCommand: (@MainActor (String) -> Void)? {
        get { self[RunCommandKey.self] } set { self[RunCommandKey.self] = newValue }
    }
    /// Set inside a chat: inline code that looks like a file path opens it on the laptop.
    var fileLinks: Bool {
        get { self[FileLinksKey.self] } set { self[FileLinksKey.self] = newValue }
    }
}

/// `nikui-file:` links for paths shown in answers; handled by the chat, never leave the app.
enum FileLink {
    static let scheme = "nikui-file"
    nonisolated(unsafe) private static let pattern = try! Regex(#"^(?:~|\.{1,2})?/?(?:[\w.@+-]+/)*[\w@+-]+\.[A-Za-z0-9]{1,8}(?::(\d+))?(?::\d+)?$"#)

    static func url(for text: String) -> URL? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard t.count < 300, !t.contains("://"), !t.contains(" "), t.contains("."),
              (try? pattern.wholeMatch(in: t)) != nil else { return nil }
        var parts = URLComponents(); parts.scheme = scheme; parts.path = t
        return parts.url
    }

    static func decode(_ url: URL) -> (String, Int?)? {
        guard let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path, !path.isEmpty else { return nil }
        let pieces = path.split(separator: ":")
        let line = pieces.count > 1 ? Int(pieces[1]) : nil
        return (String(pieces[0]), line)
    }
}
