import SwiftUI
import ImageIO
import UIKit
import NikCore

enum Haptics {
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    @MainActor static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    @MainActor static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    @MainActor static func selection() { UISelectionFeedbackGenerator().selectionChanged() }
}

extension FleetRow {
    /// working yellow, finished blue until opened then green, waiting/error red.
    var dot: StatusDot.State {
        if asleep { return .asleep }
        switch status {
        case .working: return .working
        case .waiting: return .waiting
        case .error: return .error
        case .done: return unread ? .unread : .done
        case .stopped: return .stopped
        case .idle, .unknown: return .idle
        }
    }

    /// The state in words, for the second line of a row and for VoiceOver.
    var statusWords: String {
        if asleep { return "Asleep" }
        if paused { return "Paused for quota" }
        switch status {
        case .working: return queued > 0 ? "Working · \(queued) queued" : "Working"
        case .waiting: return "Needs you"
        case .error: return "Error"
        case .done: return unread ? "Finished · new" : "Finished"
        case .stopped: return "Stopped"
        case .idle, .unknown: return "Idle"
        }
    }

    var activeDate: Date? { activeAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

extension ConversationStatus {
    var words: String {
        switch self {
        case .working: "Working"
        case .waiting: "Needs you"
        case .error: "Error"
        case .done: "Finished"
        case .stopped: "Stopped"
        case .idle, .unknown: "Idle"
        }
    }

    var dot: StatusDot.State {
        switch self {
        case .working: .working
        case .waiting: .waiting
        case .error: .error
        case .done: .done
        case .stopped: .stopped
        case .idle, .unknown: .idle
        }
    }
}

extension Provider {
    var name: String {
        switch self {
        case .claude: "Claude"
        case .codex: "Codex"
        case .unknown: "Agent"
        }
    }
    var color: Color {
        switch self {
        case .claude: Theme.claude
        case .codex: Theme.codex
        case .unknown: .secondary
        }
    }
    var symbol: String {
        switch self {
        case .claude: "sparkle"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .unknown: "circle.dashed"
        }
    }
}

struct ProviderMark: View {
    let provider: Provider
    var body: some View {
        Image(systemName: provider.symbol)
            .font(.caption2.weight(.bold))
            .foregroundStyle(provider.color)
            .frame(width: 22, height: 22)
            .background(provider.color.opacity(0.14), in: .circle)
            .accessibilityLabel(provider.name)
    }
}

extension ConnectionState {
    var words: String {
        switch self {
        case .idle: "Not connected"
        case .connecting: "Connecting…"
        case .authenticating: "Checking the laptop…"
        case .live: "Connected"
        case .reconnecting(let attempt, _): attempt > 2 ? "Reconnecting (try \(attempt))…" : "Reconnecting…"
        case .offline: "Offline"
        case .refused(let why): why.isEmpty ? "The laptop refused this iPhone" : why
        case .wrongLaptop: "This is not the paired laptop"
        case .failed(let failure): failure.message
        }
    }
    var isTrouble: Bool {
        switch self {
        case .refused, .wrongLaptop, .failed: true
        default: false
        }
    }
}

/// A scoped connection failure stays visible even while fleet is healthy.
struct ConnectionStrip: View {
    var conversationID: String? = nil
    @Environment(NikClient.self) private var client
    @Environment(AppModel.self) private var model

    private var connection: ConnectionState {
        conversationID.map { client.conversation($0).connection } ?? client.connection
    }

    var body: some View {
        if !connection.isLive && !client.isPreview {
            HStack(spacing: 8) {
                if connecting { ProgressView().controlSize(.mini) }
                else { Image(systemName: connection.isTrouble ? "exclamationmark.triangle.fill" : "wifi.slash") }
                Text(conversationID == nil ? connection.words : "Chat: \(connection.words)")
                Spacer(minLength: 0)
                if case .refused = connection {
                    Button { model.showPairing = true } label: { Text("Pair again").frame(minWidth: 44, minHeight: 44) }.buttonStyle(.borderless)
                } else if !connecting, connection != .wrongLaptop {
                    Button { Task { await model.retryConnection() } } label: { Text("Retry").frame(minWidth: 44, minHeight: 44) }.buttonStyle(.borderless)
                }
            }
            .font(.footnote)
            .foregroundStyle(connection.isTrouble ? Theme.needsYou : .secondary)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(.bar)
            .accessibilityElement(children: .combine)
        }
    }

    private var connecting: Bool {
        switch connection {
        case .connecting, .authenticating, .reconnecting: true
        default: false
        }
    }
}

/// "3 min ago", refreshing on its own.
struct RelativeTime: View {
    let date: Date
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(Self.format(date, now: context.date))
        }
    }
    static func format(_ date: Date, now: Date = .now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 45 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60)) min" }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if seconds < 6 * 86400 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.day().month(.abbreviated))
    }
}

