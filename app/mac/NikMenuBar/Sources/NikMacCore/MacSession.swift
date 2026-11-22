import Foundation
import Observation
import NikCore
import NikMenuCore
import NikMacIdentity
import AppKit

@MainActor @Observable public final class MacAppSession {
    public private(set) var client: NikClient?
    public private(set) var problem: String?
    public private(set) var connecting = false
    public private(set) var generation: String?
    public private(set) var renderedItems: [String: Set<String>] = [:]
    public private(set) var renderedStreamingItems: Set<String> = []
    public var nativeE2EActive = false
    public let selection: AppSelection
    public let desktopNotifications: MacDesktopNotifications
    @ObservationIgnored public var openNotificationWindow: (() -> Void)?
    @ObservationIgnored private var notificationWindows: [String: (MacWindowModel, NSWindow)] = [:]
    @ObservationIgnored private var pendingNotification: DesktopNotice?
    @ObservationIgnored public let management: LocalControlClient
    @ObservationIgnored let store: any KeyValueStore
    @ObservationIgnored let enrollment: LocalDeviceEnrollment
    @ObservationIgnored let cache: (any KeyValueStore)?
    public convenience init(selection: AppSelection) {
        self.init(selection: selection, store: LocalDeviceKeychain(selection: selection))
    }
    init(selection: AppSelection, store: any KeyValueStore, cache: (any KeyValueStore)? = nil) {
        self.selection = selection; management = LocalControlClient(root: selection.root,
            privateHome: selection.flavour == .production || selection.isCutoverRehearsal ? selection.home : nil)
        let directory = selection.flavour == .development ? selection.home + "/client" : selection.home + "/Library/Application Support/NikUI/client"
        let clientCache = cache ?? MacDraftStore(directory: directory)
        desktopNotifications = MacDesktopNotifications(store: clientCache)
        self.store = store; self.cache = clientCache
        enrollment = LocalDeviceEnrollment(root: selection.root, store: store)
    }
    public func registerNotificationWindow(_ model: MacWindowModel, native: NSWindow) {
        notificationWindows[model.token] = (model, native)
        if let notice = pendingNotification {
            pendingNotification = nil
            Task {
                await connect(explicit: false)
                guard let client else { problem = "LOCAL_DEVICE_IDENTITY_UNAVAILABLE"; return }
                await model.select(notice.conversationID, client: client)
                native.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
            }
        }
    }
    public func unregisterNotificationWindow(_ token: String) { notificationWindows.removeValue(forKey: token) }
    public func openNotification(_ notice: DesktopNotice) async {
        guard notice.engineID == desktopNotifications.engineID else { problem = "NOTIFICATION_ENGINE_MISMATCH"; return }
        if let (model, native) = notificationWindows.values.first(where: { $0.0.conversationID == notice.conversationID }) {
            if let client { await model.select(notice.conversationID, client: client) }
            native.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        } else { pendingNotification = notice; openNotificationWindow?() }
    }
    public func connect(explicit: Bool = true) async {
        guard !connecting else { return }
        connecting = true; defer { connecting = false }
        do {
            if !explicit, try await store.data(forKey: PairingService.pairingKey) == nil { return }
            let selected = try await enrollment.connect(allowCreation: explicit)
            if let client { try await client.refreshLocalConnection(selected.pairing) }
            else {
                let directory = selection.flavour == .development ? selection.home + "/client" : selection.home + "/Library/Application Support/NikUI/client"
                var transport = TransportConfiguration(); transport.clientKind = .mac
                let core = NikClient(signingKey: selected.key, secureStore: store,
                    cacheStore: cache ?? MacDraftStore(directory: directory),
                    http: URLSessionHTTPClient(), transportConfiguration: transport)
                await core.restore()
                if let failure = core.lastFailure { throw failure }
                client = core; await core.connect()
            }
            generation = selected.generation; problem = nil
        } catch { problem = Self.code(error); await client?.disconnect() }
    }
    public func connectAfterEngineStarts() async throws {
        // Wait for the engine's actual state before enrollment. Slow startup
        // can time out visibly, but never initiates an automatic handback.
        let transport = UnixControlTransport(root: selection.root)
        let started = Date()
        let deadline = ProcessInfo.processInfo.systemUptime + 90
        while ProcessInfo.processInfo.systemUptime < deadline {
            try Task.checkCancellation()
            if let data = try? await transport.request(Data(#"{"op":"status"}"#.utf8)),
               let status = try? JSONValue.decode(data), status["ok"].boolValue == true,
               status["state"].stringValue == "running" {
                await connect()
                guard client != nil, problem == nil else { throw IdentityFailure(problem ?? "LOCAL_DEVICE_ENROLLMENT_UNAVAILABLE") }
                return
            }
            if let code = EngineControl.startupFailure(root: selection.root, since: started) { throw IdentityFailure(code) }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw IdentityFailure("ENGINE_START_TIMEOUT")
    }
    public func engineChanged(_ value: String?) async {
        guard client != nil, let value, value != generation else { return }
        await connect(explicit: false)
    }
    public func recordRender(conversationID: String, itemIDs: Set<String>, streamingIDs: Set<String>) {
        guard nativeE2EActive else { return }
        renderedItems[conversationID] = itemIDs
        renderedStreamingItems.formUnion(streamingIDs)
    }
    public func diagnostics(window: MacWindowModel) -> JSONValue {
        .object(["connection": .string(client.map { String(describing: $0.connection) } ?? "no-client"),
            "problem": problem.map(JSONValue.string) ?? .null, "windowProblem": window.problem.map(JSONValue.string) ?? .null,
            "connecting": .bool(connecting), "generation": generation.map(JSONValue.string) ?? .null,
            "fleetRowIDs": .array((client?.fleet.rows.map(\.id) ?? []).map(JSONValue.string)),
            "codexIDs": .array((client?.fleet.codex.map(\.id) ?? []).map(JSONValue.string)),
            "lastError": client?.lastFailure.map { .object(["code": .string($0.code.rawValue), "message": .string($0.message)]) } ?? .null,
            "selectedConversation": window.conversationID.map(JSONValue.string) ?? .null,
            "conversations": .object((client?.conversationByID ?? [:]).mapValues { state in .object([
                "connection": .string(String(describing: state.connection)), "initialized": .bool(state.initialized),
                "fresh": .bool(state.controlSnapshotFresh), "status": .string(state.status.rawValue),
                "itemIDs": .array(state.items.suffix(32).map { .string($0.id) }),
                "approvalIDs": .array(state.permissions.compactMap(\.requestId).map(JSONValue.string)),
                "queueIDs": .array(state.queue.map { .string($0.id) })]) }),
            "renderedItems": .object(renderedItems.mapValues { .array($0.sorted().map(JSONValue.string)) })])
    }
    public static func code(_ error: any Error) -> String {
        if let error = error as? IdentityFailure { return error.code }
        if let error = error as? MenuFailure { return error.code }
        if let error = error as? CoreFailure { return error.message }
        return "LOCAL_CLIENT_UNAVAILABLE"
    }
}

public extension ConversationState {
    var visibleQueue: [QueueEntry] {
        queue.filter { !["dispatching", "accepted", "completed", "rejected", "discarded"].contains($0.raw["state"].stringValue ?? "queued") }
    }
}

public struct CapturedControl: Sendable, Equatable {
    public enum Kind: String, Sendable { case stop, steer, approval, question, unqueue, promote }
    public let kind: Kind
    public let conversationID: String
    public let origin: String
    public let boot: String
    public let run: RunRef?
    public let requestID: String?
    public let queueID: String?
    public let queueRevision: Int?
    public init(kind: Kind, conversationID: String, origin: String, boot: String, run: RunRef? = nil,
                requestID: String? = nil, queueID: String? = nil, queueRevision: Int? = nil) {
        self.kind = kind; self.conversationID = conversationID; self.origin = origin; self.boot = boot
        self.run = run; self.requestID = requestID; self.queueID = queueID; self.queueRevision = queueRevision
    }
    public var identity: String { JSONValue.array([kind.rawValue, conversationID, run?.id ?? "", run?.turn ?? "", requestID ?? "", queueID ?? "", queueRevision.map(String.init) ?? ""].map(JSONValue.string)).text }
    public func validate(state: ConversationState, origin: String, boot: String, consumed: Set<String>) throws {
        guard state.id == conversationID, self.origin == origin, self.boot == boot, state.controlSnapshotFresh, state.connection.isLive else { throw IdentityFailure("STALE_CONTROL") }
        guard !consumed.contains(identity) else { throw IdentityFailure("DUPLICATE_CONTROL") }
        switch kind {
        case .stop, .steer:
            guard let run, run.turn != nil, state.run == run else { throw IdentityFailure("STALE_RUN") }
        case .approval:
            guard let run, state.permissions.contains(where: { $0.requestId == requestID && $0.run == run }) else { throw IdentityFailure("APPROVAL_RESOLVED") }
        case .question:
            guard state.activeQuestion?.requestID == requestID, state.activeQuestion?.run == run else { throw IdentityFailure("QUESTION_RESOLVED") }
        case .unqueue, .promote:
            guard let row = state.queue.first(where: { $0.id == queueID }), row.raw["revision"].intValue == queueRevision else { throw IdentityFailure("STALE_QUEUE_ENTRY") }
            let action = kind == .unqueue ? "unqueue" : "promoteQueued"
            guard row.raw["actions"].arrayValue.contains(.string(action)) else { throw IdentityFailure("ACTION_UNADVERTISED") }
        }
    }
}

@MainActor @Observable public final class MacWindowModel {
    public private(set) var token: String
    public var project: String?
    public private(set) var conversationID: String?
    public var problem: String?
    public private(set) var submitting = false
    public private(set) var history: [HistoryEntry] = []
    public private(set) var historyHasMore = true
    public private(set) var loadingHistory = false
    public func consumed(_ control: CapturedControl, client: NikClient) -> Bool { client.isViewControlBlocked(control.identity) }
    public let find = MacTranscriptFindState()
    public init(token: String = UUID().uuidString) { self.token = token }
    public func restoreToken(_ value: String) { token = value }
    public func restoreDraft(windowToken: String, conversationID: String, client: NikClient) async {
        guard client.viewSessions[windowToken]?.conversationID == nil,
              client.viewSessions[windowToken]?.drafts[conversationID] != nil else { problem = "DRAFT_WINDOW_ALREADY_OPEN"; return }
        let previous = token
        token = windowToken; await select(conversationID, client: client)
        if previous != windowToken { await client.releaseViewSession(previous) }
    }
    public func select(_ id: String?, client: NikClient) async {
        conversationID = id; problem = nil
        find.query = id.flatMap { client.viewSessions[token]?.reading[$0]?.findQuery } ?? ""; find.step = 0
        if let id { await client.acquireConversation(id, forView: token) }
        else { await client.releaseViewSession(token) }
    }
    public func close(client: NikClient?) async { await client?.releaseViewSession(token); await client?.flushPersistence() }
    public func text(_ client: NikClient) -> String { conversationID.map { client.viewDraft(token, conversationID: $0).text } ?? "" }
    public func edit(_ value: String, client: NikClient) {
        guard let id = conversationID else { return }
        var draft = client.viewDraft(token, conversationID: id); draft.text = value
        client.setViewDraft(draft, forView: token, conversationID: id)
    }
    public func attach(_ sources: [MacImageSource], to id: String, client: NikClient) async {
        do {
            guard !sources.isEmpty, sources.count + client.viewDraft(token, conversationID: id).attachments.count <= 6 else { throw IdentityFailure("SIX_IMAGES_MAXIMUM") }
            var images: [Attachment] = []
            for source in sources { images.append(try await MacImageAttachments.prepare(source)) }
            var draft = client.viewDraft(token, conversationID: id)
            guard draft.attachments.count + images.count <= 6 else { throw IdentityFailure("SIX_IMAGES_MAXIMUM") }
            draft.attachments += images
            let maximum = client.protocolSessions[.conversation(id)]?.welcome?.receipts?.maximumMessageBytes ?? 16 * 1024 * 1024
            try ClientAction.send(text: draft.text, attachments: draft.attachments).validate(on: .conversation(id), maximumWireBytes: maximum)
            client.setViewDraft(draft, forView: token, conversationID: id)
            let saved = await client.flushPersistence()
            problem = saved ? nil : client.lastFailure?.message ?? "DRAFT_STORE_UNAVAILABLE"
        } catch { problem = MacAppSession.code(error) }
    }
    public func removeAttachment(_ index: Int, client: NikClient) {
        guard let id = conversationID else { return }
        var draft = client.viewDraft(token, conversationID: id)
        guard draft.attachments.indices.contains(index) else { return }
        draft.attachments.remove(at: index); client.setViewDraft(draft, forView: token, conversationID: id)
    }
    public func openInEditor(_ id: String, client: NikClient) async {
        guard conversationID == id else { problem = "STALE_WINDOW_ORIGIN"; return }
        do { _ = try MacLocalResource.directory(client.conversation(id).meta.cwd) }
        catch { problem = MacAppSession.code(error); return }
        show(await client.perform(.openFile(path: ".", line: nil), forView: token))
    }
    public func capture(_ kind: CapturedControl.Kind, client: NikClient, item: TranscriptItem? = nil, queue: QueueEntry? = nil) -> CapturedControl? {
        guard let id = conversationID, let view = client.viewSessions[token], let boot = client.protocolSessions[.conversation(id)]?.welcome?.bootID else { return nil }
        let state = client.conversation(id)
        return CapturedControl(kind: kind, conversationID: id, origin: view.origin, boot: boot, run: item?.run ?? state.run,
            requestID: item?.answerTo?.requestID ?? item?.requestId, queueID: queue?.id, queueRevision: queue?.raw["revision"].intValue)
    }
    public func send(client: NikClient, steer control: CapturedControl? = nil) async {
        guard !submitting else { problem = "COMPOSITION_IN_FLIGHT"; return }
        do {
            let submission = try client.captureDraft(forView: token)
            var metadata = IntentMetadata()
            if let control { try validate(control, client: client); metadata.fields["run"] = control.run?.raw; metadata.controlIdentity = control.identity }
            submitting = true; defer { submitting = false }
            let result = await client.submit(submission, prefix: control == nil ? "" : "/steer ", preconditions: metadata)
            show(result)
        } catch { problem = MacAppSession.code(error) }
    }
    private func validate(_ control: CapturedControl, client: NikClient) throws {
        guard conversationID == control.conversationID, let view = client.viewSessions[token],
              let boot = client.protocolSessions[.conversation(control.conversationID)]?.welcome?.bootID else { throw IdentityFailure("STALE_CONTROL") }
        try control.validate(state: client.conversation(control.conversationID), origin: view.origin, boot: boot, consumed: consumed(control, client: client) ? [control.identity] : [])
    }
    public func act(_ control: CapturedControl, client: NikClient, allow: Bool = false, answer: String = "") async {
        do {
            try validate(control, client: client)
            if control.kind == .steer { await send(client: client, steer: control); return }
            if control.kind == .question, answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw IdentityFailure("QUESTION_ANSWER_REQUIRED") }
            var metadata = IntentMetadata()
            metadata.controlIdentity = control.identity
            if [.stop, .approval].contains(control.kind) { metadata.fields["run"] = control.run?.raw }
            let action: ClientAction
            switch control.kind {
            case .stop: action = .interrupt
            case .approval: action = .permission(requestID: control.requestID!, allow: allow)
            case .question:
                guard !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let question = client.conversation(control.conversationID).activeQuestion else { throw IdentityFailure("QUESTION_ANSWER_REQUIRED") }
                metadata.fields["answerTo"] = question.raw
                action = .send(text: answer)
            case .unqueue: action = .unqueue(control.queueID!)
            case .promote: metadata.fields["mode"] = .string("reorder"); action = .promoteQueued(control.queueID!)
            case .steer: return
            }
            let result = await client.perform(action, forView: token, preconditions: metadata)
            show(result)
        } catch { problem = MacAppSession.code(error) }
    }
    private func show(_ result: ActionResult) {
        switch result {
        case .notSent(let error): problem = error.message
        case .ambiguous: problem = "DELIVERY_UNRESOLVED — The original message is retained while its receipt is checked."
        default: problem = nil
        }
    }
    public func loadHistory(_ management: LocalControlClient, reset: Bool = false) async {
        guard !loadingHistory else { return }
        loadingHistory = true; defer { loadingHistory = false }
        let project = project, offset = reset ? 0 : history.count
        do {
            let page = try await management.history(cwd: project, offset: offset)
            guard self.project == project else { return }
            let incoming = page["entries"].arrayValue.map(HistoryEntry.init)
            history = reset ? incoming : history + incoming.filter { entry in !history.contains(where: { $0.id == entry.id }) }
            historyHasMore = page["hasMore"].boolValue == true
        } catch { problem = MacAppSession.code(error) }
    }
    public func resume(_ entry: HistoryEntry, session: MacAppSession) async {
        guard let client = session.client, let cwd = entry.cwd else { problem = "HISTORY_PROJECT_REQUIRED"; return }
        let origin = client.viewSessions[token]?.origin, selected = conversationID
        do {
            let response = try await session.management.resumeHistory(conversation: entry.sessionId, cwd: cwd)
            guard conversationID == selected, client.viewSessions[token]?.origin == origin else { problem = "STALE_WINDOW_ORIGIN"; return }
            if let id = response["id"].stringValue { await select(id, client: client) }
        } catch { problem = MacAppSession.code(error) }
    }
}
