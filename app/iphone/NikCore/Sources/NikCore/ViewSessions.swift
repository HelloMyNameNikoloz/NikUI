import Foundation

/// Stable window identity; leases are transient, compositions survive release.
public struct ViewSessionState: Sendable, Equatable {
    public var conversationID: String?
    public var lastConversationID: String?
    public var origin = V2Wire.randomID()
    public var visibility = FeatureVisibility()
    public var drafts: [String: Draft] = [:]
    public var reading: [String: ReadingState] = [:]
    public var navigation: String?
    public init() {}
}
public struct PersistedViewSession: Sendable, Codable, Equatable {
    public var drafts: [String: Draft]
    public var reading: [String: ReadingState]
    public var lastConversationID: String?
    public init(drafts: [String: Draft], reading: [String: ReadingState], lastConversationID: String? = nil) {
        self.drafts = drafts; self.reading = reading; self.lastConversationID = lastConversationID
    }
}
/// Captured before any asynchronous persistence or transport work.
public struct DraftSubmission: Sendable, Equatable {
    public let viewToken: String
    public let conversationID: String
    public let origin: String
    public let draft: Draft
    public let mid: String
    public init(viewToken: String, conversationID: String, origin: String, draft: Draft, mid: String? = nil) {
        self.viewToken = viewToken; self.conversationID = conversationID; self.origin = origin; self.draft = draft; self.mid = mid ?? V2Wire.randomID()
    }
}

