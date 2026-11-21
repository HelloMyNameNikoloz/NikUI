import Foundation

public struct Seat: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `kind`: String { string("kind") }
    public var `control`: Bool { flag("control") }
    public var id: String { string("id") }
}

public struct NamedFolder: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var id: String { string("id") }
}

public struct Project: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `path`: String { string("path") }
    public var `name`: String { string("name") }
    public var id: String { path }
}

public struct Attachment: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `mediaType`: String { string("mediaType") }
    public var `data`: String { string("data") }
    public var `width`: Int? { raw["width"].intValue }
    public var `height`: Int? { raw["height"].intValue }
    public var id: String { name + ":" + String(data.prefix(40)) }
}

public struct FleetRow: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `provider`: Provider { Provider(rawValue: string("provider", default: id.hasPrefix("cx-") ? "codex" : "claude")) ?? .unknown }
    public var `sessionId`: String? { raw["sessionId"].stringValue }
    public var `label`: String { string("label") }
    public var `cwd`: String { string("cwd") }
    public var `status`: ConversationStatus { ConversationStatus(rawValue: string("status")) ?? .unknown }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var `activeAt`: Double? { raw["activeAt"].doubleValue }
    public var `queued`: Int { integer("queued") }
    public var `order`: Int { integer("order") }
    public var `paused`: Bool { flag("paused") }
    public var `asleep`: Bool { flag("asleep") }
    public var `unread`: Bool { flag("unread") }
    public var `readOnly`: Bool { flag("readOnly") }
    public var `folder`: NamedFolder? { model("folder") }
    public var `project`: Project? {
        if let offered: Project = model("project") { return offered }
        guard provider == .codex, !cwd.isEmpty else { return nil }
        return Project(.object(["path": .string(cwd), "name": .string(URL(fileURLWithPath: cwd).lastPathComponent)]))
    }
    public var `model`: String? { raw["model"].stringValue }
    public var id: String { string("id") }
}

public struct CodexCatalogState: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `loaded`: Bool { flag("loaded") }
    public var `error`: String? { raw["error"].stringValue }
}

public struct Fleet: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `instances`: [FleetRow] { models("instances") }
    public var `codex`: [FleetRow] { models("codex", as: FleetRow.self).map { var row = $0; row.raw["provider"] = .string("codex"); return row } }
    public var `codexState`: CodexCatalogState? { model("codexState") }
    public var `folders`: [NamedFolder] { models("folders") }
    public var `projects`: [Project] { models("projects") }
    public var `at`: Double? { raw["at"].doubleValue }
    public var `rows`: [FleetRow] { instances + codex }
}

public struct HistoryEntry: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `sessionId`: String { string("sessionId") }
    public var `title`: String { string("title") }
    public var `provider`: Provider { Provider(rawValue: string("provider", default: "claude")) ?? .unknown }
    public var `file`: String? { raw["file"].stringValue }
    public var `cwd`: String? { raw["cwd"].stringValue }
    public var `branch`: String? { raw["branch"].stringValue }
    public var `customTitle`: String? { raw["customTitle"].stringValue }
    public var `autoLabel`: String? { raw["autoLabel"].stringValue }
    public var `size`: Int? { raw["size"].intValue }
    public var `mtimeMs`: Double? { raw["mtimeMs"].doubleValue }
    public var `modified`: Date? { WireDate.date(raw["modified"]) }
    public var `label`: String { string("label", default: title) }
    public var id: String { provider.rawValue + ":" + sessionId }
}

public struct HistorySnapshot: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `entries`: [HistoryEntry] { models("entries") }
    public var `available`: Bool { flag("available", default: true) }
    public var `trouble`: String? { raw["trouble"].stringValue }
}

public struct DeviceRow: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `control`: Bool { flag("control") }
    public var `biometric`: Bool { flag("biometric") }
    public var `here`: Bool { flag("here") }
    public var `me`: Bool { flag("me") }
    public var `protection`: KeyProtection { KeyProtection(rawValue: string("protection")) ?? .unknown }
    public var `pairedAt`: Date? { WireDate.date(raw["pairedAt"]) }
    public var `lastSeenAt`: Date? { WireDate.date(raw["lastSeenAt"]) }
    public var id: String { string("id") }
}

public struct DevicesSnapshot: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `devices`: [DeviceRow] { models("devices") }
    public var `mayManage`: Bool { flag("mayManage") }
    public var `me`: String? { raw["me"].stringValue }
    public var `refused`: String? { raw["refused"].stringValue }
}

public struct Battery: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `ac`: Bool { flag("ac") }
    public var `percent`: Double? { raw["percent"].doubleValue }
}

public struct LidState: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `on`: Bool { flag("on") }
    public var `supported`: Bool { flag("supported") }
    public var `approved`: Bool { flag("approved") }
    public var `held`: Bool { flag("held") }
    public var `finishing`: Bool { flag("finishing") }
    public var `lowBattery`: Bool { flag("lowBattery") }
    public var `reason`: String? { raw["reason"].stringValue }
    public var `battery`: Battery? { model("battery") }
}

public struct AwakeState: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `available`: Bool { flag("available") }
    public var `on`: Bool { flag("on") }
    public var `held`: Bool { flag("held") }
    public var `supported`: Bool { flag("supported") }
    public var `mayChange`: Bool { flag("mayChange") }
    public var `since`: Date? { WireDate.date(raw["since"]) }
    public var `reason`: String? { raw["reason"].stringValue }
    public var `refused`: String? { raw["refused"].stringValue }
    public var `lid`: LidState? { model("lid") }
}

public struct CommandOption: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `value`: String { raw.stringValue ?? string("value") }
    public var `label`: String { string("label", default: value) }
    public var `detail`: String? { raw["detail"].stringValue }
    public var id: String { value }
}

