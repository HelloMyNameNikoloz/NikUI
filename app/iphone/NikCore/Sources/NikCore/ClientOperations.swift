import Foundation

struct TrackedRequest {
    var generation: UInt64
    var operation: PendingOperation
    var action: ClientAction
    var role: SocketRole
    var lane: String?
    var prURL: String?
    var draft: Draft?
    var continuation: AsyncStream<ActionResult>.Continuation?
    var timeout: Task<Void, Never>?
}
extension Draft {
    /// Delivery changes belong to the captured composition, not just matching words.
    func matchesComposition(_ other: Draft?) -> Bool {
        guard let other else { return false }
        return text == other.text && attachments == other.attachments && updatedAt == other.updatedAt
    }
}
extension ClientAction {
    var correlationID: String? {
        switch self { case .newInstance(let id, _, _, _), .resume(let id, _), .place(let id, _, _), .slackReply(let id, _, _, _), .voice(let id, _): return id; default: return nil }
    }
    var receiptLane: String? {
        switch self {
        case .newInstance, .resume, .place, .slackReply, .voice: return "id:" + (correlationID ?? "")
        case .prReply, .prResolve, .prComment, .prRerun, .prDiff: return "pr"
        case .setSetting: return "settings"
        case .saveCommand, .removeCommand, .restoreCommand: return "commands"
        case .setAwake, .setLid: return "awake"
        case .forget: return "forget"
        case .terminalList, .terminalOpen, .terminalAttach, .terminalRun, .terminalStop, .terminalClose: return "terminal"
        default: return nil
        }
    }
    var mutatesRemoteState: Bool {
        switch self { case .terminalList, .terminalAttach, .terminalDetach: return false; case .forget: return true; default: return requiresControl }
    }
    public func validate(on role: SocketRole, maximumWireBytes: Int = 24 * 1024 * 1024) throws {
        let fleetOnly: Bool
        let conversationOnly: Bool
        switch self {
        case .history, .watchCodex, .devices, .forget, .awake, .setAwake, .setLid, .newInstance, .resume, .place,
             .terminalList, .terminalOpen, .terminalAttach, .terminalDetach, .terminalRun, .terminalStop, .terminalClose,
             .slackReady, .slackRefresh, .slackOpen, .slackOlder, .slackFile, .slackReply, .slackVIPs, .slackMute, .slackEnable, .slackLink, .slackSetup:
            fleetOnly = true; conversationOnly = false
        case .visible, .send, .interrupt, .permission, .stopTask, .unqueue, .promoteQueued, .editQueued, .clearQueue, .openFile, .switchConversation, .runInTerminal,
             .statusOpen, .settings, .settingsOpen, .commands, .commandsOpen, .setSetting, .saveCommand, .removeCommand, .restoreCommand,
             .prWatch, .prRefresh, .prDiff, .prMentions, .prReply, .prResolve, .prComment, .prRerun, .prUnlink, .prAskThread, .prAskCheck, .prAskConflicts:
            fleetOnly = false; conversationOnly = true
        default: fleetOnly = false; conversationOnly = false
        }
        if fleetOnly, role != .fleet { throw CoreFailure(.invalidInput, "This operation requires the fleet connection.") }
        if conversationOnly, case .fleet = role { throw CoreFailure(.invalidInput, "This operation requires a conversation connection.") }
        if let id = correlationID, id.isEmpty || id.utf8.count > 64 { throw CoreFailure(.invalidInput, "The request ID must contain 1–64 bytes.") }
        func identifier(_ id: String, limit: Int = 40) throws {
            guard !id.isEmpty, id == id.trimmingCharacters(in: .whitespacesAndNewlines), id.count <= limit else { throw CoreFailure(.invalidInput, "The requested identifier is invalid.") }
        }
        switch self {
        case .newInstance(_, _, let provider, _): guard provider != .unknown else { throw CoreFailure(.invalidInput, "Choose Claude or Codex.") }
        case .terminalOpen(let session): if session?.hasPrefix("cx-") == true { throw CoreFailure(.unsupported, "This laptop can open a terminal beside Claude conversations only. Choose Home to open a separate terminal.") }
        case .send(let text, let attachments, let sent, _):
            guard !(sent ?? text).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else { throw CoreFailure(.invalidInput, "Write a message or attach an image.") }
            for image in attachments {
                guard image.mediaType.lowercased().hasPrefix("image/"), image.data.utf8.count <= 14 * 1024 * 1024,
                      let data = Data(base64Encoded: image.data), !data.isEmpty, data.count <= 10 * 1024 * 1024 else { throw CoreFailure(.tooLarge, "Each attachment must be an image of at most 10 MiB.") }
            }
        case .terminalRun(_, let command): guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, command.utf16.count <= 8000 else { throw CoreFailure(.invalidInput, "A terminal command must contain 1–8,000 characters.") }
        case .slackOpen(let id, let thread): try identifier(id); if let thread { try identifier(thread) }
        case .slackOlder(let id, let thread, let before): try identifier(id); try identifier(before); if let thread { try identifier(thread) }
        case .slackReply(_, let id, let text, let thread): try identifier(id); if let thread { try identifier(thread) }; guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 12000 else { throw CoreFailure(.invalidInput, "A Slack reply must contain 1–12,000 characters.") }
        case .slackMute(let id, _), .slackLink(let id, _): try identifier(id)
        case .slackFile(let id): try identifier(id, limit: 100)
        case .slackVIPs(let values): guard values.count <= 50, values.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 100 }) else { throw CoreFailure(.invalidInput, "Use up to 50 VIP entries of at most 100 characters.") }
        case .voice(_, let audio):
            guard audio.utf8.count <= 12_800_060, let data = Data(base64Encoded: audio) else { throw CoreFailure(.tooLarge, "The recording is too large or invalid.") }; _ = try WAV.inspect(data)
        case .appleToken(let token): guard (32...200).contains(token.utf8.count), RX.matches(#"^[0-9a-fA-F]+$"#, token), token.count % 2 == 0 else { throw CoreFailure(.invalidInput, "The APNs token is invalid.") }
        case .saveCommand(_, let name, let prompt, let description):
            guard RX.matches(#"^/?[A-Za-z][A-Za-z0-9_-]{0,39}$"#, name), !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, prompt.utf16.count <= 20000, description.utf16.count <= 300 else { throw CoreFailure(.invalidInput, "The snippet name, prompt, or description is invalid.") }
        case .setSetting(_, let value): guard value.boolValue != nil || value.stringValue != nil || value.doubleValue != nil else { throw CoreFailure(.invalidInput, "A setting must be a boolean, string, or number.") }
        default: break
        }
        let clear = try json.encoded().count
        // AES tag + unpadded ciphertext base64url + largest legal counter and JSON envelope.
        let cipher = clear + 16; let base64 = (cipher * 4 + 2) / 3
        let overhead = try JSONValue.object(["type": .string("@box"), "n": .number(Double(Box.counterCeiling - 1)), "c": .string("")]).encoded().count
        guard base64 + overhead <= maximumWireBytes else { throw CoreFailure(.tooLarge, "The message and attachments exceed the laptop's 24 MiB wire limit.") }
    }
}

