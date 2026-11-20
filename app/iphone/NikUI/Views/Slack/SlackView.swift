import SwiftUI
import NikCore

/// The Slack inbox: what needs a reply, direct messages, channels. Slack
/// itself stays signed in on the laptop; this screen only reads and replies.
struct SlackView: View {
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @State private var search = ""
    @State private var showVIPs = false

    private var state: SlackState { client.slack.state }

    var body: some View {
        content
            .navigationTitle("Slack")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if state.connected && state.enabled {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showVIPs = true } label: { Label("VIPs", systemImage: "star") }
                    }
                }
            }
            .sheet(isPresented: $showVIPs) { SlackVIPSheet() }
    }

    @ViewBuilder private var content: some View {
        if !state.connected && !state.enabled && !state.signedOut && !state.hasTokens && state.sidebar.items.isEmpty {
            setup
        } else if state.signedOut {
            ScrollView { EmptyState(title: "Signed out of Slack", symbol: "person.crop.circle.badge.exclamationmark", message: "Sign in to Slack on the laptop. This iPhone cannot sign in.").padding(.top, 40) }
        } else if !state.enabled {
            VStack(spacing: 16) {
                EmptyState(title: "Slack is off", symbol: "bubble.left.and.bubble.right", message: "Turn on Slack to read and answer messages from here.")
                Button("Turn On Slack") { Task { await model.run(.slackEnable) } }
                    .buttonStyle(.borderedProminent)
                    .needsControl(client.mayControl)
            }
        } else if !state.connected {
            VStack(spacing: 16) {
                EmptyState(title: "Slack is not connected", symbol: "bolt.slash", message: state.error ?? "The laptop is not connected to Slack (\(state.socket.isEmpty ? "offline" : state.socket)).")
                if !state.sidebar.items.isEmpty { inbox.frame(maxHeight: .infinity) }
            }
        } else {
            inbox
        }
    }

    private var setup: some View {
        VStack(spacing: 16) {
            EmptyState(title: "Set up Slack", symbol: "number", message: "Create the Slack app, or paste a session, on the laptop. You can open the instructions here and finish there.")
            Button("Open Setup Instructions") { Task { await model.run(.slackSetup) } }
                .buttonStyle(.borderedProminent)
        }
    }

    // MARK: Inbox

    private func matches(_ item: SlackSidebarItem) -> Bool {
        let q = search.trimmingCharacters(in: .whitespaces)
        if q.isEmpty { return true }
        return item.title.localizedStandardContains(q) || (item.last?.text.localizedStandardContains(q) ?? false)
    }

    /// Muted last, then the given order.
    private func ordered(_ items: [SlackSidebarItem]) -> [SlackSidebarItem] {
        items.filter { !$0.muted } + items.filter(\.muted)
    }

    private var inbox: some View {
        let items = state.sidebar.items.filter(matches)
        let pending = ordered(items.filter(\.pending).sorted { ($0.pendingSince ?? .distantFuture) < ($1.pendingSince ?? .distantFuture) })
        let rest = items.filter { !$0.pending }
        let dms = ordered(rest.filter { $0.kind != "channel" })
        let channels = ordered(rest.filter { $0.kind == "channel" })
        return List {
            if let error = state.error {
                Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary) }
            }
            if !pending.isEmpty { Section("Needs you") { rows(pending) } }
            if !dms.isEmpty { Section("Direct messages") { rows(dms) } }
            if !channels.isEmpty { Section("Channels") { rows(channels) } }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $search, prompt: "Search conversations")
        .refreshable { await model.run(.slackRefresh) }
        .overlay {
            if items.isEmpty {
                if search.isEmpty {
                    EmptyState(title: state.sidebar.loaded ? "No Conversations" : "Loading", symbol: "bubble.left.and.bubble.right")
                } else {
                    ContentUnavailableView.search(text: search)
                }
            }
        }
    }

    private func rows(_ items: [SlackSidebarItem]) -> some View {
        ForEach(items) { item in
            Button { model.push(.slackThread(SlackThreadID(conversation: item.id))) } label: {
                SlackRow(item: item, clock: state.clock)
            }
            .buttonStyle(.plain)
            .swipeActions(edge: .trailing) {
                if item.mutedIn != "slack" {
                    Button { mute(item) } label: { Label(item.muted ? "Unmute" : "Mute", systemImage: item.muted ? "bell" : "bell.slash") }
                        .tint(.indigo)
                }
            }
            .contextMenu {
                Button { mute(item) } label: { Label(item.muted ? "Unmute" : "Mute", systemImage: item.muted ? "bell" : "bell.slash") }
                    .disabled(item.mutedIn == "slack" || !client.mayControl)
                if item.kind == "dm", state.mayEdit {
                    let key = item.user?.id ?? item.title
                    let isVIP = item.vip
                    Button { toggleVIP(key, add: !isVIP) } label: { Label(isVIP ? "Remove VIP" : "Add VIP", systemImage: isVIP ? "star.slash" : "star") }
                        .disabled(!client.mayControl)
                }
                Button { Task { await model.run(.slackLink(conversation: item.id)) } } label: { Label("Open in Slack", systemImage: "arrow.up.forward.app") }
            }
        }
    }

    private func mute(_ item: SlackSidebarItem) {
        guard client.mayControl else { model.show("This iPhone can only watch.", .warning); return }
        Task { await model.run(.slackMute(conversation: item.id, muted: !item.muted)) }
    }

    private func toggleVIP(_ key: String, add: Bool) {
        var list = state.vipList
        if add { list.append(key) } else { list.removeAll { $0.caseInsensitiveCompare(key) == .orderedSame } }
        Task { await model.run(.slackVIPs(list)) }
    }
}

