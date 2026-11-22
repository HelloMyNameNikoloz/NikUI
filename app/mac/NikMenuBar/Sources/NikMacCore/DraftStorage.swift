import Foundation
import CryptoKit
import Darwin
import NikCore
import NikMenuCore
import NikMacIdentity

/// Bytes and metadata are one atomic private document. No source file bookmarks
/// or paths survive import; drafts and pending intents are never evicted here.
public actor MacDraftStore: KeyValueStore {
    public let directory: String
    private var prepared = false
    public init(directory: String) { self.directory = directory }
    private func file(_ key: String) -> String {
        directory + "/" + SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined() + ".json"
    }
    private func prepare() throws {
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try PrivateFiles.directory(directory)
        if !prepared {
            // This actor's startup sweep admits only its exact temporary names
            // and private regular files; symlinks and final documents survive.
            for name in try FileManager.default.contentsOfDirectory(atPath: directory) where name.hasPrefix("draft-") && UUID(uuidString: String(name.dropFirst(6))) != nil {
                let path = directory + "/" + name
                try PrivateFiles.entry(path, kind: S_IFREG, mode: 0o600)
                guard unlink(path) == 0 else { throw IdentityFailure("DRAFT_STORE_UNAVAILABLE") }
            }
            prepared = true
        }
    }
    public func data(forKey key: String) throws -> Data? {
        guard FileManager.default.fileExists(atPath: directory) else { return nil }
        try prepare()
        do { return try PrivateFiles.read(file(key), maximumBytes: 24 * 1024 * 1024) }
        catch MenuFailure.unavailable { return nil }
    }
    public func set(_ data: Data, forKey key: String) throws {
        guard data.count <= 24 * 1024 * 1024 else { throw IdentityFailure("DRAFT_STORE_FULL") }
        try prepare()
        let destination = file(key), temporary = directory + "/draft-" + UUID().uuidString
        defer { _ = unlink(temporary) }
        try PrivateFiles.create(temporary, data: data)
        if FileManager.default.fileExists(atPath: destination) { try PrivateFiles.entry(destination, kind: S_IFREG, mode: 0o600) }
        guard rename(temporary, destination) == 0 else { throw IdentityFailure("DRAFT_STORE_UNAVAILABLE") }
        let fd = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw IdentityFailure("DRAFT_STORE_UNAVAILABLE") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw IdentityFailure("DRAFT_STORE_UNAVAILABLE") }
    }
    public func removeValue(forKey key: String) throws {
        guard FileManager.default.fileExists(atPath: directory) else { return }
        try PrivateFiles.directory(directory)
        do { try PrivateFiles.entry(file(key), kind: S_IFREG, mode: 0o600) }
        catch MenuFailure.unavailable { return }
        guard unlink(file(key)) == 0 else { throw IdentityFailure("DRAFT_STORE_UNAVAILABLE") }
    }
}
