import SwiftUI
import UIKit
import NikCore

/// One transcript entry, by kind. Unknown kinds show a readable fallback.
struct TranscriptItemView: View {
    let item: TranscriptItem
    let conversationID: String
    let provider: Provider
    @Binding var expanded: Bool
    var highlighted = false
    var searchMatch: TranscriptMatch? = nil

    var body: some View {
        Group {
            if let searchMatch { SearchOccurrence(item: item, match: searchMatch) }
            else { content }
        }
            .padding(highlighted ? 6 : 0)
            .background(highlighted ? Theme.working.opacity(0.18) : .clear, in: .rect(cornerRadius: 10))
    }

    @ViewBuilder private var content: some View {
        switch item.kind {
        case "user": UserMessage(item: item)
        case "text": AnswerText(item: item)
        case "thinking": ThinkingBlock(item: item, expanded: $expanded)
        case "tool": ToolBlock(item: item, expanded: $expanded)
        case "permission": PermissionCard(item: item, conversationID: conversationID)
        case "result": ResultSeparator(item: item, provider: provider)
        case "compact": CompactMarker(item: item)
        case "notice": NoticeLine(item: item)
        default: UnknownItem(item: item, expanded: $expanded)
        }
    }
}

/// Find mode reveals the exact occurrence in rendered text, including folded arguments.
private struct SearchOccurrence: View {
    let item: TranscriptItem
    let match: TranscriptMatch
    var body: some View {
        let source = TranscriptSearch.searchableText(item) as NSString
        let start = min(max(0, match.range.lowerBound), source.length)
        let end = min(max(start, match.range.upperBound), source.length)
        VStack(alignment: .leading, spacing: 0) {
            if start > 0 { Text(source.substring(to: start)) }
            Text(source.substring(with: NSRange(location: start, length: end - start)))
                .bold().padding(2).background(Theme.working.opacity(0.3), in: .rect(cornerRadius: 3))
                .id("find:" + match.id)
                .accessibilityLabel("Match: " + source.substring(with: NSRange(location: start, length: end - start)))
            if end < source.length { Text(source.substring(from: end)) }
        }
        .readingFont()
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Kinds

private struct UserMessage: View {
    let item: TranscriptItem
    @Environment(NikClient.self) private var client
    @State private var viewing: Attachment?

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !item.images.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                    ForEach(Array(item.images.enumerated()), id: \.offset) { _, image in
                        Button { viewing = image } label: { Thumbnail(attachment: image, size: 84) }
                            .buttonStyle(.plain)
                    }
                    }
                }
            }
            if !item.text.isEmpty {
                Text(item.text)
                    .readingFont()
                    .textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.accent.opacity(0.16), in: .rect(cornerRadius: 18))
            }
            if !item.snippets.isEmpty {
                HStack(spacing: 6) {
                    ForEach(item.snippets, id: \.self) { name in
                        Text("/" + name).font(.caption.monospaced())
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color(uiColor: .tertiarySystemFill), in: .capsule)
                            .help(client.selectedConversation?.configuration.snippets[name] ?? "")
                    }
                }
            }
            if let at = item.at {
                Text(at.formatted(date: .omitted, time: .shortened)).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
        .contextMenu {
            Button { UIPasteboard.general.string = item.text } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
        .fullScreenCover(item: $viewing) { ImageViewer(attachment: $0) }
    }
}

private struct AnswerText: View {
    let item: TranscriptItem
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let agent = item.agent?.nilIfEmpty {
                Label(agent, systemImage: "person.2").font(.caption).foregroundStyle(.secondary)
            }
            MarkdownView(item.text)
            if item.streaming {
                ProgressView().controlSize(.mini).accessibilityLabel("Still writing")
            }
        }
        .contextMenu {
            Button { UIPasteboard.general.string = item.text } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
    }
}

private struct ThinkingBlock: View {
    let item: TranscriptItem
    @Binding var expanded: Bool
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(item.text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
        } label: {
            Label(item.streaming ? "Thinking…" : "Thought", systemImage: "brain").font(.subheadline).foregroundStyle(.secondary)
        }
        .tint(.secondary)
    }
}

