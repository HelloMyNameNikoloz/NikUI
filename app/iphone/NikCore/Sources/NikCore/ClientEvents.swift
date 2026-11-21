import Foundation

@MainActor extension NikClient {
    func receive(_ update: ConnectionUpdate, managerID: UUID? = nil) async {
        if let managerID, self.managerID != managerID { return }
        if lifecycle != .foreground {
            if case .state = update {} else { return }
        }
        switch update {
        case .state(let role, let state):
            if role == .fleet {
                connection = state
                if !state.isLive { report.isStale = true }
                else { beginSnapshot("fleet"); beginSnapshot("history") }
            }
            if let id = role.conversationID { var value = conversation(id); value.connection = state; if !state.isLive { value.report.isStale = true }; conversationByID[id] = value }
            if [.offline, .wrongLaptop].contains(state) { markAmbiguous(on: role) }
            if case .reconnecting = state { markAmbiguous(on: role) }
            if case .refused = state { markAmbiguous(on: role) }
            if case .failed = state { markAmbiguous(on: role) }
            continuation.yield(.connection(role, state))
        case .welcome(let role, let seat, let version):
            if role == .fleet || self.seat == nil { self.seat = seat }
            if let version { extensionVersion = version }; lastFailure = nil
        case .event(let role, let event): ingest(event, on: role)
        case .failure(let role, let failure):
            // A requested self-removal is confirmed by the server's policy close, even without a list receipt.
            if failure.code == .refused, failure.message == "this device was removed", let own = seat?.id {
                for request in Array(requests.values) { if case .forget(let id) = request.action, id == own { finishRequest(request.operation.id, result: .accepted(.null)) } }
            }
            markAmbiguous(on: role); fail(failure)
        }
    }
    /// Deterministic event injection also supports UI fixtures and contract tests without a network.
    public func ingest(_ event: ServerEvent, on role: SocketRole = .fleet) {
        resolveRequests(event, role: role)
        let now = clock.now()
        switch event {
        case .fleet(let value): fleet = value; fleetStatus.receive(at: now); snapshotTimeouts["fleet"]?.cancel(); schedulePersistence()
        case .history(let value):
            history = value.raw["entries"].isNull ? HistorySnapshot(history.raw.merged(with: value.raw)) : value
            historyStatus.receive(at: now); snapshotTimeouts["history"]?.cancel()
        case .devices(let value): devices = value.raw["devices"].isNull ? DevicesSnapshot(devices.raw.merged(with: value.raw)) : value
        case .awake(let value): awake = value
        case .device(let value): seat = value
        case .report(let available, let value, let trouble):
            if role == .fleet { report.receive(available: available, value: value, trouble: trouble, at: now) }
        case .terminal(let value):
            terminal.reduce(value)
            if case .opened(let descriptor) = value { Task { [weak self] in _ = await self?.perform(.terminalAttach(descriptor.id)) } }
        case .slack(let value):
            slack.reduce(value)
            if case .link(let text) = value, let url = URL(string: text), ["https", "http", "slack", "mailto"].contains(url.scheme?.lowercased() ?? "") { setIntent(.externalURL(url)) }
        case .navigate(let id): if !id.isEmpty { setIntent(.navigate(id)) }
        case .created(_, let instance): if !instance.isEmpty { setIntent(.navigate(instance)) }
        case .focus: setIntent(.focus)
        case .openStatus: setIntent(.report)
        case .notify(let event): _ = handleNotification(event)
        case .voiceState(let value): let previous = voice.building; voice = value; if previous != voice.building { restartPolling() }
        case .refused(_, let reason, _): fail(CoreFailure(.refused, reason))
        default: break
        }
        if let id = role.conversationID {
            var state = conversation(id); let oldURL = state.pr.url
            state.reduce(event, at: now)
            if oldURL != state.pr.url {
                for request in Array(requests.values) where request.role == role && request.lane == "pr" {
                    finishRequest(request.operation.id, result: .ambiguous(PendingOperation(id: request.operation.id, action: request.action.type, state: .ambiguous, createdAt: request.operation.createdAt, reason: "The linked PR changed before the result arrived.")))
                }
            }
            conversationByID[id] = state
            var recall = promptHistories[id] ?? PromptHistory()
            switch event {
            case .initialized(let snapshot): for item in snapshot.items where item.kind == "user" { recall.remember(item.text, itemID: item.id) }
            case .items(let items): for item in items where item.kind == "user" { recall.remember(item.text, itemID: item.id) }
            case .draft, .editPrompt: schedulePersistence()
            default: break
            }
            promptHistories[id] = recall
        }
        continuation.yield(.server(role, event))
    }
    @discardableResult public func handleNotification(_ event: NotificationEvent) -> NotificationPresentation? {
        guard let presentation = notifications.receive(event, preferences: preferences.notifications, locked: lifecycle == .locked || lifecycle == .inactive, at: clock.now()) else { return nil }
        var safe = event; safe.raw["title"] = .string(presentation.title); safe.raw["body"] = .string(presentation.body)
        continuation.yield(.notification(safe)); return presentation
    }
    public func recallOlder(conversationID: String) -> String? {
        var recall = promptHistories[conversationID] ?? PromptHistory()
        let value = recall.older(draft: conversation(conversationID).draft.text); promptHistories[conversationID] = recall
        if let value { var draft = conversation(conversationID).draft; draft.text = value; setDraft(draft, conversationID: conversationID) }; return value
    }
    public func recallNewer(conversationID: String) -> String? {
        var recall = promptHistories[conversationID] ?? PromptHistory()
        let value = recall.newer(); promptHistories[conversationID] = recall
        if let value { var draft = conversation(conversationID).draft; draft.text = value; setDraft(draft, conversationID: conversationID) }; return value
    }
    public func suggestedReplies(conversationID: String) -> [String] {
        let state = conversation(conversationID)
        guard mayControl, state.configuration.replySuggestions, state.draft.text.isEmpty, state.draft.attachments.isEmpty,
              ![.working, .waiting].contains(state.status), let lastResult = state.items.lastIndex(where: { $0.kind == "result" }),
              !state.items[lastResult].isError, !state.items[lastResult].interrupted,
              lastResult == state.items.count - 1 else { return [] }
        guard let answer = state.items[..<lastResult].last(where: { $0.kind == "text" && !$0.streaming }) else { return [] }
        return ReplySuggestions.replies(answer.text)
    }
    public func handleMemoryPressure() {
        for id in Array(conversationByID.keys) where id != selectedConversationID {
            conversationByID[id]?.items.removeAll(); conversationByID[id]?.pr.snapshot = nil; conversationByID[id]?.report.report = nil; conversationByID[id]?.initialized = false
        }
        slack.files.removeAll()
    }
    func previewAction(_ action: ClientAction, role: SocketRole, operation: PendingOperation, preservesDraft: Bool = false) -> ActionResult {
        var payload: JSONValue = .null
        switch action {
        case .send(let text, let attachments, _, let snippets):
            if let id = role.conversationID {
                ingest(.items([TranscriptItem(.object(["id": .string(UUID().uuidString), "kind": .string("user"), "text": .string(text), "images": .array(attachments.map(\.raw)), "snippets": .array(snippets.map(JSONValue.string)), "at": .number(WireDate.milliseconds(clock.now()))]))]), on: role)
                if !preservesDraft { conversationByID[id]?.draft.delivery = .submitted }
            }
        case .permission(let id, let allow):
            if let chat = role.conversationID, var item = conversation(chat).items.first(where: { $0.requestId == id }) { item.raw["resolved"] = .string(allow ? "allow" : "deny"); ingest(.items([item]), on: role) }
        case .interrupt: if let chat = role.conversationID { conversationByID[chat]?.status = .stopped }
        case .terminalList: ingest(.terminal(.list(terminal.terminals)))
        case .terminalOpen:
            let descriptor = TerminalDescriptor(.object(["id": .string("term-" + UUID().uuidString), "name": .string("Home"), "cwd": .string("/Users/nik"), "busy": .bool(false)])); ingest(.terminal(.opened(descriptor))); payload = descriptor.raw
        case .terminalRun(let id, let command):
            let descriptor = terminal.terminals.first(where: { $0.id == id }) ?? PreviewFixtures.terminal
            let run = TerminalRun(.object(["id": .string(UUID().uuidString), "terminal": .string(id), "command": .string(command), "cwd": .string(descriptor.cwd), "at": .number(WireDate.milliseconds(clock.now())), "exit": .number(0), "done": .bool(true), "output": .string("Preview command completed.\n"), "tookMs": .number(125)])); ingest(.terminal(.done(descriptor, run))); payload = run.raw
        case .slackReply(let id, let conversation, let text, let thread):
            let key = SlackThreadID(conversation: conversation, thread: thread)
            let message = SlackMessage(.object(["ts": .string(String(clock.now().timeIntervalSince1970)), "name": .string("You"), "initials": .string("NI"), "mine": .bool(true), "html": .string(HTMLPreview.escape(text)), "at": .number(WireDate.milliseconds(clock.now()))]))
            slack.threads[key]?.messages.append(message); ingest(.slack(.sent(id: id, ok: true, reason: nil)))
        case .setAwake(let on): awake.raw["on"] = .bool(on); awake.raw["held"] = .bool(on)
        case .setLid(let on): var lid = awake.raw["lid"]; lid["on"] = .bool(on); awake.raw["lid"] = lid
        case .prRefresh: if let id = role.conversationID { conversationByID[id]?.pr.loading = false }
        case .slackOpen(let id, let thread): slack.selection = SlackThreadID(conversation: id, thread: thread)
        case .newInstance(let requestID, let cwd, let provider, _):
            let id = (provider == .codex ? "cx-" : "") + UUID().uuidString
            var row: JSONValue = .object(["id": .string(id), "label": .string("New conversation"), "cwd": .string(cwd), "status": .string("idle"), "provider": .string(provider.rawValue)])
            row["activeAt"] = .number(WireDate.milliseconds(clock.now()))
            let key = provider == .codex ? "codex" : "instances"; fleet.raw[key] = .array(fleet.raw[key].arrayValue + [row]); ingest(.created(id: requestID, instance: id)); payload = .object(["instance": .string(id)])
        default: break
        }
        if action.receiptLane != nil { finishRequest(operation.id, result: .accepted(payload)); return .accepted(payload) }
        pendingOperations[operation.id]?.state = .submitted
        return .submitted(PendingOperation(id: operation.id, action: action.type, state: .submitted, createdAt: operation.createdAt))
    }
}
private enum HTMLPreview {
    static func escape(_ value: String) -> String { value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
}
