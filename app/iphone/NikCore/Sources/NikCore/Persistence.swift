import Foundation
import CryptoKit

/// Atomic, hashed-name Codable/blob storage. On iOS both directory and files use protection complete.
public actor ProtectedFileStore: KeyValueStore {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    private func file(_ key: String) -> URL { directory.appendingPathComponent(SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()).appendingPathExtension("json") }
    private func prepare() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        #endif
    }
    public func data(forKey key: String) throws -> Data? {
        let url = file(key); guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url)
    }
    public func set(_ data: Data, forKey key: String) throws {
        try prepare()
        #if os(iOS)
        try data.write(to: file(key), options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file(key), options: .atomic)
        #endif
    }
    public func removeValue(forKey key: String) throws {
        let url = file(key); if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}
public struct DraftLimits: Sendable, Equatable {
    public var maximumCount = 64
    public var maximumTextBytes = 128 * 1024
    public var maximumAttachmentBytes = 10 * 1024 * 1024
    public var maximumTotalBytes = 24 * 1024 * 1024
    public init() {}
}
public struct PersistedUIState: Sendable, Codable, Equatable {
    public var fleet = Fleet()
    public var drafts: [String: Draft] = [:]
    public var slackDrafts: [SlackThreadID: Draft] = [:]
    public var prDrafts: [String: [String: String]] = [:]
    public var prDraftsByURL: [String: [String: [String: String]]]?
    public var terminalDrafts: [String: String] = [:]
    public init() {}
    /// Keeps the newest drafts within the retention budget; no transcripts, reports, terminal output or Slack messages.
    public func bounded(limits: DraftLimits = DraftLimits()) throws -> PersistedUIState {
        var value = self
        for draft in Array(drafts.values) + Array(slackDrafts.values) {
            guard draft.text.utf8.count <= limits.maximumTextBytes else { throw CoreFailure(.tooLarge, "A draft exceeds the protected storage limit.") }
            for image in draft.attachments {
                guard let data = Data(base64Encoded: image.data), data.count <= limits.maximumAttachmentBytes else { throw CoreFailure(.tooLarge, "A draft image exceeds the protected storage limit.") }
            }
        }
        value.drafts = Dictionary(uniqueKeysWithValues: drafts.sorted { $0.value.updatedAt > $1.value.updatedAt }.prefix(max(0, limits.maximumCount)).map { ($0.key, $0.value) })
        value.slackDrafts = Dictionary(uniqueKeysWithValues: slackDrafts.sorted { $0.value.updatedAt > $1.value.updatedAt }.prefix(max(0, limits.maximumCount)).map { ($0.key, $0.value) })
        value.prDrafts = Dictionary(uniqueKeysWithValues: prDrafts.sorted { $0.key < $1.key }.prefix(max(0, limits.maximumCount)).map { ($0.key, $0.value) })
        value.prDraftsByURL = prDraftsByURL.map { Dictionary(uniqueKeysWithValues: $0.sorted { $0.key < $1.key }.prefix(max(0, limits.maximumCount)).map { ($0.key, $0.value) }) }
        value.terminalDrafts = Dictionary(uniqueKeysWithValues: terminalDrafts.sorted { $0.key < $1.key }.prefix(max(0, limits.maximumCount)).map { ($0.key, $0.value) })
        while try WireCoding.encode(value).count > limits.maximumTotalBytes {
            if let oldest = value.drafts.min(by: { $0.value.updatedAt < $1.value.updatedAt })?.key { value.drafts.removeValue(forKey: oldest) }
            else if let oldest = value.slackDrafts.min(by: { $0.value.updatedAt < $1.value.updatedAt })?.key { value.slackDrafts.removeValue(forKey: oldest) }
            else if let key = value.prDrafts.keys.sorted().first { value.prDrafts.removeValue(forKey: key) }
            else if let key = value.prDraftsByURL?.keys.sorted().first { value.prDraftsByURL?.removeValue(forKey: key) }
            else if let key = value.terminalDrafts.keys.sorted().first { value.terminalDrafts.removeValue(forKey: key) }
            else { throw CoreFailure(.tooLarge, "The fleet cache exceeds the protected storage limit.") }
        }
        return value
    }
}
/// Chains writes so a slow previous save cannot overwrite newer drafts or resurrect a forgotten scope.
public actor CacheRepository {
    private let store: any KeyValueStore
    private var tail: Task<Void, any Error>?
    public init(store: any KeyValueStore) { self.store = store }
    public func load(scope: String) async throws -> PersistedUIState? {
        try await tail?.value
        guard let data = try await store.data(forKey: "nikui.cache.v1:" + scope) else { return nil }
        guard data.count <= 24 * 1024 * 1024 else { throw CoreFailure(.persistence, "The protected cache is too large.") }
        return try JSONDecoder().decode(PersistedUIState.self, from: data)
    }
    public func save(_ value: PersistedUIState, scope: String) async throws {
        let data = try WireCoding.encode(value.bounded()); let previous = tail; let store = store
        let task = Task { _ = try? await previous?.value; try await store.set(data, forKey: "nikui.cache.v1:" + scope) }
        tail = task; try await task.value
    }
    public func remove(scope: String) async throws {
        let previous = tail; let store = store
        let task = Task { _ = try? await previous?.value; try await store.removeValue(forKey: "nikui.cache.v1:" + scope) }
        tail = task; try await task.value
    }
}
