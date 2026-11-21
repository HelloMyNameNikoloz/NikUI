import Foundation

struct ComposerQuery: Sendable {
    var id = UUID()
    let action: String
    let draft: Draft
    let origin: String
    let selection: String?
    let prURL: String?
    var expired = false
    var timeout: Task<Void, Never>?
}
extension ClientAction {
    var isComposerQuery: Bool { switch self { case .prAskThread, .prAskCheck, .prAskConflicts: true; default: false } }
}
@MainActor extension NikClient {
    func beginComposerQuery(_ action: ClientAction, role: SocketRole) -> Bool {
        guard composerQueries[role] == nil, let chat = role.conversationID else { return false }
        guard !pendingIntents.values.contains(where: { $0.target == role.target && $0.what == "editQueued" && ($0.state == .pending || $0.isQuarantined) }) else { return false }
        let state = conversation(chat)
        var query = ComposerQuery(action: action.type, draft: state.draft, origin: selectionOrigin, selection: selectedConversationID, prURL: state.pr.url.isEmpty ? state.meta.prUrl : state.pr.url)
        let id = query.id
        query.timeout = Task { [weak self, clock] in
            do { try await clock.sleep(for: .seconds(12)); try Task.checkCancellation() } catch { return }
            guard let self, self.composerQueries[role]?.id == id else { return }
            // An uncorrelated late reply must drain before this lane can be reused.
            self.composerQueries[role]?.expired = true
        }
        composerQueries[role] = query; return true
    }
    func clearComposerQuery(_ role: SocketRole) { composerQueries.removeValue(forKey: role)?.timeout?.cancel() }
    func mayApplyComposerReply(on role: SocketRole) -> Bool {
        guard let query = composerQueries[role], let chat = role.conversationID else { return false }
        clearComposerQuery(role)
        let state = conversation(chat), url = state.pr.url.isEmpty ? state.meta.prUrl : state.pr.url
        return !query.expired && query.origin == selectionOrigin && query.selection == selectedConversationID && query.prURL == url && state.draft.matchesComposition(query.draft)
    }
    func captureIntent(_ action: ClientAction, role: SocketRole, sourceDraft: Draft?, preservesDraft: Bool, supplied: IntentMetadata?) throws -> IntentMetadata {
        var metadata = supplied ?? IntentMetadata()
        metadata.mid = metadata.mid ?? V2Wire.randomID(); metadata.selection = selectedConversationID; metadata.origin = selectionOrigin
        let state = role.conversationID.map { conversation($0) }
        metadata.prDraftRevision = state?.pr.draftRevision
        metadata.draft = sourceDraft ?? state?.draft ?? selectedConversation?.draft
        metadata.updatesDraft = !preservesDraft && action.type == "send"
        func bind(_ run: RunRef?) throws {
            guard state?.controlSnapshotFresh == true else { throw CoreFailure(.refused, "Refresh the conversation before using this control. Your draft is preserved.") }
            if metadata.fields["run"] != nil { _ = try RunRef(validating: metadata.fields["run"]!); return }
            guard let run, run.turn != nil else { throw CoreFailure(.refused, "Refresh the conversation before using this control. Your draft is preserved.") }
            metadata.fields["run"] = run.raw
        }
        switch action {
        case .permission(let requestID, _): try bind(state?.permissions.first(where: { $0.requestId == requestID })?.run)
        case .interrupt: try bind(state?.run)
        case .stopTask(let taskID):
            if state?.meta.provider == .codex { throw CoreFailure(.unsupported, "Codex does not support stopping background tasks.") }
            try bind(state?.stats.shellList.first(where: { $0.id == taskID && !$0.stopping })?.run)
        case .send(let text, _, _, _):
            if text.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^/steer(?:\s|$)"#, options: [.regularExpression, .caseInsensitive]) != nil { try bind(state?.run) }
            if metadata.fields["answerTo"] == nil, let answer = sourceDraft?.answerTo { metadata.fields["answerTo"] = answer.raw }
            if let answer = metadata.fields["answerTo"] {
                guard state?.controlSnapshotFresh == true else { throw CoreFailure(.refused, "Refresh the question before answering. Your draft is preserved.") }
                _ = try QuestionRef(validating: answer)
            }
            if state?.activeQuestion != nil, metadata.fields["answerTo"] == nil { throw CoreFailure(.refused, "This prompt is not bound to the current question. Review it before answering; your draft is preserved.") }
            if metadata.fields["retryOf"] == nil, let sourceDraft,
               let earlier = pendingIntents.values.first(where: { $0.target == role.target && $0.isQuarantined && $0.what == "send" && $0.draft?.text.utf8.elementsEqual(sourceDraft.text.utf8) == true && $0.draft?.attachments == sourceDraft.attachments }) {
                metadata.fields["retryOf"] = .string(earlier.mid)
            }
        case .promoteQueued:
            if metadata.fields["mode"] == nil { metadata.fields["mode"] = .string(state?.meta.provider == .codex && state?.status == .working ? "steer" : "reorder") }
            if metadata.fields["mode"]?.stringValue == "steer" { try bind(state?.run) }
        case .prReply, .prResolve, .prComment, .prRerun, .prUnlink:
            if metadata.fields["prUrl"] == nil {
                guard let url = state?.pr.url.isEmpty == false ? state?.pr.url : state?.meta.prUrl, !url.isEmpty else { throw CoreFailure(.refused, "Refresh the linked PR before changing it.") }
                metadata.fields["prUrl"] = .string(url)
            }
        case .terminalStop(let id), .terminalClose(let id):
            guard terminal.freshControlIDs.contains(id) else { throw CoreFailure(.refused, "Refresh the terminal list before stopping or closing a command.") }
            if metadata.fields["terminalRun"] == nil {
                guard let descriptor = terminal.terminals.first(where: { $0.id == id }), let observed = descriptor.raw.objectValue["activeRun"] else { throw CoreFailure(.refused, "Refresh the terminal list before stopping or closing a command.") }
                metadata.fields["terminalRun"] = observed
            }
        case .slackReply(_, let conversation, let text, let thread):
            let key = SlackThreadID(conversation: conversation, thread: thread)
            var current = slack.threads[key] ?? SlackThreadState()
            if current.draft.text.isEmpty { current.draft = Draft(text: text, updatedAt: clock.now()); slack.threads[key] = current }
            metadata.draft = current.draft; metadata.updatesDraft = true
        default: break
        }
        return metadata
    }
    func executeV2(_ action: ClientAction, role: SocketRole, sourceDraft: Draft?, preservesDraft: Bool, metadata supplied: IntentMetadata?) async -> ActionResult {
        let generation = clientGeneration
        if case .editQueued = action, composerQueries[role] != nil { return .notSent(CoreFailure(.refused, "Wait for the current draft query before reclaiming a queued prompt.")) }
        let lane = action.receiptLane
        if let lane, requests.values.contains(where: { $0.role == role && $0.lane == lane }) { return .notSent(CoreFailure(.refused, "Wait for the previous operation to finish.")) }
        var metadata: IntentMetadata
        do { metadata = try captureIntent(action, role: role, sourceDraft: sourceDraft, preservesDraft: preservesDraft, supplied: supplied) }
        catch { return .notSent((error as? CoreFailure) ?? CoreFailure(.invalidInput, "Invalid mutation preconditions.")) }
        if let mid = metadata.mid, let original = pendingIntents[mid] {
            metadata.draft = original.draft; metadata.selection = original.selection; metadata.origin = original.origin
            metadata.updatesDraft = original.updatesDraft; metadata.prDraftRevision = original.prDraftRevision
        }
        let id = metadata.mid!, operation = PendingOperation(id: id, action: action.type, createdAt: clock.now())
        guard requests[id] == nil else { return .notSent(CoreFailure(.invalidInput, "This intent is already in flight.")) }
        let stream = AsyncStream<ActionResult>.makeStream(bufferingPolicy: .bufferingNewest(1))
        requests[id] = TrackedRequest(v2: true, generation: generation, operation: operation, action: action, role: role, lane: lane, prURL: metadata.fields["prUrl"]?.stringValue, draft: metadata.updatesDraft ? metadata.draft : nil, continuation: stream.continuation)
        pendingOperations[id] = operation
        if metadata.updatesDraft, action.type == "send", let chat = role.conversationID { conversationByID[chat]?.draft.delivery = .submitting }
        if case .slackReply(_, let conversation, _, let thread) = action { slack.threads[SlackThreadID(conversation: conversation, thread: thread)]?.pending = operation }
        if case .slackOpen(let conversation, let thread) = action {
            let key = SlackThreadID(conversation: conversation, thread: thread); slack.selection = key
            if slack.threads[key] == nil { slack.threads[key] = SlackThreadState() }
        }
        if lane == "pr", let chat = role.conversationID { conversationByID[chat]?.pr.pending = operation }
        if case .terminalRun = action { terminal.pending = operation }
        do {
            guard let manager else { throw CoreFailure(.offline, "The laptop is not connected.") }
            try await manager.send(action, on: role, metadata: metadata)
            if generation != clientGeneration { return .ambiguous(PendingOperation(id: id, action: action.type, state: .ambiguous, createdAt: operation.createdAt, reason: "The connection changed. The original intent is retained for reconciliation.")) }
            if requests[id] != nil {
                requests[id]?.operation.state = .submitted; pendingOperations[id]?.state = .submitted
                if metadata.updatesDraft, let chat = role.conversationID, conversation(chat).draft.matchesComposition(metadata.draft) { conversationByID[chat]?.draft.delivery = .submitted }
                requests[id]?.timeout = Task { [weak self, clock] in
                    do { try await clock.sleep(for: .seconds(12)); try Task.checkCancellation(); self?.timeoutRequest(id, generation: generation) } catch {}
                }
            }
            schedulePersistence()
            var iterator = stream.stream.makeAsyncIterator()
            if let result = await iterator.next() { return result }
            let ambiguous = PendingOperation(id: id, action: action.type, state: .ambiguous, createdAt: operation.createdAt, reason: "Awaiting the original intent's receipt.")
            finishRequest(id, result: .ambiguous(ambiguous)); return .ambiguous(ambiguous)
        } catch {
            let failure = (error as? CoreFailure) ?? CoreFailure(.transport, "The connection was interrupted during the write.")
            let result: ActionResult
            if pendingIntents[id] == nil { result = .notSent(failure) }
            else { result = .ambiguous(PendingOperation(id: id, action: action.type, state: .ambiguous, createdAt: operation.createdAt, reason: "The intent is retained. Check its original receipt before retrying.")) }
            finishRequest(id, result: result); return result
        }
    }
    func receiveIntent(_ change: IntentChange, restoring: Bool = false) {
        let record = change.intent
        if record.acknowledgement == nil && !restoring { pendingIntents = pendingIntents.filter { !$0.value.mayDiscardAutomatically } }
        pendingIntents[record.mid] = record
        let delivery: DeliveryState
        if record.isQuarantined { delivery = .ambiguous }
        else {
            switch record.state { case .applied: delivery = .accepted; case .rejected: delivery = .failed; case .pending: delivery = restoring ? .ambiguous : .submitting; case .unknown, .quarantined: delivery = .ambiguous }
        }
        let operation = PendingOperation(id: record.mid, action: record.what, state: delivery, createdAt: Date(timeIntervalSince1970: Double(record.issuedAt) / 1_000), reason: record.lookupFailure?.message ?? record.operation?.error?.message ?? record.acknowledgement?.error?.message ?? record.quarantineReason)
        pendingOperations[record.mid] = operation
        let chat = record.target.hasPrefix("session:") ? String(record.target.dropFirst(8)) : nil
        if let chat, let saved = record.draft {
            var state = conversation(chat)
            if restoring, state.draft.text.isEmpty && state.draft.attachments.isEmpty || saved.updatedAt >= state.draft.updatedAt { state.draft = saved }
            if record.updatesDraft, state.draft.matchesComposition(saved) { state.draft.delivery = delivery }
            conversationByID[chat] = state
        }
        if record.what == "slack:reply", record.updatesDraft {
            let payload = record.payload, key = SlackThreadID(conversation: payload["conversation"].stringValue ?? "", thread: payload["thread"].stringValue)
            var thread = slack.threads[key] ?? SlackThreadState()
            if restoring, let draft = record.draft, record.acknowledgement?.outcome != .applied, thread.draft.text.isEmpty || draft.updatedAt >= thread.draft.updatedAt { thread.draft = draft }
            if thread.draft.matchesComposition(record.draft) { thread.draft.delivery = delivery }
            slack.threads[key] = thread
        }
        if let ack = record.acknowledgement, requests[record.mid]?.v2 == true {
            switch ack.outcome {
            case .applied: finishRequest(record.mid, result: .accepted(ack.result!.data))
            case .rejected: finishRequest(record.mid, result: .notSent(CoreFailure(ack.error?.code == .unsupported ? .unsupported : .refused, ack.error!.message)))
            case .unknown: finishRequest(record.mid, result: .ambiguous(operation))
            case .pending: break
            }
        }
        guard change.consumesResult, let result = record.acknowledgement?.result else { return }
        // The origin and captured composition must still be current. A late
        // receipt can update delivery, but cannot redirect or overwrite edits.
        guard selectedConversationID == record.selection, record.origin == selectionOrigin else { return }
        if let chat, !conversation(chat).draft.matchesComposition(record.draft) { return }
        if chat == nil, let selected = record.selection, !conversation(selected).draft.matchesComposition(record.draft) { return }
        for reply in result.replies {
            switch reply["type"].stringValue {
            case "instance:created", "@navigate":
                let destination = reply["instance"].stringValue ?? reply["session"].stringValue ?? ""
                if !destination.isEmpty { setIntent(.navigate(destination)) }
            case "editPrompt":
                guard let chat else { continue }
                var state = conversation(chat)
                let text = reply["text"].stringValue ?? ""
                state.draft = Draft(text: text + (state.draft.text.isEmpty ? "" : "\n\n" + state.draft.text), attachments: reply["attachments"].arrayValue.map(Attachment.init) + state.draft.attachments, updatedAt: clock.now(), sent: reply["sent"].stringValue, snippets: reply["snippets"].arrayValue.compactMap(\.stringValue))
                state.editPromptRevision &+= 1; conversationByID[chat] = state
            case "slack:link":
                if let text = reply["url"].stringValue, let url = URL(string: text), ["https", "http", "slack", "mailto"].contains(url.scheme?.lowercased() ?? "") { setIntent(.externalURL(url)) }
            default: break
            }
        }
        schedulePersistence()
    }
}
