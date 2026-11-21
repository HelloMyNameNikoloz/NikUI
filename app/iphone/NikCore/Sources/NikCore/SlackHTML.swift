import Foundation

/// Non-executing HTML subset reader. No WebKit, NSAttributedString HTML importer, CSS, or network fetching.
enum HTMLReader {
    private final class Node {
        var tag: String
        var text: String
        var attributes: [String: String]
        var children: [Node] = []
        init(_ tag: String = "", text: String = "", attributes: [String: String] = [:]) { self.tag = tag; self.text = text; self.attributes = attributes }
    }
    static func entities(_ source: String) -> String {
        let chars = Array(source); var output = ""; var i = 0
        let named = ["amp":"&", "lt":"<", "gt":">", "quot":"\"", "apos":"'", "nbsp":"\u{a0}"]
        while i < chars.count {
            if chars[i] == "&" {
                var end = i + 1
                while end < min(chars.count, i + 14), chars[end] != ";", !chars[end].isWhitespace { end += 1 }
                if end < chars.count, chars[end] == ";" {
                    let token = String(chars[(i + 1)..<end]); var replacement = named[token]
                    if token.hasPrefix("#") {
                        let hex = token.hasPrefix("#x") || token.hasPrefix("#X")
                        if let number = UInt32(token.dropFirst(hex ? 2 : 1), radix: hex ? 16 : 10), let scalar = UnicodeScalar(number), number != 0 { replacement = String(scalar) }
                    }
                    if let replacement { output += replacement; i = end + 1; continue }
                }
            }
            output.append(chars[i]); i += 1
        }
        return output
    }
    static func parse(_ source: String) -> [MarkdownBlock] {
        guard source.utf8.count <= 4 * 1024 * 1024 else { return [.paragraph([InlineSpan("Slack message is too large to render.")])] }
        let root = Node("root"); var stack = [root]
        let chars = Array(source); var i = 0; var buffer = ""
        func flush() { if !buffer.isEmpty { stack.last?.children.append(Node(text: entities(buffer))); buffer = "" } }
        let known: Set<String> = ["p", "div", "br", "strong", "b", "em", "i", "s", "strike", "del", "a", "code", "pre", "blockquote", "ul", "ol", "li", "hr", "span", "img", "h1", "h2", "h3", "h4", "h5", "h6"]
        let voids: Set<String> = ["br", "hr", "img"]
        while i < chars.count {
            guard chars[i] == "<" else { buffer.append(chars[i]); i += 1; continue }
            var end = i + 1; var quote: Character?
            while end < chars.count {
                let c = chars[end]
                if let q = quote { if c == q { quote = nil } }
                else if c == "\"" || c == "'" { quote = c }
                else if c == ">" { break }
                end += 1
            }
            guard end < chars.count else { buffer += String(chars[i...]); break }
            let token = String(chars[i...end])
            guard let match = RX.first(#"^<\s*(/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b"#, token) else { buffer += token; i = end + 1; continue }
            let tag = RX.text(match, 2, token).lowercased(); let closing = RX.text(match, 1, token) == "/"
            guard known.contains(tag) else { buffer += token; i = end + 1; continue }
            flush()
            if closing {
                if let index = stack.lastIndex(where: { $0.tag == tag }), index > 0 { stack.removeSubrange(index...) }
            } else {
                var attributes: [String: String] = [:]
                if let regex = try? NSRegularExpression(pattern: #"([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#) {
                    for attribute in regex.matches(in: token, range: NSRange(token.startIndex..., in: token)) {
                        let key = RX.text(attribute, 1, token).lowercased()
                        if ["href", "alt", "class", "start"].contains(key) {
                            let value = (2...4).map { RX.text(attribute, $0, token) }.first { !$0.isEmpty } ?? ""
                            attributes[key] = entities(value)
                        }
                    }
                }
                let node = Node(tag, attributes: attributes); stack.last?.children.append(node)
                if !voids.contains(tag), !token.hasSuffix("/>"), stack.count < 64 { stack.append(node) }
            }
            i = end + 1
        }
        flush(); return blocks(root.children, depth: 0)
    }
    private static let blockTags: Set<String> = ["p", "div", "pre", "blockquote", "ul", "ol", "li", "hr", "h1", "h2", "h3", "h4", "h5", "h6"]
    private static func text(_ node: Node) -> String { node.tag.isEmpty ? node.text : (node.tag == "br" ? "\n" : node.children.map(text).joined()) }
    private static func inline(_ nodes: [Node], styles: Set<InlineStyle> = [], destination: String? = nil, depth: Int = 0) -> [InlineSpan] {
        guard depth < 64 else { return nodes.map { InlineSpan(text($0), styles: styles, destination: destination) } }
        var result: [InlineSpan] = []
        for node in nodes {
            if node.tag.isEmpty { result.append(InlineSpan(node.text, styles: styles, destination: destination)); continue }
            var next = styles; var link = destination
            switch node.tag {
            case "strong", "b": next.insert(.strong)
            case "em", "i": next.insert(.emphasis)
            case "s", "strike", "del": next.insert(.strike)
            case "code": next.insert(.code)
            case "a":
                if let raw = node.attributes["href"], let safe = NativeURL.safe(raw), RX.matches(#"^(https?:|mailto:|slack:)"#, safe, options: .caseInsensitive) { link = safe } else { link = nil }
            case "br": result.append(InlineSpan("\n", styles: styles, destination: destination)); continue
            case "img": result.append(InlineSpan(node.attributes["alt"] ?? "", styles: styles)); continue
            default: break
            }
            result += inline(node.children, styles: next, destination: link, depth: depth + 1)
        }
        return result
    }
    private static func blocks(_ nodes: [Node], depth: Int) -> [MarkdownBlock] {
        guard depth < 64 else { return [.paragraph(nodes.map { InlineSpan(text($0)) })] }
        var result: [MarkdownBlock] = []; var pending: [Node] = []
        func flush() {
            if !pending.isEmpty {
                let spans = inline(pending)
                if !spans.map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append(.paragraph(spans)) }
                pending.removeAll()
            }
        }
        for node in nodes {
            guard blockTags.contains(node.tag) else { pending.append(node); continue }
            flush()
            switch node.tag {
            case "pre":
                let codeNode = node.children.first(where: { $0.tag == "code" })
                let language = (codeNode?.attributes["class"] ?? "").split(separator: " ").first(where: { $0.hasPrefix("language-") }).map { String($0.dropFirst(9)) }
                result.append(.code(language: language, code: node.children.map(text).joined()))
            case "blockquote": result.append(.quote(blocks(node.children, depth: depth + 1)))
            case "ul", "ol": result.append(.list(ordered: node.tag == "ol", start: Int(node.attributes["start"] ?? "1") ?? 1, items: node.children.filter { $0.tag == "li" }.map { blocks($0.children, depth: depth + 1) }))
            case "hr": result.append(.rule)
            case "h1", "h2", "h3", "h4", "h5", "h6": result.append(.heading(level: Int(node.tag.suffix(1)) ?? 1, spans: inline(node.children)))
            default: result += blocks(node.children, depth: depth + 1)
            }
        }
        flush(); return result
    }
}
