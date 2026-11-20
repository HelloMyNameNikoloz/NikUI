import Foundation

public enum TerminalEvent: Sendable, Equatable {
    case list([TerminalDescriptor]), opened(TerminalDescriptor)
    case scrollback(TerminalDescriptor, [TerminalRun])
    case began(TerminalDescriptor, TerminalRun), done(TerminalDescriptor, TerminalRun)
    case output(terminal: String, run: String, stream: String, text: String)
    case closed(String), refused(id: String?, reason: String)
}
public enum PREvent: Sendable, Equatable {
    case state(PRStateEvent), diff(text: String, truncated: Bool), mentions(PRMentions)
    case done(action: String, ok: Bool, message: String)
}
public enum SlackEvent: Sendable, Equatable {
    case state(SlackState), thread(SlackThreadPage), older(SlackThreadPage)
    case sent(id: String, ok: Bool, reason: String?)
    case file(id: String, ok: Bool, dataURL: String?, reason: String?)
    case link(String), refused(what: String, reason: String), unknown(JSONValue)
}
/// Decode with the originating socket role; fleet `status` and conversation `status` are distinct.
public enum ServerEvent: Sendable, Equatable {
    case fleet(Fleet), history(HistorySnapshot), devices(DevicesSnapshot), awake(AwakeState)
    case initialized(ConversationInit), items([TranscriptItem]), meta(ConversationMeta, RenderConfiguration)
    case conversationStatus(ConversationStatus), stats(Stats), queue([QueueEntry], drainAt: Date?)
    case reset, presence([PresenceClient]), focus, draft(String), editPrompt(String), openStatus
    case report(available: Bool, report: Report?, trouble: String?), statusReport(Report)
    case settings(SettingsSnapshot), commands(CommandsSnapshot), pr(PREvent), terminal(TerminalEvent), slack(SlackEvent)
    case device(Seat), navigate(String), notify(NotificationEvent)
    case refused(what: String, reason: String, id: String?)
    case created(id: String, instance: String), placed(id: String)
    case voiceState(VoiceAvailability), voiceText(VoiceText), voiceFailed(id: String, code: String, reason: String)
    case unknown(type: String, raw: JSONValue)

    public static func decode(_ data: Data, role: SocketRole) throws -> ServerEvent { try decode(JSONValue.decode(data), role: role) }
    public static func decode(_ j: JSONValue, role: SocketRole) throws -> ServerEvent {
        guard case .object = j, let type = j["type"].stringValue else { throw CoreFailure(.protocolViolation, "Expected a JSON event with a type.") }
        func s(_ key: String) -> String { j[key].stringValue ?? "" }
        func list<T: WireModel>(_ key: String, _ t: T.Type) -> [T] { j[key].arrayValue.map(T.init) }
        switch type {
        case "fleet": return .fleet(Fleet(j))
        case "history": return .history(HistorySnapshot(j))
        case "devices": return .devices(DevicesSnapshot(j))
        case "awake": return .awake(AwakeState(j))
        case "init": return .initialized(ConversationInit(j))
        case "items": return .items(list("items", TranscriptItem.self))
        case "meta": return .meta(ConversationMeta(j["meta"]), RenderConfiguration.fromEnvelope(j))
        case "status":
            if case .conversation = role, j["status"].stringValue != nil { return .conversationStatus(ConversationStatus(rawValue: s("status")) ?? .unknown) }
            return .report(available: j["available"].boolValue ?? true, report: j["report"].isNull ? nil : Report(j["report"]), trouble: j["trouble"].stringValue)
        case "stats": return .stats(Stats(j["stats"]))
        case "queue": return .queue(list("queue", QueueEntry.self), drainAt: WireDate.date(j["drainAt"]))
        case "reset": return .reset
        case "presence": return .presence(list("clients", PresenceClient.self))
        case "focus": return .focus
        case "draft": return .draft(s("text"))
        case "editPrompt": return .editPrompt(s("text"))
        case "openStatus": return .openStatus
        case "statusReport": return .statusReport(Report(j["report"]))
        case "settings": return .settings(SettingsSnapshot(j))
        case "commands": return .commands(CommandsSnapshot(j))
        case "@device": return .device(Seat(j["device"]))
        case "@navigate": return .navigate(s("session"))
        case "@notify": return .notify(NotificationEvent(j))
        case "@refused": return .refused(what: s("what"), reason: s("reason"), id: j["id"].stringValue)
        case "instance:created": return .created(id: s("id"), instance: s("instance"))
        case "instance:placed": return .placed(id: s("id"))
        case "voice:state": return .voiceState(VoiceAvailability(j))
        case "voice:text": return .voiceText(VoiceText(j))
        case "voice:no": return .voiceFailed(id: s("id"), code: s("code"), reason: s("reason"))
        case "pr:state": return .pr(.state(PRStateEvent(j)))
        case "pr:diff": return .pr(.diff(text: s("diff"), truncated: j["truncated"].boolValue ?? false))
        case "pr:mentions": return .pr(.mentions(PRMentions(j)))
        case "pr:done": return .pr(.done(action: s("action"), ok: j["ok"].boolValue ?? false, message: s("message")))
        case "term:list": return .terminal(.list(list("terminals", TerminalDescriptor.self)))
        case "term:opened": return .terminal(.opened(TerminalDescriptor(j["terminal"])))
        case "term:scrollback": return .terminal(.scrollback(TerminalDescriptor(j["terminal"]), list("runs", TerminalRun.self)))
        case "term:began": return .terminal(.began(TerminalDescriptor(j["terminal"]), TerminalRun(j["run"])))
        case "term:done": return .terminal(.done(TerminalDescriptor(j["terminal"]), TerminalRun(j["run"])))
        case "term:out": return .terminal(.output(terminal: s("terminal"), run: s("run"), stream: s("stream"), text: s("text")))
        case "term:closed": return .terminal(.closed(s("id")))
        case "term:no": return .terminal(.refused(id: j["id"].stringValue, reason: s("reason")))
        case "slack:state": return .slack(.state(SlackState(j["state"])))
        case "slack:thread": return .slack(.thread(SlackThreadPage(j)))
        case "slack:older": return .slack(.older(SlackThreadPage(j)))
        case "slack:sent": return .slack(.sent(id: s("id"), ok: j["ok"].boolValue ?? false, reason: j["reason"].stringValue))
        case "slack:file": return .slack(.file(id: s("id"), ok: j["ok"].boolValue ?? false, dataURL: j["dataUrl"].stringValue, reason: j["reason"].stringValue))
        case "slack:link": return .slack(.link(s("url")))
        case "slack:refused": return .slack(.refused(what: s("what"), reason: s("reason")))
        default: return .unknown(type: type, raw: j)
        }
    }
}