public struct RenderConfiguration: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `slashCommands`: [String] { raw["slashCommands"].arrayValue.compactMap(\.stringValue) }
    public var `commandArgs`: [String: [CommandOption]] { raw["commandArgs"].objectValue.mapValues { $0.arrayValue.map(CommandOption.init) } }
    public var `ownCommands`: [String] { raw["ownCommands"].arrayValue.compactMap(\.stringValue) }
    public var `snippets`: [String: String] { raw["snippets"].objectValue.compactMapValues(\.stringValue) }
    public var `showThinking`: Bool { flag("showThinking", default: true) }
    public var `clock`: String { string("clock", default: "24h") }
    public var `replySuggestions`: Bool { flag("replySuggestions", default: true) }
    public var `singleEscape`: Bool { flag("singleEscape") }
    public var `font`: String { string("font") }
    public var `fontSize`: Double { number("fontSize", default: 16) }
}

public struct Goal: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `objective`: String { string("objective") }
    public var `status`: String { string("status") }
}

public struct UsingMac: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `since`: Date? { WireDate.date(raw["since"]) }
    public var `title`: String? { raw["title"].stringValue }
}

public struct PRPane: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `open`: Bool { flag("open") }
    public var `full`: Bool { flag("full") }
    public var `tab`: String { string("tab", default: "conversation") }
    public var `width`: Double? { raw["width"].doubleValue }
}

public struct ConversationMeta: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `label`: String { string("label") }
    public var `cwd`: String { string("cwd") }
    public var `home`: String { string("home") }
    public var `model`: String? { raw["model"].stringValue }
    public var `ticket`: String? { raw["ticket"].stringValue }
    public var `prUrl`: String? { raw["prUrl"].stringValue }
    public var `effort`: String? { raw["effort"].stringValue }
    public var `permissionMode`: String? { raw["permissionMode"].stringValue }
    public var `mode`: String? { raw["mode"].stringValue }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var `prPinned`: Bool { flag("prPinned") }
    public var `prPane`: PRPane { model("prPane") ?? PRPane() }
    public var `provider`: Provider { Provider(rawValue: string("provider", default: "claude")) ?? .unknown }
    public var `goal`: Goal? { model("goal") }
    public var `usingMac`: UsingMac? { model("usingMac") }
}

public struct QueueEntry: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `text`: String { string("text") }
    public var `images`: Int { integer("images") }
    public var `lostImages`: Int { integer("lostImages") }
    public var id: String { string("id") }
}

public struct TranscriptItem: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `kind`: String { string("kind", default: "unknown") }
    public var `text`: String { string("text") }
    public var `name`: String { string("name") }
    public var `requestId`: String { string("requestId") }
    public var run: RunRef? { try? RunRef(validating: raw["run"]) }
    public var answerTo: QuestionRef? { try? QuestionRef(validating: raw["answerTo"]) }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `streaming`: Bool { flag("streaming") }
    public var `isError`: Bool { flag("isError") }
    public var `resultClipped`: Bool { flag("resultClipped") }
    public var `interrupted`: Bool { flag("interrupted") }
    public var `agent`: String? { raw["agent"].stringValue }
    public var `rawInput`: String? { raw["rawInput"].stringValue }
    public var `result`: String? { raw["result"].stringValue }
    public var `resolved`: String? { raw["resolved"].stringValue }
    public var `subtype`: String? { raw["subtype"].stringValue }
    public var `trigger`: String? { raw["trigger"].stringValue }
    public var `level`: String? { raw["level"].stringValue }
    public var `toolStatus`: String? { raw["status"].stringValue }
    public var `snippets`: [String] { raw["snippets"].arrayValue.compactMap(\.stringValue) }
    public var `images`: [Attachment] { models("images") }
    public var `input`: JSONValue { raw["input"] }
    public var `resultLength`: Int? { raw["resultLength"].intValue }
    public var `numTurns`: Int? { raw["numTurns"].intValue }
    public var `before`: Int? { raw["before"].intValue }
    public var `durationMs`: Double? { raw["durationMs"].doubleValue }
    public var `costUsd`: Double? { raw["costUsd"].doubleValue }
    public var `isLive`: Bool { (kind == "permission" && resolved == nil) || (kind == "tool" && toolStatus == "running") || streaming }
    public var id: String { string("id") }
}

public struct BackgroundShell: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `command`: String { string("command") }
    public var `startedAt`: Date? { WireDate.date(raw["startedAt"]) }
    public var `stopping`: Bool { flag("stopping") }
    public var run: RunRef? { try? RunRef(validating: raw["run"]) }
    public var id: String { string("id") }
}

public struct CIState: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `phase`: String { string("phase") }
    public var `startedAt`: Date? { WireDate.date(raw["startedAt"]) }
    public var `finishedAt`: Date? { WireDate.date(raw["finishedAt"]) }
    public var `finished`: Bool { flag("finished") }
    public var `quiet`: Bool { flag("quiet") }
    public var `pr`: JSONValue { raw["pr"] }
    public var `averageMs`: Double? { raw["averageMs"].doubleValue }
    public var `elapsedMs`: Double? { raw["elapsedMs"].doubleValue }
    public var `done`: Int? { raw["done"].intValue }
    public var `total`: Int? { raw["total"].intValue }
    public var `failing`: [String] { raw["failing"].arrayValue.compactMap(\.stringValue) }
    public var `url`: String? { raw["url"].stringValue }
    public var `message`: String? { raw["message"].stringValue }
}

public struct Stats: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `input`: Int { integer("input") }
    public var `output`: Int { integer("output") }
    public var `cacheRead`: Int { integer("cacheRead") }
    public var `cacheCreate`: Int { integer("cacheCreate") }
    public var `total`: Int { integer("total") }
    public var `turns`: Int { integer("turns") }
    public var `background`: Int { integer("background") }
    public var `shells`: Int { integer("shells") }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var `elapsedMs`: Double { number("elapsedMs") }
    public var `running`: Bool { flag("running") }
    public var `shellList`: [BackgroundShell] { models("shellList") }
    public var `contextTokens`: Int? { raw["contextTokens"].intValue }
    public var `contextWindow`: Int? { raw["contextWindow"].intValue }
    public var `ci`: CIState? { model("ci") }
}

