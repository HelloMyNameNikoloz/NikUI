import Foundation

enum RX {
    static func first(_ pattern: String, _ source: String, options: NSRegularExpression.Options = []) -> NSTextCheckingResult? {
        (try? NSRegularExpression(pattern: pattern, options: options))?.firstMatch(in: source, range: NSRange(source.startIndex..., in: source))
    }
    static func text(_ match: NSTextCheckingResult, _ group: Int, _ source: String) -> String {
        guard group < match.numberOfRanges, let range = Range(match.range(at: group), in: source) else { return "" }; return String(source[range])
    }
    static func replace(_ pattern: String, _ source: String, _ replacement: String, options: NSRegularExpression.Options = []) -> String {
        (try? NSRegularExpression(pattern: pattern, options: options))?.stringByReplacingMatches(in: source, range: NSRange(source.startIndex..., in: source), withTemplate: replacement) ?? source
    }
    static func matches(_ pattern: String, _ source: String, options: NSRegularExpression.Options = []) -> Bool { first(pattern, source, options: options) != nil }
}
public struct ExpandedPrompt: Sendable, Equatable {
    public var text: String
    public var sent: String
    public var used: [String]
}
public enum SnippetExpander {
    public static func expand(_ source: String, snippets: [String: String]) -> ExpandedPrompt {
        let raw = source.trimmingCharacters(in: .whitespacesAndNewlines)
        var table: [String: String] = [:]
        for (key, value) in snippets { let value = value.trimmingCharacters(in: .whitespacesAndNewlines); if !value.isEmpty { table[key.lowercased()] = value } }
        var words = raw.split(whereSeparator: \.isWhitespace).map(String.init)
        func known(_ word: String?) -> String? {
            guard let word, RX.matches(#"^/[a-z][A-Za-z0-9_-]*$"#, word, options: .caseInsensitive) else { return nil }
            let key = String(word.dropFirst()).lowercased(); return table[key] != nil ? key : nil
        }
        var lead: [String] = []; var tail: [String] = []
        while let name = known(words.first) { lead.append(name); words.removeFirst() }
        while let name = known(words.last) { tail.insert(name, at: 0); words.removeLast() }
        var seen = Set<String>(); let used = (lead + tail).filter { seen.insert($0).inserted }
        guard !used.isEmpty else { return ExpandedPrompt(text: raw, sent: raw, used: []) }
        let text = words.joined(separator: " ")
        return ExpandedPrompt(text: text, sent: ([text] + used.compactMap { table[$0] }).filter { !$0.isEmpty }.joined(separator: "\n\n"), used: used)
    }
    public static func localIntent(text: String, attachmentCount: Int) -> LocalIntent? {
        guard attachmentCount == 0 else { return nil }
        switch text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "/status": return .report
        case "/settings": return .settings
        case "/commands": return .commands
        case "/slack": return .slack
        default: return nil
        }
    }
}
public struct PaletteRow: Sendable, Equatable, Identifiable {
    public var value: String
    public var label: String
    public var note: String
    public var kind: String
    public var id: String { kind + ":" + value }
}
public struct PalettePlan: Sendable, Equatable {
    public var mode: String
    public var head: Bool
    public var command: String
    public var prefix: String
    public var query: String
    public var matches: [PaletteRow]
}
public struct PaletteSelection: Sendable, Equatable { public var text: String; public var more: Bool; public var picked: PaletteRow }
public enum SlashPalette {
    public static func plan(_ text: String, configuration: RenderConfiguration, current: [String: String] = [:]) -> PalettePlan? {
        func ranked(_ rows: [PaletteRow], _ query: String) -> [PaletteRow] {
            let q = query.lowercased(); guard !q.isEmpty else { return rows }
            let starts = rows.filter { $0.value.lowercased().hasPrefix(q) || $0.label.lowercased().hasPrefix(q) }
            let others = rows.filter { !($0.value.lowercased().hasPrefix(q) || $0.label.lowercased().hasPrefix(q)) && ($0.value.localizedCaseInsensitiveContains(q) || $0.label.localizedCaseInsensitiveContains(q)) }
            return starts + others
        }
        if let match = RX.first(#"(?:^|\s)/([\w:.-]*)$"#, text) {
            let query = RX.text(match, 1, text)
            let prefix = String(text.dropLast(query.count + 1)); let head = prefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let snippetNames = Set(configuration.snippets.filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.keys.map { $0.lowercased() })
            let names = configuration.slashCommands.filter { head || snippetNames.contains($0.lowercased()) }
            let rows = names.map { name in
                let parts = name.split(separator: ":").map(String.init)
                return PaletteRow(value: name, label: parts.last ?? name, note: parts.count > 1 ? parts[0] : (configuration.ownCommands.contains(name) ? "NikUI" : ""), kind: snippetNames.contains(name.lowercased()) ? "snippet" : "command")
            }
            return PalettePlan(mode: "cmd", head: head, command: "", prefix: prefix, query: query, matches: Array(ranked(rows, query).prefix(40)))
        }
        guard let match = RX.first(#"^/([\w:.-]+)[ \t]+([^\s]*)$"#, text) else { return nil }
        let command = RX.text(match, 1, text); let query = RX.text(match, 2, text)
        guard let values = configuration.commandArgs[command], !values.isEmpty else { return nil }
        let rows = values.map { option in
            let labels = [(option.label != option.value ? option.value : ""), option.detail ?? "", option.value.lowercased() == current[command]?.lowercased() ? "current" : ""].filter { !$0.isEmpty }
            return PaletteRow(value: option.value, label: option.label, note: labels.joined(separator: " · "), kind: "value")
        }
        return PalettePlan(mode: "value", head: true, command: command, prefix: "", query: query, matches: ranked(rows, query))
    }
    public static func apply(_ plan: PalettePlan, index: Int, configuration: RenderConfiguration) -> PaletteSelection? {
        guard !plan.matches.isEmpty else { return nil }; let row = plan.matches[max(0, min(index, plan.matches.count - 1))]
        return PaletteSelection(text: plan.mode == "value" ? "/\(plan.command) \(row.value)" : plan.prefix + "/\(row.value) ", more: plan.mode != "value" && plan.head && !(configuration.commandArgs[row.value] ?? []).isEmpty, picked: row)
    }
}
public struct PromptHistory: Sendable, Equatable {
    public private(set) var entries: [String] = []
    public private(set) var index: Int?
    public private(set) var savedDraft = ""
    private var seen: Set<String> = []
    private var seenOrder: [String] = []
    private let limit: Int
    public init(limit: Int = 200) { self.limit = max(1, min(200, limit)) }
    @discardableResult public mutating func remember(_ text: String, itemID: String? = nil) -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines); guard !text.isEmpty else { return false }
        if let itemID {
            guard seen.insert(itemID).inserted else { return false }; seenOrder.append(itemID)
            if seenOrder.count > 2048 { seen.remove(seenOrder.removeFirst()) }
        }
        guard entries.last != text else { return false }; entries.append(text)
        if entries.count > limit { entries.removeFirst() }; reset(); return true
    }
    public mutating func older(draft: String) -> String? {
        guard !entries.isEmpty else { return nil }
        if index == nil { savedDraft = draft; index = entries.count }
        index = max(0, (index ?? 1) - 1); return entries[index!]
    }
    public mutating func newer() -> String? {
        guard let position = index else { return nil }
        if position >= entries.count - 1 { let result = savedDraft; reset(); return result }
        index = position + 1; return entries[position + 1]
    }
    public mutating func edited(_ value: String) { if let index, entries.indices.contains(index), entries[index] != value { reset() } }
    public mutating func reset() { index = nil; savedDraft = "" }
}
public enum ReplySuggestions {
    public static func replies(_ source: String) -> [String] {
        var prose = RX.replace(#"```[\s\S]*?```"#, source, " ")
        prose = RX.replace(#"`([^`]*)`"#, prose, "$1"); prose = RX.replace(#"[*_#>]"#, prose, "")
        prose = RX.replace(#"\[([^\]]*)\]\([^)]*\)"#, prose, "$1"); let end = String(prose.suffix(900))
        let did = ["push":"pushed", "merge":"merged", "reload":"reloaded", "restart":"restarted", "deploy":"deployed", "install":"installed", "run":"ran it", "approve":"approved", "review":"reviewed", "update":"updated", "commit":"committed", "rebase":"rebased", "publish":"published", "release":"released", "upload":"uploaded", "login":"logged in", "log in":"logged in", "sign in":"signed in", "test":"tested", "try":"tried it", "check":"checked", "fix":"fixed", "add":"added", "set":"set", "save":"saved", "connect":"connected"]
        let past = Set(did.values).union(["done", "ready", "finished", "in", "up", "back", "live", "green"])
        var out: [String] = []
        func add(_ s: String?) { if let s, !s.isEmpty, !out.contains(s), out.count < 3 { out.append(s) } }
        if let m = RX.first(#"\b(?:tell|let) me(?: know)? (?:once|when|after|as soon as) (?:it(?:'s| is| has been| was)|you(?:'ve| have)?|they(?:'re| are| have been)|that(?:'s| is)) ?(?:been )?([a-z]+(?: in| up)?)"#, end, options: .caseInsensitive) {
            let word = RX.text(m, 1, end).lowercased(); add(past.contains(word) ? word : did[word])
        }
        if let m = RX.first(#"\b(?:after|once|when) you(?:'ve| have)? (push|merge|reload|restart|deploy|install|approve|commit|rebase|publish|release|upload|log in|sign in|pushed|merged|reloaded|restarted|deployed|installed|approved)\b"#, end, options: .caseInsensitive) {
            let word = RX.text(m, 1, end).lowercased(); add(did[word] ?? word)
        }
        if RX.matches(#"\breload (?:the |your )?(?:vs ?code )?window\b"#, end, options: .caseInsensitive) { add("reloaded") }
        let sentences = RX.replace(#"(?<=[.!?])\s+|\n+"#, end, "\u{1f}").components(separatedBy: "\u{1f}").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if let last = sentences.suffix(2).reversed().first(where: { $0.hasSuffix("?") }) {
            var picks: [String] = []
            if let m = RX.first(#"\b(?:do you want|would you like|would you prefer|do you prefer|should i do|which(?: one)?(?: do you want)?|prefer)\b(?: me to)?\s+([^?]+)\?"#, last, options: .caseInsensitive) {
                let body = RX.replace(#"\s+(?:for now|first|here|instead)\s*$"#, RX.text(m, 1, last), "", options: .caseInsensitive)
                if RX.matches(#"\bor\b"#, body, options: .caseInsensitive) {
                    picks = RX.replace(#"\s*,\s*(?:or\s+)?|\s+or\s+"#, body, "\u{1f}", options: .caseInsensitive).components(separatedBy: "\u{1f}").map { RX.replace(#"^(?:just|only|maybe)\s+|[.,;:]+$"#, $0, "", options: .caseInsensitive).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                    if !(2...3).contains(picks.count) || picks.contains(where: { $0.count > 60 || $0.split(whereSeparator: \.isWhitespace).count > 9 }) { picks = [] }
                }
            }
            if !picks.isEmpty { picks.forEach { add($0) } }
            else if RX.matches(#"^(?:shall|should|can|may) i\b|^(?:do you )?want me to\b|^(?:would|do) you (?:like|want) me to\b|^ok(?:ay)? (?:to|if)\b|^is (?:that|this) (?:ok|okay|fine|right)\b|^go ahead\b|^ready\b"#, last, options: .caseInsensitive) { add("yes"); add("no") }
        }
        if RX.matches(#"\b(?:your go-ahead|go-ahead|say the word|say go)\b"#, end, options: .caseInsensitive) { add("go ahead") }
        return out
    }
}
public enum RunnableCode {
    public static func looksRunnable(language: String?, code: String) -> Bool {
        let language = (language ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !language.isEmpty { return RX.matches(#"^(sh|bash|zsh|fish|ksh|shell|console|terminal|command|commandline|cmd)$"#, language, options: .caseInsensitive) }
        let lines = code.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard (1...12).contains(lines.count), !lines.contains(where: { $0.utf16.count > 400 }) else { return false }
        return lines.allSatisfy {
            let bare = RX.replace(#"^[$#>]\s+"#, $0, "")
            return !bare.isEmpty && !RX.matches(#"^(function|class|const|let|var|import|from|def|public|private|package|return|if|for|while|else|#include|using|<)\b"#, bare) && !RX.matches(#"[{};]$"#, bare) && RX.matches(#"^[a-zA-Z0-9_./~-]+(\s|$)"#, bare)
        }
    }
    public static func clean(_ source: String) -> String { RX.replace(#"(?m)^\s*[$#]\s+"#, source, "").trimmingCharacters(in: .whitespacesAndNewlines) }
}
public enum ConversationScope: Sendable { case active, earlier }
public struct ConversationSummary: WireModel, Identifiable {
    public var raw: JSONValue
    public init(_ raw: JSONValue = .object([:])) { self.raw = raw }
    public var id: String { string("id") }
    public var provider: Provider { Provider(rawValue: string("provider", default: id.hasPrefix("cx-") ? "codex" : "claude")) ?? .unknown }
    public var transcriptID: String { let value = string("sessionId", default: id); return provider == .codex && value.hasPrefix("cx-") ? String(value.dropFirst(3)) : value }
    public var identity: String { provider.rawValue + ":" + transcriptID }
    public var label: String { string("label", default: string("title")) }
    public var cwd: String { string("cwd") }
    public var status: ConversationStatus { ConversationStatus(rawValue: string("status", default: "idle")) ?? .unknown }
    public var past: Bool { flag("past") }
    public var unread: Bool { flag("unread") }
    public var activeAt: Double { number("activeAt") }
    public var socketID: String? { past && provider == .claude ? nil : id }
}
public struct ConversationGroup: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String?
    public var kind: String
    public var rows: [ConversationSummary]
}
public enum FleetLogic {
    public static func merge(active: [FleetRow], history: [HistoryEntry]) -> [ConversationSummary] {
        var order: [String] = []; var map: [String: ConversationSummary] = [:]
        for entry in history {
            var raw = entry.raw
            let provider: Provider = entry.provider == .codex || entry.sessionId.hasPrefix("cx-") ? .codex : entry.provider
            let transcript = provider == .codex && entry.sessionId.hasPrefix("cx-") ? String(entry.sessionId.dropFirst(3)) : entry.sessionId
            raw["provider"] = .string(provider.rawValue); raw["id"] = .string(provider == .codex ? "cx-" + transcript : "past:" + transcript)
            raw["past"] = .bool(true); raw["activeAt"] = .number(entry.modified.map(WireDate.milliseconds) ?? entry.mtimeMs ?? 0)
            let row = ConversationSummary(raw); if map[row.identity] == nil { order.append(row.identity) }; map[row.identity] = row
        }
        for entry in active {
            var raw = entry.raw; raw["provider"] = .string(entry.provider.rawValue); raw["past"] = .bool(false)
            let row = ConversationSummary(raw); if map[row.identity] == nil { order.append(row.identity) }
            map[row.identity] = ConversationSummary((map[row.identity]?.raw ?? .object([:])).merged(with: raw))
        }
        return order.compactMap { map[$0] }
    }
    public static func list(fleet: Fleet, history: HistorySnapshot, scope: ConversationScope = .active, query: String = "", provider: Provider? = nil, projectPath: String? = nil) -> [ConversationSummary] {
        let all = merge(active: fleet.rows, history: history.entries)
        let historyKeys = Set(merge(active: [], history: history.entries).map(\.identity))
        let terms = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        let filtered = all.filter { row in
            if let provider, row.provider != provider { return false }
            if let projectPath, row.cwd != projectPath, row.raw["project"]["path"].stringValue != projectPath { return false }
            if terms.isEmpty {
                if scope == .active, row.past { return false }
                if scope == .earlier, row.provider != .codex, !historyKeys.contains(row.identity) { return false }
            }
            let haystack = [row.label, row.cwd, row.provider.rawValue, row.raw["branch"].stringValue ?? "", row.raw["ticket"].stringValue ?? "", row.raw["model"].stringValue ?? "", row.raw["folder"]["name"].stringValue ?? "", row.raw["project"]["name"].stringValue ?? ""].joined(separator: " ").lowercased()
            return terms.allSatisfy { haystack.contains($0) }
        }
        return filtered.enumerated().sorted { a, b in a.element.activeAt == b.element.activeAt ? a.offset < b.offset : a.element.activeAt > b.element.activeAt }.map(\.element)
    }
    public static func attentionGroups(_ rows: [ConversationSummary], compact: Bool = false) -> [ConversationGroup] {
        func rank(_ row: ConversationSummary) -> Int { [.waiting, .error].contains(row.status) ? 0 : (compact ? 1 : (row.status == .working ? 1 : 2)) }
        return (0..<(compact ? 2 : 3)).compactMap { group in
            let list = rows.enumerated().filter { rank($0.element) == group }.sorted {
                if !(compact && group == 1), $0.element.unread != $1.element.unread { return $0.element.unread }
                if $0.element.activeAt != $1.element.activeAt { return $0.element.activeAt > $1.element.activeAt }; return $0.offset < $1.offset
            }.map(\.element)
            guard !list.isEmpty else { return nil }
            let key = compact && group == 1 ? "recent" : ["attention", "working", "ready"][group]
            return ConversationGroup(id: key, name: compact && group == 1 ? nil : ["Needs you", "In progress", "Ready to continue"][group], kind: key, rows: list)
        }
    }
    public static func folderGroups(_ rows: [ConversationSummary], folders: [NamedFolder], includeEmpty: Bool = false) -> [ConversationGroup] {
        var result: [ConversationGroup] = []
        func add(_ id: String, _ name: String, _ kind: String, _ row: ConversationSummary?) {
            if let i = result.firstIndex(where: { $0.id == id }) { if let row { result[i].rows.append(row) } }
            else { result.append(ConversationGroup(id: id, name: name, kind: kind, rows: row.map { [$0] } ?? [])) }
        }
        for row in rows {
            if let folder = row.model("folder", as: NamedFolder.self) { add("f:" + folder.id, folder.name, "folder", row) }
            else if let project = row.model("project", as: Project.self) { add("p:" + project.path, project.name, "project", row) }
            else if row.provider == .codex, !row.cwd.isEmpty { add("p:" + row.cwd, URL(fileURLWithPath: row.cwd).lastPathComponent, "project", row) }
            else { add("loose", "Everything else", "loose", row) }
        }
        if includeEmpty { for folder in folders { add("f:" + folder.id, folder.name, "folder", nil) } }
        let rank = ["folder":0, "project":1, "loose":2]
        return result.sorted { a, b in (rank[a.kind] ?? 3) == (rank[b.kind] ?? 3) ? (a.name ?? "").localizedStandardCompare(b.name ?? "") == .orderedAscending : (rank[a.kind] ?? 3) < (rank[b.kind] ?? 3) }
    }
}
