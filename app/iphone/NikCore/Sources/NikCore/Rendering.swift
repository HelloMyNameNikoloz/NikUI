import Foundation

public enum InlineStyle: String, Sendable, Codable, Hashable { case strong, emphasis, strike, code, image }
public struct InlineSpan: Sendable, Equatable, Codable {
    public var text: String
    public var styles: Set<InlineStyle>
    public var destination: String?
    public init(_ text: String, styles: Set<InlineStyle> = [], destination: String? = nil) {
        self.text = text; self.styles = styles; self.destination = destination
    }
}
public enum TableAlignment: String, Sendable, Equatable { case leading, center, trailing }
public indirect enum MarkdownBlock: Sendable, Equatable {
    case paragraph([InlineSpan]), heading(level: Int, spans: [InlineSpan]), code(language: String?, code: String)
    case quote([MarkdownBlock]), list(ordered: Bool, start: Int, items: [[MarkdownBlock]])
    case table(headers: [[InlineSpan]], rows: [[[InlineSpan]]], alignments: [TableAlignment]), rule
}
public enum MarkdownParser {
    public static func parse(_ source: String) -> [MarkdownBlock] { MarkdownReader.blocks(source, depth: 0) }
    public static func inline(_ source: String) -> [InlineSpan] { MarkdownReader.inline(source) }
}
public enum CodeTokenKind: String, Sendable, Equatable, CaseIterable { case comment, string, keyword, number, type, function, property, punctuation, inserted, deleted, heading }
/// All ranges are UTF-16 offsets into the unchanged source, suitable for TextKit/AttributedString conversion.
public struct CodeToken: Sendable, Equatable {
    public var range: Range<Int>
    public var kind: CodeTokenKind
    public init(range: Range<Int>, kind: CodeTokenKind) { self.range = range; self.kind = kind }
}
public enum CodeTokenizer {
    public static func tokenize(_ source: String, language: String? = nil) -> [CodeToken] { SyntaxReader.tokenize(source, language: language) }
    public static func detectedLanguage(_ source: String) -> String? { SyntaxReader.detect(source) }
}
public enum SlackHTMLParser {
    public static func parse(_ html: String) -> [MarkdownBlock] { HTMLReader.parse(html) }
    public static func plainText(_ html: String) -> String { parse(html).map(\.plainText).joined(separator: "\n") }
}
extension MarkdownBlock {
    public var plainText: String {
        switch self {
        case .paragraph(let spans), .heading(_, let spans): return spans.map(\.text).joined()
        case .code(_, let text): return text
        case .quote(let blocks): return blocks.map(\.plainText).joined(separator: "\n")
        case .list(_, _, let items): return items.map { $0.map(\.plainText).joined(separator: "\n") }.joined(separator: "\n")
        case .table(let headers, let rows, _): return ([headers] + rows).map { $0.map { $0.map(\.text).joined() }.joined(separator: " | ") }.joined(separator: "\n")
        case .rule: return ""
        }
    }
}