@MainActor extension NikClient {
    func execute(_ action: ClientAction, role: SocketRole, sourceDraft: Draft? = nil, preservesDraft: Bool = false) async -> ActionResult {
        let generation = clientGeneration
        if Task.isCancelled { return .notSent(CoreFailure(.canceled, "The operation was canceled before sending.")) }
        do { try action.validate(on: role, maximumWireBytes: transportConfiguration.maximumSendBytes) }
        catch { return .notSent((error as? CoreFailure) ?? CoreFailure(.invalidInput, "The request is invalid.")) }
        if case .appleToken(let token) = action {
            pendingAppleToken = token; await manager?.rememberAppleToken(token)
        }
        guard generation == clientGeneration else { return .notSent(CoreFailure(.canceled, "The connection changed before sending.")) }
        if !preservesDraft, case .send(let text, let attachments, let sent, _) = action, let chat = role.conversationID {
            var current = conversation(chat)
            current.draft = sourceDraft ?? Draft(text: text.isEmpty && attachments.isEmpty ? sent ?? text : text, attachments: attachments, updatedAt: clock.now())
            conversationByID[chat] = current; schedulePersistence()
        }
        guard lifecycle == .foreground else { return .notSent(CoreFailure(.locked, "Unlock and return to NikUI before sending.")) }
        let state = role == .fleet ? connection : { if case .conversation(let id) = role { return conversation(id).connection }; return .offline }()
        guard state.isLive, isPreview || manager != nil else { return .notSent(CoreFailure(.offline, "The laptop is not connected. Your draft is preserved.")) }
        if action.requiresControl, seat?.control != true { return .notSent(CoreFailure(.refused, "This device may watch. Grant control on the laptop to use this action.")) }
        if case .forget(let id) = action, id != seat?.id, seat?.control != true { return .notSent(CoreFailure(.refused, "Only a controlling device can remove another device.")) }
        if role == .fleet {
            if case .history = action { beginSnapshot("history") }
            if case .ready = action { beginSnapshot("fleet") }
        }
        if case .newInstance(_, let cwd, let provider, _) = action {
            guard fleet.projects.contains(where: { $0.path == cwd }) || (provider == .codex && fleet.codex.contains(where: { $0.cwd == cwd })) else { return .notSent(CoreFailure(.invalidInput, "Choose a project offered by the laptop.")) }
        }
        if case .slackReply = action, !slack.state.mayReply { return .notSent(CoreFailure(.refused, "Slack replies are unavailable.")) }
        if case .slackVIPs = action, !slack.state.mayEdit { return .notSent(CoreFailure(.refused, "Slack editing is unavailable.")) }
        let lane = action.receiptLane
        if let lane, requests.values.contains(where: { $0.role == role && $0.lane == lane }) { return .notSent(CoreFailure(.refused, "Wait for the previous operation to finish.")) }
        let id = action.correlationID ?? UUID().uuidString
        guard requests[id] == nil else { return .notSent(CoreFailure(.invalidInput, "This request ID is already in use.")) }
        let operation = PendingOperation(id: id, action: action.type, createdAt: clock.now())
        let stream = lane == nil ? nil : AsyncStream<ActionResult>.makeStream(bufferingPolicy: .bufferingNewest(1))
        var draft: Draft?
        if !preservesDraft, case .conversation(let conversationID) = role, case .send = action {
            var current = conversation(conversationID)
            if current.draft.text.isEmpty, current.draft.attachments.isEmpty, case .send(let text, let attachments, _, _) = action { current.draft = Draft(text: text, attachments: attachments, updatedAt: clock.now()) }
            draft = current.draft; current.draft.delivery = .submitting; conversationByID[conversationID] = current
        }
        if case .slackOpen(let conversation, let thread) = action {
            let key = SlackThreadID(conversation: conversation, thread: thread); slack.selection = key
            if slack.threads[key] == nil { slack.threads[key] = SlackThreadState() }
        }
        if case .terminalAttach(let id) = action { terminal.selectedID = id }
        if case .slackReply(_, let conversation, let text, let thread) = action {
            let key = SlackThreadID(conversation: conversation, thread: thread)
            var current = slack.threads[key] ?? SlackThreadState()
            if current.draft.text.isEmpty { current.draft = Draft(text: text, updatedAt: clock.now()) }
            draft = current.draft; current.draft.delivery = .submitting; current.pending = operation; slack.threads[key] = current
        }
        if case .prMentions(let query) = action, case .conversation(let chat) = role { conversationByID[chat]?.pr.mentionQuery = query }
        if lane == "pr", case .conversation(let chat) = role {
            var current = conversation(chat); current.pr.pending = operation; conversationByID[chat] = current
        }
        if case .terminalRun = action { terminal.pending = operation }
        let track = lane != nil || (action.mutatesRemoteState && !preservesDraft)
        if track {
            requests[id] = TrackedRequest(generation: generation, operation: operation, action: action, role: role, lane: lane, prURL: role.conversationID.map { conversation($0).pr.url }, draft: draft, continuation: stream?.continuation)
            pendingOperations[id] = operation
        }
        if isPreview { return previewAction(action, role: role, operation: operation, preservesDraft: preservesDraft) }
        do {
            try await manager?.send(action, on: role)
            guard generation == clientGeneration else { return .ambiguous(PendingOperation(id: id, action: action.type, state: .ambiguous, createdAt: operation.createdAt, reason: "The connection changed during this operation.")) }
            if let ambiguous = pendingOperations[id], ambiguous.state == .ambiguous { return .ambiguous(ambiguous) }
            if requests[id] != nil { requests[id]?.operation.state = .submitted; pendingOperations[id]?.state = .submitted }
            if requests[id] != nil, case .conversation(let chat) = role, case .send = action, conversation(chat).draft.matchesComposition(draft) { conversationByID[chat]?.draft.delivery = .submitted }
            if requests[id] != nil, case .slackReply(_, let conversation, _, let thread) = action {
                let key = SlackThreadID(conversation: conversation, thread: thread)
                if slack.threads[key]?.draft.matchesComposition(draft) == true { slack.threads[key]?.draft.delivery = .submitted }
            }
            schedulePersistence()
            if let stream {
                // IDs correlate where available; PR/settings/terminal lanes serialize their uncorrelated receipts.
                let seconds: Double
                if case .voice(_, let audio) = action, let bytes = Data(base64Encoded: audio), let info = try? WAV.inspect(bytes) { seconds = 120 + info.seconds } else { seconds = 12 }
                if requests[id] != nil {
                    requests[id]?.timeout = Task { [weak self, clock] in
                        do { try await clock.sleep(for: .milliseconds(Int64(seconds * 1000))); try Task.checkCancellation(); self?.timeoutRequest(id, generation: generation) } catch {}
                    }
                }
                var iterator = stream.stream.makeAsyncIterator()
                if let result = await iterator.next() { return result }
                let ambiguous = PendingOperation(id: id, action: action.type, state: .ambiguous, createdAt: operation.createdAt, reason: "The request was canceled before a receipt arrived.")
                finishRequest(id, result: .ambiguous(ambiguous), generation: generation); return .ambiguous(ambiguous)
            }
            return .submitted(PendingOperation(id: id, action: action.type, state: .submitted, createdAt: operation.createdAt))
        } catch {
            guard generation == clientGeneration else { return .ambiguous(PendingOperation(id: id, action: action.type, state: .ambiguous, createdAt: operation.createdAt, reason: "The previous connection ended during this operation.")) }
            let failure = (error as? CoreFailure) ?? CoreFailure(.transport, "The connection was interrupted during the write.")
            if [.invalidInput, .tooLarge, .refused, .offline, .locked].contains(failure.code) {
                finishRequest(id, result: .notSent(failure)); return .notSent(failure)
            }
            let ambiguous = PendingOperation(id: id, action: action.type, state: .ambiguous, createdAt: operation.createdAt, reason: "The laptop may have received this operation. Check before retrying.")
            finishRequest(id, result: .ambiguous(ambiguous)); return .ambiguous(ambiguous)
        }
    }
    func timeoutRequest(_ id: String, generation: UInt64) {
        guard let request = requests[id], request.generation == generation else { return }
        let result: ActionResult = request.action.mutatesRemoteState ? .ambiguous(PendingOperation(id: id, action: request.action.type, state: .ambiguous, createdAt: request.operation.createdAt, reason: "The laptop did not confirm this operation. Check before retrying.")) : .notSent(CoreFailure(.timeout, "The laptop did not answer."))
        finishRequest(id, result: result)
    }
    func finishRequest(_ id: String, result: ActionResult, generation: UInt64? = nil) {
        if let generation, requests[id]?.generation != generation { return }
        guard let request = requests.removeValue(forKey: id) else { return }
        request.timeout?.cancel()
        let delivery: DeliveryState
        switch result { case .accepted: delivery = .accepted; case .ambiguous: delivery = .ambiguous; default: delivery = .failed }
        pendingOperations[id]?.state = delivery
        if case .ambiguous(let operation) = result { pendingOperations[id] = operation }
        if case .notSent(let error) = result { pendingOperations[id]?.reason = error.message }
        if case .send = request.action, let chat = request.role.conversationID, conversation(chat).draft.matchesComposition(request.draft) { conversationByID[chat]?.draft.delivery = delivery }
        if case .slackReply(_, let conversation, _, let thread) = request.action {
            let key = SlackThreadID(conversation: conversation, thread: thread)
            if slack.threads[key]?.pending?.id == id {
                if slack.threads[key]?.draft.matchesComposition(request.draft) == true {
                    if delivery == .accepted { slack.threads[key]?.draft = Draft(updatedAt: clock.now()) }
                    else { slack.threads[key]?.draft.delivery = delivery }
                }
                slack.threads[key]?.pending = nil
            }
        }
        if let chat = request.role.conversationID, request.lane == "pr", conversation(chat).pr.pending?.id == id {
            var state = conversation(chat)
            let key: String?
            switch request.action { case .prReply(let thread, let body): key = state.pr.drafts[thread] == body ? thread : nil; case .prComment(let body): key = state.pr.drafts["comment"] == body ? "comment" : nil; default: key = nil }
            if delivery == .accepted, state.pr.url == request.prURL, let key { state.pr.drafts[key] = nil }
            state.pr.pending = nil
            if case .notSent(let failure) = result { state.pr.error = failure.message }
            conversationByID[chat] = state
        }
        if request.lane == "terminal", terminal.pending?.id == id { terminal.pending = nil }
        request.continuation?.yield(result); request.continuation?.finish()
        if pendingOperations.count > 128 {
            let removable = pendingOperations.values.filter { [.accepted, .failed].contains($0.state) }.sorted { $0.createdAt < $1.createdAt }
            for value in removable.prefix(pendingOperations.count - 128) { pendingOperations[value.id] = nil }
        }
        schedulePersistence()
    }
    func markAmbiguous(on role: SocketRole?) {
        for request in Array(requests.values) where role == nil || request.role == role {
            if request.action.mutatesRemoteState {
                finishRequest(request.operation.id, result: .ambiguous(PendingOperation(id: request.operation.id, action: request.action.type, state: .ambiguous, createdAt: request.operation.createdAt, reason: "The connection changed before acceptance was known. Check the laptop snapshot before retrying.")))
            } else { finishRequest(request.operation.id, result: .notSent(CoreFailure(.offline, "The connection changed before the response arrived."))) }
        }
    }
    func resolveRequests(_ event: ServerEvent, role: SocketRole) {
        let outstanding = Array(requests.values)
        for request in outstanding where request.role == role {
            let action = request.action; var result: ActionResult?
            func accepted(_ raw: JSONValue = .null) -> ActionResult { .accepted(raw) }
            func refused(_ reason: String) -> ActionResult { .notSent(CoreFailure(.refused, reason)) }
            if let url = request.prURL, request.lane == "pr", let chat = role.conversationID, conversation(chat).pr.url != url { continue }
            switch (action, event) {
            case (_, .refused(let what, let reason, let id)) where id == request.operation.id || (id == nil && (what == action.type || what == action.type.replacingOccurrences(of: "pr:", with: ""))):
                let matches = outstanding.filter { $0.role == role && $0.action.type == what }.count
                if id == nil, request.lane == nil, matches > 1 {
                    result = .ambiguous(PendingOperation(id: request.operation.id, action: action.type, state: .ambiguous, createdAt: request.operation.createdAt, reason: "The laptop refused an operation without identifying which submission: " + reason))
                } else { result = refused(reason) }
            case (.newInstance(let id, _, _, _), .created(let answer, let instance)) where id == answer: result = accepted(.object(["id": .string(id), "instance": .string(instance)]))
            case (.resume(let id, _), .created(let answer, let instance)) where id == answer: result = accepted(.object(["id": .string(id), "instance": .string(instance)]))
            case (.place(let id, _, _), .placed(let answer)) where id == answer: result = accepted(.object(["id": .string(id)]))
            case (.slackReply(let id, _, _, _), .slack(.sent(let reply, let ok, let reason))) where id == reply: result = ok ? accepted(.object(["id": .string(id)])) : refused(reason ?? "Slack refused the reply.")
            case (.slackReply, .slack(.refused(let what, let reason))) where what == action.type || what == "reply": result = refused(reason)
            case (.voice(let id, _), .voiceText(let text)) where id == text.id: result = accepted(text.raw)
            case (.voice(let id, _), .voiceFailed(let answer, _, let reason)) where id == answer: result = refused(reason)
            case (_, .pr(.done(let done, let ok, let message))) where request.lane == "pr" && "pr:" + done == action.type: result = ok ? accepted(.object(["action": .string(done)])) : refused(message)
            case (.prDiff, .pr(.diff(let diff, let truncated))): result = accepted(.object(["diff": .string(diff), "truncated": .bool(truncated)]))
            case (.setSetting(let id, let value), .settings(let snapshot)):
                if let error = snapshot.refused, snapshot.refusedID == nil || snapshot.refusedID == id { result = refused(error) }
                else if snapshot.settings?.rows.contains(where: { $0.id == id && $0.value == value }) == true { result = accepted(snapshot.raw) }
            case (_, .commands(let snapshot)) where request.lane == "commands":
                if let error = snapshot.refused { result = refused(error) }
                else if snapshot.done == action.type { result = accepted(snapshot.raw) }
            case (.setAwake(let on), .awake(let state)):
                if let error = state.refused { result = refused(error) } else if state.available, state.on == on { result = accepted(state.raw) }
            case (.setLid(let on), .awake(let state)):
                if let error = state.refused { result = refused(error) } else if state.available, state.lid?.on == on { result = accepted(state.raw) }
            case (.forget(let id), .devices(let state)):
                if let error = state.refused { result = refused(error) } else if !state.devices.contains(where: { $0.id == id }) { result = accepted(state.raw) }
            case (.terminalList, .terminal(.list(let terminals))): result = accepted(.array(terminals.map(\.raw)))
            case (.terminalOpen, .terminal(.opened(let terminal))): result = accepted(terminal.raw)
            case (.terminalAttach(let id), .terminal(.scrollback(let terminal, let runs))) where id == terminal.id: result = accepted(.object(["terminal": terminal.raw, "runs": .array(runs.map(\.raw))]))
            case (.terminalRun(let id, let command), .terminal(.began(let terminal, let run))) where id == terminal.id && command == run.command: result = accepted(run.raw)
            case (.terminalStop(let id), .terminal(.done(let terminal, let run))) where id == terminal.id: result = accepted(run.raw)
            case (.terminalClose(let id), .terminal(.closed(let closed))) where id == closed: result = accepted(.object(["id": .string(id)]))
            case (_, .terminal(.refused(_, let reason))) where request.lane == "terminal": result = refused(reason)
            case (.permission(let id, let allow), .items(let items)) where items.contains(where: { $0.kind == "permission" && $0.requestId == id && $0.resolved == (allow ? "allow" : "deny") }): result = accepted()
            default: break
            }
            if let result { finishRequest(request.operation.id, result: result) }
        }
    }
}
extension SocketRole { var conversationID: String? { if case .conversation(let id) = self { return id }; return nil } }