public enum ClientAction: Sendable, Equatable {
    case ready(hidden: Bool = false), history(limit: Int = 200, cwd: String? = nil), watchCodex, status, devices, forget(id: String), awake
    case setAwake(Bool), setLid(Bool)
    case newInstance(id: String, cwd: String, provider: Provider, folderID: String? = nil)
    case resume(id: String, sessionID: String), place(id: String, instance: String, folderID: String?)
    case visible(Bool), send(text: String, attachments: [Attachment] = [], sent: String? = nil, snippets: [String] = [])
    case interrupt, permission(requestID: String, allow: Bool), stopTask(String)
    case unqueue(String), promoteQueued(String), editQueued(String), clearQueue
    case openFile(path: String, line: Int? = nil), switchConversation(String), runInTerminal(String)
    case statusOpen(Bool), settings, settingsOpen(Bool), commands, commandsOpen(Bool)
    case setSetting(id: String, value: JSONValue)
    case saveCommand(was: String? = nil, name: String, prompt: String, description: String), removeCommand(String), restoreCommand(String)
    case prWatch(Bool), prRefresh, prDiff, prMentions(String), prReply(threadID: String, body: String), prResolve(threadID: String, resolved: Bool)
    case prComment(String), prRerun, prUnlink, prAskThread(String), prAskCheck(runID: String, name: String? = nil), prAskConflicts
    case terminalList, terminalOpen(session: String? = nil), terminalAttach(String), terminalDetach(String), terminalRun(id: String, command: String), terminalStop(String), terminalClose(String)
    case voiceState, voice(id: String, audio: String), appleToken(String)
    case slackReady, slackRefresh, slackOpen(conversation: String, thread: String? = nil), slackOlder(conversation: String, thread: String? = nil, before: String)
    case slackFile(String), slackReply(id: String, conversation: String, text: String, thread: String? = nil)
    case slackVIPs([String]), slackMute(conversation: String, muted: Bool), slackEnable, slackLink(conversation: String, ts: String? = nil), slackSetup

