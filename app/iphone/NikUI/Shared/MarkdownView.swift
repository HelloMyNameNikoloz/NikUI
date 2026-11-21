import SwiftUI
import UIKit
import ImageIO
import NikCore

/// Renders NikCore's parsed Markdown with native text: selectable, Dynamic
/// Type, links open in Safari. Used by chat answers, PR bodies and Slack.
struct MarkdownView: View {
    let blocks: [MarkdownBlock]
    var compact = false

    init(_ source: String, compact: Bool = false) {
        blocks = MarkdownParser.parse(source); self.compact = compact
    }
    init(blocks: [MarkdownBlock], compact: Bool = false) {
        self.blocks = blocks; self.compact = compact
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .readingFont()
    }
}

private struct BlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .paragraph(let spans):
            InlineContent(spans: spans)
        case .heading(let level, let spans):
            InlineContent(spans: spans)
                .font(level <= 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
        case .code(let language, let code):
            CodeBlockView(code: code, language: language)
        case .quote(let inner):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(.tertiary).frame(width: 3)
                MarkdownView(blocks: inner, compact: true).foregroundStyle(.secondary)
            }
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? "\(start + index)." : "•")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .frame(minWidth: ordered ? 22 : 12, alignment: .trailing)
                        MarkdownView(blocks: item, compact: true)
                    }
                }
            }
        case .table(let headers, let rows, let alignments):
            TableBlock(headers: headers, rows: rows, alignments: alignments)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }
}

/// Keep text/image order in paragraphs, headings and table cells.
private struct InlineContent: View {
    let spans: [InlineSpan]
    private enum Piece { case text([InlineSpan]), image(URL, String) }
    private var pieces: [Piece] {
        var result: [Piece] = [], text: [InlineSpan] = []
        for span in spans {
            if let url = MarkdownImage.url(for: span) {
                if !text.isEmpty { result.append(.text(text)); text.removeAll() }
                result.append(.image(url, span.text))
            } else { text.append(span) }
        }
        if !text.isEmpty { result.append(.text(text)) }
        return result
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .text(let text): InlineText(spans: text)
                case .image(let url, let alt): MarkdownImage(url: url, alt: alt)
                }
            }
        }
    }
}

/// One run of inline text: bold, italic, struck, code and links in one `Text`.
struct InlineText: View {
    let spans: [InlineSpan]
    @Environment(\.fileLinks) private var fileLinks
    @Environment(\.font) private var inheritedFont
    var body: some View {
        Text(Self.attributed(spans, fileLinks: fileLinks, baseFont: inheritedFont ?? .body))
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    static func attributed(_ spans: [InlineSpan], fileLinks: Bool = false, baseFont: Font = .body) -> AttributedString {
        var out = AttributedString()
        for span in spans {
            var piece = AttributedString(span.styles.contains(.image) ? "🖼 " + (span.text.isEmpty ? "image" : span.text) : span.text)
            var font: Font = baseFont
            if span.styles.contains(.code) {
                font = baseFont.monospaced()
                piece.backgroundColor = Color(uiColor: .tertiarySystemFill)
                if fileLinks, span.destination == nil, let link = FileLink.url(for: span.text) {
                    piece.link = link
                }
            }
            if span.styles.contains(.strong) { font = font.bold() }
            if span.styles.contains(.emphasis) { font = font.italic() }
            piece.font = font
            if span.styles.contains(.strike) { piece.strikethroughStyle = .single }
            if let destination = span.destination {
                if let url = URL(string: destination), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                    piece.link = url
                    piece.underlineStyle = .single
                } else if fileLinks, let link = FileLink.url(for: destination.replacingOccurrences(of: "#L", with: ":")) {
                    piece.link = link
                    piece.underlineStyle = .single
                }
            }
            out += piece
        }
        return out
    }
}