public struct ConversationInit: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `sessionId`: String { string("sessionId") }
    public var `client`: String? { raw["client"].stringValue }
    public var run: RunRef? { try? RunRef(validating: raw["run"]) }
    public var operations: [ProviderOperation] { raw["operations"].arrayValue.compactMap { try? ProviderOperation(validating: $0) } }
    public var `items`: [TranscriptItem] { models("items") }
    public var `dropped`: Int { integer("dropped") }
    public var `maxItems`: Int { integer("maxItems", default: 400) }
    public var `meta`: ConversationMeta { model("meta") ?? ConversationMeta() }
    public var `status`: ConversationStatus { ConversationStatus(rawValue: string("status")) ?? .unknown }
    public var `stats`: Stats { model("stats") ?? Stats() }
    public var `queue`: [QueueEntry] { models("queue") }
    public var `drainAt`: Date? { WireDate.date(raw["drainAt"]) }
    public var `configuration`: RenderConfiguration { RenderConfiguration.fromEnvelope(raw) }
}

public struct PresenceClient: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `kind`: String { string("kind") }
    public var `control`: Bool { flag("control") }
    public var `since`: Date? { WireDate.date(raw["since"]) }
    public var id: String { string("id") }
}

public struct SettingChoice: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `value`: String { string("value") }
    public var `label`: String { string("label", default: value) }
    public var id: String { value }
}

public struct SettingRow: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `group`: String { string("group") }
    public var `kind`: String { string("kind") }
    public var `label`: String { string("label") }
    public var `hint`: String { string("hint") }
    public var `value`: JSONValue { raw["value"] }
    public var `choices`: [SettingChoice] { models("choices") }
    public var `min`: Double? { raw["min"].doubleValue }
    public var `max`: Double? { raw["max"].doubleValue }
    public var `unavailable`: String? { raw["unavailable"].stringValue }
    public var `note`: String? { raw["note"].stringValue }
    public var `warn`: Bool { flag("warn") }
    public var id: String { string("id") }
}

public struct SettingsCatalog: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `groups`: [String] { raw["groups"].arrayValue.compactMap(\.stringValue) }
    public var `rows`: [SettingRow] { models("rows") }
}

public struct SettingsSnapshot: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `settings`: SettingsCatalog? { model("settings") }
    public var `mayChange`: Bool { flag("mayChange") }
    public var `local`: Bool { flag("local") }
    public var `refused`: String? { raw["refused"].stringValue }
    public var `refusedID`: String? { raw["id"].stringValue }
}

public struct CommandDescription: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `kind`: String { string("kind") }
    public var `usage`: String { string("usage") }
    public var `description`: String { string("description") }
    public var `prompt`: String { string("prompt") }
    public var `summary`: String { string("summary") }
    public var `shipped`: Bool { flag("shipped") }
    public var `off`: Bool { flag("off") }
    public var `edited`: Bool { flag("edited") }
    public var id: String { name }
}

public struct CommandsSnapshot: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `commands`: [CommandDescription] { models("commands") }
    public var `available`: Bool { !raw["commands"].isNull }
    public var `mayChange`: Bool { flag("mayChange") }
    public var `refused`: String? { raw["refused"].stringValue }
    public var `name`: String? { raw["name"].stringValue }
    public var `done`: String? { raw["done"].stringValue }
}

public struct PRActor: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `login`: String? { raw["login"].stringValue }
    public var `avatar`: String? { raw["avatar"].stringValue }
    public var id: String { login ?? "unknown" }
}

public struct PRComment: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `author`: String? { raw["author"].stringValue }
    public var `body`: String? { raw["body"].stringValue }
    public var `url`: String? { raw["url"].stringValue }
    public var `avatar`: String? { raw["avatar"].stringValue }
    public var `reviewId`: String? { raw["reviewId"].stringValue }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `databaseId`: Int? { raw["databaseId"].intValue }
    public var id: String { string("id", default: string("url") + ":" + string("at") + ":" + string("author")) }
}

public struct PRThread: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `resolved`: Bool { flag("resolved") }
    public var `outdated`: Bool { flag("outdated") }
    public var `path`: String? { raw["path"].stringValue }
    public var `diffHunk`: String? { raw["diffHunk"].stringValue }
    public var `line`: Int? { raw["line"].intValue }
    public var `comments`: [PRComment] { models("comments") }
    public var id: String { string("id", default: string("path") + ":" + String(integer("line"))) }
}

public struct PRCommit: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `oid`: String? { raw["oid"].stringValue }
    public var `short`: String? { raw["short"].stringValue }
    public var `headline`: String? { raw["headline"].stringValue }
    public var `author`: String? { raw["author"].stringValue }
    public var `avatar`: String? { raw["avatar"].stringValue }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var id: String { string("oid") }
}

public struct PRCheck: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String? { raw["name"].stringValue }
    public var `workflow`: String? { raw["workflow"].stringValue }
    public var `url`: String? { raw["url"].stringValue }
    public var `status`: String { string("status") }
    public var `startedAt`: Date? { WireDate.date(raw["startedAt"]) }
    public var `completedAt`: Date? { WireDate.date(raw["completedAt"]) }
    public var `runId`: Int? { raw["runId"].intValue }
    public var id: String { string("workflow") + ":" + string("name") + ":" + String(integer("runId")) }
}

public struct PRReview: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `author`: String? { raw["author"].stringValue }
    public var `state`: String? { raw["state"].stringValue }
    public var `url`: String? { raw["url"].stringValue }
    public var `body`: String { string("body") }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var id: String { string("url", default: string("author") + ":" + string("at")) }
}

public struct PRReviewer: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `login`: String { string("login") }
    public var `state`: String { string("state") }
    public var `avatar`: String? { raw["avatar"].stringValue }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `team`: Bool { flag("team") }
    public var `stale`: Bool { flag("stale") }
    public var `rerequested`: Bool { flag("rerequested") }
    public var id: String { login }
}

public struct PRLabel: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String? { raw["name"].stringValue }
    public var `color`: String? { raw["color"].stringValue }
    public var id: String { string("name") }
}

public struct PRFile: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `path`: String? { raw["path"].stringValue }
    public var `additions`: Int? { raw["additions"].intValue }
    public var `deletions`: Int? { raw["deletions"].intValue }
    public var id: String { string("path") }
}