@MainActor extension NikClient {
    public func isViewControlBlocked(_ identity: String) -> Bool { viewControlClaims[identity] != nil }
    public func acquireConversation(_ id: String, forView token: String, visibility: FeatureVisibility = FeatureVisibility()) async {
        guard !id.isEmpty, id.utf8.count <= 256, !token.isEmpty, token.utf8.count <= 128 else { fail(CoreFailure(.invalidInput, "VIEW_SESSION_INVALID")); return }
        var view = viewSessions[token] ?? ViewSessionState()
        if view.conversationID != id { view.origin = V2Wire.randomID() }
        view.conversationID = id; view.lastConversationID = id; view.visibility = visibility
        if view.drafts[id] == nil { view.drafts[id] = Draft(updatedAt: clock.now()) }
        viewSessions[token] = view
        schedulePersistence()
        if conversationByID[id] == nil { conversationByID[id] = ConversationState(id: id) }
        if !isPreview { await manager?.setViewSession(token, conversationID: id, visibility: visibility) }
    }
    public func releaseViewSession(_ token: String) async {
        viewSessions[token]?.conversationID = nil
        viewSessions[token]?.origin = V2Wire.randomID()
        if !isPreview { await manager?.setViewSession(token, conversationID: nil) }
        schedulePersistence()
    }
    public func viewDraft(_ token: String, conversationID: String) -> Draft {
        viewSessions[token]?.drafts[conversationID] ?? Draft(updatedAt: clock.now())
    }
    public func setViewDraft(_ draft: Draft, forView token: String, conversationID: String) {
        var view = viewSessions[token] ?? ViewSessionState(), draft = draft
        let old = view.drafts[conversationID]
        if old?.text.utf8.elementsEqual(draft.text.utf8) != true || old?.attachments != draft.attachments || old?.answerTo != draft.answerTo {
            draft.compositionID = V2Wire.randomID(); draft.updatedAt = clock.now(); draft.delivery = .draft
        }
        view.drafts[conversationID] = draft; viewSessions[token] = view; schedulePersistence()
    }
    public func setViewReading(_ reading: ReadingState, forView token: String, conversationID: String) {
        viewSessions[token]?.reading[conversationID] = reading; schedulePersistence()
    }
    public func captureDraft(forView token: String) throws -> DraftSubmission {
        guard let view = viewSessions[token], let id = view.conversationID, let draft = view.drafts[id] else { throw CoreFailure(.refused, "VIEW_SESSION_RELEASED") }
        return DraftSubmission(viewToken: token, conversationID: id, origin: view.origin, draft: draft)
    }
    public func submit(_ submission: DraftSubmission, prefix: String = "", preconditions: IntentMetadata = IntentMetadata()) async -> ActionResult {
        guard let view = viewSessions[submission.viewToken], view.conversationID == submission.conversationID,
              view.origin == submission.origin, view.drafts[submission.conversationID]?.matchesComposition(submission.draft) == true else {
            return .notSent(CoreFailure(.refused, "STALE_COMPOSITION"))
        }
        let composition = submission.viewToken + "\u{0}" + submission.conversationID + "\u{0}" + (submission.draft.compositionID ?? "legacy")
        guard viewSubmissions.insert(composition).inserted else { return .notSent(CoreFailure(.refused, "COMPOSITION_IN_FLIGHT")) }
        defer { viewSubmissions.remove(composition) }
        if pendingIntents.values.contains(where: { $0.mid != submission.mid && $0.viewToken == submission.viewToken && $0.target == "session:" + submission.conversationID &&
            $0.draft?.matchesComposition(submission.draft) == true && ($0.state == .pending || $0.isQuarantined) }) {
            return .notSent(CoreFailure(.refused, "COMPOSITION_DELIVERY_UNRESOLVED"))
        }
        var metadata = preconditions
        metadata.mid = submission.mid; metadata.draft = submission.draft; metadata.updatesDraft = true
        let expanded = SnippetExpander.expand(submission.draft.text, snippets: conversation(submission.conversationID).configuration.snippets)
        return await perform(.send(text: prefix + expanded.text, attachments: submission.draft.attachments,
                                   sent: expanded.used.isEmpty ? nil : prefix + expanded.sent, snippets: expanded.used),
                             forView: submission.viewToken, preconditions: metadata)
    }
    public func perform(_ action: ClientAction, forView token: String, preconditions: IntentMetadata = IntentMetadata(), onFleet: Bool = false) async -> ActionResult {
        guard let view = viewSessions[token], let id = view.conversationID else { return .notSent(CoreFailure(.refused, "VIEW_SESSION_RELEASED")) }
        let role: SocketRole = onFleet ? .fleet : .conversation(id)
        guard protocolSessions[role]?.version == .v2 else { return .notSent(CoreFailure(.unsupported, "VIEW_SESSION_PROTOCOL_V2_REQUIRED")) }
        var metadata = preconditions
        metadata.viewToken = token; metadata.selection = id; metadata.origin = view.origin
        metadata.draft = metadata.draft ?? view.drafts[id]
        metadata.mid = metadata.mid ?? V2Wire.randomID()
        if let identity = metadata.controlIdentity {
            guard viewControlClaims[identity] == nil else { return .notSent(CoreFailure(.refused, "DUPLICATE_CONTROL")) }
            viewControlClaims[identity] = metadata.mid!
        }
        let lease = "intent:" + metadata.mid!
        // An accepted click owns a temporary lease until its receipt resolves;
        // navigation/closing another window cannot tear down that write lane.
        if !onFleet {
            viewIntentLeases[metadata.mid!] = id
            await manager?.setViewSession(lease, conversationID: id)
        }
        let result = await execute(action, role: role, sourceDraft: metadata.draft, preservesDraft: true, v2Metadata: metadata)
        let record = pendingIntents[metadata.mid!]
        if record == nil || record?.state == .applied || record?.state == .rejected {
            viewIntentLeases.removeValue(forKey: metadata.mid!)
            if !onFleet { await manager?.setViewSession(lease, conversationID: nil) }
        }
        if let identity = metadata.controlIdentity, case .notSent = result { viewControlClaims.removeValue(forKey: identity) }
        return result
    }
    func receiveViewIntent(_ record: PendingIntent, restoring: Bool) {
        if let identity = record.controlIdentity {
            if record.state == .rejected {
                if viewControlClaims[identity] == record.mid { viewControlClaims.removeValue(forKey: identity) }
            } else if viewControlClaims[identity] == nil || viewControlClaims[identity] == record.mid { viewControlClaims[identity] = record.mid }
        }
        if requests[record.mid] == nil, (record.state == .applied || record.state == .rejected), viewIntentLeases.removeValue(forKey: record.mid) != nil {
            let manager = manager
            Task { await manager?.setViewSession("intent:" + record.mid, conversationID: nil) }
        }
        guard let token = record.viewToken, record.target.hasPrefix("session:"), record.updatesDraft, let saved = record.draft else { return }
        let chat = String(record.target.dropFirst(8))
        var view = viewSessions[token] ?? ViewSessionState()
        if restoring, view.drafts[chat] == nil { view.drafts[chat] = saved }
        if view.drafts[chat]?.matchesComposition(saved) == true {
            if record.acknowledgement?.outcome == .applied { view.drafts[chat] = Draft(updatedAt: clock.now()) }
            else { view.drafts[chat]?.delivery = pendingOperations[record.mid]?.state ?? .ambiguous }
        }
        viewSessions[token] = view; schedulePersistence()
    }
    func restoreViewCompositions(_ saved: PersistedUIState?) {
        viewSessions = (saved?.viewSessions ?? [:]).mapValues { value in
            var view = ViewSessionState(); view.drafts = value.drafts; view.reading = value.reading; view.lastConversationID = value.lastConversationID; return view
        }
        var latest: [String: PendingIntent] = [:]
        for record in pendingIntents.values where record.viewToken != nil && record.updatesDraft && record.draft != nil && record.target.hasPrefix("session:") {
            let key = record.viewToken! + "\u{0}" + record.target
            if latest[key].map({ $0.localOrder < record.localOrder }) ?? true { latest[key] = record }
        }
        for record in latest.values {
            let token = record.viewToken!, chat = String(record.target.dropFirst(8)), draft = record.draft!
            var view = viewSessions[token] ?? ViewSessionState()
            let cached = view.drafts[chat]
            let chooseCache = cached.map { $0.updatedAt > draft.updatedAt || $0.updatedAt == draft.updatedAt && (saved?.lastIntentOrder ?? 0) >= record.localOrder } ?? false
            if !chooseCache { view.drafts[chat] = draft }
            viewSessions[token] = view; receiveViewIntent(record, restoring: false)
        }
    }
}
