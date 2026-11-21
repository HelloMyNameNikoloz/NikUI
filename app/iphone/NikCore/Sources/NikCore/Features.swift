import Foundation

public enum NotificationDestination: Sendable, Equatable { case chats, conversation(String), slack(String) }
public struct NotificationPresentation: Sendable, Equatable {
    public var identifier: String
    public var title: String
    public var body: String
    public var urgent: Bool
    public var destination: NotificationDestination
}
public struct NotificationCoordinator: Sendable {
    private var seen: [String: Date] = [:]
    public init() {}
    public static func destination(_ event: NotificationEvent) -> NotificationDestination {
        if let id = event.conversation, validID(id, limit: 40) { return .slack(id) }
        if let id = event.session, validID(id, limit: 128) { return .conversation(id) }
        if let text = event.url, let c = URLComponents(string: text), c.path.hasPrefix("/s/") {
            let id = String(c.path.dropFirst(3)); if validID(id, limit: 128) { return .conversation(id) }
        }
        return .chats
    }
    private static func validID(_ id: String, limit: Int) -> Bool { !id.isEmpty && id.utf8.count <= limit && RX.matches(#"^[A-Za-z0-9_-]+$"#, id) }
    public mutating func receive(_ event: NotificationEvent, preferences: NotificationPreferences, locked: Bool, at now: Date = Date()) -> NotificationPresentation? {
        guard preferences.on, let kind = NotificationKind(rawValue: event.kind), preferences.enabledKinds.contains(kind) else { return nil }
        let key = [event.kind, event.tag ?? "", event.raw["at"].text, event.session ?? "", event.conversation ?? ""].joined(separator: "\u{1f}")
        seen = seen.filter { now.timeIntervalSince($0.value) < 3600 }
        guard seen[key] == nil else { return nil }
        if seen.count >= 512, let oldest = seen.min(by: { $0.value < $1.value })?.key { seen.removeValue(forKey: oldest) }
        seen[key] = now
        return NotificationPresentation(identifier: event.tag ?? NikCrypto.fingerprint(Data(key.utf8)), title: String(event.title.prefix(120)), body: locked || !preferences.showPreviews ? "Open NikUI to view." : String(event.body.prefix(300)), urgent: kind == .needsYou || kind == .slack, destination: Self.destination(event))
    }
}
public struct TranscriptMatch: Sendable, Equatable, Identifiable {
    public var itemID: String
    public var range: Range<Int>
    public var id: String { itemID + ":" + String(range.lowerBound) }
}
public enum TranscriptSearch {
    public static func searchableText(_ item: TranscriptItem) -> String {
        if item.kind == "tool" || item.kind == "permission" { return item.name + "\n" + item.input.text + "\n" + (item.result ?? "") }
        if item.kind == "text" { return MarkdownParser.parse(item.text).map(\.plainText).joined(separator: "\n") }
        return item.text
    }
    public static func matches(_ query: String, items: [TranscriptItem]) -> [TranscriptMatch] {
        guard !query.isEmpty else { return [] }; var result: [TranscriptMatch] = []
        for item in items {
            let source = searchableText(item)
            let text = source as NSString; var start = 0
            while start < text.length {
                let range = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive], range: NSRange(location: start, length: text.length - start))
                if range.location == NSNotFound { break }
                result.append(TranscriptMatch(itemID: item.id, range: range.location..<(range.location + range.length))); start = range.location + max(1, range.length)
                if result.count >= 10_000 { return result }
            }
        }
        return result
    }
}
public struct DiffLine: Sendable, Equatable {
    public enum Kind: String, Sendable { case header, hunk, context, addition, deletion }
    public var text: String
    public var kind: Kind
    public var oldLine: Int?
    public var newLine: Int?
}
public struct DiffFile: Sendable, Equatable, Identifiable {
    public var path: String
    public var lines: [DiffLine]
    public var id: String { path }
}
public enum UnifiedDiffParser {
    public static func parse(_ text: String) -> [DiffFile] {
        var files: [DiffFile] = []; var old: Int?; var new: Int?
        for line in text.components(separatedBy: "\n") {
            if line.hasPrefix("diff --git ") {
                let path = line.range(of: " b/", options: .backwards).map { String(line[$0.upperBound...]) } ?? line
                files.append(DiffFile(path: path, lines: [])); old = nil; new = nil
            }
            if files.isEmpty { files.append(DiffFile(path: "Diff", lines: [])) }
            let entry: DiffLine
            if let m = RX.first(#"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@"#, line) {
                old = Int(RX.text(m, 1, line)); new = Int(RX.text(m, 2, line)); entry = DiffLine(text: line, kind: .hunk)
            } else if line.hasPrefix("diff ") || line.hasPrefix("index ") || line.hasPrefix("--- ") || line.hasPrefix("+++ ") || line.hasPrefix("Binary files ") { entry = DiffLine(text: line, kind: .header) }
            else if line.hasPrefix("+") { entry = DiffLine(text: line, kind: .addition, oldLine: nil, newLine: new); if new != nil { new! += 1 } }
            else if line.hasPrefix("-") { entry = DiffLine(text: line, kind: .deletion, oldLine: old, newLine: nil); if old != nil { old! += 1 } }
            else { entry = DiffLine(text: line, kind: .context, oldLine: line.hasPrefix(" ") ? old : nil, newLine: line.hasPrefix(" ") ? new : nil); if line.hasPrefix(" ") { if old != nil { old! += 1 }; if new != nil { new! += 1 } } }
            files[files.count - 1].lines.append(entry)
        }
        return files
    }
}
public struct WAVInfo: Sendable, Equatable { public let sampleRate: Int; public let sampleBytes: Int; public var seconds: Double { Double(sampleBytes) / Double(sampleRate * 2) } }
public enum WAV {
    public static let maximumBytes = 9_600_044
    /// AVFoundation can add RIFF metadata chunks. Emit the protocol's 44-byte
    /// header without re-encoding samples or exceeding the five-minute wire cap.
    public static func canonicalPCM16(_ file: Data) throws -> Data {
        guard file.count >= 44, file.count <= maximumBytes + 65_536 else { throw CoreFailure(.invalidInput, "The recording is missing or too large.") }
        let b = [UInt8](file)
        func word(_ n: Int) -> String { String(bytes: b[n..<(n + 4)], encoding: .ascii) ?? "" }
        func u16(_ n: Int) -> Int { Int(b[n]) | Int(b[n + 1]) << 8 }
        func u32(_ n: Int) -> Int { Int(b[n]) | Int(b[n + 1]) << 8 | Int(b[n + 2]) << 16 | Int(b[n + 3]) << 24 }
        guard word(0) == "RIFF", word(8) == "WAVE", u32(4) + 8 == b.count else { throw CoreFailure(.invalidInput, "The recording is not a complete WAV file.") }
        var at = 12; var validFormat = false
        while at + 8 <= b.count {
            let size = u32(at + 4), body = at + 8
            guard size <= b.count - body else { throw CoreFailure(.invalidInput, "The recording is truncated.") }
            if word(at) == "fmt ", size >= 16 {
                validFormat = u16(body) == 1 && u16(body + 2) == 1 && u32(body + 4) == 16_000 && u16(body + 14) == 16
            } else if word(at) == "data", validFormat {
                guard size <= maximumBytes - 44, size % 2 == 0 else { throw CoreFailure(.tooLarge, "Record at most five minutes.") }
                var result = try pcm16([])
                func put(_ value: Int, at offset: Int) {
                    for i in 0..<4 { result[offset + i] = UInt8(truncatingIfNeeded: value >> (i * 8)) }
                }
                put(36 + size, at: 4); put(size, at: 40)
                result.append(file[body..<(body + size)])
                _ = try inspect(result)
                return result
            }
            at = body + size + size % 2
        }
        throw CoreFailure(.invalidInput, "The recording has no 16 kHz mono PCM audio.")
    }
    public static func inspect(_ data: Data) throws -> WAVInfo {
        guard data.count >= 44, data.count <= maximumBytes else { throw CoreFailure(.invalidInput, "The recording is missing or exceeds five minutes.") }
        let b = [UInt8](data)
        func word(_ offset: Int, _ length: Int) -> String { String(bytes: b[offset..<(offset + length)], encoding: .ascii) ?? "" }
        func u16(_ n: Int) -> Int { Int(b[n]) | Int(b[n + 1]) << 8 }
        func u32(_ n: Int) -> Int { Int(b[n]) | Int(b[n + 1]) << 8 | Int(b[n + 2]) << 16 | Int(b[n + 3]) << 24 }
        guard word(0, 4) == "RIFF", word(8, 4) == "WAVE", u32(4) + 8 == data.count else { throw CoreFailure(.invalidInput, "Expected a complete RIFF/WAVE recording.") }
        var at = 12; var rate: Int?
        while at + 8 <= b.count {
            let size = u32(at + 4); let body = at + 8
            guard size <= b.count - body else { throw CoreFailure(.invalidInput, "The WAV recording is truncated.") }
            if word(at, 4) == "fmt ", size >= 16 {
                guard u16(body) == 1, u16(body + 2) == 1, u16(body + 14) == 16, (8000...48000).contains(u32(body + 4)) else { throw CoreFailure(.invalidInput, "Expected mono 16-bit PCM audio.") }
                rate = u32(body + 4)
            } else if word(at, 4) == "data", let rate {
                let info = WAVInfo(sampleRate: rate, sampleBytes: size)
                guard size % 2 == 0, info.seconds >= 0.3, info.seconds <= 300 else { throw CoreFailure(.invalidInput, "Record between 0.3 seconds and five minutes.") }; return info
            }
            at = body + size + size % 2
        }
        throw CoreFailure(.invalidInput, "The WAV recording has no audio data.")
    }
    public static func pcm16(_ samples: [Int16], sampleRate: Int = 16_000) throws -> Data {
        guard sampleRate == 16_000, samples.count <= sampleRate * 300 else { throw CoreFailure(.invalidInput, "Expected at most five minutes at 16 kHz.") }
        var result = Data()
        func bytes(_ value: UInt32, _ count: Int) { for i in 0..<count { result.append(UInt8(truncatingIfNeeded: value >> (i * 8))) } }
        result.append(Data("RIFF".utf8)); bytes(UInt32(36 + samples.count * 2), 4); result.append(Data("WAVEfmt ".utf8)); bytes(16, 4); bytes(1, 2); bytes(1, 2); bytes(UInt32(sampleRate), 4); bytes(UInt32(sampleRate * 2), 4); bytes(2, 2); bytes(16, 2); result.append(Data("data".utf8)); bytes(UInt32(samples.count * 2), 4)
        for sample in samples { bytes(UInt32(UInt16(bitPattern: sample)), 2) }; return result
    }
    /// UTF-16 composer selection, with boundary spacing and no changes to surrounding words.
    public static func insert(_ transcription: String, into text: String, selection: Range<Int>) -> (text: String, caret: Int) {
        let value = transcription.trimmingCharacters(in: .whitespacesAndNewlines); let string = text as NSString
        guard !value.isEmpty else { return (text, min(selection.upperBound, string.length)) }
        let start = max(0, min(selection.lowerBound, string.length)); let end = max(start, min(selection.upperBound, string.length))
        let before = string.substring(to: start); let after = string.substring(from: end)
        let inserted = (before.last.map { $0.isWhitespace ? "" : " " } ?? "") + value + (after.first.map { $0.isWhitespace ? "" : " " } ?? "")
        return (before + inserted + after, start + inserted.utf16.count)
    }
}
extension Report {
    /// Codex's current zero is a wire placeholder, not reported billing.
    public var reportedCost: Double? { instance.provider == .codex ? nil : totals.cost }
    public func isStale(at now: Date, after seconds: TimeInterval = 30 * 60) -> Bool { generatedAt.map { now.timeIntervalSince($0) > seconds } ?? true }
    public func plainText(stale: Bool = false) -> String {
        var lines = ["NikUI report" + (stale ? " (stale)" : "")]
        if let generatedAt { lines.append("Measured: " + generatedAt.ISO8601Format()) }
        func add(_ label: String, _ value: String?) { if let value { lines.append(label + ": " + value) } }
        add("Conversation", instance.label); add("Provider", instance.provider.rawValue); add("Status", instance.status.rawValue)
        add("Folder", instance.cwd); add("Branch", git?.branch); add("Model", config.model); add("Effort", config.effort); add("Session", instance.claudeSessionId ?? instance.id)
        add("Reported cost", reportedCost.map { String(format: "$%.4f", $0) }); add("Turns", totals.turns.map(String.init)); add("Tokens", totals.tokens.total.map(String.init))
        add("Input", totals.tokens.input.map(String.init)); add("Output", totals.tokens.output.map(String.init)); add("Cache read", totals.tokens.cacheRead.map(String.init)); add("Cache write", totals.tokens.cacheCreate.map(String.init))
        add("Context", totals.contextTokens.map(String.init)); add("Context window", totals.contextWindow.map(String.init)); add("Compactions", totals.compactions.map(String.init))
        if !tools.isEmpty { lines.append("Tools: " + tools.map { "\($0.name) \($0.calls.map(String.init) ?? "unknown")" }.joined(separator: ", ")) }
        if !files.isEmpty { lines.append("Files: " + files.map(\.file).joined(separator: ", ")) }
        if let limits { add("Claude limit", limits.used.map { String(format: "%.0f%%", $0 * 100) }) }
        lines.append("Kept-window statistics: \(window.kept.map(String.init) ?? "unknown") items; \(window.dropped.map(String.init) ?? "unknown") dropped.")
        return lines.joined(separator: "\n")
    }
}
extension ConversationState { public var reportedCost: Double? { meta.provider == .codex ? nil : stats.cost } }
extension FleetRow { public var reportedCost: Double? { provider == .codex ? nil : cost } }
extension FleetMember { public var reportedCost: Double? { provider == .codex ? nil : cost } }
