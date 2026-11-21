import Foundation
import CryptoKit

/// Application protocol versions are independent of authentication and @box versions.
public enum ApplicationProtocol: Int, Codable, Sendable { case v1 = 1, v2 = 2 }
public enum ProtocolCapabilities {
    public static let core = ["mid-ack-v1", "receipts-v1", "run-precondition-v1", "operation-state-v1"]
    public static let supported = core + ["pr-v1", "slack-v1", "terminal-v1", "voice-v1"]
}

enum V2Wire {
    static func require(_ condition: Bool, _ detail: String) throws {
        if !condition { throw CoreFailure(.protocolViolation, "Invalid protocol v2 " + detail + ".") }
    }
    static func object(_ j: JSONValue, _ keys: [String]) throws {
        guard case .object(let fields) = j else { throw CoreFailure(.protocolViolation, "Expected a protocol v2 object.") }
        try require(keys.allSatisfy { fields[$0] != nil }, "required fields")
    }
    static func id(_ value: JSONValue) -> Bool {
        guard let s = value.stringValue else { return false }
        return s.utf8.count == 32 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func integer(_ j: JSONValue, minimum: Int = 0) -> Bool {
        guard let n = j.intValue else { return false }; return n >= minimum && n <= 9_007_199_254_740_991
    }
    static func text(_ j: JSONValue, maximum: Int = 256, empty: Bool = false) -> Bool {
        guard let s = j.stringValue else { return false }; return (empty || !s.isEmpty) && s.utf8.count <= maximum
    }
    static func target(_ j: JSONValue) -> Bool {
        guard let s = j.stringValue else { return false }; return s == "fleet" || (s.hasPrefix("session:") && s.utf8.count > 8)
    }
    static func caps(_ j: JSONValue) throws -> [String] {
        guard case .array(let values) = j else { throw CoreFailure(.protocolViolation, "Invalid protocol capabilities.") }
        let strings = values.compactMap(\.stringValue)
        try require(strings.count == values.count && strings.count <= 64 && Set(strings).count == strings.count && strings.allSatisfy {
            !$0.isEmpty && $0.utf8.count <= 64 && $0.utf8.allSatisfy { (32...126).contains($0) }
        }, "capabilities")
        return strings
    }
    static func range(_ j: JSONValue) throws -> ClosedRange<Int> {
        try object(j, ["min", "max"])
        try require(integer(j["min"], minimum: 1) && integer(j["max"], minimum: 1) && j["min"].intValue! <= j["max"].intValue!, "version range")
        return j["min"].intValue!...j["max"].intValue!
    }
    static func randomID() -> String {
        SymmetricKey(size: .bits128).withUnsafeBytes { bytes in bytes.map { String(format: "%02x", $0) }.joined() }
    }
}

/// Immutable DTOs validate required fields while retaining additive wire data.
public protocol ValidatedWireModel: Codable, Sendable, Equatable {
    var raw: JSONValue { get }
    init(validating raw: JSONValue) throws
}
extension ValidatedWireModel {
    public init(from decoder: any Decoder) throws { try self.init(validating: JSONValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct RunRef: ValidatedWireModel, Hashable {
    public let raw: JSONValue
    public var id: String { raw["id"].stringValue! }
    public var turn: String? { raw["turn"].stringValue }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["id", "turn"])
        try V2Wire.require(Set(raw.objectValue.keys) == ["id", "turn"] && V2Wire.id(raw["id"]) && (raw["turn"].isNull || V2Wire.text(raw["turn"])), "run reference")
        self.raw = raw
    }
    public init(id: String, turn: String?) throws { try self.init(validating: .object(["id": .string(id), "turn": turn.map(JSONValue.string) ?? .null])) }
    public static func == (lhs: Self, rhs: Self) -> Bool { lhs.id.utf8.elementsEqual(rhs.id.utf8) && lhs.turn.map { Data($0.utf8) } == rhs.turn.map { Data($0.utf8) } }
    public func hash(into hasher: inout Hasher) { hasher.combine(Data(id.utf8)); hasher.combine(turn.map { Data($0.utf8) }) }
}
public struct QuestionRef: ValidatedWireModel {
    public let raw: JSONValue
    public var requestID: String { raw["requestId"].stringValue! }
    public var run: RunRef { try! RunRef(validating: raw["run"]) }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["requestId", "run"])
        try V2Wire.require(V2Wire.text(raw["requestId"]), "question identity")
        _ = try RunRef(validating: raw["run"]); self.raw = raw
    }
    public static func == (lhs: Self, rhs: Self) -> Bool { lhs.requestID.utf8.elementsEqual(rhs.requestID.utf8) && lhs.run == rhs.run }
}
public struct ReceiptPolicy: ValidatedWireModel {
    public let raw: JSONValue
    public var scope: String { raw["scope"].stringValue! }
    public var retentionMilliseconds: Int { raw["retentionMs"].intValue! }
    public var maximumMessageBytes: Int { raw["maxMessageBytes"].intValue! }
    public var now: Int { raw["now"].intValue! }
    public init(validating raw: JSONValue) throws {
        let keys = ["retentionMs", "maxEntries", "maxBytes", "maxMessageBytes", "maxResultBytes", "now"]
        try V2Wire.object(raw, ["scope"] + keys)
        try V2Wire.require(V2Wire.id(raw["scope"]) && keys.allSatisfy { V2Wire.integer(raw[$0], minimum: $0 == "now" ? 0 : 1) } && (raw["retentionMs"].intValue ?? 0) >= 86_400_000, "receipt policy")
        self.raw = raw
    }
}
public struct ProtocolWelcome: ValidatedWireModel {
    public let raw: JSONValue
    public var version: ApplicationProtocol { ApplicationProtocol(rawValue: raw["proto"].intValue!)! }
    public var capabilities: [String] { raw["caps"].arrayValue.compactMap(\.stringValue) }
    public var engineID: String { raw["engine"]["id"].stringValue! }
    public var bootID: String { raw["engine"]["boot"].stringValue! }
    public var seat: Seat { Seat(raw["seat"]) }
    public var receipts: ReceiptPolicy? { raw["receipts"].isNull ? nil : try! ReceiptPolicy(validating: raw["receipts"]) }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["type", "proto", "caps", "engine", "seat", "receipts"])
        try V2Wire.require(raw["type"].stringValue == "welcome" && [1, 2].contains(raw["proto"].intValue ?? 0), "welcome version")
        let caps = try V2Wire.caps(raw["caps"])
        let engine = raw["engine"], seat = raw["seat"]
        try V2Wire.object(engine, ["id", "boot", "version", "mode"])
        try V2Wire.object(seat, ["id", "control", "local", "editor"])
        try V2Wire.require(V2Wire.id(engine["id"]) && V2Wire.id(engine["boot"]) && V2Wire.text(engine["version"], maximum: 80, empty: true) && ["window", "service"].contains(engine["mode"].stringValue ?? ""), "engine identity")
        try V2Wire.require(V2Wire.text(seat["id"]) && ["control", "local", "editor"].allSatisfy { seat[$0].boolValue != nil } && (seat["editor"].boolValue != true || seat["local"].boolValue == true), "seat")
        if raw["proto"].intValue == 2 {
            try V2Wire.require(ProtocolCapabilities.core.allSatisfy(caps.contains), "required capabilities")
            _ = try ReceiptPolicy(validating: raw["receipts"])
        } else { try V2Wire.require(caps.isEmpty && raw["receipts"].isNull, "legacy welcome") }
        self.raw = raw
    }
}
public struct ProtocolSession: Sendable, Equatable {
    public let version: ApplicationProtocol
    public let welcome: ProtocolWelcome?
    public let receivedAt: Date
    public init(welcome: ProtocolWelcome? = nil, receivedAt: Date = Date()) { self.welcome = welcome; version = welcome?.version ?? .v1; self.receivedAt = receivedAt }
    public func serverTime(at date: Date) -> Int {
        let base = welcome?.receipts?.now ?? Int(WireDate.milliseconds(receivedAt))
        return base + Int(date.timeIntervalSince(receivedAt) * 1_000)
    }
    public func supports(_ capability: String) -> Bool { version == .v1 || welcome?.capabilities.contains(capability) == true }
    public static func hello(clientID: String, version: String = "1.0") -> JSONValue {
        .object(["type": .string("hello"), "proto": .object(["min": .number(1), "max": .number(2)]), "caps": .array(ProtocolCapabilities.supported.map(JSONValue.string)), "client": .object(["id": .string(clientID), "kind": .string("iphone"), "version": .string(version)])])
    }
    static func advertised(_ welcome: JSONValue) throws -> Bool {
        guard let range = welcome.objectValue["proto"] else {
            try V2Wire.require(welcome.objectValue["caps"] == nil, "advertisement"); return false
        }
        _ = try V2Wire.range(range); _ = try V2Wire.caps(welcome["caps"]); return true
    }
}