private struct TableBlock: View {
    let headers: [[InlineSpan]]
    let rows: [[[InlineSpan]]]
    let alignments: [TableAlignment]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(headers.indices, id: \.self) { i in
                        InlineContent(spans: headers[i]).font(.subheadline.weight(.semibold))
                            .gridColumnAlignment(alignment(i))
                    }
                }
                Divider()
                ForEach(rows.indices, id: \.self) { r in
                    GridRow {
                        ForEach(rows[r].indices, id: \.self) { i in
                            InlineContent(spans: rows[r][i]).font(.subheadline)
                        }
                    }
                }
            }
            .padding(12)
        }
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 10))
    }

    private func alignment(_ i: Int) -> HorizontalAlignment {
        guard i < alignments.count else { return .leading }
        switch alignments[i] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

/// A code block: syntax colours from NikCore's tokenizer, horizontal scroll,
/// a copy button, monospaced at the person's text size.
struct CodeBlockView: View {
    let code: String
    var language: String?
    @State private var copied = false
    @Environment(\.runCommand) private var runCommand

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? CodeTokenizer.detectedLanguage(code) ?? "code")
                    .font(.caption.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                if let runCommand, let command = ShellCommand.runnable(code, language: language) {
                    Button { runCommand(command) } label: {
                        Label("Run in Terminal", systemImage: "play.fill").font(.caption).labelStyle(.iconOnly)
                            .frame(width: 44, height: 44).contentShape(.rect)
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .accessibilityLabel("Run in Terminal")
                }
                Button {
                    UIPasteboard.general.string = code
                    Haptics.success()
                    copied = true
                    Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption).labelStyle(.iconOnly)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .padding(.leading, 12).padding(.trailing, 4).padding(.top, 4)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(Self.highlighted(code, language: language))
                    .readingFont(.footnote, monospaced: true)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, 12).padding(.bottom, 12).padding(.top, 2)
            }
        }
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 10))
    }

    static func highlighted(_ code: String, language: String?) -> AttributedString {
        let source = NSMutableAttributedString(string: code)
        let length = (code as NSString).length
        for token in code.utf16.count > 100_000 ? [] : CodeTokenizer.tokenize(code, language: language) {
            guard token.range.lowerBound >= 0, token.range.upperBound <= length else { continue }
            source.addAttribute(.foregroundColor, value: color(token.kind),
                                range: NSRange(location: token.range.lowerBound, length: token.range.count))
        }
        return (try? AttributedString(source, including: \.uiKit)) ?? AttributedString(code)
    }

    private static func color(_ kind: CodeTokenKind) -> UIColor {
        switch kind {
        case .comment: .secondaryLabel
        case .string: dynamic(0x1E7F4F, 0x8FD9A8)
        case .keyword: dynamic(0xA3326E, 0xFF8AC0)
        case .number: dynamic(0x8250DF, 0xC7A6FF)
        case .type: dynamic(0x0B6E99, 0x7ED0F5)
        case .function: dynamic(0x6F4B00, 0xF3D86A)
        case .property: dynamic(0x2563C9, 0x9CC2FF)
        case .punctuation: .secondaryLabel
        case .inserted: dynamic(0x1E7F4F, 0x77D6B1)
        case .deleted: dynamic(0xB3423B, 0xF29891)
        case .heading: .label
        }
    }

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
    }
}

/// Whether a code block is a shell command worth offering to run, and the
/// command with any `$ ` prompts taken off.
enum ShellCommand {
    static let shells: Set<String> = ["sh", "bash", "zsh", "shell", "console", "shellsession", "fish"]

