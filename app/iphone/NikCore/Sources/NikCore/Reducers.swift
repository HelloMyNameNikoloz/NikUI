import Foundation

extension ConversationState {
    /// Applies authoritative snapshots/partial cumulative item updates while preserving private UI state.
    public mutating func reduce(_ event: ServerEvent, at now: Date = Date()) {
        switch event {
        case .initialized(let snapshot):
            clientID = snapshot.client; items = Self.unique(snapshot.items); meta = snapshot.meta; status = snapshot.status
            stats = snapshot.stats; statsReceivedAt = now; configuration = snapshot.configuration
            queue = snapshot.queue; drainAt = snapshot.drainAt; dropped = snapshot.dropped; maxItems = max(0, snapshot.maxItems)
            initialized = true; trim()
            run = snapshot.run; controlSnapshotFresh = true
        case .items(let incoming):
            var index = Dictionary(items.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { _, b in b })
            for item in incoming where !item.id.isEmpty {
                if let position = index[item.id] { items[position].raw = items[position].raw.merged(with: item.raw) }
                else { index[item.id] = items.count; items.append(item) }
            }
            trim()
        case .meta(let metadata, let render):
            meta.raw = meta.raw.merged(with: metadata.raw); configuration.raw = configuration.raw.merged(with: render.raw)
        case .conversationStatus(let value): status = value
        case .runStatus(let value, let run): status = value; self.run = run
        case .runMeta(let metadata, let render, let run):
            meta.raw = meta.raw.merged(with: metadata.raw); configuration.raw = configuration.raw.merged(with: render.raw); self.run = run
        case .stats(let value): stats = value; statsReceivedAt = now
        case .queue(let value, let at): queue = value; drainAt = at
        case .reset:
            items.removeAll(); dropped = 0; reading.findQuery = ""; reading.selectedMatch = nil; reading.expandedItemIDs.removeAll()
        case .presence(let clients): presence = clients.filter { $0.id != clientID }
        case .draft(let text):
            if !text.isEmpty { draft.text += (draft.text.isEmpty ? "" : "\n") + text; draft.updatedAt = now; draft.delivery = .draft; draft.compositionID = V2Wire.randomID(); draft.sent = nil; draft.snippets = nil }
        case .editPrompt(let text):
            editPromptRevision &+= 1
            if !text.isEmpty { draft.text = text + (draft.text.isEmpty ? "" : "\n\n" + draft.text); draft.updatedAt = now; draft.delivery = .draft; draft.compositionID = V2Wire.randomID(); draft.sent = nil; draft.snippets = nil }
        case .statusReport(let value): report.receive(available: true, value: value, trouble: nil, at: now)
        case .report(let available, let value, let trouble): report.receive(available: available, value: value, trouble: trouble, at: now)
        case .settings(let value):
            if value.settings != nil { settings = value } else { settings.raw = settings.raw.merged(with: value.raw) }
        case .commands(let value):
            if value.available { commands = value } else { commands.raw = commands.raw.merged(with: value.raw) }
        case .pr(let value): pr.reduce(value)
        default: break
        }
    }
    private static func unique(_ incoming: [TranscriptItem]) -> [TranscriptItem] {
        var result: [TranscriptItem] = []; var index: [String: Int] = [:]
        for (offset, original) in incoming.enumerated() {
            var item = original
            if item.id.isEmpty { item.raw["id"] = .string("unknown:\(offset)") }
            if let i = index[item.id] { result[i].raw = result[i].raw.merged(with: item.raw) }
            else { index[item.id] = result.count; result.append(item) }
        }
        return result
    }
    private mutating func trim() {
        guard maxItems > 0, items.count > maxItems else { return }
        let wanted = items.count - maxItems
        let protected = items.firstIndex(where: \.isLive) ?? items.count
        let count = min(wanted, protected)
        if count > 0 { items.removeFirst(count); dropped += count }
    }
    public func runningElapsed(at now: Date, live: Bool) -> TimeInterval {
        stats.elapsedMs / 1_000 + ((stats.running && live) ? max(0, now.timeIntervalSince(statsReceivedAt ?? now)) : 0)
    }
    public func queueRemaining(at now: Date) -> TimeInterval? { drainAt.map { max(0, $0.timeIntervalSince(now)) } }
}
extension ReportState {
    public mutating func receive(available: Bool, value: Report?, trouble: String?, at now: Date) {
        revision &+= 1
        self.available = available; self.trouble = trouble
        if let value { report = value; receivedAt = now; isStale = false }
        else if trouble != nil || !available { isStale = true }
        else { report = nil; receivedAt = now; isStale = false }
    }
}
extension PRFeatureState {
    public mutating func reduce(_ event: PREvent) {
        switch event {
        case .state(let value):
            if value.prUrl != url {
                if !url.isEmpty { draftsByURL[url] = drafts; tabsByURL[url] = tab }
                drafts = draftsByURL[value.prUrl] ?? (url.isEmpty && draftsByURL.isEmpty ? drafts : [:])
                tab = tabsByURL[value.prUrl] ?? "conversation"
                snapshot = nil; diff = nil; mentions = nil; pending = nil
            }
            url = value.prUrl; loading = value.loading; error = value.error
            if let offered = value.state { snapshot = offered }
        case .diff(let text, let truncated): diff = text; diffTruncated = truncated
        case .mentions(let value): if value.url == url, value.query == mentionQuery { mentions = value }
        case .done(let action, let ok, let message):
            guard let operation = pending, operation.action == "pr:" + action else { return }
            if ok { pending = nil; error = nil }
            else { pending?.state = .failed; pending?.reason = message; error = message }
        }
    }
}
extension RenderConfiguration {
    /// The config must not retain an init envelope's whole transcript after trimming/reset.
    public static func fromEnvelope(_ envelope: JSONValue) -> RenderConfiguration {
        let keys: Set<String> = ["slashCommands", "commandArgs", "ownCommands", "snippets", "showThinking", "clock", "replySuggestions", "singleEscape", "font", "fontSize"]
        return RenderConfiguration(.object(envelope.objectValue.filter { keys.contains($0.key) }))
    }
}
extension TerminalRun {
    /// Use for row identity until the laptop adds monotonic run IDs. The wire ID remains `id`.
    public var displayID: String { id + ":" + String(number("at")) + ":" + command }
}
extension TerminalState {
    public mutating func reduce(_ event: TerminalEvent) {
        func replace(_ list: inout [TerminalDescriptor], _ terminal: TerminalDescriptor) {
            if let i = list.firstIndex(where: { $0.id == terminal.id }) { list[i] = terminal } else { list.append(terminal) }
        }
        switch event {
        case .list(let values): freshControlIDs = Set(values.map(\.id))
        case .opened(let value), .scrollback(let value, _), .began(let value, _), .done(let value, _): freshControlIDs.insert(value.id)
        case .closed(let id): freshControlIDs.remove(id)
        default: break
        }
        switch event {
        case .list(let list): terminals = list
        case .opened(let terminal): replace(&terminals, terminal); selectedID = terminal.id; error = nil
        case .scrollback(let terminal, let runs): replace(&terminals, terminal); runsByTerminal[terminal.id] = Array(runs.suffix(60)); error = nil
        case .began(var terminal, let run):
            terminal.raw["busy"] = .bool(true); terminal.raw["command"] = .string(run.command); replace(&terminals, terminal)
            var runs = runsByTerminal[terminal.id] ?? []
            if let i = runs.lastIndex(where: { $0.displayID == run.displayID }) { runs[i] = run } else { runs.append(run) }
            runsByTerminal[terminal.id] = Array(runs.suffix(60)); pending = nil; error = nil
        case .output(let terminal, let id, _, let text):
            guard var runs = runsByTerminal[terminal], let i = runs.lastIndex(where: { $0.id == id && !$0.done }) else { return }
            let output = runs[i].output + text
            runs[i].raw["output"] = .string(output.utf16.count > 200 * 1024 ? "…\n" + String(decoding: output.utf16.suffix(200 * 1024), as: UTF16.self) : output)
            runsByTerminal[terminal] = runs
        case .done(let terminal, let run):
            replace(&terminals, terminal)
            var runs = runsByTerminal[terminal.id] ?? []
            if let i = runs.lastIndex(where: { $0.displayID == run.displayID }) { runs[i] = run } else { runs.append(run) }
            runsByTerminal[terminal.id] = Array(runs.suffix(60)); pending = nil
        case .closed(let id): terminals.removeAll { $0.id == id }; runsByTerminal.removeValue(forKey: id); if selectedID == id { selectedID = nil }
        case .refused(_, let reason): error = reason; pending?.state = .failed; pending?.reason = reason
        }
    }
}
extension SlackFeatureState {
    public mutating func reduce(_ event: SlackEvent) {
        switch event {
        case .state(let value): state = value; error = value.error
        case .thread(let page), .older(let page):
            let key = SlackThreadID(conversation: page.conversation.id, thread: page.thread)
            // Unsolicited broadcasts may update retained threads, but never select another route.
            guard selection == key || threads[key] != nil else { return }
            var current = threads[key] ?? SlackThreadState()
            current.conversation.raw = current.conversation.raw.merged(with: page.conversation.raw)
            if case .older = event {
                var seen = Set<String>()
                current.messages = (page.messages + current.messages).filter { seen.insert($0.ts).inserted }
            } else { current.messages = page.messages }
            current.hasMore = page.hasMore; current.error = nil
            threads[key] = current
        case .sent(let id, let ok, let reason):
            guard let key = threads.first(where: { $0.value.pending?.id == id })?.key else { return }
            if ok { threads[key]?.pending = nil; threads[key]?.error = nil }
            else { threads[key]?.pending?.state = .failed; threads[key]?.draft.delivery = .failed; threads[key]?.error = reason ?? "Slack did not send the reply." }
        case .file(let id, let ok, let data, let reason):
            if ok, let data, data.utf8.count <= 16 * 1024 * 1024 {
                if files.count >= 40 { files.removeAll() }; files[id] = data; fileErrors[id] = nil
                // Bound aggregate retained base64, independently of count.
                if files.values.reduce(0, { $0 + $1.utf8.count }) > 25 * 1024 * 1024 { files = [id: data] }
            } else { fileErrors[id] = reason ?? "The image is unavailable." }
        case .refused(_, let reason): error = reason
        default: break
        }
    }
    public func sections(query: String = "") -> [(name: String, items: [SlackSidebarItem])] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let rows = state.sidebar.items.filter { q.isEmpty || ($0.title + " " + ($0.last?.text ?? "")).localizedCaseInsensitiveContains(q) }
        func sorted(_ list: [SlackSidebarItem], pending: Bool = false) -> [SlackSidebarItem] {
            list.enumerated().sorted { a, b in
                if a.element.muted != b.element.muted { return !a.element.muted }
                if pending, a.element.pendingSince != b.element.pendingSince { return (a.element.pendingSince ?? .distantFuture) < (b.element.pendingSince ?? .distantFuture) }
                return a.offset < b.offset
            }.map(\.element)
        }
        return [("Needs you", sorted(rows.filter(\.pending), pending: true)),
                ("Direct messages", sorted(rows.filter { !$0.pending && $0.kind != "channel" })),
                ("Channels", sorted(rows.filter { !$0.pending && $0.kind == "channel" }))].filter { !$0.1.isEmpty }
    }
}