public enum AckOutcome: String, Codable, Sendable { case applied, rejected, pending, unknown }
public enum AckStatus: String, Codable, Sendable { case applied, rejected, pending, unknown, duplicate }
public enum ProtocolErrorCode: String, Codable, Sendable {
    case badMessage = "BAD_MESSAGE", midRequired = "MID_REQUIRED", midConflict = "MID_CONFLICT", scopeChanged = "SCOPE_CHANGED"
    case expired = "EXPIRED", clockSkew = "CLOCK_SKEW", forbidden = "FORBIDDEN", localRequired = "LOCAL_REQUIRED", unsupported = "UNSUPPORTED", notFound = "NOT_FOUND"
    case staleRun = "STALE_RUN", staleTurn = "STALE_TURN", staleResource = "STALE_RESOURCE", approvalResolved = "APPROVAL_RESOLVED"
    case editorUnavailable = "EDITOR_UNAVAILABLE", uiUnavailable = "UI_UNAVAILABLE", cancelled = "CANCELLED"
    case receiptFull = "RECEIPT_FULL", storageUnavailable = "STORAGE_UNAVAILABLE", engineRestarted = "ENGINE_RESTARTED", providerRejected = "PROVIDER_REJECTED", outcomeUnknown = "OUTCOME_UNKNOWN"
}
public struct ProtocolFailure: ValidatedWireModel {
    public let raw: JSONValue
    public var code: ProtocolErrorCode { ProtocolErrorCode(rawValue: raw["code"].stringValue!)! }
    public var message: String { raw["message"].stringValue! }
    public var retryable: Bool { raw["retryable"].boolValue! }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["code", "message", "retryable"])
        try V2Wire.require(ProtocolErrorCode(rawValue: raw["code"].stringValue ?? "") != nil && V2Wire.text(raw["message"], maximum: 2048, empty: true) && raw["retryable"].boolValue != nil, "error")
        self.raw = raw
    }
}
public struct MutationResult: ValidatedWireModel {
    public enum Code: String, Codable, Sendable { case accepted, ok, noop }
    public let raw: JSONValue
    public var code: Code { Code(rawValue: raw["code"].stringValue!)! }
    public var data: JSONValue { raw["data"] }
    public var replies: [JSONValue] { raw["replies"].arrayValue }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["code", "data", "replies"])
        try V2Wire.require(Code(rawValue: raw["code"].stringValue ?? "") != nil, "result code")
        guard case .object = raw["data"], case .array(let replies) = raw["replies"] else { throw CoreFailure(.protocolViolation, "Invalid mutation result.") }
        let forbidden = ["ack", "operation", "@auth", "@box", "@challenge", "@welcome", "welcome"]
        try V2Wire.require(replies.allSatisfy { V2Wire.text($0["type"]) && !forbidden.contains($0["type"].stringValue!) }, "recorded replies")
        self.raw = raw
    }
    func validate(what: String) throws {
        let permitted: [String: [String]] = ["instance:new": ["instance:created"], "instance:resume": ["instance:created"], "instance:place": ["instance:placed"], "editQueued": ["editPrompt"], "saveCommand": ["commands"], "removeCommand": ["commands"], "restoreCommand": ["commands"], "pr:reply": ["pr:done"], "pr:resolve": ["pr:done"], "pr:comment": ["pr:done"], "pr:rerun": ["pr:done"], "term:open": ["term:opened"], "term:close": ["term:closed"], "@listen": ["@listener"], "slack:reply": ["slack:sent"], "slack:link": ["slack:link"], "slack:openTicket": ["slack:openTicket"], "switch": ["@navigate"]]
        try V2Wire.require(replies.allSatisfy { permitted[what, default: []].contains($0["type"].stringValue ?? "") }, "reply family")
        func strings(_ keys: [String]) throws { try V2Wire.require(keys.allSatisfy { data[$0].stringValue != nil }, "result data") }
        func nullableStrings(_ keys: [String]) throws { try V2Wire.require(keys.allSatisfy { data.objectValue[$0] != nil && (data[$0].isNull || data[$0].stringValue != nil) }, "nullable result data") }
        switch what {
        case "send":
            try strings(["instance", "queueId", "operation"])
            try V2Wire.require(code == .accepted && V2Wire.id(data["operation"]), "send acceptance")
        case "ready":
            try strings(["instance"]); try V2Wire.object(data, ["run"])
            if !data["run"].isNull { _ = try RunRef(validating: data["run"]) }
        case "visible": try V2Wire.require(data["on"].boolValue != nil, "visible result")
        case "instance:new", "instance:resume": try strings(["instance"])
        case "instance:place": try strings(["instance"]); try nullableStrings(["folderId"])
        case "permission":
            try strings(["requestId"]); _ = try RunRef(validating: data["run"])
            try V2Wire.require(data["allow"].boolValue != nil && data["delivery"].stringValue == "submitted", "permission result")
        case "interrupt", "stopTask":
            _ = try RunRef(validating: data["run"]); try nullableStrings(["taskId"])
            try V2Wire.require(data["delivery"].stringValue == "submitted", "control result")
        case "unqueue", "promoteQueued", "editQueued":
            try strings(["queueId"])
            if what == "editQueued" {
                try V2Wire.require(replies.count == 1, "reclaimed draft")
                let reply = replies[0]
                try V2Wire.object(reply, ["text", "sent", "snippets", "attachments"])
                try V2Wire.require(reply["text"].stringValue != nil && (reply["sent"].isNull || reply["sent"].stringValue != nil), "reclaimed text")
                guard case .array(let snippets) = reply["snippets"], case .array(let images) = reply["attachments"] else { throw CoreFailure(.protocolViolation, "Invalid reclaimed draft arrays.") }
                try V2Wire.require(snippets.allSatisfy { $0.stringValue != nil } && images.allSatisfy { $0["name"].stringValue != nil && $0["mediaType"].stringValue != nil && $0["data"].stringValue != nil }, "reclaimed attachments")
            }
        case "clearQueue": try V2Wire.require(V2Wire.integer(data["removed"]), "queue count")
        case "setSetting", "awake:set", "lid:set": try strings(["id"]); try V2Wire.object(data, ["value"])
        case "saveCommand", "removeCommand", "restoreCommand": try strings(["name"])
        case "pr:reply", "pr:resolve", "pr:comment", "pr:rerun":
            try strings(["prUrl", "action", "message"]); try nullableStrings(["providerId"])
            try V2Wire.require(data["action"].stringValue == String(what.dropFirst(3)), "PR action")
        case "pr:pane", "pr:link", "pr:unlink":
            try nullableStrings(["prUrl"]); try V2Wire.object(data, ["pane"])
            if !data["pane"].isNull { try V2Wire.object(data["pane"], ["open", "tab", "width", "full"]) }
        case "term:open": try V2Wire.object(data["terminal"], ["id"])
        case "term:run", "term:stop", "term:close": try strings(["terminal"]); try nullableStrings(["terminalRun"])
        case "@apple": try V2Wire.require(data["registered"].boolValue == true, "APNs result")
        case "@listen": try V2Wire.require(data.objectValue.isEmpty && replies.count == 1 && replies[0]["secret"].stringValue != nil, "listener result")
        case "forget": try strings(["device"])
        case "slack:reply", "slack:open":
            try nullableStrings(["conversation", "thread"])
            if what == "slack:reply" { try strings(["ts"]) }
        case "slack:mute", "slack:vips", "slack:enable": try nullableStrings(["conversation"]); try V2Wire.object(data, ["value"])
        case "slack:connect", "slack:disconnect", "slack:signIn":
            try V2Wire.object(data, ["connected", "who"]); try V2Wire.require(data["connected"].boolValue != nil, "Slack connection")
        case "openFile", "runInTerminal", "switch", "allSettings", "slack", "openPr", "pr:open", "slack:settings", "slack:setup", "slack:link", "slack:openTicket": try nullableStrings(["provider", "destination"])
        default: break
        }
    }
}
public struct MutationAck: ValidatedWireModel {
    public let raw: JSONValue
    public var scope: String { raw["scope"].stringValue! }
    public var mid: String? { raw["mid"].stringValue }
    public var what: String { raw["what"].stringValue! }
    public var target: String { raw["target"].stringValue! }
    public var status: AckStatus { AckStatus(rawValue: raw["status"].stringValue!)! }
    public var outcome: AckOutcome { AckOutcome(rawValue: raw["outcome"].stringValue!)! }
    public var admitted: Bool { raw["admitted"].boolValue! }
    public var at: Int { raw["at"].intValue! }
    public var expiresAt: Int? { raw["expiresAt"].intValue }
    public var result: MutationResult? { raw["result"].isNull ? nil : try! MutationResult(validating: raw["result"]) }
    public var error: ProtocolFailure? { raw["error"].isNull ? nil : try! ProtocolFailure(validating: raw["error"]) }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["type", "scope", "mid", "what", "target", "status", "outcome", "admitted", "at", "expiresAt", "result", "error"])
        try V2Wire.require(raw["type"].stringValue == "ack" && V2Wire.id(raw["scope"]) && (raw["mid"].isNull || V2Wire.id(raw["mid"])) && V2Wire.text(raw["what"]) && V2Wire.target(raw["target"]) && V2Wire.integer(raw["at"]), "ack identity")
        guard let status = AckStatus(rawValue: raw["status"].stringValue ?? ""), let outcome = AckOutcome(rawValue: raw["outcome"].stringValue ?? ""), let admitted = raw["admitted"].boolValue else { throw CoreFailure(.protocolViolation, "Invalid ack disposition.") }
        try V2Wire.require(status == .duplicate ? admitted : status.rawValue == outcome.rawValue, "ack disposition")
        try V2Wire.require(admitted ? V2Wire.id(raw["mid"]) && V2Wire.integer(raw["expiresAt"]) && (raw["expiresAt"].intValue! - raw["at"].intValue!) >= 86_400_000 : raw["expiresAt"].isNull && outcome == .rejected, "ack retention")
        try V2Wire.require((outcome == .applied) == !raw["result"].isNull && ([AckOutcome.rejected, .unknown].contains(outcome) == !raw["error"].isNull), "ack result")
        if !raw["result"].isNull { try MutationResult(validating: raw["result"]).validate(what: raw["what"].stringValue!) }
        if !raw["error"].isNull {
            let error = try ProtocolFailure(validating: raw["error"])
            try V2Wire.require(!error.retryable || (!admitted && outcome == .rejected), "retry permission")
        }
        self.raw = raw
    }
}