public struct PRTimelineItem: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `kind`: String { string("kind") }
    public var `text`: String { string("text") }
    public var `type`: String? { raw["type"].stringValue }
    public var `author`: String? { raw["author"].stringValue }
    public var `actor`: String? { raw["actor"].stringValue }
    public var `avatar`: String? { raw["avatar"].stringValue }
    public var `body`: String? { raw["body"].stringValue }
    public var `state`: String? { raw["state"].stringValue }
    public var `url`: String? { raw["url"].stringValue }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `edited`: Bool { flag("edited") }
    public var `commits`: [PRCommit] { models("commits") }
    public var id: String { string("id", default: kind + ":" + string("at") + ":" + string("author") + ":" + text) }
}

public struct PRCheckSummary: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `total`: Int { integer("total") }
    public var `pass`: Int { integer("pass") }
    public var `fail`: Int { integer("fail") }
    public var `pending`: Int { integer("pending") }
}

public struct PRSnapshot: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `url`: String? { raw["url"].stringValue }
    public var `repo`: String? { raw["repo"].stringValue }
    public var `title`: String? { raw["title"].stringValue }
    public var `state`: String? { raw["state"].stringValue }
    public var `author`: String? { raw["author"].stringValue }
    public var `authorAvatar`: String? { raw["authorAvatar"].stringValue }
    public var `headRef`: String? { raw["headRef"].stringValue }
    public var `baseRef`: String? { raw["baseRef"].stringValue }
    public var `headSha`: String? { raw["headSha"].stringValue }
    public var `mergeable`: String? { raw["mergeable"].stringValue }
    public var `reviewDecision`: String? { raw["reviewDecision"].stringValue }
    public var `body`: String? { raw["body"].stringValue }
    public var `number`: Int? { raw["number"].intValue }
    public var `additions`: Int? { raw["additions"].intValue }
    public var `deletions`: Int? { raw["deletions"].intValue }
    public var `changedFiles`: Int? { raw["changedFiles"].intValue }
    public var `commitCount`: Int? { raw["commitCount"].intValue }
    public var `timelineTotal`: Int? { raw["timelineTotal"].intValue }
    public var `isDraft`: Bool { flag("isDraft") }
    public var `createdAt`: Date? { WireDate.date(raw["createdAt"]) }
    public var `updatedAt`: Date? { WireDate.date(raw["updatedAt"]) }
    public var `fetchedAt`: Date? { WireDate.date(raw["fetchedAt"]) }
    public var `labels`: [PRLabel] { models("labels") }
    public var `assignees`: [PRActor] { models("assignees") }
    public var `checks`: [PRCheck] { models("checks") }
    public var `checkSummary`: PRCheckSummary { model("checkSummary") ?? PRCheckSummary() }
    public var `reviewers`: [PRReviewer] { models("reviewers") }
    public var `reviews`: [PRReview] { models("reviews") }
    public var `threads`: [PRThread] { models("threads") }
    public var `comments`: [PRComment] { models("comments") }
    public var `files`: [PRFile] { models("files") }
    public var `commits`: [PRCommit] { models("commits") }
    public var `avatars`: [String: String] { raw["avatars"].objectValue.compactMapValues(\.stringValue) }
    public var `timeline`: [PRTimelineItem] { models("timeline") }
}

public struct PRStateEvent: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `state`: PRSnapshot? { model("state") }
    public var `loading`: Bool { flag("loading") }
    public var `error`: String? { raw["error"].stringValue }
    public var `prUrl`: String { string("prUrl") }
}

public struct PRMention: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `login`: String { string("login") }
    public var `name`: String? { raw["name"].stringValue }
    public var `avatar`: String? { raw["avatar"].stringValue }
    public var `team`: Bool { flag("team") }
    public var id: String { login }
}

public struct PRMentions: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `query`: String { string("query") }
    public var `url`: String { string("url") }
    public var `ok`: Bool { flag("ok") }
    public var `complete`: Bool { flag("complete") }
    public var `users`: [PRMention] { models("users") }
    public var `teams`: [PRMention] { models("teams") }
    public var `viewer`: String? { raw["viewer"].stringValue }
    public var `message`: String? { raw["message"].stringValue }
}

public struct TerminalDescriptor: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `cwd`: String { string("cwd") }
    public var `busy`: Bool { flag("busy") }
    public var activeRun: String? { raw["activeRun"].stringValue }
    public var `command`: String? { raw["command"].stringValue }
    public var id: String { string("id") }
}

public struct TerminalRun: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `terminal`: String { string("terminal") }
    public var `command`: String { string("command") }
    public var `cwd`: String { string("cwd") }
    public var `output`: String { string("output") }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `exit`: Int? { raw["exit"].intValue }
    public var `note`: String? { raw["note"].stringValue }
    public var `done`: Bool { flag("done") }
    public var `tookMs`: Double { number("tookMs") }
    public var id: String { string("id") }
}

public struct VoiceAvailability: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `available`: Bool { flag("available") }
    public var `building`: Bool { flag("building") }
    public var `needsBuild`: Bool { flag("needsBuild") }
    public var `model`: String? { raw["model"].stringValue }
    public var `code`: String? { raw["code"].stringValue }
    public var `reason`: String? { raw["reason"].stringValue }
}

public struct VoiceText: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `text`: String { string("text") }
    public var `seconds`: Double { number("seconds") }
    public var `ms`: Double { number("ms") }
    public var id: String { string("id") }
}

public struct SlackUser: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `initials`: String { string("initials") }
    public var `image`: String? { raw["image"].stringValue }
    public var id: String { string("id") }
}

public struct SlackPreview: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `text`: String { string("text") }
    public var `from`: String? { raw["from"].stringValue }
    public var `ts`: String? { raw["ts"].stringValue }
    public var `mine`: Bool { flag("mine") }
    public var `at`: Date? { WireDate.date(raw["at"]) }
}

public struct SlackSidebarItem: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `kind`: String { string("kind") }
    public var `title`: String { string("title") }
    public var `isPrivate`: Bool { flag("private") }
    public var `user`: SlackUser? { model("user") }
    public var `latestAt`: Date? { WireDate.date(raw["latestAt"]) }
    public var `pendingSince`: Date? { WireDate.date(raw["pendingSince"]) }
    public var `unread`: Bool { flag("unread") }
    public var `pending`: Bool { flag("pending") }
    public var `vip`: Bool { flag("vip") }
    public var `muted`: Bool { flag("muted") }
    public var `mentions`: Int { integer("mentions") }
    public var `last`: SlackPreview? { model("last") }
    public var `mutedIn`: String? { raw["mutedIn"].stringValue }
    public var id: String { string("id") }
}