private struct ToolBlock: View {
    let item: TranscriptItem
    @Binding var expanded: Bool

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                let input = ToolSummary.inputText(item)
                if !input.isEmpty {
                    Text("Input").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Preformatted(text: String(input.prefix(8000)))
                    if input.count > 8000 { clipNote("Input shortened to 8,000 of \(input.count) characters.") }
                }
                if let result = item.result, !result.isEmpty {
                    Text(item.isError ? "Error" : "Output").font(.caption.weight(.semibold))
                        .foregroundStyle(item.isError ? Theme.needsYou : .secondary)
                    if ToolSummary.isDiff(item) { CodeBlockView(code: result, language: "diff") }
                    else { Preformatted(text: result) }
                    if item.resultClipped || (item.resultLength ?? 0) > result.count {
                        clipNote("The laptop sent \(result.count.formatted()) of \((item.resultLength ?? result.count).formatted()) characters.")
                    }
                }
            }
            .padding(.top, 6)
        } label: {
            HStack(spacing: 8) {
                statusIcon
                Text(item.name).font(.subheadline.weight(.semibold))
                Text(ToolSummary.summary(item)).font(.subheadline.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
        }
        .tint(.secondary)
        .accessibilityLabel("\(item.name), \(ToolSummary.summary(item)), \(statusWords)")
    }

    private var statusWords: String {
        if item.isError { return "failed" }
        switch item.toolStatus {
        case "running": return "running"
        case "stopped": return "stopped"
        default: return "done"
        }
    }

    @ViewBuilder private var statusIcon: some View {
        if item.isError {
            Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.needsYou)
        } else if item.toolStatus == "running" || item.streaming {
            ProgressView().controlSize(.mini)
        } else if item.toolStatus == "stopped" {
            Image(systemName: "stop.circle").foregroundStyle(.secondary)
        } else {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.done)
        }
    }

    private func clipNote(_ text: String) -> some View {
        Label(text, systemImage: "scissors").font(.caption).foregroundStyle(.secondary)
    }
}

struct PermissionCard: View {
    let item: TranscriptItem
    let conversationID: String
    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @State private var sent: Bool?
    @State private var showArgs = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: item.resolved == nil ? "hand.raised.fill" : (item.resolved == "allow" ? "checkmark.shield.fill" : "xmark.shield.fill"))
                    .foregroundStyle(item.resolved == nil ? Theme.needsYou : (item.resolved == "allow" ? Theme.done : .secondary))
                Text(item.resolved == nil ? "Allow \(item.name)?" : (item.resolved == "allow" ? "Allowed \(item.name)" : "Denied \(item.name)"))
                    .font(.headline)
            }
            let command = item.input["command"].stringValue
            if let command {
                Preformatted(text: command)
                if let description = item.input["description"].stringValue {
                    Text(description).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if command == nil || item.input.objectValue.count > 1 {
                DisclosureGroup("Arguments", isExpanded: $showArgs) {
                    Preformatted(text: ToolSummary.pretty(item.input))
                }
                .font(.subheadline).tint(.secondary)
            }
            if item.resolved == nil {
                HStack(spacing: 10) {
                    Button { answer(false) } label: { Text("Deny").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered).controlSize(.large)
                    Button { answer(true) } label: {
                        Group { if sent == true { ProgressView() } else { Text("Allow") } }.frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                }
                .disabled(sent != nil)
                .needsControl(client.mayControlConversation(conversationID))
                if !client.mayControlConversation(conversationID) {
                    Text("Answering needs a live chat connection and control. You can also answer on the laptop.").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 14))
        .overlay {
            if item.resolved == nil { RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.needsYou.opacity(0.5), lineWidth: 1) }
        }
        .onChange(of: item.resolved) { sent = nil }
    }

    private func answer(_ allow: Bool) {
        sent = allow
        Haptics.tap()
        Task {
            let result = await model.run(.permission(requestID: item.requestId, allow: allow), on: .conversation(conversationID))
            if case .notSent = result { sent = nil }
            // Otherwise wait for the laptop to mark it resolved; never claim it was allowed before that.
            try? await Task.sleep(for: .seconds(8))
            if item.resolved == nil { sent = nil }
        }
    }
}

private struct ResultSeparator: View {
    let item: TranscriptItem
    let provider: Provider

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 10) {
                line
                // One line: the label gets space before the divider lines and shrinks before it wraps.
                Label(title, systemImage: icon).font(.caption.weight(.medium)).foregroundStyle(color)
                    .lineLimit(1).minimumScaleFactor(0.75).layoutPriority(1)
                line
            }
            if item.isError, !item.text.isEmpty {
                Text(item.text).font(.footnote).foregroundStyle(Theme.needsYou).multilineTextAlignment(.center)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var line: some View { Rectangle().fill(.quaternary).frame(height: 1) }

    private var title: String {
        var parts: [String] = [item.isError ? "Error" : item.interrupted ? "Interrupted" : "Done"]
        if let ms = item.durationMs { parts.append(Format.duration(ms: ms)) }
        if provider == .claude, let cost = item.costUsd, cost > 0 { parts.append(Format.cost(cost)) }
        if let at = item.at { parts.append(at.formatted(date: .omitted, time: .shortened)) }
        return parts.joined(separator: " · ")
    }
    private var icon: String { item.isError ? "exclamationmark.triangle" : item.interrupted ? "stop.circle" : "checkmark" }
    private var color: Color { item.isError ? Theme.needsYou : .secondary }
}

