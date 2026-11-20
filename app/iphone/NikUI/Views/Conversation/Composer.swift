import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import UIKit
import ImageIO
import NikCore

/// The message field: text, photos, voice, the slash palette and Send.
/// While the agent works, Send becomes Queue (or Steer for Codex).
struct Composer: View {
    let conversationID: String
    let provider: Provider
    @Binding var showTools: Bool
    var dismissFind: () -> Bool = { false }

    @Environment(AppModel.self) private var model
    @Environment(NikClient.self) private var client
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var focused: Bool
    @State private var selection: TextSelection?
    @State private var picked: [PhotosPickerItem] = []
    @State private var loadingPhotos = false
    @State private var steer = false
    @State private var sending = false
    @State private var paletteDismissed = ""
    @State private var photoJob: Task<Void, Never>?
    @State private var photoGeneration = 0
    @State private var importingFiles = false
    @State private var recalling = false
    @State private var lastEscape: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var voice: VoiceComposition { model.voiceComposition(conversationID) }
    private var recorder: VoiceRecorder { voice.recorder }
    private var heldClip: String? {
        get { voice.clip }
        nonmutating set { voice.clip = newValue }
    }
    private var listeningID: String? {
        get { voice.requestID }
        nonmutating set { voice.requestID = newValue }
    }
    private var state: ConversationState { client.conversation(conversationID) }
    private var busy: Bool { state.status == .working || state.status == .waiting }
    private var watching: Bool { client.connection.isLive && client.seat?.control != true }
    private var draft: Draft { state.draft }

    private var text: Binding<String> {
        Binding(get: { draft.text }, set: { value in
            recalling = false; lastEscape = nil
            voice.sendAfterTranscription = false
            var next = draft; next.text = value; next.delivery = .draft; next.updatedAt = Date()
            client.setDraft(next, conversationID: conversationID)
        })
    }