public struct SlackConversation: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `kind`: String? { raw["kind"].stringValue }
    public var `title`: String { string("title") }
    public var `isPrivate`: Bool { flag("private") }
    public var `with`: SlackUser? { model("with") }
    public var `vip`: Bool { flag("vip") }
    public var `pending`: Bool { flag("pending") }
    public var `muted`: Bool { flag("muted") }
    public var `lastAt`: Date? { WireDate.date(raw["lastAt"]) }
    public var `pendingSince`: Date? { WireDate.date(raw["pendingSince"]) }
    public var `last`: SlackPreview? { model("last") }
    public var `mutedIn`: String? { raw["mutedIn"].stringValue }
    public var id: String { string("id") }
}

public struct SlackMe: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `teamId`: String { string("teamId") }
    public var `team`: String { string("team") }
    public var `url`: String { string("url") }
    public var id: String { string("id") }
}

public struct SlackSidebar: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `loaded`: Bool { flag("loaded") }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `items`: [SlackSidebarItem] { models("items") }
}

public struct SlackState: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `connected`: Bool { flag("connected") }
    public var `signedOut`: Bool { flag("signedOut") }
    public var `enabled`: Bool { flag("enabled") }
    public var `hasTokens`: Bool { flag("hasTokens") }
    public var `mayReply`: Bool { flag("mayReply") }
    public var `mayEdit`: Bool { flag("mayEdit") }
    public var `local`: Bool { flag("local") }
    public var `socket`: String { string("socket") }
    public var `mode`: String { string("mode") }
    public var `setupUrl`: String { string("setupUrl") }
    public var `error`: String? { raw["error"].stringValue }
    public var `me`: SlackMe? { model("me") }
    public var `unresolved`: [String] { raw["unresolved"].arrayValue.compactMap(\.stringValue) }
    public var `vips`: [SlackUser] { models("vips") }
    public var `conversations`: [SlackConversation] { models("conversations") }
    public var `sidebar`: SlackSidebar { model("sidebar") ?? SlackSidebar() }
    public var `vipList`: [String] { raw["vipList"].arrayValue.compactMap(\.stringValue) }
    public var `mutedList`: [String] { raw["mutedList"].arrayValue.compactMap(\.stringValue) }
    public var `clock`: String { string("clock", default: "24h") }
}

public struct SlackFile: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String? { raw["name"].stringValue }
    public var `title`: String? { raw["title"].stringValue }
    public var `permalink`: String? { raw["permalink"].stringValue }
    public var `mimetype`: String { string("mimetype") }
    public var `image`: Bool { flag("image") }
    public var `w`: Int? { raw["w"].intValue }
    public var `h`: Int? { raw["h"].intValue }
    public var id: String { string("id") }
}

public struct SlackReaction: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `emoji`: String { string("emoji") }
    public var `count`: Int { integer("count") }
    public var `mine`: Bool { flag("mine") }
    public var id: String { name }
}

public struct SlackMessage: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `ts`: String { string("ts") }
    public var `initials`: String { string("initials") }
    public var `html`: String { string("html") }
    public var `user`: String? { raw["user"].stringValue }
    public var `name`: String? { raw["name"].stringValue }
    public var `threadTs`: String? { raw["threadTs"].stringValue }
    public var `mine`: Bool { flag("mine") }
    public var `edited`: Bool { flag("edited") }
    public var `files`: [SlackFile] { models("files") }
    public var `reactions`: [SlackReaction] { models("reactions") }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `replyCount`: Int { integer("replyCount") }
    public var id: String { ts }
}

public struct SlackThreadPage: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `conversation`: SlackConversation { model("conversation") ?? SlackConversation() }
    public var `thread`: String? { raw["thread"].stringValue }
    public var `messages`: [SlackMessage] { models("messages") }
    public var `hasMore`: Bool { flag("hasMore") }
}

public struct NotificationEvent: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `kind`: String { string("kind") }
    public var `title`: String { string("title") }
    public var `body`: String { string("body") }
    public var `at`: Date? { WireDate.date(raw["at"]) }
    public var `tag`: String? { raw["tag"].stringValue }
    public var `session`: String? { raw["session"].stringValue }
    public var `conversation`: String? { raw["conversation"].stringValue }
    public var `url`: String? { raw["url"].stringValue }
    public var `to`: String? { raw["to"].stringValue }
    public var `renotify`: Bool { flag("renotify") }
    public var `alarm`: Bool { flag("alarm") }
}

public struct TokenTotals: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `input`: Int? { raw["input"].intValue }
    public var `output`: Int? { raw["output"].intValue }
    public var `cacheRead`: Int? { raw["cacheRead"].intValue }
    public var `cacheCreate`: Int? { raw["cacheCreate"].intValue }
    public var `total`: Int? { raw["total"].intValue }
}

public struct ReportWindow: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `kept`: Int? { raw["kept"].intValue }
    public var `dropped`: Int? { raw["dropped"].intValue }
    public var `limit`: Int? { raw["limit"].intValue }
}

public struct ReportInstance: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `id`: String? { raw["id"].stringValue }
    public var `label`: String? { raw["label"].stringValue }
    public var `ticket`: String? { raw["ticket"].stringValue }
    public var `customTitle`: String? { raw["customTitle"].stringValue }
    public var `cwd`: String? { raw["cwd"].stringValue }
    public var `folder`: String? { raw["folder"].stringValue }
    public var `claudeSessionId`: String? { raw["claudeSessionId"].stringValue }
    public var `lastError`: String? { raw["lastError"].stringValue }
    public var `provider`: Provider { Provider(rawValue: string("provider", default: "claude")) ?? .unknown }
    public var `status`: ConversationStatus { ConversationStatus(rawValue: string("status")) ?? .unknown }
    public var `busy`: Bool { flag("busy") }
    public var `running`: Bool { flag("running") }
    public var `asleep`: Bool { flag("asleep") }
    public var `paused`: Bool { flag("paused") }
    public var `pid`: Int? { raw["pid"].intValue }
    public var `startedAt`: Double? { raw["startedAt"].doubleValue }
    public var `ageMs`: Double? { raw["ageMs"].doubleValue }
    public var `processUpMs`: Double? { raw["processUpMs"].doubleValue }
    public var `pausedUntil`: Double? { raw["pausedUntil"].doubleValue }
}

