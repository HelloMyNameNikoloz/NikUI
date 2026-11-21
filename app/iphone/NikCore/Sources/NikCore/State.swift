import Foundation

/// Response freshness is independent of socket readiness and of whether values changed.
public struct SnapshotStatus: Sendable, Equatable {
    public var requestedAt: Date?
    public var receivedAt: Date?
    public var revision: UInt64 = 0
    public var error: String?
    public var isLoading: Bool { requestedAt != nil }
    public init() {}
    mutating func begin(at now: Date) { requestedAt = now; error = nil }
    mutating func receive(at now: Date) { requestedAt = nil; receivedAt = now; revision &+= 1; error = nil }
}

public struct PairingInvitation: Sendable, Equatable {
    public var baseURL: URL
    public var code: String
    public var fingerprint: String?
    public var laptopName: String?
    public init(baseURL: URL, code: String, fingerprint: String? = nil, laptopName: String? = nil) {
        self.baseURL = baseURL; self.code = code; self.fingerprint = fingerprint; self.laptopName = laptopName
    }
}
public struct PairedConnection: Sendable, Codable, Equatable {
    public var deviceID: String
    public var baseURL: URL
    public var laptopName: String
    public var serverSPKI: Data
    public var fingerprint: String
    public var keyID: String
    public var publicSPKI: Data
    public var protection: KeyProtection
    public var pairedAt: Date
    public init(deviceID: String, baseURL: URL, laptopName: String, serverSPKI: Data, fingerprint: String, keyID: String, publicSPKI: Data, protection: KeyProtection, pairedAt: Date = Date()) {
        self.deviceID = deviceID; self.baseURL = baseURL; self.laptopName = laptopName; self.serverSPKI = serverSPKI
        self.fingerprint = fingerprint; self.keyID = keyID; self.publicSPKI = publicSPKI; self.protection = protection; self.pairedAt = pairedAt
    }
    /// Cache/draft namespace changes when either laptop or device identity changes.
    public var scope: String { fingerprint + ":" + deviceID }
}
public enum PairingResult: Sendable, Equatable { case paired(PairedConnection), failed(CoreFailure) }
public struct Draft: Sendable, Codable, Equatable {
    public var text: String
    public var attachments: [Attachment]
    public var delivery: DeliveryState
    public var updatedAt: Date
    public var answerTo: QuestionRef?
    public var sent: String?
    public var snippets: [String]?
    public var compositionID: String?
    public init(text: String = "", attachments: [Attachment] = [], delivery: DeliveryState = .draft, updatedAt: Date = Date(), answerTo: QuestionRef? = nil, sent: String? = nil, snippets: [String]? = nil) {
        self.text = text; self.attachments = attachments; self.delivery = delivery; self.updatedAt = updatedAt
        self.answerTo = answerTo; self.sent = sent; self.snippets = snippets
        compositionID = V2Wire.randomID()
    }
}
public struct ReadingState: Sendable, Equatable {
    public var anchorID: String?
    public var offset: Double = 0
    public var followsLatest = true
    public var expandedItemIDs: Set<String> = []
    public var findQuery = ""
    public var selectedMatch: String?
    public init() {}
}
public struct ReportState: Sendable, Equatable {
    public var report: Report?
    public var available = true
    public var trouble: String?
    public var receivedAt: Date?
    public var isStale = true
    public var expandedSections: Set<String> = []
    public var disclosuresInitialized = false
    public var revision: UInt64 = 0
    public init() {}
}
public struct PRFeatureState: Sendable, Equatable {
    public var snapshot: PRSnapshot?
    public var url = ""
    public var loading = false
    public var error: String?
    public var diff: String?
    public var diffTruncated = false
    public var mentions: PRMentions?
    public var mentionQuery = ""
    public var drafts: [String: String] = [:]
    public var draftsByURL: [String: [String: String]] = [:]
    public var tabsByURL: [String: String] = [:]
    public var pending: PendingOperation?
    public var tab = "conversation"
    public var draftRevision = UUID().uuidString
    public init() {}
}
public struct ConversationState: Sendable, Equatable, Identifiable {
    public let id: String
    public var clientID: String?
    public var items: [TranscriptItem] = []
    public var meta = ConversationMeta()
    public var status: ConversationStatus = .idle
    public var run: RunRef?
    public var controlSnapshotFresh = false
    public var activeQuestion: QuestionRef? {
        guard status == .waiting else { return nil }
        return items.last(where: { $0.answerTo?.run == run && $0.answerTo != nil && $0.resolved == nil })?.answerTo
    }
    public var stats = Stats()
    public var statsReceivedAt: Date?
    public var configuration = RenderConfiguration()
    public var queue: [QueueEntry] = []
    public var drainAt: Date?
    public var dropped = 0
    public var maxItems = 400
    public var presence: [PresenceClient] = []
    public var draft = Draft()
    public var reading = ReadingState()
    public var report = ReportState()
    public var settings = SettingsSnapshot()
    public var commands = CommandsSnapshot()
    public var pr = PRFeatureState()
    public var connection: ConnectionState = .idle
    public var initialized = false
    public var editPromptRevision: UInt64 = 0
    public init(id: String) { self.id = id }
    public var permissions: [TranscriptItem] { items.filter { $0.kind == "permission" && $0.resolved == nil } }
}
public struct TerminalState: Sendable, Equatable {
    public var terminals: [TerminalDescriptor] = []
    public var selectedID: String?
    public var runsByTerminal: [String: [TerminalRun]] = [:]
    public var drafts: [String: String] = [:]
    public var error: String?
    public var pending: PendingOperation?
    public var freshControlIDs: Set<String> = []
    public init() {}
    public var selected: TerminalDescriptor? { terminals.first { $0.id == selectedID } }
    public var runs: [TerminalRun] { selectedID.flatMap { runsByTerminal[$0] } ?? [] }
}
public struct SlackThreadID: Sendable, Hashable, Codable {
    public var conversation: String
    public var thread: String?
    public init(conversation: String, thread: String? = nil) { self.conversation = conversation; self.thread = thread }
}
public struct SlackThreadState: Sendable, Equatable {
    public var conversation = SlackConversation()
    public var messages: [SlackMessage] = []
    public var hasMore = false
    public var draft = Draft()
    public var pending: PendingOperation?
    public var error: String?
    public init() {}
}
public struct SlackFeatureState: Sendable, Equatable {
    public var state = SlackState()
    public var selection: SlackThreadID?
    public var threads: [SlackThreadID: SlackThreadState] = [:]
    public var files: [String: String] = [:]
    public var fileErrors: [String: String] = [:]
    public var error: String?
    public init() {}
    public var selectedThread: SlackThreadState? { selection.flatMap { threads[$0] } }
}
public enum NotificationKind: String, CaseIterable, Codable, Sendable { case needsYou = "needs-you", failed, quota, ci, turnFinished = "turn-finished", slack }
public struct NotificationPreferences: Sendable, Codable, Equatable {
    public var on = false
    public var enabledKinds: Set<NotificationKind> = Set(NotificationKind.allCases)
    public var showPreviews = true
    public init() {}
}
public struct LocalPreferences: Sendable, Codable, Equatable {
    public var appearance = "system"
    public var textSize = "default"
    public var notifications = NotificationPreferences()
    public init() {}
}
public struct FeatureVisibility: Sendable, Equatable {
    public var report = false
    public var settings = false
    public var commands = false
    public var pr = false
    public var terminal = false
    public var slack = false
    public init() {}
}
public enum CoreEvent: Sendable, Equatable {
    case connection(SocketRole, ConnectionState), server(SocketRole, ServerEvent), intent(LocalIntent)
    case notification(NotificationEvent), failure(CoreFailure)
}