public enum OperationPhase: String, Codable, Sendable { case queued, dispatching, accepted, completed, rejected, unknown }
public struct OperationProvider: ValidatedWireModel {
    public enum Ownership: String, Codable, Sendable { case owned, borrowed }
    public enum Writer: String, Codable, Sendable { case engine, external, unknown }
    public let raw: JSONValue
    public var kind: Provider { Provider(rawValue: raw["kind"].stringValue!)! }
    public var account: String { raw["account"].stringValue! }
    public var threadID: String? { raw["threadId"].stringValue }
    public var clientUserMessageID: String? { raw["clientUserMessageId"].stringValue }
    public var turnID: String? { raw["turnId"].stringValue }
    public var ownership: Ownership { Ownership(rawValue: raw["ownership"].stringValue!)! }
    public var writer: Writer { Writer(rawValue: raw["writer"].stringValue!)! }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["kind", "account", "threadId", "clientUserMessageId", "turnId", "ownership", "writer"])
        try V2Wire.require(["claude", "codex"].contains(raw["kind"].stringValue ?? "") && V2Wire.text(raw["account"], maximum: 1024) && Ownership(rawValue: raw["ownership"].stringValue ?? "") != nil && Writer(rawValue: raw["writer"].stringValue ?? "") != nil, "operation provider")
        try V2Wire.require(["threadId", "clientUserMessageId", "turnId"].allSatisfy { raw[$0].isNull || V2Wire.text(raw[$0], maximum: 1024) }, "provider correlation")
        self.raw = raw
    }
}
public struct ProviderOperation: ValidatedWireModel {
    public let raw: JSONValue
    public var scope: String { raw["scope"].stringValue! }
    public var mid: String { raw["mid"].stringValue! }
    public var target: String { raw["target"].stringValue! }
    public var revision: Int { raw["revision"].intValue! }
    public var state: OperationPhase { OperationPhase(rawValue: raw["state"].stringValue!)! }
    public var provider: OperationProvider? { raw["provider"].isNull ? nil : try! OperationProvider(validating: raw["provider"]) }
    public var error: ProtocolFailure? { raw["error"].isNull ? nil : try! ProtocolFailure(validating: raw["error"]) }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["type", "scope", "mid", "target", "revision", "state", "provider", "error", "at"])
        try V2Wire.require(raw["type"].stringValue == "operation" && V2Wire.id(raw["scope"]) && V2Wire.id(raw["mid"]) && V2Wire.target(raw["target"]) && V2Wire.integer(raw["revision"], minimum: 1) && V2Wire.integer(raw["at"]), "operation identity")
        guard let state = OperationPhase(rawValue: raw["state"].stringValue ?? "") else { throw CoreFailure(.protocolViolation, "Invalid operation state.") }
        try V2Wire.require([OperationPhase.rejected, .unknown].contains(state) == !raw["error"].isNull, "operation error")
        if !raw["provider"].isNull { _ = try OperationProvider(validating: raw["provider"]) }
        if !raw["error"].isNull { try V2Wire.require(try !ProtocolFailure(validating: raw["error"]).retryable, "operation retry") }
        self.raw = raw
    }
}
public struct LookupMissing: ValidatedWireModel {
    public enum Reason: String, Codable, Sendable { case notFound = "not_found", expired, scopeChanged = "scope_changed" }
    public let raw: JSONValue
    public var scope: String { raw["scope"].stringValue! }
    public var mid: String { raw["mid"].stringValue! }
    public var reason: Reason { Reason(rawValue: raw["reason"].stringValue!)! }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["type", "scope", "mid", "reason"])
        try V2Wire.require(["receipt:missing", "operation:missing"].contains(raw["type"].stringValue ?? "") && V2Wire.id(raw["scope"]) && V2Wire.id(raw["mid"]) && Reason(rawValue: raw["reason"].stringValue ?? "") != nil, "lookup missing")
        self.raw = raw
    }
}
public struct LookupFailure: ValidatedWireModel {
    public let raw: JSONValue
    public var scope: String { raw["scope"].stringValue! }
    public var mid: String? { raw["mid"].stringValue }
    public var code: ProtocolErrorCode { ProtocolErrorCode(rawValue: raw["code"].stringValue!)! }
    public var message: String { raw["message"].stringValue! }
    public init(validating raw: JSONValue) throws {
        try V2Wire.object(raw, ["type", "scope", "mid", "code", "message"])
        try V2Wire.require(["receipt:error", "operation:error"].contains(raw["type"].stringValue ?? "") && V2Wire.id(raw["scope"]) && (raw["mid"].isNull || V2Wire.id(raw["mid"])) && ["BAD_MESSAGE", "FORBIDDEN", "STORAGE_UNAVAILABLE"].contains(raw["code"].stringValue ?? "") && V2Wire.text(raw["message"], maximum: 2048, empty: true), "lookup error")
        self.raw = raw
    }
}