private struct CompactMarker: View {
    let item: TranscriptItem
    var body: some View {
        Label {
            Text("Context compacted\(item.trigger == "auto" ? " automatically" : "")\(item.before.map { " · \(Format.tokens($0)) tokens before" } ?? ""). Earlier messages stay readable; the agent sees a summary.")
        } icon: { Image(systemName: "rectangle.compress.vertical") }
        .font(.footnote).foregroundStyle(.secondary)
    }
}

private struct NoticeLine: View {
    let item: TranscriptItem
    var body: some View {
        let bad = item.level == "error" || item.level == "stderr" || item.level == "exit"
        Label {
            Text(item.text).textSelection(.enabled)
        } icon: {
            Image(systemName: bad ? "exclamationmark.triangle" : "info.circle")
        }
        .font(.footnote)
        .foregroundStyle(bad ? Theme.needsYou : .secondary)
    }
}

private struct UnknownItem: View {
    let item: TranscriptItem
    @Binding var expanded: Bool
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Preformatted(text: ToolSummary.pretty(item.raw))
        } label: {
            Label("Something this app does not show yet (\(item.kind))", systemImage: "questionmark.square.dashed")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .tint(.secondary)
    }
}

// MARK: Pieces

/// Monospaced, selectable, horizontally scrolling text.
struct Preformatted: View {
    let text: String
    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            Text(text.count > 60_000 ? String(text.prefix(60_000)) + "\n…" : text)
                .readingFont(.footnote, monospaced: true)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: true)
                .padding(10)
        }
        .frame(maxHeight: 420)
        .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 8))
        .contextMenu {
            Button { UIPasteboard.general.string = text } label: { Label("Copy", systemImage: "doc.on.doc") }
        }
    }
}

struct Thumbnail: View {
    let attachment: Attachment
    var size: CGFloat = 64
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if failed {
                Image(systemName: "photo.badge.exclamationmark").foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .task(id: attachment) {
            image = nil; failed = false
            let loaded = await ImageStore.image(attachment, maxPixels: size * displayScale)
            guard !Task.isCancelled else { return }
            image = loaded; failed = loaded == nil
        }
        .frame(width: size, height: size)
        .background(Color(uiColor: .tertiarySystemFill))
        .clipShape(.rect(cornerRadius: 10))
        .accessibilityLabel(attachment.name.isEmpty ? "Image" : attachment.name)
    }
}

/// Full-screen image with pinch to zoom and share.
struct ImageViewer: View {
    let attachment: Attachment
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ZoomableImage(image: image, label: attachment.name.isEmpty ? "Image" : attachment.name).ignoresSafeArea()
                        .accessibilityLabel(attachment.name.isEmpty ? "Image" : attachment.name)
                } else if failed {
                    ContentUnavailableView("Cannot show this image", systemImage: "photo")
                } else {
                    ProgressView()
                }
            }
            .task(id: attachment) {
                image = nil; failed = false
                let loaded = await ImageStore.image(attachment, maxPixels: 4_096)
                guard !Task.isCancelled else { return }
                image = loaded; failed = loaded == nil
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if let image {
                    ToolbarItem(placement: .bottomBar) {
                        Button { UIPasteboard.general.image = image; Haptics.tap() } label: { Label("Copy", systemImage: "doc.on.doc") }
                    }
                    ToolbarItem(placement: .bottomBar) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview(attachment.name.nilIfEmpty ?? "Image", image: Image(uiImage: image)))
                    }
                }
            }
            .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: Text helpers

enum ToolSummary {
    /// The one argument that says what the tool did.
    static func summary(_ item: TranscriptItem) -> String {
        let input = item.input
        for key in ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "notebook_path"] {
            if let value = input[key].stringValue, !value.isEmpty {
                return key.hasSuffix("path") ? Format.shortPath(value) : value.replacingOccurrences(of: "\n", with: " ")
            }
        }
        if let raw = item.rawInput, !raw.isEmpty { return String(raw.prefix(80)) }
        return ""
    }

    static func inputText(_ item: TranscriptItem) -> String {
        if case .null = item.input { return item.rawInput ?? "" }
        if let command = item.input["command"].stringValue, item.input.objectValue.count <= 2 { return command }
        return pretty(item.input)
    }

    static func isDiff(_ item: TranscriptItem) -> Bool {
        ["Edit", "Write", "MultiEdit", "apply_patch"].contains(item.name) && (item.result ?? "").contains("\n@@")
    }

    static func pretty(_ value: JSONValue) -> String {
        guard let data = try? value.encoded(), let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let out = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed]),
              let text = String(data: out, encoding: .utf8) else { return value.text }
        return text
    }
}

enum TranscriptText {
    /// The words of an item, for copying and for find.
    static func plain(_ item: TranscriptItem) -> String {
        switch item.kind {
        case "user", "text", "notice", "thinking": item.text
        case "tool": [item.name, ToolSummary.summary(item), item.result ?? ""].joined(separator: "\n")
        case "permission": "Allow \(item.name)? " + (item.input["command"].stringValue ?? "")
        case "result": item.text
        default: ""
        }
    }
}