public struct ReportConfiguration: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `model`: String? { raw["model"].stringValue }
    public var `requestedModel`: String? { raw["requestedModel"].stringValue }
    public var `effort`: String? { raw["effort"].stringValue }
    public var `permissionMode`: String? { raw["permissionMode"].stringValue }
    public var `outputStyle`: String? { raw["outputStyle"].stringValue }
    public var `claudePath`: String? { raw["claudePath"].stringValue }
    public var `autoTitle`: Bool? { raw["autoTitle"].boolValue }
    public var `extraArgs`: [String] { raw["extraArgs"].arrayValue.compactMap(\.stringValue) }
    public var `queueDelayMs`: Double? { raw["queueDelayMs"].doubleValue }
}

public struct MessageCounts: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `user`: Int? { raw["user"].intValue }
    public var `assistant`: Int? { raw["assistant"].intValue }
    public var `thinking`: Int? { raw["thinking"].intValue }
    public var `tool`: Int? { raw["tool"].intValue }
    public var `permission`: Int? { raw["permission"].intValue }
    public var `notice`: Int? { raw["notice"].intValue }
    public var `images`: Int? { raw["images"].intValue }
}

public struct ReportTotals: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var `cacheHitRate`: Double? { raw["cacheHitRate"].doubleValue }
    public var `contextPct`: Double? { raw["contextPct"].doubleValue }
    public var `workedMs`: Double? { raw["workedMs"].doubleValue }
    public var `wallMs`: Double? { raw["wallMs"].doubleValue }
    public var `idleMs`: Double? { raw["idleMs"].doubleValue }
    public var `focusPct`: Double? { raw["focusPct"].doubleValue }
    public var `avgTurnMs`: Double? { raw["avgTurnMs"].doubleValue }
    public var `avgCost`: Double? { raw["avgCost"].doubleValue }
    public var `outputPerSecond`: Double? { raw["outputPerSecond"].doubleValue }
    public var `burnPerHour`: Double? { raw["burnPerHour"].doubleValue }
    public var `thinkingShare`: Double? { raw["thinkingShare"].doubleValue }
    public var `lastCompactedAt`: Double? { raw["lastCompactedAt"].doubleValue }
    public var `turns`: Int? { raw["turns"].intValue }
    public var `contextTokens`: Int? { raw["contextTokens"].intValue }
    public var `contextWindow`: Int? { raw["contextWindow"].intValue }
    public var `turnsLogged`: Int? { raw["turnsLogged"].intValue }
    public var `toolCalls`: Int? { raw["toolCalls"].intValue }
    public var `toolErrors`: Int? { raw["toolErrors"].intValue }
    public var `toolsRunning`: Int? { raw["toolsRunning"].intValue }
    public var `errors`: Int? { raw["errors"].intValue }
    public var `interrupts`: Int? { raw["interrupts"].intValue }
    public var `compactions`: Int? { raw["compactions"].intValue }
    public var `writtenChars`: Int? { raw["writtenChars"].intValue }
    public var `promptChars`: Int? { raw["promptChars"].intValue }
    public var `images`: Int? { raw["images"].intValue }
    public var `tokens`: TokenTotals { model("tokens") ?? TokenTotals() }
    public var `messages`: MessageCounts { model("messages") ?? MessageCounts() }
}

public struct ReportTurn: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `n`: Int? { raw["n"].intValue }
    public var `input`: Int? { raw["input"].intValue }
    public var `output`: Int? { raw["output"].intValue }
    public var `cacheRead`: Int? { raw["cacheRead"].intValue }
    public var `cacheCreate`: Int? { raw["cacheCreate"].intValue }
    public var `tokens`: Int? { raw["tokens"].intValue }
    public var `contextTokens`: Int? { raw["contextTokens"].intValue }
    public var `tools`: Int? { raw["tools"].intValue }
    public var `at`: Double? { raw["at"].doubleValue }
    public var `durationMs`: Double? { raw["durationMs"].doubleValue }
    public var `costUsd`: Double? { raw["costUsd"].doubleValue }
    public var `toolNames`: [String] { raw["toolNames"].arrayValue.compactMap(\.stringValue) }
    public var `model`: String? { raw["model"].stringValue }
    public var `interrupted`: Bool { flag("interrupted") }
    public var `isError`: Bool { flag("isError") }
    public var id: String { String(integer("n")) }
}

public struct LastTurn: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `n`: Int? { raw["n"].intValue }
    public var `tokens`: Int? { raw["tokens"].intValue }
    public var `tools`: Int? { raw["tools"].intValue }
    public var `durationMs`: Double? { raw["durationMs"].doubleValue }
    public var `costUsd`: Double? { raw["costUsd"].doubleValue }
    public var `outputPerSecond`: Double? { raw["outputPerSecond"].doubleValue }
}

public struct ToolCount: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `calls`: Int? { raw["calls"].intValue }
    public var `errors`: Int? { raw["errors"].intValue }
    public var id: String { name }
}

public struct FileCount: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `file`: String { string("file") }
    public var `name`: String { string("name") }
    public var `count`: Int? { raw["count"].intValue }
    public var id: String { file }
}

public struct CommandCount: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `cmd`: String { string("cmd") }
    public var `count`: Int? { raw["count"].intValue }
    public var id: String { cmd }
}

public struct Runway: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `growthPerTurn`: Double? { raw["growthPerTurn"].doubleValue }
    public var `turnsLeft`: Double? { raw["turnsLeft"].doubleValue }
}

public struct ReportRecord: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `n`: Int? { raw["n"].intValue }
    public var `tokens`: Int? { raw["tokens"].intValue }
    public var `durationMs`: Double? { raw["durationMs"].doubleValue }
    public var `costUsd`: Double? { raw["costUsd"].doubleValue }
}