    private var trimmed: String { draft.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var unresolved: Bool { [.submitting, .submitted, .ambiguous].contains(draft.delivery) }
    private var canSend: Bool {
        client.mayControlConversation(conversationID) && !sending && !unresolved
            && (!trimmed.isEmpty || !draft.attachments.isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let plan = palette { PaletteList(plan: plan) { pick(plan, $0) } }
            if !draft.attachments.isEmpty || loadingPhotos {
                attachments
                Text("Up to 6 images, sent as JPEG.").font(.caption).foregroundStyle(.secondary)
            }
            if heldClip != nil && listeningID == nil { heldClipBar }
            if draft.delivery == .submitted || draft.delivery == .ambiguous {
                let unconfirmed = draft
                VStack(alignment: .leading, spacing: 6) {
                    Label(draft.delivery == .submitted ? "Sent without a delivery receipt. Check the chat or queue, then choose what to do with this draft." : "NikUI could not confirm this message reached the laptop. Check the chat before sending it again.", systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(Theme.working)
                    HStack {
                        Button("It arrived, clear") { if draft == unconfirmed { client.markDraftReviewed(conversationID: conversationID, clear: true) } }
                        Button("It didn't, keep") { if draft == unconfirmed { client.markDraftReviewed(conversationID: conversationID, clear: false) } }
                    }
                    .buttonStyle(.bordered).controlSize(.large)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.top, 8)
            }
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(spacing: 4) {
                        field
                        HStack { addControls; Spacer(); trailingControl }
                    }
                } else {
                    HStack(alignment: .bottom, spacing: 8) { addControls; field; trailingControl }
                }
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
        }
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .fileImporter(isPresented: $importingFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            prepare(urls.map { url in
                { () async -> Data? in
                    await ImagePrep.read(url)
                }
            })
        }
        .dropDestination(for: Data.self) { items, _ in
            guard client.mayControl, !items.isEmpty else { return false }
            prepare(items.map { data in { data } })
            return true
        }
        .task(id: "\(conversationID)-\(client.mayControlConversation(conversationID))") {
            if client.mayControlConversation(conversationID) { _ = await client.perform(.voiceState, on: .conversation(conversationID)) }
        }
        .task(id: recorder.startedAt) {
            // The recorder stops itself at the limit; turn what it caught into words.
            guard let started = recorder.startedAt else { return }
            try? await Task.sleep(for: .seconds(max(0, VoiceRecorder.limit - Date().timeIntervalSince(started))))
            if recorder.isRecording, recorder.startedAt == started { finishVoice() }
        }
        .onChange(of: busy) { _, now in if !now { steer = false; lastEscape = nil } }
        .onChange(of: scenePhase) { _, phase in if phase != .active { holdRecording() } }
        .onChange(of: client.mayControlConversation(conversationID)) { _, may in if !may { holdRecording() } }
        .onChange(of: recorder.interrupted) { _, now in if now { holdRecording() } }
        .onDisappear {
            recorder.cancel()
            voice.sendAfterTranscription = false
            photoJob?.cancel(); photoJob = nil
        }
        .onChange(of: client.intent) { _, intent in if intent == .focus { focused = true } }
        .onChange(of: selection) { _, value in
            guard let value, case .selection(let range) = value.indices,
                  let lower = range.lowerBound.samePosition(in: draft.text.utf16),
                  let upper = range.upperBound.samePosition(in: draft.text.utf16) else { return }
            voice.selection = draft.text.utf16.distance(from: draft.text.utf16.startIndex, to: lower)..<draft.text.utf16.distance(from: draft.text.utf16.startIndex, to: upper)
            voice.selectionText = draft.text
        }
        .onChange(of: voice.insertedCaret) { _, caret in
            guard let caret, model.mayPresentContent, model.currentConversationID == conversationID else { return }
            selection = TextSelection(insertionPoint: String.Index(utf16Offset: min(caret, draft.text.utf16.count), in: draft.text))
            focused = true
        }
    }

    // MARK: Pieces

    @ViewBuilder private var addControls: some View {
        Menu {
            Button { showTools = true } label: { Label("Tools", systemImage: "slider.horizontal.3") }
            Button { importingFiles = true } label: { Label("Image from Files", systemImage: "folder") }.disabled(watching || recorder.isRecording)
            if UIPasteboard.general.hasImages {
                Button { pasteImages() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }.disabled(watching || recorder.isRecording)
            }
            if busy && provider == .codex {
                Toggle(isOn: $steer) { Label("Steer the current turn", systemImage: "arrow.triangle.turn.up.right.diamond") }
            }
        } label: {
            Image(systemName: "plus").font(.title3.weight(.medium)).frame(width: 44, height: 44)
        }
        .accessibilityLabel("More")

        PhotosPicker(selection: $picked, maxSelectionCount: 6, matching: .images, photoLibrary: .shared()) {
            Image(systemName: "photo").font(.title3).frame(width: 44, height: 44)
        }
        .accessibilityLabel("Add photos")
        .onChange(of: picked) { _, items in load(items) }
        .disabled(recorder.isRecording || watching)

    }

    @ViewBuilder private var trailingControl: some View {
        if trimmed.isEmpty && draft.attachments.isEmpty && client.voice.available && !recorder.isRecording && listeningID == nil && heldClip == nil {
            Button { Task { await startVoice() } } label: {
                Image(systemName: "mic").font(.title3).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Dictate on the laptop")
            .disabled(!client.mayControlConversation(conversationID))
        } else if recorder.isRecording {
            Button { finishVoice() } label: {
                Image(systemName: "stop.circle.fill").font(.title).foregroundStyle(Theme.needsYou).frame(width: 44, height: 44)
            }
            .accessibilityLabel("Stop recording and turn it into words")
        } else {
            sendButton
        }
    }

    @ViewBuilder private var field: some View {
        if recorder.isRecording, let started = recorder.startedAt {
            VStack(spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "waveform").symbolEffect(.variableColor.iterative, options: .repeating, isActive: !reduceMotion).foregroundStyle(Theme.needsYou)
                    Text(timerInterval: started...started.addingTimeInterval(VoiceRecorder.limit), countsDown: false).monospacedDigit()
                    TimelineView(.periodic(from: .now, by: 0.2)) { _ in
                        ProgressView(value: recorder.level()).frame(width: 36)
                            .accessibilityLabel("Microphone level")
                    }
                    Spacer(minLength: 0)
                }
                HStack {
                    Button("Cancel") { recorder.cancel() }.font(.subheadline).frame(minWidth: 44, minHeight: 44)
                    Spacer(minLength: 4)
                    Button("Send after transcription") { finishVoice(sendAfter: true) }
                        .font(.footnote).frame(minHeight: 44)
                        .disabled(!client.mayControlConversation(conversationID))
                }
            }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 18))
        } else {
            TextField(placeholder, text: text, selection: $selection, axis: .vertical)
                .disabled(watching)
                .lineLimit(1...(dynamicTypeSize.isAccessibilitySize ? 3 : 8))
                .focused($focused)
                .onKeyPress(.upArrow) {
                    guard draft.attachments.isEmpty, draft.text.isEmpty || recalling else { return .ignored }
                    _ = client.recallOlder(conversationID: conversationID); recalling = true
                    return .handled
                }
                .onKeyPress(.downArrow) {
                    guard recalling else { return .ignored }
                    _ = client.recallNewer(conversationID: conversationID)
                    return .handled
                }
                .onKeyPress(.escape) {
                    if dismissFind() { lastEscape = nil; return .handled }
                    if palette != nil { paletteDismissed = draft.text; lastEscape = nil; return .handled }
                    guard busy, client.mayControlConversation(conversationID) else { return .ignored }
                    if state.configuration.singleEscape || lastEscape.map({ Date().timeIntervalSince($0) < 2 }) == true {
                        lastEscape = nil
                        Task { _ = await model.run(.interrupt, on: .conversation(conversationID)) }
                    } else { lastEscape = .now }
                    return .handled
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color(uiColor: .secondarySystemBackground), in: .rect(cornerRadius: 18))
                .overlay(alignment: .trailing) {
                    if listeningID != nil { ProgressView().padding(.trailing, 10).accessibilityLabel("Turning your voice into words") }
                }
        }
    }

    private var placeholder: String {
        if !state.connection.isLive { return "Chat disconnected" }
        if !client.mayControlConversation(conversationID) { return "Watching only" }
        if listeningID != nil { return "Listening on the laptop…" }
        if busy { return steer ? "Steer the current turn" : "Queue a message" }
        return "Message \(provider.name)"
    }

    private var sendButton: some View {
        let title = busy ? (steer ? "Steer" : "Queue") : "Send"
        return Button(action: send) {
            Group {
                if sending || draft.delivery == .submitting { ProgressView() }
                else { Image(systemName: busy ? (steer ? "arrow.triangle.turn.up.right.circle.fill" : "text.badge.plus") : "arrow.up.circle.fill") }
            }
            .font(.title)
            .frame(width: 44, height: 44)
        }
        .disabled(!canSend)
        .accessibilityLabel(title)
        .keyboardShortcut(.return, modifiers: .command)
    }

    private var attachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(draft.attachments.enumerated()), id: \.offset) { index, attachment in
                    Thumbnail(attachment: attachment, size: 64)
                        .overlay(alignment: .topTrailing) {
                            Button { remove(at: index) } label: {
                                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6)).font(.title3)
                                    .frame(width: 44, height: 44).contentShape(.rect)
                            }
                            .offset(x: 6, y: -6)
                            .disabled(watching)
                            .accessibilityLabel("Remove image")
                        }
                }
                if loadingPhotos { ProgressView().frame(width: 64, height: 64) }
            }
            .padding(.horizontal, 16).padding(.top, 12)
        }
    }

    // MARK: Palette

    private var palette: PalettePlan? {
        guard focused, client.mayControl, draft.text != paletteDismissed else { return nil }
        var current: [String: String] = [:]
        if let model = state.meta.model { current["model"] = model }
        if let effort = state.meta.effort { current["effort"] = effort }
        guard let plan = SlashPalette.plan(draft.text, configuration: state.configuration, current: current), !plan.matches.isEmpty else { return nil }
        return plan
    }

    private func pick(_ plan: PalettePlan, _ index: Int) {
        guard let selection = SlashPalette.apply(plan, index: index, configuration: state.configuration) else { return }
        Haptics.selection()
        text.wrappedValue = selection.text
        if !selection.more && plan.mode == "value" { paletteDismissed = selection.text }
    }

    // MARK: Actions

    private func send() {
        guard canSend else { return }
        if let intent = SnippetExpander.localIntent(text: draft.text, attachmentCount: draft.attachments.count) {
            text.wrappedValue = ""
            model.follow(intent)
            return
        }
        // The core keeps the written text, snippet tokens and photos as the draft;
        // only the outgoing payload gets the Steer prefix.
        let prefix = busy && steer && provider == .codex ? "/steer " : ""
        let composition = draft
        let scope = client.pairedConnection?.scope
        sending = true
        Task {
            guard model.mayPresentContent, scope == client.pairedConnection?.scope, draft == composition else { sending = false; return }
            let result = await client.send(conversationID: conversationID, prefix: prefix)
            sending = false
            switch result {
            case .submitted, .accepted:
                steer = false
                Haptics.tap()
            case .ambiguous:
                model.show("The connection dropped while sending. Check the chat before sending again.", .warning)
            case .notSent(let failure):
                model.show(failure.message, .error)
            case .local(let intent):
                model.follow(intent)
            }
        }
    }

    private func remove(at index: Int) {
        var next = draft
        guard next.attachments.indices.contains(index) else { return }
        next.attachments.remove(at: index)
        client.setDraft(next, conversationID: conversationID)
    }

    private func load(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        prepare(items.map { item in { try? await item.loadTransferable(type: Data.self) } })
    }

    private func pasteImages() {
        let images = UIPasteboard.general.images ?? []
        prepare(images.map { image in { image.pngData() } })
    }

    /// Every image source (Photos, Files, paste, drop) goes through the same
    /// bounded JPEG preparation.
    private func prepare(_ sources: [() async -> Data?]) {
        guard !sources.isEmpty else { return }
        photoJob?.cancel()
        photoGeneration += 1
        let generation = photoGeneration
        let target = conversationID
        let scope = client.pairedConnection?.scope
        loadingPhotos = true
        photoJob = Task {
            var added: [Attachment] = []
            var skipped = 0
            for source in sources.prefix(6) {
                if Task.isCancelled { return }
                guard let data = await source(),
                      let attachment = await ImagePrep.attachment(from: data) else { skipped += 1; continue }
                added.append(attachment)
            }
            // A newer pick, a closed chat or a different laptop makes this result stale.
            guard !Task.isCancelled, generation == photoGeneration, scope == client.pairedConnection?.scope, target == conversationID else { return }
            var next = client.conversation(conversationID).draft
            let room = max(0, 6 - next.attachments.count)
            skipped += max(0, added.count - room)
            var exceedsBudget = false
            let expanded = SnippetExpander.expand(next.text, snippets: state.configuration.snippets)
            for attachment in added.prefix(room) {
                let images = next.attachments + [attachment]
                do {
                    try ClientAction.send(text: expanded.text, attachments: images, sent: expanded.used.isEmpty ? nil : expanded.sent, snippets: expanded.used).validate(on: .conversation(conversationID))
                    next.attachments = images
                } catch { skipped += 1; exceedsBudget = true }
            }
            client.setDraft(next, conversationID: conversationID)
            picked = []
            loadingPhotos = false
            if exceedsBudget { model.show("Some images would exceed the combined message size. The earlier draft and its images are kept.", .warning) }
            else if sources.count > 6 || skipped > 0 && next.attachments.count == 6 { model.show("A message can include up to 6 images. Some images were not added.", .warning) }
            else if skipped > 0 { model.show(skipped == 1 ? "One photo could not be read or was too large to send." : "\(skipped) photos could not be read or were too large to send.", .warning) }
        }
    }

    private func startVoice() async {
        guard client.mayControlConversation(conversationID) else { return }
        let scope = client.pairedConnection?.scope
        do {
            try await recorder.start()
            guard model.mayPresentContent, scenePhase == .active, model.currentConversationID == conversationID,
                  scope == client.pairedConnection?.scope, client.mayControlConversation(conversationID) else { recorder.cancel(); return }
            Haptics.tap()
        } catch is CancellationError {
            return
        } catch VoiceRecorder.Trouble.denied {
            model.show("Allow the microphone for NikUI in Settings to dictate.", .warning)
        } catch {
            model.show("Recording could not start.", .error)
        }
    }

    private func finishVoice(sendAfter: Bool = false) {
        guard let audio = recorder.finish() else { model.show("That recording was too short.", .warning); return }
        voice.sendAfterTranscription = sendAfter
        heldClip = audio
        transcribe()
    }

    /// Stops a recording without sending it, e.g. when NikUI leaves the screen.
    private func holdRecording() {
        voice.sendAfterTranscription = false
        guard recorder.isRecording else { return }
        if let audio = recorder.finish() { heldClip = audio }
    }

    /// Sends the kept recording to the laptop. The clip stays until words come back.
    private func transcribe() {
        guard let audio = heldClip, listeningID == nil else { return }
        guard client.mayControlConversation(conversationID) else { voice.sendAfterTranscription = false; model.show("Transcription needs a live chat connection and control from the laptop.", .warning); return }
        let id = UUID().uuidString
        listeningID = id
        Haptics.tap()
        let scope = client.pairedConnection?.scope
        voice.transcription = Task {
            let result = await client.perform(.voice(id: id, audio: audio), on: .conversation(conversationID))
            guard !Task.isCancelled, scope == client.pairedConnection?.scope, listeningID == id else { return }
            switch result {
            case .accepted(let value):
                model.receiveVoiceText(VoiceText(value), conversationID: conversationID)
                if listeningID == id { listeningID = nil; voice.sendAfterTranscription = false; model.show("No words were returned. Your recording is kept.", .warning) }
            case .notSent(let failure):
                voice.sendAfterTranscription = false
                if listeningID == id { listeningID = nil; model.show(failure.message, .warning) }
            case .ambiguous:
                voice.sendAfterTranscription = false
                if listeningID == id { listeningID = nil; model.show("The laptop did not send back the words. Try again.", .warning) }
            default:
                // Words normally arrive as a separate event; this is the last resort.
                try? await Task.sleep(for: .seconds(30))
                if !Task.isCancelled, listeningID == id { listeningID = nil; model.show("The laptop did not send back the words in time. Try again.", .warning) }
            }
        }
    }

    private var heldClipBar: some View {
        HStack(spacing: 10) {
            Label("Recording kept", systemImage: "waveform").font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Button("Discard", role: .destructive) { heldClip = nil }.frame(minHeight: 44)
            Button("Turn into words") { transcribe() }.frame(minHeight: 44).disabled(!client.mayControlConversation(conversationID))
        }
        .buttonStyle(.bordered).controlSize(.large)
        .padding(.horizontal, 16).padding(.top, 8)
    }


}

