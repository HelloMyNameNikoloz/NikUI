import Foundation
import Testing
@testable import NikCore

@Suite("Native Markdown, code, Slack HTML") struct RenderingTests {
    @Test(arguments: ["javascript", "typescript", "python", "swift", "json", "sql", "shell", "yaml", "diff", "html", "css", "vue"])
    func tokenRangesMatchNode(_ language: String) throws {
        let row = try #require(fixture("rendering")["tokens"].arrayValue.first { $0["language"].stringValue == language })
        let source = row["source"].stringValue!
        let expected = row["tokens"].arrayValue.map { CodeToken(range: $0["start"].intValue!..<$0["end"].intValue!, kind: CodeTokenKind(rawValue: $0["kind"].stringValue!)!) }
        #expect(CodeTokenizer.tokenize(source, language: language) == expected)
    }
    @Test func detectionAndBoundedHighlighting() throws {
        let rows = try fixture("rendering")["tokens"].arrayValue
        for row in rows { #expect(CodeTokenizer.detectedLanguage(row["source"].stringValue!) == row["detected"].stringValue) }
        #expect(CodeTokenizer.tokenize("const a = 42;", language: "plain").isEmpty)
        #expect(CodeTokenizer.tokenize(String(repeating: "a", count: 100_001), language: "javascript").isEmpty)
        #expect(CodeTokenizer.detectedLanguage("Note: run it again.") == nil)
    }
    @Test func codeUTF16RangesRespectEmojiAndSource() {
        let source = "let name = \"👋\"; // comment"
        let tokens = CodeTokenizer.tokenize(source, language: "swift")
        let string = tokens.first { $0.kind == .string }!
        #expect((source as NSString).substring(with: NSRange(location: string.range.lowerBound, length: string.range.count)) == "\"👋\"")
        #expect(zip(tokens, tokens.dropFirst()).allSatisfy { $0.range.upperBound <= $1.range.lowerBound })
    }
    @Test func blocksHaveHeadingsFencesQuotesTablesLists() {
        let source = "# Title\n\nText **bold**.\n\n```swift\nlet x = 42\n```\n\n> quoted\n\n- first\n  - child\n- last\n\n| A | B |\n| :--- | ---: |\n| 1 | `a|b` |\n| 2 | x | y |\n\n---"
        let blocks = MarkdownParser.parse(source)
        #expect(blocks.count == 7)
        if case .heading(let level, let spans) = blocks[0] { #expect(level == 1); #expect(spans.map(\.text).joined() == "Title") } else { Issue.record("Missing heading") }
        if case .code(let lang, let code) = blocks[2] { #expect(lang == "swift"); #expect(code == "let x = 42") } else { Issue.record("Missing fence") }
        if case .table(let headers, let rows, let align) = blocks[5] { #expect(headers.count == 2); #expect(rows[0][1].map(\.text).joined() == "a|b"); #expect(rows[1][1].map(\.text).joined() == "x | y"); #expect(align == [.leading, .trailing]) } else { Issue.record("Missing table") }
        if case .list(_, _, let items) = blocks[4] { #expect(items.count == 2); #expect(items[0].count == 2) } else { Issue.record("Missing nested list") }
    }
    @Test func inlineCodeProtectedAndURLSafe() {
        let spans = MarkdownParser.inline("**bold** _em_ ~~gone~~ `**literal**` [unsafe](javascript:alert) [file](src/a.swift) ![img](data:image/png;base64,AAAA)")
        #expect(spans.contains { $0.text == "bold" && $0.styles.contains(.strong) })
        #expect(spans.contains { $0.text == "**literal**" && $0.styles == [.code] })
        #expect(spans.first { $0.text == "unsafe" }?.destination == nil)
        #expect(spans.first { $0.text == "file" }?.destination == "src/a.swift")
        #expect(spans.first { $0.styles.contains(.image) }?.destination == "data:image/png;base64,AAAA")
    }
    @Test func markdownLiteralHTMLAndUnclosedFence() {
        #expect(MarkdownParser.parse("<script>alert(1)</script> & literal").map(\.plainText).joined() == "<script>alert(1)</script> & literal")
        #expect(MarkdownParser.parse("~~~python\nprint('hi')") == [.code(language: "python", code: "print('hi')")])
        #expect(MarkdownParser.parse("a\r\nb").map(\.plainText) == ["a\nb"])
    }
    @Test func escapedAndCodePipesInRaggedTable() {
        let blocks = MarkdownParser.parse("| A | B |\n| - | - |\n| a\\|b | c |\n| short |")
        if case .table(_, let rows, _) = blocks[0] { #expect(rows[0][0].map(\.text).joined() == "a|b"); #expect(rows[1][1].isEmpty) } else { Issue.record("Missing table") }
    }
    @Test func slackSafeSubsetAndEntities() {
        let blocks = SlackHTMLParser.parse("<p>Hello <strong>Maya</strong> &amp; &#x1F44B;<br><a href=\"https://example.com?a=1&amp;b=2\">link</a></p><blockquote><p>Quoted <em>words</em></p></blockquote><pre><code>let x = &lt;value&gt;</code></pre>")
        #expect(blocks.count == 3); #expect(blocks[0].plainText == "Hello Maya & 👋\nlink")
        if case .paragraph(let spans) = blocks[0] { #expect(spans.first { $0.text == "Maya" }?.styles == [.strong]); #expect(spans.first { $0.text == "link" }?.destination == "https://example.com?a=1&b=2") }
        #expect(blocks[2] == .code(language: nil, code: "let x = <value>"))
    }
    @Test func slackUnknownTagsAndUnsafeLinksStayText() {
        let blocks = SlackHTMLParser.parse("<script>alert(1)</script><a href=\"javascript:evil()\">Bad</a><img src=\"https://tracker.invalid/x\" alt=\":wave:\">")
        #expect(blocks.map(\.plainText).joined().contains("<script>alert(1)</script>"))
        if case .paragraph(let spans) = blocks[0] { #expect(spans.allSatisfy { $0.destination == nil }) }
        #expect(SlackHTMLParser.plainText("&amp;lt; &#39; &#x41; &unknown;") == "&lt; ' A &unknown;")
    }
    @Test func slackListsAndMalformedNesting() {
        let blocks = SlackHTMLParser.parse("<ul><li>one</li><li><strong>two</strong></li></ul><p>tail <em>open</p>")
        #expect(blocks.count == 2); #expect(blocks[0].plainText == "one\ntwo"); #expect(blocks[1].plainText == "tail open")
    }
}