public struct ReportRecords: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `longest`: ReportRecord? { model("longest") }
    public var `costliest`: ReportRecord? { model("costliest") }
    public var `biggest`: ReportRecord? { model("biggest") }
    public var `peakContext`: ReportRecord? { model("peakContext") }
    public var `busiestTurn`: Int? { raw["busiestTurn"].intValue }
}

public struct ReportQueue: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `length`: Int? { raw["length"].intValue }
    public var `drainAt`: Double? { raw["drainAt"].doubleValue }
    public var `delayMs`: Double? { raw["delayMs"].doubleValue }
}

public struct GitState: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `root`: String? { raw["root"].stringValue }
    public var `branch`: String? { raw["branch"].stringValue }
    public var `commit`: String? { raw["commit"].stringValue }
    public var `detached`: Bool { flag("detached") }
    public var `worktree`: Bool { flag("worktree") }
}

public struct TranscriptInfo: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `path`: String? { raw["path"].stringValue }
    public var `exists`: Bool { flag("exists") }
    public var `sizeBytes`: Int? { raw["sizeBytes"].intValue }
    public var `modified`: Double? { raw["modified"].doubleValue }
}

public struct FleetMember: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `id`: String? { raw["id"].stringValue }
    public var `label`: String? { raw["label"].stringValue }
    public var `cwd`: String? { raw["cwd"].stringValue }
    public var `folder`: String? { raw["folder"].stringValue }
    public var `project`: String? { raw["project"].stringValue }
    public var `projectPath`: String? { raw["projectPath"].stringValue }
    public var `branch`: String? { raw["branch"].stringValue }
    public var `model`: String? { raw["model"].stringValue }
    public var `effort`: String? { raw["effort"].stringValue }
    public var `provider`: Provider { Provider(rawValue: string("provider", default: "claude")) ?? .unknown }
    public var `status`: ConversationStatus { ConversationStatus(rawValue: string("status")) ?? .unknown }
    public var `busy`: Bool { flag("busy") }
    public var `asleep`: Bool { flag("asleep") }
    public var `paused`: Bool { flag("paused") }
    public var `running`: Bool { flag("running") }
    public var `active`: Bool { flag("active") }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var `cacheHitRate`: Double? { raw["cacheHitRate"].doubleValue }
    public var `contextPct`: Double? { raw["contextPct"].doubleValue }
    public var `workedMs`: Double? { raw["workedMs"].doubleValue }
    public var `avgTurnMs`: Double? { raw["avgTurnMs"].doubleValue }
    public var `avgCost`: Double? { raw["avgCost"].doubleValue }
    public var `burnPerHour`: Double? { raw["burnPerHour"].doubleValue }
    public var `ageMs`: Double? { raw["ageMs"].doubleValue }
    public var `lastTurnAt`: Double? { raw["lastTurnAt"].doubleValue }
    public var `quietMs`: Double? { raw["quietMs"].doubleValue }
    public var `turns`: Int? { raw["turns"].intValue }
    public var `tokens`: Int? { raw["tokens"].intValue }
    public var `input`: Int? { raw["input"].intValue }
    public var `output`: Int? { raw["output"].intValue }
    public var `cacheRead`: Int? { raw["cacheRead"].intValue }
    public var `cacheCreate`: Int? { raw["cacheCreate"].intValue }
    public var `contextTokens`: Int? { raw["contextTokens"].intValue }
    public var `contextWindow`: Int? { raw["contextWindow"].intValue }
    public var `turnsLogged`: Int? { raw["turnsLogged"].intValue }
    public var `toolCalls`: Int? { raw["toolCalls"].intValue }
    public var `toolErrors`: Int? { raw["toolErrors"].intValue }
    public var `errors`: Int? { raw["errors"].intValue }
    public var `interrupts`: Int? { raw["interrupts"].intValue }
    public var `compactions`: Int? { raw["compactions"].intValue }
    public var `queue`: Int? { raw["queue"].intValue }
    public var `spend`: [Double] { raw["spend"].arrayValue.compactMap(\.doubleValue) }
}

public struct FleetTotals: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `instances`: Int? { raw["instances"].intValue }
    public var `running`: Int? { raw["running"].intValue }
    public var `working`: Int? { raw["working"].intValue }
    public var `waiting`: Int? { raw["waiting"].intValue }
    public var `asleep`: Int? { raw["asleep"].intValue }
    public var `errored`: Int? { raw["errored"].intValue }
    public var `queued`: Int? { raw["queued"].intValue }
    public var `tokens`: Int? { raw["tokens"].intValue }
    public var `output`: Int? { raw["output"].intValue }
    public var `cacheRead`: Int? { raw["cacheRead"].intValue }
    public var `promptTokens`: Int? { raw["promptTokens"].intValue }
    public var `turns`: Int? { raw["turns"].intValue }
    public var `toolCalls`: Int? { raw["toolCalls"].intValue }
    public var `toolErrors`: Int? { raw["toolErrors"].intValue }
    public var `projects`: Int? { raw["projects"].intValue }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var `workedMs`: Double? { raw["workedMs"].doubleValue }
    public var `share`: Double? { raw["share"].doubleValue }
}

public struct ProjectTotals: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `project`: String? { raw["project"].stringValue }
    public var `path`: String? { raw["path"].stringValue }
    public var `instances`: Int? { raw["instances"].intValue }
    public var `working`: Int? { raw["working"].intValue }
    public var `tokens`: Int? { raw["tokens"].intValue }
    public var `turns`: Int? { raw["turns"].intValue }
    public var `toolCalls`: Int? { raw["toolCalls"].intValue }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var id: String { string("path") }
}

public struct LifetimeTotals: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `cost`: Double? { raw["cost"].doubleValue }
    public var `since`: Double? { raw["since"].doubleValue }
    public var `tokens`: Int? { raw["tokens"].intValue }
    public var `turns`: Int? { raw["turns"].intValue }
    public var `instances`: Int? { raw["instances"].intValue }
    public var `projects`: Int? { raw["projects"].intValue }
}

public struct UsageWindow: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `used`: Double? { raw["used"].doubleValue }
    public var `resetsAt`: Double? { raw["resetsAt"].doubleValue }
}