private struct PaletteList: View {
    let plan: PalettePlan
    let pick: (Int) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(plan.matches.prefix(40).enumerated()), id: \.element.id) { index, row in
                    Button { pick(index) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: row.kind == "snippet" ? "text.append" : row.kind == "value" ? "checkmark.circle" : "command")
                                .foregroundStyle(.secondary).frame(width: 20)
                            Text(row.kind == "value" ? row.label : "/" + row.value).font(.body.monospaced())
                            Spacer(minLength: 8)
                            if !row.note.isEmpty { Text(row.note).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    Divider().padding(.leading, 46)
                }
            }
        }
        .frame(maxHeight: 240)
        .scrollBounceBehavior(.basedOnSize)
    }
}

/// Turns picked photos into JPEG attachments no larger than the laptop accepts.
enum ImagePrep {
    static let maxBytes = 10 * 1_024 * 1_024

    static func attachment(from data: Data) async -> Attachment? {
        await Task.detached(priority: .userInitiated) { () -> Attachment? in
            guard data.count <= 30 * 1_024 * 1_024,
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceThumbnailMaxPixelSize: 2_048,
                  ] as CFDictionary) else { return nil }
            let image = UIImage(cgImage: cg)
            var side: CGFloat = 2_048
            var quality: CGFloat = 0.85
            for _ in 0..<5 {
                let scaled = scale(image, maxSide: side)
                if let jpeg = scaled.jpegData(compressionQuality: quality), jpeg.count <= maxBytes {
                    return Attachment(.object([
                        "name": .string("photo-\(UUID().uuidString.prefix(8)).jpg"),
                        "mediaType": .string("image/jpeg"),
                        "data": .string(jpeg.base64EncodedString()),
                        "width": .number(Double(scaled.size.width * scaled.scale)),
                        "height": .number(Double(scaled.size.height * scaled.scale)),
                    ]))
                }
                side *= 0.75; quality -= 0.1
            }
            return nil
        }.value
    }

    static func read(_ url: URL) async -> Data? {
        await Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  size <= 30 * 1_024 * 1_024 else { return nil as Data? }
            return try? Data(contentsOf: url, options: .mappedIfSafe)
        }.value
    }

    private static func scale(_ image: UIImage, maxSide: CGFloat) -> UIImage {
        let size = image.size
        let factor = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: (size.width * factor).rounded(), height: (size.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
    }
}
