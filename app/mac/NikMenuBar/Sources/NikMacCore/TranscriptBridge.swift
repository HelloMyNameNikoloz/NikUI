import Foundation
import NikCore
import NikMacIdentity
import Observation
import WebKit

@MainActor @Observable public final class MacTranscriptFindState {
    public var visible = false
    public var query = ""
    public var step = 0
    public private(set) var count = 0
    public private(set) var index = -1
    public private(set) var limited = false
    public init() {}
    public func move(_ delta: Int) { visible = true; step += delta }
    public var snapshot: JSONValue { .object(["query": .string(String(query.prefix(300))), "step": .number(Double(step)), "visible": .bool(visible)]) }
    public func receive(_ raw: JSONValue) {
        guard raw["query"].stringValue == String(query.prefix(300)), let count = raw["count"].intValue, (0...10000).contains(count),
              let index = raw["index"].intValue, index >= -1, index < count || count == 0 && index == -1 else { return }
        self.count = count; self.index = index; limited = raw["limited"].boolValue == true
    }
}

/// Each WebContent document needs its own first paint, even for an unchanged
/// conversation. Old JavaScript completions cannot mark a new document painted.
public struct TranscriptPaintState {
    public private(set) var ready = false
    public private(set) var generation = 0
    private var lastSnapshot: JSONValue?
    public init() {}
    public mutating func reset() { ready = false; lastSnapshot = nil; generation += 1 }
    public mutating func documentReady() { reset(); ready = true }
    public mutating func begin(_ snapshot: JSONValue) -> Int? {
        guard ready, snapshot != lastSnapshot else { return nil }
        lastSnapshot = snapshot; return generation
    }
    public mutating func failed(generation: Int) { if self.generation == generation { lastSnapshot = nil } }
}

/// No wire mutations or arbitrary native selectors are part of this bridge.
public enum TranscriptBridgeMessage: Sendable, Equatable {
    case ready
    case reading(conversationID: String, anchor: String?, offset: Double, followsLatest: Bool)
    case externalURL(URL)
    public init(_ value: JSONValue, conversationID: String?, itemIDs: Set<String>) throws {
        guard case .object(let fields) = value, (try value.encoded()).count <= 8192 else { throw IdentityFailure("BRIDGE_INVALID") }
        switch value["type"].stringValue {
        case "ready":
            guard Set(fields.keys) == ["type", "version"], value["version"].intValue == 1 else { throw IdentityFailure("BRIDGE_VERSION_INVALID") }
            self = .ready
        case "reading":
            guard Set(fields.keys) == ["type", "conversationID", "anchor", "offset", "followsLatest"],
                  let id = value["conversationID"].stringValue, id == conversationID,
                  let offset = value["offset"].doubleValue, offset >= 0, offset < 1e9,
                  let follow = value["followsLatest"].boolValue,
                  value["anchor"].isNull || value["anchor"].stringValue.map(itemIDs.contains) == true else { throw IdentityFailure("BRIDGE_STALE_READING") }
            self = .reading(conversationID: id, anchor: value["anchor"].stringValue, offset: offset, followsLatest: follow)
        case "externalURL":
            guard Set(fields.keys) == ["type", "url"], let text = value["url"].stringValue, let url = URL(string: text), Self.isExternal(url) else { throw IdentityFailure("BRIDGE_URL_REFUSED") }
            self = .externalURL(url)
        default: throw IdentityFailure("BRIDGE_ACTION_REFUSED")
        }
    }
    public static func isExternal(_ url: URL) -> Bool {
        guard url.absoluteString.utf8.count <= 4096, !url.absoluteString.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              url.user == nil, url.password == nil else { return false }
        switch url.scheme?.lowercased() {
        case "http", "https": return url.host?.isEmpty == false
        case "mailto": return !url.path.isEmpty
        default: return false
        }
    }
}
public enum TranscriptResources {
    // This is the decision used by the actual WKNavigationDelegate, including
    // WebContent recovery. Resource subrequests never authorize navigation.
    public static func allowsNavigation(_ url: URL, type: WKNavigationType, mainFrame: Bool) -> Bool {
        mainFrame && resourceName(url) == "mac-transcript.html" && (type == .other || type == .reload)
    }
    public static let names: Set<String> = ["mac-transcript.html", "mac-transcript.js", "mac-transcript-find.js", "mac-transcript.css", "transcript-renderer.js", "markdown.js", "highlight.js", "icons.js", "panel.css"]
    public static func resourceName(_ url: URL) -> String? {
        guard url.scheme == "nikui-bundle", url.host == "transcript", url.query == nil, url.fragment == nil,
              url.user == nil, url.password == nil, url.port == nil, url.pathComponents.count == 2 else { return nil }
        let name = url.lastPathComponent
        return names.contains(name) && url.path == "/" + name ? name : nil
    }
    /// Strip additive wire metadata; JS receives presentation data only.
    public static func snapshot(_ state: ConversationState, reading: ReadingState) -> JSONValue {
        let keys: Set<String> = ["id", "kind", "text", "name", "requestId", "streaming", "isError", "interrupted", "result", "resultClipped", "resultLength", "resolved", "input", "status", "durationMs", "costUsd", "at", "trigger", "before", "level", "images", "snippets"]
        return .object(["version": .number(1), "conversationID": .string(state.id),
            "items": .array(state.items.map { .object($0.raw.objectValue.filter { keys.contains($0.key) }) }),
            "dropped": .number(Double(state.dropped)), "showThinking": .bool(state.configuration.showThinking),
            "reading": .object(["anchor": reading.anchorID.map(JSONValue.string) ?? .null, "offset": .number(reading.offset), "followsLatest": .bool(reading.followsLatest)])])
    }
}
