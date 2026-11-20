import SwiftUI
import ImageIO
import UIKit
import NikCore

/// One Slack conversation, or one thread inside it.
struct SlackThreadView: View {
    let thread: SlackThreadID
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @State private var sending = false
    @State private var nearBottom = true
    @State private var scrollID: String?
    @State private var restoredReading = false
    @State private var restoringOffset: ReadingState?
    @State private var viewport = ReadingViewport()
    @State private var olderAnchor: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var fullscreen: UIImage?

    private var page: SlackThreadState? { client.slack.threads[thread] }
    private var readingKey: String { "slack:" + thread.conversation + ":" + (thread.thread ?? "") }
    private var messages: [SlackMessage] { page?.messages ?? [] }
    private var canReply: Bool { client.slack.state.mayReply && client.mayControl }
    /// The reply lives in the core so it survives leaving the thread, and only the
    /// exact reply the laptop confirmed is cleared.
    private var draft: Binding<String> {
        Binding(get: { page?.draft.text ?? "" },
                set: { client.setSlackDraft($0, conversation: thread.conversation, thread: thread.thread) })
    }
    private var busy: Bool { sending || page?.pending != nil }
    private var title: String {
        let conversation = page?.conversation
        let name = conversation?.title ?? ""
        if !name.isEmpty { return thread.thread == nil ? name : "Thread" }
        return client.slack.state.sidebar.items.first { $0.id == thread.conversation }?.title ?? "Slack"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if page?.hasMore == true, let first = messages.first {
                        Button("Load older messages") {
                            olderAnchor = scrollID
                            Task { await model.run(.slackOlder(conversation: thread.conversation, thread: thread.thread, before: first.ts)) }
                        }
                        .buttonStyle(.bordered).frame(maxWidth: .infinity)
                    }
                    ForEach(messages) { message in
                        MessageView(message: message, thread: thread, fullscreen: $fullscreen)
                            .id(message.ts)
                            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .scrollView).minY } action: { y in
                                rememberOffset(message.ts, y: y)
                            }
                    }
                    if messages.isEmpty {
                        if let error = page?.error { EmptyState(title: "Could not load", symbol: "exclamationmark.triangle", message: error) }
                        else { ProgressView().frame(maxWidth: .infinity).padding(.top, 40) }
                    }
                }
                .background(ReadingViewportProbe(viewport: viewport).frame(width: 0, height: 0))
                .scrollTargetLayout()
                .padding()
            }
            .scrollPosition(id: $scrollID, anchor: .top)
            .onScrollGeometryChange(for: ReadingGeometry.self) { ReadingGeometry($0) } action: { old, new in
                guard restoringOffset == nil else { return }
                if restoredReading, nearBottom, old.extent != new.extent, let last = messages.last {
                    proxy.scrollTo(last.ts, anchor: .bottom)
                    return
                }
                nearBottom = new.bottom
                guard restoredReading else { return }
                var reading = model.reading(readingKey); reading.followsLatest = new.bottom
                model.saveReading(reading, key: readingKey)
            }
            .task(id: messages.isEmpty) {
                guard !messages.isEmpty, !restoredReading else { return }
                var reading = model.reading(readingKey)
                if reading.anchorID == nil || !messages.contains(where: { $0.ts == reading.anchorID }) { reading.followsLatest = true }
                nearBottom = reading.followsLatest
                restoringOffset = reading.followsLatest ? nil : reading
                scrollID = reading.followsLatest ? messages.last?.ts : reading.anchorID
                restoredReading = true
            }
            .onChange(of: scrollID) { _, anchor in
                guard restoredReading else { return }
                var reading = model.reading(readingKey); reading.anchorID = anchor
                if restoringOffset == nil { reading.offset = 0 }
                model.saveReading(reading, key: readingKey)
            }
            .onChange(of: messages.first?.ts) { _, _ in
                if let anchor = olderAnchor {
                    restoringOffset = model.reading(readingKey)
                    proxy.scrollTo(anchor, anchor: .top); olderAnchor = nil
                }
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: messages.last?.ts) { _, last in
                // Follow new messages only when already reading the newest one.
                if let last, nearBottom { withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo(last, anchor: .bottom) } }
            }
            .overlay(alignment: .bottomTrailing) {
                if !nearBottom, let last = messages.last {
                    Button {
                        withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo(last.ts, anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down").frame(width: 44, height: 44).background(.bar, in: .circle)
                    }.accessibilityLabel("Jump to latest").padding()
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await model.run(.slackLink(conversation: thread.conversation, ts: thread.thread)) } } label: {
                    Label("Open in Slack", systemImage: "arrow.up.forward.app")
                }
            }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .fullScreenCover(item: Binding(get: { fullscreen.map(ImageBox.init) }, set: { if $0 == nil { fullscreen = nil } })) { box in
            SlackImageViewer(image: box.image) { fullscreen = nil }
        }
        .refreshable { await model.run(.slackOpen(conversation: thread.conversation, thread: thread.thread)) }
    }

    private func rememberOffset(_ itemID: String, y: CGFloat) {
        guard restoredReading else { return }
        if let saved = restoringOffset, saved.anchorID == itemID, viewport.scrollView != nil {
            restoringOffset = nil; viewport.restore(offset: saved.offset, observedY: y)
        } else if restoringOffset == nil {
            var reading = model.reading(readingKey)
            if reading.anchorID == itemID, !nearBottom, abs(reading.offset - Double(y)) > 0.5 {
                reading.offset = Double(y); model.saveReading(reading, key: readingKey)
            }
        }
    }

    // MARK: Composer

    @ViewBuilder private var composer: some View {
        VStack(spacing: 6) {
            if let error = page?.error, !messages.isEmpty {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(canReply ? "Reply" : "Replying is off", text: draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 18))
                    .disabled(!canReply)
                Button(action: send) {
                    if busy { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
                }
                .frame(minWidth: 44, minHeight: 44)
                .disabled(!canReply || busy || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.wrappedValue.utf16.count > 12000)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal).padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let text = draft.wrappedValue
        guard canReply, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= 12000, !busy else { return }
        sending = true
        Task {
            // Waits for slack:sent; the core then clears the reply if it was not edited meanwhile.
            let result = await model.run(.slackReply(id: UUID().uuidString, conversation: thread.conversation, text: text, thread: thread.thread))
            sending = false
            switch result {
            case .accepted: Haptics.success()
            case .notSent, .ambiguous: Haptics.error()
            default: break
            }
        }
    }
}