/// ECMAScript JSON spelling, UTF-16 key ordering, and no Unicode normalization.
public enum IntentCanonicalJSON {
    public static func encode(_ value: JSONValue) throws -> Data { Data(try text(value).utf8) }
    public static func hash(message: JSONValue, target: String) throws -> String {
        var fields = message.objectValue; fields.removeValue(forKey: "mid"); fields.removeValue(forKey: "scope")
        return SHA256.hash(data: try encode(.object(["message": .object(fields), "target": .string(target)]))).map { String(format: "%02x", $0) }.joined()
    }
    public static func text(_ value: JSONValue) throws -> String {
        switch value {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .string(let s):
            var result = "\""
            for scalar in s.unicodeScalars {
                switch scalar.value {
                case 34: result += "\\\""
                case 92: result += "\\\\"
                case 8: result += "\\b"
                case 9: result += "\\t"
                case 10: result += "\\n"
                case 12: result += "\\f"
                case 13: result += "\\r"
                case 0..<32: result += String(format: "\\u%04x", scalar.value)
                default: result.unicodeScalars.append(scalar)
                }
            }
            return result + "\""
        case .number(let n):
            try V2Wire.require(n.isFinite, "finite number")
            if n == 0 { return "0" }
            let negative = n < 0, spelling = String(abs(n)).lowercased()
            let parts = spelling.split(separator: "e"), mantissa = String(parts[0])
            let exponent = parts.count == 2 ? Int(parts[1])! : 0
            let before = mantissa.split(separator: ".")[0].count
            var digits = mantissa.replacingOccurrences(of: ".", with: "")
            var point = before + exponent
            while digits.first == "0", digits.count > 1 { digits.removeFirst(); point -= 1 }
            while digits.last == "0", digits.count > 1 { digits.removeLast() }
            let body: String
            if point > 0 && point <= 21 {
                if point >= digits.count { body = digits + String(repeating: "0", count: point - digits.count) }
                else { let i = digits.index(digits.startIndex, offsetBy: point); body = String(digits[..<i]) + "." + digits[i...] }
            } else if point <= 0 && point > -6 { body = "0." + String(repeating: "0", count: -point) + digits }
            else { body = String(digits.prefix(1)) + (digits.count > 1 ? "." + digits.dropFirst() : "") + "e" + (point - 1 >= 0 ? "+" : "") + String(point - 1) }
            return (negative ? "-" : "") + body
        case .array(let a): return "[" + (try a.map(text)).joined(separator: ",") + "]"
        case .object(let d): return "{" + (try d.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }.map { try text(.string($0)) + ":" + text(d[$0]!) }).joined(separator: ",") + "}"
        }
    }
}

extension SocketRole {
    public var target: String { switch self { case .fleet: "fleet"; case .conversation(let id): "session:" + id } }
}
extension ClientAction {
    public func needsIntent(on role: SocketRole) -> Bool {
        switch self {
        case .ready: return role != .fleet
        case .visible, .forget, .setAwake, .setLid, .newInstance, .resume, .place, .send, .interrupt, .permission, .stopTask,
             .unqueue, .promoteQueued, .editQueued, .clearQueue, .openFile, .switchConversation, .runInTerminal,
             .setSetting, .saveCommand, .removeCommand, .restoreCommand, .prReply, .prResolve, .prComment, .prRerun, .prUnlink,
             .terminalOpen, .terminalRun, .terminalStop, .terminalClose, .appleToken, .slackOpen, .slackReply, .slackVIPs, .slackMute, .slackEnable, .slackLink, .slackSetup: return true
        default: return false
        }
    }
    var optionalCapability: String? {
        if type.hasPrefix("pr:") { return "pr-v1" }
        if type.hasPrefix("term:") { return "terminal-v1" }
        if type.hasPrefix("slack:") { return "slack-v1" }
        if type == "voice" || type == "voice:state" { return "voice-v1" }
        return nil
    }
}
