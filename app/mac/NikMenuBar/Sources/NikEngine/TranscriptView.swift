import SwiftUI
import AppKit
import WebKit
import NikCore
import NikMacCore

struct MacTranscript: NSViewRepresentable {
    @AppStorage("nikui.appearance") private var appearance = "system"
    @AppStorage("nikui.reading.fontSize") private var fontSize = 15.0
    @AppStorage("nikui.reading.width") private var readingWidth = 840.0
    @AppStorage("nikui.reading.thinking") private var showThinking = true
    let state: ConversationState
    let reading: ReadingState
    let find: MacTranscriptFindState
    let onReading: (ReadingState) -> Void
    let onRendered: (String, Set<String>, Set<String>) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(BundledTranscriptResources(), forURLScheme: "nikui-bundle")
        config.userContentController.add(context.coordinator, name: "nikTranscript")
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = view
        view.load(URLRequest(url: URL(string: "nikui-bundle://transcript/mac-transcript.html")!))
        view.setAccessibilityLabel("Conversation transcript")
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) { context.coordinator.parent = self; context.coordinator.render() }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "nikTranscript")
        view.stopLoading(); coordinator.webView = nil
    }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: MacTranscript
        weak var webView: WKWebView?
        var paint = TranscriptPaintState()
        init(_ parent: MacTranscript) { self.parent = parent }
        func render() {
            guard paint.ready, let webView else { return }
            var snapshot = TranscriptResources.snapshot(parent.state, reading: parent.reading)
            snapshot["find"] = parent.find.snapshot
            snapshot["appearance"] = .string(parent.appearance)
            snapshot["fontSize"] = .number(parent.fontSize); snapshot["readingWidth"] = .number(parent.readingWidth)
            snapshot["showThinking"] = .bool(parent.showThinking && parent.state.configuration.showThinking)
            guard let bytes = try? snapshot.encoded(),
                  let object = try? JSONSerialization.jsonObject(with: bytes) else { return }
            guard let generation = paint.begin(snapshot) else { return }
            webView.callAsyncJavaScript("return window.NikMacTranscript.update(snapshot)", arguments: ["snapshot": object], in: nil, in: .page) { [weak self] result in
                guard let self, generation == self.paint.generation else { return }
                switch result {
                case .failure: self.paint.failed(generation: generation)
                case .success(let result):
                    guard let value = result as? [String: Any], let conversation = value["conversationID"] as? String,
                          conversation == self.parent.state.id, let ids = value["itemIDs"] as? [String], let streaming = value["streamingIDs"] as? [String] else { return }
                    self.parent.onRendered(conversation, Set(ids), Set(streaming))
                    if let raw = value["find"], let bytes = try? JSONSerialization.data(withJSONObject: raw), let found = try? JSONValue.decode(bytes) { self.parent.find.receive(found) }
                }
            }
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "nikTranscript", message.frameInfo.isMainFrame,
                  let source = message.frameInfo.request.url, TranscriptResources.resourceName(source) == "mac-transcript.html",
                  let bytes = try? JSONSerialization.data(withJSONObject: message.body), let raw = try? JSONValue.decode(bytes),
                  let event = try? TranscriptBridgeMessage(raw, conversationID: parent.state.id, itemIDs: Set(parent.state.items.map(\.id))) else { return }
            switch event {
            case .ready: paint.documentReady(); render()
            case .externalURL(let url): NSWorkspace.shared.open(url)
            case .reading(_, let anchor, let offset, let follows):
                var reading = parent.reading; reading.anchorID = anchor; reading.offset = offset; reading.followsLatest = follows; parent.onReading(reading)
            }
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            paint.reset(); webView.reload()
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if TranscriptResources.allowsNavigation(url, type: navigationAction.navigationType, mainFrame: navigationAction.targetFrame?.isMainFrame == true) {
                decisionHandler(.allow); return
            }
            if navigationAction.navigationType == .linkActivated, TranscriptBridgeMessage.isExternal(url) { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
}
private final class BundledTranscriptResources: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, let name = TranscriptResources.resourceName(url),
              let media = Bundle.main.resourceURL?.appendingPathComponent("engine/media", isDirectory: true),
              let data = try? Data(contentsOf: media.appendingPathComponent(name)) else {
            urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile)); return
        }
        let mime = name.hasSuffix(".html") ? "text/html" : name.hasSuffix(".css") ? "text/css" : "application/javascript"
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}