    public var json: JSONValue {
        var p: [String: JSONValue] = [:]
        func string(_ key: String, _ value: String?) { if let value { p[key] = .string(value) } }
        func bool(_ key: String, _ value: Bool) { p[key] = .bool(value) }
        var type: String
        switch self {
        case .ready(let hidden): type = "ready"; bool("hidden", hidden)
        case .history(let limit, let cwd): type = "history"; p["limit"] = .number(Double(min(200, max(1, limit)))); string("cwd", cwd)
        case .watchCodex: type = "codex:watch"
        case .status: type = "status"
        case .devices: type = "devices"
        case .forget(let id): type = "forget"; string("id", id)
        case .awake: type = "awake"
        case .setAwake(let on): type = "awake:set"; bool("on", on)
        case .setLid(let on): type = "lid:set"; bool("on", on)
        case .newInstance(let id, let cwd, let provider, let folder):
            type = "instance:new"; string("id", id); string("cwd", cwd); if provider == .codex { string("provider", "codex") }; p["folderId"] = folder.map(JSONValue.string) ?? .null
        case .resume(let id, let session): type = "instance:resume"; string("id", id); string("sessionId", session)
        case .place(let id, let instance, let folder): type = "instance:place"; string("id", id); string("instance", instance); p["folderId"] = folder.map(JSONValue.string) ?? .null
        case .visible(let on): type = "visible"; bool("on", on)
        case .send(let text, let attachments, let sent, let snippets):
            type = "send"; string("text", text); string("sent", sent)
            if !attachments.isEmpty { p["attachments"] = .array(attachments.map(\.raw)) }
            if !snippets.isEmpty { p["snippets"] = .array(snippets.map(JSONValue.string)) }
        case .interrupt: type = "interrupt"
        case .permission(let id, let allow): type = "permission"; string("requestId", id); bool("allow", allow)
        case .stopTask(let id): type = "stopTask"; string("taskId", id)
        case .unqueue(let id): type = "unqueue"; string("id", id)
        case .promoteQueued(let id): type = "promoteQueued"; string("id", id)
        case .editQueued(let id): type = "editQueued"; string("id", id)
        case .clearQueue: type = "clearQueue"
        case .openFile(let path, let line): type = "openFile"; string("path", path); if let line { p["line"] = .number(Double(line)) }
        case .switchConversation(let id): type = "switch"; string("id", id)
        case .runInTerminal(let command): type = "runInTerminal"; string("command", command)
        case .statusOpen(let open): type = "statusOpen"; bool("open", open)
        case .settings: type = "settings"
        case .settingsOpen(let open): type = "settingsOpen"; bool("open", open)
        case .commands: type = "commands"
        case .commandsOpen(let open): type = "commandsOpen"; bool("open", open)
        case .setSetting(let id, let value): type = "setSetting"; string("id", id); p["value"] = value
        case .saveCommand(let was, let name, let prompt, let description): type = "saveCommand"; string("was", was); string("name", name); string("prompt", prompt); string("description", description)
        case .removeCommand(let name): type = "removeCommand"; string("name", name)
        case .restoreCommand(let name): type = "restoreCommand"; string("name", name)
        case .prWatch(let on): type = "pr:watch"; bool("on", on)
        case .prRefresh: type = "pr:refresh"
        case .prDiff: type = "pr:diff"
        case .prMentions(let query): type = "pr:mentions"; string("query", query)
        case .prReply(let thread, let body): type = "pr:reply"; string("threadId", thread); string("body", body)
        case .prResolve(let thread, let resolved): type = "pr:resolve"; string("threadId", thread); bool("resolved", resolved)
        case .prComment(let body): type = "pr:comment"; string("body", body)
        case .prRerun: type = "pr:rerun"
        case .prUnlink: type = "pr:unlink"
        case .prAskThread(let thread): type = "pr:askThread"; string("threadId", thread)
        case .prAskCheck(let run, let name): type = "pr:askCheck"; string("runId", run); string("name", name)
        case .prAskConflicts: type = "pr:askConflicts"
        case .terminalList: type = "term:list"
        case .terminalOpen(let session): type = "term:open"; string("session", session)
        case .terminalAttach(let id): type = "term:attach"; string("id", id)
        case .terminalDetach(let id): type = "term:detach"; string("id", id)
        case .terminalRun(let id, let command): type = "term:run"; string("id", id); string("command", command)
        case .terminalStop(let id): type = "term:stop"; string("id", id)
        case .terminalClose(let id): type = "term:close"; string("id", id)
        case .voiceState: type = "voice:state"
        case .voice(let id, let audio): type = "voice"; string("id", id); string("audio", audio)
        case .appleToken(let token): type = "@apple"; string("token", token)
        case .slackReady: type = "slack:ready"
        case .slackRefresh: type = "slack:refresh"
        case .slackOpen(let conversation, let thread): type = "slack:open"; string("conversation", conversation); string("thread", thread)
        case .slackOlder(let conversation, let thread, let before): type = "slack:older"; string("conversation", conversation); string("thread", thread); string("before", before)
        case .slackFile(let id): type = "slack:file"; string("id", id)
        case .slackReply(let id, let conversation, let text, let thread): type = "slack:reply"; string("id", id); string("conversation", conversation); string("text", text); string("thread", thread)
        case .slackVIPs(let vips): type = "slack:vips"; p["vips"] = .array(vips.map(JSONValue.string))
        case .slackMute(let conversation, let muted): type = "slack:mute"; string("conversation", conversation); bool("muted", muted)
        case .slackEnable: type = "slack:enable"
        case .slackLink(let conversation, let ts): type = "slack:link"; string("conversation", conversation); string("ts", ts)
        case .slackSetup: type = "slack:setup"
        }
        p["type"] = .string(type); return .object(p)
    }
    public var type: String { json["type"].stringValue ?? "" }
    public var requiresControl: Bool {
        switch self {
        case .newInstance, .resume, .place, .setAwake, .setLid, .send, .interrupt, .permission, .stopTask,
             .unqueue, .promoteQueued, .editQueued, .clearQueue, .openFile, .switchConversation, .runInTerminal,
             .setSetting, .saveCommand, .removeCommand, .restoreCommand, .prReply, .prResolve, .prComment, .prRerun, .prUnlink,
             .terminalList, .terminalOpen, .terminalAttach, .terminalDetach, .terminalRun, .terminalStop, .terminalClose,
             .voice, .slackReply, .slackVIPs, .slackMute, .slackEnable: return true
        default: return false
        }
    }
}