public struct ClaudeLimitWindows: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `fiveHour`: UsageWindow? { model("fiveHour") }
    public var `week`: UsageWindow? { model("week") }
    public var `weekOverage`: UsageWindow? { model("weekOverage") }
}

public struct ClaudeLimits: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `status`: String? { raw["status"].stringValue }
    public var `type`: String? { raw["type"].stringValue }
    public var `used`: Double? { raw["used"].doubleValue }
    public var `resetsAt`: Double? { raw["resetsAt"].doubleValue }
    public var `at`: Double? { raw["at"].doubleValue }
    public var `overage`: Bool? { raw["overage"].boolValue }
    public var `fromMessage`: Bool { flag("fromMessage") }
    public var `windows`: ClaudeLimitWindows { model("windows") ?? ClaudeLimitWindows() }
}

public struct CodexUsageWindow: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `mins`: Double? { raw["mins"].doubleValue }
    public var `used`: Double? { raw["used"].doubleValue }
    public var `resetsAt`: Double? { raw["resetsAt"].doubleValue }
    public var id: String { name }
}

public struct CodexLimitAccount: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String? { raw["name"].stringValue }
    public var `home`: String? { raw["home"].stringValue }
    public var `email`: String? { raw["email"].stringValue }
    public var `plan`: String? { raw["plan"].stringValue }
    public var `reached`: String? { raw["reached"].stringValue }
    public var `error`: String? { raw["error"].stringValue }
    public var `windows`: [CodexUsageWindow] { models("windows") }
    public var `resets`: Double? { raw["resets"].doubleValue }
    public var `at`: Double? { raw["at"].doubleValue }
    public var id: String { string("id") }
}

public struct QuotaPause: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `since`: Double? { raw["since"].doubleValue }
    public var `until`: Double? { raw["until"].doubleValue }
    public var `blind`: Bool { flag("blind") }
    public var `limitType`: String? { raw["limitType"].stringValue }
}

public struct TrailEntry: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `deviceId`: String? { raw["deviceId"].stringValue }
    public var `device`: String? { raw["device"].stringValue }
    public var `action`: String? { raw["action"].stringValue }
    public var `instance`: String? { raw["instance"].stringValue }
    public var `detail`: String? { raw["detail"].stringValue }
    public var `allowed`: Bool { flag("allowed") }
    public var `at`: Date? { WireDate.date(raw["at"]) }
}

public struct ReachState: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `sealed`: Bool? { raw["sealed"].boolValue }
    public var `appOnly`: Bool? { raw["appOnly"].boolValue }
    public var `push`: Bool? { raw["push"].boolValue }
    public var `apple`: Bool? { raw["apple"].boolValue }
}

public struct ReportDevice: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `name`: String { string("name") }
    public var `control`: Bool { flag("control") }
    public var `biometric`: Bool { flag("biometric") }
    public var `protection`: KeyProtection { KeyProtection(rawValue: string("protection")) ?? .unknown }
    public var `lastSeenAt`: Date? { WireDate.date(raw["lastSeenAt"]) }
    public var `pairedAt`: Date? { WireDate.date(raw["pairedAt"]) }
    public var `reach`: ReachState? { model("reach") }
}

public struct ReportEnvironment: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `awake`: AwakeState? { model("awake") }
    public var `devices`: [ReportDevice] { models("devices") }
    public var `trail`: [TrailEntry] { models("trail") }
    public var `reach`: ReachState? { model("reach") }
    public var `limits`: ClaudeLimits? { model("limits") }
    public var `codexLimits`: [CodexLimitAccount] { models("codexLimits") }
    public var `pause`: QuotaPause? { model("pause") }
    public var `transcriptPath`: String? { raw["transcriptPath"].stringValue }
    public var `vscode`: String? { raw["vscode"].stringValue }
    public var `node`: String? { raw["node"].stringValue }
    public var `electron`: String? { raw["electron"].stringValue }
    public var `platform`: String? { raw["platform"].stringValue }
    public var `arch`: String? { raw["arch"].stringValue }
    public var `extension`: String? { raw["extension"].stringValue }
    public var `home`: String? { raw["home"].stringValue }
    public var `groupByProject`: String? { raw["groupByProject"].stringValue }
    public var `cpus`: Double? { raw["cpus"].doubleValue }
    public var `memoryGb`: Double? { raw["memoryGb"].doubleValue }
    public var `showThinking`: Bool? { raw["showThinking"].boolValue }
}

public struct Report: WireModel {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var `generatedAt`: Date? { WireDate.date(raw["generatedAt"]) }
    public var `window`: ReportWindow { model("window") ?? ReportWindow() }
    public var `instance`: ReportInstance { model("instance") ?? ReportInstance() }
    public var `config`: ReportConfiguration { model("config") ?? ReportConfiguration() }
    public var `totals`: ReportTotals { model("totals") ?? ReportTotals() }
    public var `turns`: [ReportTurn] { models("turns") }
    public var `lastTurn`: LastTurn? { model("lastTurn") }
    public var `tools`: [ToolCount] { models("tools") }
    public var `files`: [FileCount] { models("files") }
    public var `commands`: [CommandCount] { models("commands") }
    public var `hourly`: [Double] { raw["hourly"].arrayValue.compactMap(\.doubleValue) }
    public var `runway`: Runway? { model("runway") }
    public var `records`: ReportRecords? { model("records") }
    public var `queue`: ReportQueue { model("queue") ?? ReportQueue() }
    public var `git`: GitState? { model("git") }
    public var `transcript`: TranscriptInfo { model("transcript") ?? TranscriptInfo() }
    public var `fleet`: [FleetMember] { models("fleet") }
    public var `fleetTotals`: FleetTotals { model("fleetTotals") ?? FleetTotals() }
    public var `projects`: [ProjectTotals] { models("projects") }
    public var `lifetime`: LifetimeTotals? { model("lifetime") }
    public var `limits`: ClaudeLimits? { model("limits") }
    public var `codexLimits`: [CodexLimitAccount] { models("codexLimits") }
    public var `pause`: QuotaPause? { model("pause") }
    public var `env`: ReportEnvironment { model("env") ?? ReportEnvironment() }
}