    static func runnable(_ code: String, language: String?) -> String? {
        let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
            .map { String($0) }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !lines.isEmpty else { return nil }
        let stripped = lines.map { line -> String in
            for prompt in ["$ ", "# "] where line.hasPrefix(prompt) { return String(line.dropFirst(prompt.count)) }
            return line
        }
        if let language = language?.lowercased(), !language.isEmpty {
            return shells.contains(language) ? stripped.joined(separator: "\n") : nil
        }
        guard lines.count <= 12, lines.allSatisfy({ $0.count <= 400 }) else { return nil }
        let other = try! Regex(#"^\s*(def |class |function |import |const |let |var |fn |func |public |#include|package |<\w)"#)
        for line in stripped {
            if line.contains(other) || line.hasSuffix(";") || line.hasSuffix("{") || line.hasSuffix("}") { return nil }
        }
        let first = stripped[0].split(separator: " ").first.map(String.init) ?? ""
        let known: Set<String> = ["git", "npm", "npx", "yarn", "pnpm", "swift", "xcodebuild", "make", "cd", "ls", "cat", "brew", "pip", "pip3",
                                  "python", "python3", "node", "cargo", "go", "docker", "kubectl", "gh", "curl", "rm", "mkdir", "cp", "mv",
                                  "echo", "export", "open", "code", "bun", "deno", "pytest", "./", "xcrun", "adb", "grep", "rg", "find", "sudo", "tail", "head"]
        return known.contains(first) || first.hasPrefix("./") ? stripped.joined(separator: "\n") : nil
    }
}

/// An image from Markdown (http(s) or a data: image), loaded off the main
/// thread and opened full screen on tap.
struct MarkdownImage: View {
    let url: URL
    let alt: String
    @State private var image: UIImage?
    @State private var failed = false
    @State private var viewing = false

    static func url(for span: InlineSpan) -> URL? {
        guard span.styles.contains(.image), let destination = span.destination, let url = URL(string: destination) else { return nil }
        switch url.scheme?.lowercased() {
        case "http", "https": return url
        case "data": return destination.lowercased().hasPrefix("data:image/") ? url : nil
        default: return nil
        }
    }

    var body: some View {
        Group {
            if let image {
                Button { viewing = true } label: {
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
                        .clipShape(.rect(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(alt.isEmpty ? "Image" : alt)
                .accessibilityHint("Opens full screen")
            } else if failed {
                Label(alt.isEmpty ? "Image could not load" : alt, systemImage: "photo.badge.exclamationmark")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity, minHeight: 80).accessibilityLabel("Loading image")
            }
        }
        .task(id: url) { await load() }
        .fullScreenCover(isPresented: $viewing) {
            if let image {
                NavigationStack {
                    ZoomableImage(image: image, label: alt.isEmpty ? "Image" : alt).ignoresSafeArea()
                        .background(Color.black.ignoresSafeArea())
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) { Button("Done") { viewing = false } }
                            ToolbarItem(placement: .bottomBar) {
                                Button { UIPasteboard.general.image = image; Haptics.tap() } label: { Label("Copy", systemImage: "doc.on.doc") }
                            }
                            ToolbarItem(placement: .bottomBar) {
                                ShareLink(item: Image(uiImage: image), preview: SharePreview(alt.isEmpty ? "Image" : alt, image: Image(uiImage: image)))
                            }
                        }
                        .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
                }
                .preferredColorScheme(.dark)
            }
        }
    }

    private func load() async {
        image = nil; failed = false
        let target = url
        guard let data = try? await Self.bytes(target), !Task.isCancelled else { failed = !Task.isCancelled; return }
        let loaded = await Task.detached(priority: .utility) { () -> UIImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: 2_048,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
        }.value
        guard !Task.isCancelled, url == target else { return }
        image = loaded; failed = loaded == nil
    }

    nonisolated private static func bytes(_ url: URL) async throws -> Data {
        let limit = 20 * 1_024 * 1_024
        if url.scheme?.lowercased() == "data" {
            let source = url.absoluteString
            guard source.utf8.count <= 28 * 1_024 * 1_024, let comma = source.firstIndex(of: ","),
                  source[..<comma].lowercased().hasSuffix(";base64"),
                  let data = Data(base64Encoded: String(source[source.index(after: comma)...])), data.count <= limit else {
                throw CoreFailure(.tooLarge, "The image is too large or invalid.")
            }
            return data
        }
        // Ephemeral loading avoids leaving private image URLs, cookies or pixels on disk.
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.timeoutInterval = 20
        let (bytes, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              response.mimeType?.lowercased().hasPrefix("image/") == true,
              response.expectedContentLength <= limit else { throw CoreFailure(.tooLarge, "The image is unavailable or too large.") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < limit else { throw CoreFailure(.tooLarge, "The image is too large.") }
            data.append(byte)
        }
        return data
    }

}