private struct SlackRow: View {
    let item: SlackSidebarItem
    let clock: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if item.kind == "channel" { Image(systemName: item.isPrivate ? "lock" : "number").font(.footnote).foregroundStyle(.secondary) }
                    if item.kind == "group" { Image(systemName: "person.2").font(.footnote).foregroundStyle(.secondary) }
                    Text(item.title).font(.headline).fontWeight(item.unread ? .bold : .regular).lineLimit(1)
                    if item.vip { Image(systemName: "star.fill").font(.caption).foregroundStyle(.yellow).accessibilityLabel("VIP") }
                    if item.muted { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary).accessibilityLabel("Muted") }
                    Spacer(minLength: 4)
                    if let at = item.last?.at ?? item.latestAt {
                        Text(RelativeTime.format(at)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    Spacer(minLength: 4)
                    if item.mentions > 0 {
                        Text("\(item.mentions)").font(.caption.bold()).foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.needsYou, in: Capsule())
                            .accessibilityLabel("\(item.mentions) mentions")
                    } else if item.unread {
                        Circle().fill(Theme.unread).frame(width: 10, height: 10).accessibilityLabel("Unread")
                    }
                }
                if item.pending, let since = item.pendingSince {
                    Label("Waiting \(Format.duration(ms: Date.now.timeIntervalSince(since) * 1000))", systemImage: "clock")
                        .font(.caption).foregroundStyle(Theme.needsYou)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .opacity(item.muted ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }

    private var preview: String {
        guard let last = item.last else { return "No messages" }
        let text = SlackHTMLParser.plainText(last.text)
        if last.mine { return "You: " + text }
        if let from = last.from, item.kind != "dm" { return "\(from): " + text }
        return text
    }

    @ViewBuilder private var avatar: some View {
        let initials = item.user?.initials ?? String(item.title.prefix(1)).uppercased()
        Text(initials).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
            .frame(width: 40, height: 40)
            .background(item.kind == "channel" ? Color.indigo : Color.teal, in: item.kind == "channel" ? AnyShape(RoundedRectangle(cornerRadius: 10)) : AnyShape(Circle()))
            .accessibilityHidden(true)
    }
}

/// Add and remove VIPs. Names, IDs or emails; gated by `mayEdit`.
private struct SlackVIPSheet: View {
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var entry = ""

    private var state: SlackState { client.slack.state }
    private var canEdit: Bool { state.mayEdit && client.mayControl }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(state.vipList, id: \.self) { vip in
                        HStack {
                            Image(systemName: "star.fill").foregroundStyle(.yellow).accessibilityHidden(true)
                            Text(displayName(vip))
                            if state.unresolved.contains(vip) { Spacer(); Text("Not found").font(.footnote).foregroundStyle(.orange) }
                        }
                        .swipeActions { if canEdit { Button("Remove", role: .destructive) { save(state.vipList.filter { $0 != vip }) } } }
                    }
                    if state.vipList.isEmpty { Text("No VIPs yet").foregroundStyle(.secondary) }
                } header: { Text("VIPs") } footer: { Text("Messages from VIPs surface first.") }
                Section("Add") {
                    HStack {
                        TextField("Name, ID or email", text: $entry)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.done).onSubmit(add)
                        Button("Add", action: add).disabled(entry.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                .needsControl(canEdit)
            }
            .navigationTitle("VIPs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func displayName(_ vip: String) -> String { state.vips.first { $0.id == vip }?.name ?? vip }

    private func add() {
        let value = String(entry.trimmingCharacters(in: .whitespaces).prefix(100))
        guard !value.isEmpty, canEdit else { return }
        if state.vipList.contains(where: { $0.caseInsensitiveCompare(value) == .orderedSame }) { entry = ""; return }
        save(state.vipList + [value]); entry = ""
    }

    private func save(_ list: [String]) { Task { await model.run(.slackVIPs(list)) } }
}