enum Format {
    static func duration(ms: Double) -> String {
        let s = Int(ms / 1000)
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }
    static func cost(_ usd: Double) -> String { usd.formatted(.currency(code: "USD").precision(.fractionLength(usd < 10 ? 2 : 0))) }
    static func tokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 10_000 { return "\(n / 1000)k" }
        if n >= 1000 { return String(format: "%.1fk", Double(n) / 1000) }
        return "\(n)"
    }
    static func percent(_ fraction: Double) -> String { fraction.formatted(.percent.precision(.fractionLength(0))) }
    static func shortPath(_ path: String, home: String? = nil) -> String {
        if let home, !home.isEmpty, path.hasPrefix(home) { return "~" + path.dropFirst(home.count) }
        if let range = path.range(of: #"^/Users/[^/]+"#, options: .regularExpression) { return "~" + path[range.upperBound...] }
        return path
    }
}

/// A placeholder that explains itself, with an optional action.
struct EmptyState: View {
    let title: String
    let symbol: String
    var message: String? = nil
    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            if let message { Text(message) }
        }
    }
}

extension View {
    func readingFont(_ style: Font.TextStyle = .body, monospaced: Bool = false) -> some View {
        modifier(ReadingFont(style: style, monospaced: monospaced))
    }
    /// Disables a control when this iPhone may only watch, and says why.
    func needsControl(_ allowed: Bool) -> some View {
        disabled(!allowed).accessibilityHint(allowed ? "" : "This iPhone can only watch.")
    }
}

/// The app's reading preference adjusts a scalable base, never the system's size category.
private struct ReadingFont: ViewModifier {
    let style: Font.TextStyle
    let monospaced: Bool
    @Environment(NikClient.self) private var client
    @ScaledMetric private var size: CGFloat

    init(style: Font.TextStyle, monospaced: Bool) {
        self.style = style; self.monospaced = monospaced
        _size = ScaledMetric(wrappedValue: style == .footnote ? 13 : 17, relativeTo: style)
    }
    func body(content: Content) -> some View {
        let factor: CGFloat = client.preferences.textSize == "small" ? 14 / 17 : client.preferences.textSize == "large" ? 19 / 17 : 1
        content.font(.system(size: size * factor, design: monospaced ? .monospaced : .default))
    }
}

/// Attachment helper: images arrive as base64 `data` (optionally a data: URL).
extension Attachment {
    /// The decoded bytes, or nil for an empty or malformed payload.
    var bytes: Data? {
        var base64 = Substring(data)
        if base64.hasPrefix("data:") {
            guard let comma = base64.firstIndex(of: ",") else { return nil }
            base64 = base64[base64.index(after: comma)...]
        }
        guard !base64.isEmpty, base64.utf8.count <= 28 * 1_024 * 1_024,
              let data = Data(base64Encoded: String(base64)), !data.isEmpty else { return nil }
        return data
    }
}

/// Decodes attachment images off the main thread, downsampled, and keeps a
/// bounded cache that is dropped on memory warnings.
@MainActor enum ImageStore {
    private static var generation = 0
    static func clear() { generation &+= 1; cache.removeAllObjects() }
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 64 * 1_024 * 1_024
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ImageStore.clear() }
        }
        return cache
    }()

    static func image(_ attachment: Attachment, maxPixels: CGFloat) async -> UIImage? {
        let generation = Self.generation
        // Hash the complete payload off-main. Equal headers, tails and byte counts
        // are common for different images and cannot identify cached pixels.
        let digest = await Task.detached(priority: .userInitiated) {
            NikCrypto.fingerprint(Data(attachment.data.utf8))
        }.value
        guard !Task.isCancelled, generation == Self.generation else { return nil }
        let key = "\(digest)@\(Int(maxPixels))" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let payload = attachment
        let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let data = payload.bytes, let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            ]
            return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
        }.value
        guard !Task.isCancelled, generation == Self.generation else { return nil }
        if let image, let cg = image.cgImage { cache.setObject(image, forKey: key, cost: cg.bytesPerRow * cg.height) }
        return image
    }
}

