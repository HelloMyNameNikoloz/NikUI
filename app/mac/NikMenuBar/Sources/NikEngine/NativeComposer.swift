import SwiftUI
import AppKit
import NikMacCore

/// TextKit owns marked text/caret. SwiftUI never replaces a marked composition.
struct NativeComposer: NSViewRepresentable {
    @Binding var text: String
    let enabled: Bool
    let attach: ([MacImageSource]) -> Void
    var attachmentProblem: (String) -> Void = { _ in }
    let send: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.borderType = .noBorder
        let editor = ComposerTextView()
        editor.delegate = context.coordinator; editor.send = send; editor.attach = attach
        editor.attachmentProblem = attachmentProblem
        editor.registerForDraggedTypes([.fileURL, .png, .tiff])
        editor.isRichText = false; editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false; editor.allowsUndo = true
        editor.font = .systemFont(ofSize: 15); editor.textContainerInset = NSSize(width: 10, height: 12)
        editor.minSize = NSSize(width: 0, height: 90)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.isVerticallyResizable = true; editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.setAccessibilityLabel("Message"); editor.setAccessibilityIdentifier("nikui.composer")
        editor.string = text; scroll.documentView = editor
        return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let editor = scroll.documentView as? ComposerTextView else { return }
        editor.isEditable = enabled; editor.send = send; editor.attach = attach
        editor.attachmentProblem = attachmentProblem
        guard !editor.hasMarkedText(), editor.string != text else { return }
        let selection = editor.selectedRange()
        editor.string = text; editor.setSelectedRange(NSRange(location: min(selection.location, editor.string.utf16.count), length: 0))
    }
    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeComposer
        init(_ parent: NativeComposer) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NSTextView else { return }
            parent.text = editor.string
        }
    }
}
@MainActor private final class ComposerTextView: NSTextView {
    var send: (() -> Void)?
    var attach: (([MacImageSource]) -> Void)?
    var attachmentProblem: ((String) -> Void)?
    private func importImages(_ pasteboard: NSPasteboard) -> Bool {
        guard isEditable else { return false }
        do {
            let sources = try MacImageAttachments.pasteboardSources(pasteboard)
            guard !sources.isEmpty else { return false }
            attach?(sources); return true
        } catch { attachmentProblem?(MacAppSession.code(error)); return true }
    }
    override func paste(_ sender: Any?) { if !importImages(.general) { super.paste(sender) } }
    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        if isEditable && sender.draggingPasteboard.availableType(from: [.fileURL, .png, .tiff]) != nil { return .copy }
        return super.draggingEntered(sender)
    }
    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        if importImages(sender.draggingPasteboard) { return true }; return super.performDragOperation(sender)
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36, event.modifierFlags.intersection([.command, .shift, .option, .control]) == .command, !hasMarkedText() {
            if isEditable { send?() }; return
        }
        super.keyDown(with: event)
    }
}