private struct ImageBox: Identifiable { let image: UIImage; var id: ObjectIdentifier { ObjectIdentifier(image) } }

private struct SlackImageViewer: View {
    let image: UIImage
    let close: () -> Void
    var body: some View {
        NavigationStack {
            ZoomableImage(image: image).ignoresSafeArea()
                .background(Color.black.ignoresSafeArea())
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Done", action: close) }
                    ToolbarItem(placement: .bottomBar) {
                        Button { UIPasteboard.general.image = image; Haptics.tap() } label: { Label("Copy", systemImage: "doc.on.doc") }
                    }
                    ToolbarItem(placement: .bottomBar) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview("Image", image: Image(uiImage: image)))
                    }
                }
                .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
        }
        .preferredColorScheme(.dark)
    }
}

private struct MessageView: View {
    let message: SlackMessage
    let thread: SlackThreadID
    @Binding var fullscreen: UIImage?
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(message.initials).font(.footnote.weight(.semibold)).foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(message.mine ? Theme.accent : Color.teal, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(message.mine ? "You" : (message.name ?? "Unknown")).font(.subheadline.bold())
                    if let at = message.at { Text(at.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
                    if message.edited { Text("edited").font(.caption).foregroundStyle(.secondary) }
                }
                if !message.html.isEmpty { MarkdownView(blocks: SlackHTMLParser.parse(message.html), compact: true) }
                ForEach(Array(message.files.enumerated()), id: \.offset) { _, file in
                    FileView(file: file, fullscreen: $fullscreen)
                }
                if !message.reactions.isEmpty {
                    HStack { ForEach(message.reactions) { r in
                        Text("\(r.emoji) \(r.count)").font(.footnote)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(r.mine ? Theme.accent.opacity(0.2) : Color.secondary.opacity(0.15), in: Capsule())
                            .accessibilityLabel("\(r.name) \(r.count)")
                    } }
                }
                if message.replyCount > 0, thread.thread == nil {
                    Button { model.push(.slackThread(SlackThreadID(conversation: thread.conversation, thread: message.ts))) } label: {
                        Label("\(message.replyCount) \(message.replyCount == 1 ? "reply" : "replies")", systemImage: "bubble.left.and.bubble.right")
                            .font(.footnote)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct FileView: View {
    let file: SlackFile
    @Binding var fullscreen: UIImage?
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?

    private var dataURL: String? { file.id.isEmpty ? nil : client.slack.files[file.id] }

    var body: some View {
        if file.image {
            Group {
                if let image {
                    Button { fullscreen = image } label: {
                        Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 280).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .accessibilityLabel("Image \(file.name ?? ""). Open full screen")
                } else if let reason = client.slack.fileErrors[file.id] {
                    HStack {
                        Label(reason.isEmpty ? "Image unavailable" : reason, systemImage: "photo.badge.exclamationmark").font(.footnote).foregroundStyle(.secondary)
                        Button { Task { await model.run(.slackFile(file.id)) } } label: { Text("Retry").font(.footnote).frame(minWidth: 44, minHeight: 44) }
                    }
                } else {
                    RoundedRectangle(cornerRadius: 10).fill(.fill.tertiary)
                        .aspectRatio(aspect, contentMode: .fit).frame(maxHeight: 200)
                        .overlay { ProgressView() }
                }
            }
            .task(id: file.id) {
                if dataURL == nil, !file.id.isEmpty { await model.run(.slackFile(file.id)) }
            }
            .task(id: dataURL) {
                guard let dataURL else { return }
                let decoded = await Task.detached { Self.decode(dataURL) }.value
                image = decoded
            }
        } else if let link = file.permalink, let url = URL(string: link) {
            Link(destination: url) { Label(file.title ?? file.name ?? "File", systemImage: "doc") }.font(.subheadline)
        } else {
            Label(file.title ?? file.name ?? "File", systemImage: "doc").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var aspect: CGFloat {
        if let w = file.w, let h = file.h, w > 0, h > 0 { return CGFloat(w) / CGFloat(h) }
        return 4.0 / 3.0
    }

    nonisolated private static func decode(_ dataURL: String) -> UIImage? {
        let base64 = dataURL.split(separator: ",", maxSplits: 1).last.map(String.init) ?? ""
        guard let data = Data(base64Encoded: base64), let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 1600]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}