/// A pinch-to-zoom, pannable image backed by UIScrollView.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    var label = "Image"

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 6
        scroll.showsHorizontalScrollIndicator = false; scroll.showsVerticalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        let view = UIImageView(image: image)
        view.contentMode = .scaleAspectFit
        view.isAccessibilityElement = true
        view.accessibilityLabel = label
        view.accessibilityTraits = .image
        view.frame = scroll.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(view)
        context.coordinator.imageView = view
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(tap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        context.coordinator.imageView?.image = image
        context.coordinator.imageView?.accessibilityLabel = label
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var imageView: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = gesture.view as? UIScrollView else { return }
            let animated = !UIAccessibility.isReduceMotionEnabled
            if scroll.zoomScale > 1 { scroll.setZoomScale(1, animated: animated); return }
            let point = gesture.location(in: imageView)
            let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
            scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: animated)
        }
    }
}


/// The stable item ID chooses a lazy scroll target; this handle restores the
/// offset within a long item after SwiftUI has laid that target out.
@MainActor final class ReadingViewport {
    weak var scrollView: UIScrollView?
    private var observation: NSKeyValueObservation?
    private var initialOffset: Double?
    private var onScroll: ((Double) -> Void)?

    func remember(offset: Double, onScroll: @escaping (Double) -> Void) {
        initialOffset = offset; self.onScroll = onScroll
        if let scrollView { observe(scrollView) }
    }
    func resolve(_ scroll: UIScrollView) {
        guard scrollView !== scroll else { return }
        scrollView = scroll
        if onScroll != nil { observe(scroll) }
    }
    private func observe(_ scroll: UIScrollView) {
        observation?.invalidate()
        if let offset = initialOffset {
            initialOffset = nil
            DispatchQueue.main.async { [weak self, weak scroll] in
                guard let self, let scroll else { return }
                let lower = -scroll.adjustedContentInset.top
                let upper = max(lower, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(upper, max(lower, CGFloat(offset)))), animated: false)
                self.onScroll?(scroll.contentOffset.y)
            }
        }
        observation = scroll.observe(\.contentOffset, options: [.new]) { [weak self] scroll, _ in
            MainActor.assumeIsolated { self?.onScroll?(scroll.contentOffset.y) }
        }
    }
    func restore(offset: Double, observedY: CGFloat) {
        guard let scroll = scrollView else { return }
        let lower = -scroll.adjustedContentInset.top
        let upper = max(lower, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let target = scroll.contentOffset.y + observedY - CGFloat(offset)
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(upper, max(lower, target))), animated: false)
    }
}

struct ReadingViewportProbe: UIViewRepresentable {
    let viewport: ReadingViewport
    func makeUIView(context: Context) -> Probe { Probe(viewport: viewport) }
    func updateUIView(_ view: Probe, context: Context) { view.resolve() }
    final class Probe: UIView {
        let viewport: ReadingViewport
        init(viewport: ReadingViewport) { self.viewport = viewport; super.init(frame: .zero); isUserInteractionEnabled = false; isAccessibilityElement = false }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); resolve() }
        func resolve() {
            var ancestor = superview
            while let view = ancestor {
                if let scroll = view as? UIScrollView { viewport.resolve(scroll); return }
                ancestor = view.superview
            }
        }
    }
}

struct ReadingGeometry: Equatable {
    let offset: CGFloat
    let extent: CGFloat
    let bottom: Bool
    init(_ geometry: ScrollGeometry) {
        offset = geometry.contentOffset.y
        extent = geometry.contentSize.height
        bottom = geometry.visibleRect.maxY >= geometry.contentSize.height - 60
    }
}
