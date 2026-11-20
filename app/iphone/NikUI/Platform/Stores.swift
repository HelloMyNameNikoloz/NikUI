import Foundation
import Security
import NikCore

/// Pairing identity, PIN record: Keychain items that never leave this device
/// and are readable only while it is unlocked.
struct KeychainStore: KeyValueStore {
    let service: String
    init(service: String = "com.nikoloz.nikui") { self.service = service }

    func data(forKey key: String) async throws -> Data? { try read(key) }
    func set(_ data: Data, forKey key: String) async throws { try write(data, key) }
    func removeValue(forKey key: String) async throws { try remove(key) }

    private func base(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    func read(_ key: String) throws -> Data? {
        var query = base(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        try check(status, operation: "read")
        guard let data = out as? Data else { throw CoreFailure(.keychain, "The Keychain record is unreadable. It was not replaced.") }
        return data
    }

    func write(_ data: Data, _ key: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        var status = SecItemUpdate(base(key) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(base(key).merging(attributes) { $1 } as CFDictionary, nil)
        }
        try check(status, operation: "write")
    }

    func remove(_ key: String) throws {
        let status = SecItemDelete(base(key) as CFDictionary)
        if status != errSecItemNotFound { try check(status, operation: "delete") }
    }

    private func check(_ status: OSStatus, operation: String) throws {
        switch status {
        case errSecSuccess: return
        case errSecInteractionNotAllowed:
            throw CoreFailure(.locked, "Unlock the iPhone and try again. The Keychain is currently locked.")
        case errSecMissingEntitlement:
            throw CoreFailure(.noEntitlement, "This build cannot access its Keychain. Check its signing and entitlements; saved records were preserved.")
        default:
            throw CoreFailure(.keychain, "Keychain \(operation) failed (\(status)). Saved records were preserved; try again.")
        }
    }
}

/// Drafts, the last fleet, preferences: small files in Application Support,
/// protected while the phone is locked, including the containing directory.
actor FileStore: KeyValueStore {
    private let directory: URL
    private var prepared = false

    init(name: String = "NikUI") {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = root.appending(path: name, directoryHint: .isDirectory)
    }

    private func url(_ key: String) -> URL {
        directory.appending(path: NikCrypto.base64URL(Data(key.utf8)), directoryHint: .notDirectory)
    }

    func data(forKey key: String) throws -> Data? {
        try prepare()
        let url = url(key)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do { return try Data(contentsOf: url) } catch { throw CoreFailure(.persistence, error.localizedDescription) }
    }

    func set(_ data: Data, forKey key: String) throws {
        try prepare()
        do {
            try data.write(to: url(key), options: [.atomic, .completeFileProtection])
            try protect(url(key))
        }
        catch { throw CoreFailure(.persistence, error.localizedDescription) }
    }

    func removeValue(forKey key: String) throws {
        do { try FileManager.default.removeItem(at: url(key)) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { return }
        catch { throw CoreFailure(.persistence, "Saved laptop data could not be removed. Try forgetting again. \(error.localizedDescription)") }
    }

    /// Recovery when an unreadable pairing pointer cannot identify its scope.
    /// Preferences are intentionally outside this namespace.
    func removeScopedCaches() throws {
        do {
            let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            for file in files {
                guard let data = try? NikCrypto.decodeBase64URL(file.lastPathComponent),
                      let key = String(data: data, encoding: .utf8), key.hasPrefix("nikui.cache.v1:") else { continue }
                try removeValue(forKey: key)
            }
        } catch let error as CocoaError where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile { return }
        catch { throw CoreFailure(.persistence, "The saved laptop caches could not be removed. The identity was preserved; try forgetting again. \(error.localizedDescription)") }
    }

    private func protect(_ location: URL) throws {
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: location.path)
        var location = location
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try location.setResourceValues(values)
    }

    private func prepare() throws {
        guard !prepared else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.protectionKey: FileProtectionType.complete])
            try protect(directory)
            // Upgrade existing class-C files in place, retaining their keys and
            // leaving no less-protected migration copies behind.
            for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
                try protect(file)
            }
            prepared = true
        } catch { throw CoreFailure(.persistence, "Protected local storage is unavailable. Unlock the iPhone and retry. \(error.localizedDescription)") }
    }
}
