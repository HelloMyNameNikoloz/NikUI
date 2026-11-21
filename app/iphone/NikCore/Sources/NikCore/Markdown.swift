import Foundation

enum NativeURL {
    static func safe(_ source: String, image: Bool = false) -> String? {
        let value = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        if image, RX.matches(#"^data:image/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$"#, value, options: .caseInsensitive) { return value }
        if RX.matches(#"^(https?:|mailto:|file:|vscode:|#)"#, value, options: .caseInsensitive) { return value }
        // Relative/laptop paths are dispatched to openFile, never implicitly fetched or executed.
        if !value.contains(":"), !value.hasPrefix("//"), !value.contains("\\") { return value }
        return nil
    }
}
enum MarkdownReader {
    static let fence = #"^\s*(```+|~~~+)\s*([\w.+-]*)\s*$"#
    static let heading = #"^(#{1,6})\s+(.*)$"#
    static let rule = #"^\s*([-*_])(\s*\1){2,}\s*$"#
    static let list = #"^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$"#
    static let quote = #"^\s*>\s?(.*)$"#
    static let tableSeparator = #"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$"#
    static func blocks(_ source: String, depth: Int) -> [MarkdownBlock] {
        guard depth < 48 else { return [.paragraph([InlineSpan(source)])] }
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var result: [MarkdownBlock] = []; var i = 0
        func special(_ line: String) -> Bool { [fence, heading, rule, list, quote].contains { RX.matches($0, line) } }
        while i < lines.count {
            let line = lines[i]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { i += 1; continue }
            if let match = RX.first(fence, line) {
                let marker = RX.text(match, 1, line).first; let language = RX.text(match, 2, line)
                var body: [String] = []; i += 1
                while i < lines.count {
                    if let close = RX.first(fence, lines[i]), RX.text(close, 1, lines[i]).first == marker { i += 1; break }
                    body.append(lines[i]); i += 1
                }
                result.append(.code(language: language.isEmpty ? nil : language, code: body.joined(separator: "\n"))); continue
            }
            if RX.matches(rule, line) { result.append(.rule); i += 1; continue }
            if let match = RX.first(heading, line) { result.append(.heading(level: RX.text(match, 1, line).count, spans: inline(RX.text(match, 2, line)))); i += 1; continue }
            if RX.matches(quote, line) {
                var body: [String] = []
                while i < lines.count, let match = RX.first(quote, lines[i]) { body.append(RX.text(match, 1, lines[i])); i += 1 }
                result.append(.quote(blocks(body.joined(separator: "\n"), depth: depth + 1))); continue
            }
            if line.contains("|"), i + 1 < lines.count, RX.matches(tableSeparator, lines[i + 1]) {
                let headers = splitRow(line); let separators = splitRow(lines[i + 1]); i += 2
                let alignment = (0..<headers.count).map { index -> TableAlignment in
                    let cell = separators.indices.contains(index) ? separators[index] : ""
                    return cell.hasSuffix(":") ? (cell.hasPrefix(":") ? .center : .trailing) : .leading
                }
                var rows: [[[InlineSpan]]] = []
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    var cells = splitRow(lines[i]); let count = headers.count
                    if cells.count > count, count > 0 { cells = Array(cells.prefix(count - 1)) + [cells.suffix(from: count - 1).joined(separator: " | ")] }
                    while cells.count < count { cells.append("") }; rows.append(cells.map { inline($0) }); i += 1
                }
                result.append(.table(headers: headers.map { inline($0) }, rows: rows, alignments: alignment)); continue
            }
            if RX.matches(list, line) {
                struct Item { var indent: Int; var ordered: Bool; var start: Int; var text: [String] }
                var records: [Item] = []
                while i < lines.count {
                    if let match = RX.first(list, lines[i]) {
                        let marker = RX.text(match, 2, lines[i]); let indent = RX.text(match, 1, lines[i]).replacingOccurrences(of: "\t", with: "  ").count
                        records.append(Item(indent: indent, ordered: marker.first?.isNumber == true, start: Int(marker.dropLast()) ?? 1, text: [RX.text(match, 3, lines[i])]))
                    } else if !records.isEmpty, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, RX.matches(#"^\s{2,}"#, lines[i]) { records[records.count - 1].text.append(lines[i].trimmingCharacters(in: .whitespaces)) }
                    else { break }
                    i += 1
                }
                var position = 0
                func build(_ indent: Int, _ nesting: Int) -> MarkdownBlock {
                    let first = records[position]; var entries: [[MarkdownBlock]] = []
                    while position < records.count, records[position].indent >= indent {
                        if records[position].indent > indent, nesting < 48 {
                            let child = build(records[position].indent, nesting + 1)
                            if entries.isEmpty { entries.append([child]) } else { entries[entries.count - 1].append(child) }; continue
                        }
                        let item = records[position]; position += 1
                        entries.append([.paragraph(inline(item.text.joined(separator: "\n")))])
                    }
                    return .list(ordered: first.ordered, start: first.start, items: entries)
                }
                if !records.isEmpty { result.append(build(records[0].indent, 0)) }; continue
            }
            var paragraph: [String] = []
            while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty, !special(lines[i]) { paragraph.append(lines[i]); i += 1 }
            if !paragraph.isEmpty { result.append(.paragraph(inline(paragraph.joined(separator: "\n")))) } else { i += 1 }
        }
        return result
    }
    static func splitRow(_ source: String) -> [String] {
        var value = source.trimmingCharacters(in: .whitespaces); if value.hasPrefix("|") { value.removeFirst() }; if value.hasSuffix("|") { value.removeLast() }
        let chars = Array(value); var cells: [String] = []; var cell = ""; var ticks = 0; var i = 0
        while i < chars.count {
            if chars[i] == "\\", i + 1 < chars.count, chars[i + 1] == "|" { cell.append("|"); i += 2; continue }
            if chars[i] == "`" {
                var count = 1; while i + count < chars.count, chars[i + count] == "`" { count += 1 }
                if ticks == 0 { ticks = count } else if ticks == count { ticks = 0 }
                cell += String(repeating: "`", count: count); i += count; continue
            }
            if chars[i] == "|", ticks == 0 { cells.append(cell.trimmingCharacters(in: .whitespaces)); cell = "" } else { cell.append(chars[i]) }
            i += 1
        }
        cells.append(cell.trimmingCharacters(in: .whitespaces)); return cells
    }
    static func inline(_ source: String, styles: Set<InlineStyle> = [], destination: String? = nil, depth: Int = 0) -> [InlineSpan] {
        guard depth < 16 else { return [InlineSpan(source, styles: styles, destination: destination)] }
        let chars = Array(source); var spans: [InlineSpan] = []; var buffer = ""; var i = 0
        var searchBudget = max(4096, chars.count * 16)
        func flush() { if !buffer.isEmpty { spans.append(InlineSpan(buffer, styles: styles, destination: destination)); buffer = "" } }
        func has(_ marker: String, at offset: Int) -> Bool { let mark = Array(marker); return offset + mark.count <= chars.count && Array(chars[offset..<(offset + mark.count)]) == mark }
        func find(_ marker: String, from start: Int, singleLine: Bool = false) -> Int? {
            var j = start
            while j < chars.count, searchBudget > 0 { searchBudget -= 1; if singleLine, chars[j] == "\n" { return nil }; if has(marker, at: j) { return j }; j += 1 }; return nil
        }
        while i < chars.count {
            if chars[i] == "`" {
                var count = 1; while i + count < chars.count, chars[i + count] == "`" { count += 1 }
                if let end = find(String(repeating: "`", count: count), from: i + count) {
                    flush(); spans.append(InlineSpan(String(chars[(i + count)..<end]).trimmingCharacters(in: .whitespacesAndNewlines), styles: styles.union([.code]), destination: destination)); i = end + count; continue
                }
            }
            let image = has("![", at: i); let link = chars[i] == "["
            if image || link {
                let start = i + (image ? 2 : 1)
                if let labelEnd = find("](", from: start) {
                    var j = labelEnd + 2; var nested = 0
                    while j < chars.count {
                        if chars[j].isWhitespace { break }
                        if chars[j] == "(" { nested += 1; if nested > 1 { break } }
                        if chars[j] == ")" { if nested == 0 { break }; nested -= 1 }; j += 1
                    }
                    if j < chars.count, chars[j] == ")", j > labelEnd + 2 {
                        let url = NativeURL.safe(String(chars[(labelEnd + 2)..<j]), image: image)
                        let label = String(chars[start..<labelEnd]); flush()
                        if image { spans.append(InlineSpan(label, styles: styles.union([.image]), destination: url)) }
                        else { spans += inline(label, styles: styles, destination: url, depth: depth + 1) }
                        i = j + 1; continue
                    }
                }
            }
            let markers: [(String, InlineStyle)] = [("**", .strong), ("__", .strong), ("~~", .strike), ("*", .emphasis), ("_", .emphasis)]
            var matched = false
            for (marker, style) in markers where has(marker, at: i) {
                let length = marker.count
                if length == 1, i > 0, chars[i - 1].isLetter || chars[i - 1].isNumber || chars[i - 1] == "_" || chars[i - 1] == chars[i] { continue }
                if let end = find(marker, from: i + length, singleLine: style == .emphasis), end > i + length {
                    flush(); spans += inline(String(chars[(i + length)..<end]), styles: styles.union([style]), destination: destination, depth: depth + 1); i = end + length; matched = true; break
                }
            }
            if matched { continue }
            if (has("https://", at: i) || has("http://", at: i)), i == 0 || chars[i - 1].isWhitespace || chars[i - 1] == "(" {
                var j = i; while j < chars.count, !chars[j].isWhitespace, !"<>()".contains(chars[j]) { j += 1 }
                let text = String(chars[i..<j]); flush(); spans.append(InlineSpan(text, styles: styles, destination: NativeURL.safe(text))); i = j; continue
            }
            buffer.append(chars[i]); i += 1
        }
        flush(); return spans
    }
}
