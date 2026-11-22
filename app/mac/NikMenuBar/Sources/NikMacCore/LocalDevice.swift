import Foundation
import CryptoKit
import Security
import NikCore
import NikMenuCore
import NikMacIdentity

public enum LocalDeviceNamespace {
    public static func service(_ selection: AppSelection) -> String {
        if selection.flavour == .production { return "com.nikui.app.local-device.v1" }
        let hash = SHA256.hash(data: Data(selection.home.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return "com.nikui.app.test.\(hash).local-device.v1"
    }
}

/// Every query contains the exact service and account. No engine items, broad
/// enumeration, ACL changes, file/memory fallback, or silent replacement.
public actor LocalDeviceKeychain: KeyValueStore {
    public let service: String
    public init(selection: AppSelection) { service = LocalDeviceNamespace.service(selection) }
    // Match the established Mac file-Keychain policy: no access group or
    // provisioning profile, and the creating signed app retains its default
    // ACL. The real account login Keychain is independent of the dev HOME.
    private static func selectedKeychain() throws -> SecKeychain {
        let login = try BuildFlavour.accountHome() + "/Library/Keychains/login.keychain-db"
        var keychain: SecKeychain?
        let opened = SecKeychainOpen(login, &keychain)
        guard opened == errSecSuccess, let keychain else { throw failure(opened) }
        let interaction = SecKeychainSetUserInteractionAllowed(false)
        guard interaction == errSecSuccess else { throw failure(interaction) }
        var status: SecKeychainStatus = 0
        let inspected = SecKeychainGetStatus(keychain, &status)
        guard inspected == errSecSuccess else { throw failure(inspected) }
        guard status & kSecUnlockStateStatus != 0 else { throw IdentityFailure("KEYCHAIN_LOCKED") }
        return keychain
    }
    private func query(_ key: String) throws -> [String: Any] {
        guard ["device-key.v1", PairingService.pairingKey, "engine-id.v1"].contains(key) else { throw IdentityFailure("KEYCHAIN_NAMESPACE") }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: key, kSecMatchSearchList as String: [try Self.selectedKeychain()]]
    }
    private static func failure(_ status: OSStatus) -> IdentityFailure {
        switch status {
        case errSecInteractionNotAllowed, errSecInteractionRequired: IdentityFailure("KEYCHAIN_DENIED")
        case errSecAuthFailed, errSecUserCanceled, errSecMissingEntitlement, 100001: IdentityFailure("KEYCHAIN_DENIED")
        case errSecDecode: IdentityFailure("KEYCHAIN_CORRUPT")
        default: IdentityFailure("KEYCHAIN_UNAVAILABLE")
        }
    }
    public func data(forKey key: String) throws -> Data? {
        var q = try query(key); q[kSecReturnData as String] = true; q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Self.failure(status) }
        guard let attributes = result as? [String: Any], attributes[kSecAttrService as String] as? String == service,
              attributes[kSecAttrAccount as String] as? String == key,
              let bytes = attributes[kSecValueData as String] as? Data, bytes.count <= 65536 else { throw IdentityFailure("KEYCHAIN_CORRUPT") }
        return bytes
    }
    public func set(_ data: Data, forKey key: String) throws {
        guard data.count <= 65536 else { throw IdentityFailure("KEYCHAIN_CORRUPT") }
        let q = try query(key)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            guard let keychain = (q[kSecMatchSearchList as String] as? [SecKeychain])?.first else { throw IdentityFailure("KEYCHAIN_UNAVAILABLE") }
            var add = q; add[kSecValueData as String] = data
            add[kSecUseKeychain as String] = keychain
            add.removeValue(forKey: kSecMatchSearchList as String)
            let created = SecItemAdd(add as CFDictionary, nil)
            guard created == errSecSuccess else { throw Self.failure(created) }
        } else if status != errSecSuccess { throw Self.failure(status) }
    }
    public func removeValue(forKey key: String) throws {
        let status = SecItemDelete(try query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure(status) }
    }
    public static func deleteTestSelection(_ selection: AppSelection) throws {
        #if NIKUI_PRODUCTION
        throw IdentityFailure("DEVELOPMENT_PROFILE_ONLY")
        #else
        guard selection.flavour == .development, selection.home.hasPrefix(BuildFlavour.testBase + "/") else { throw IdentityFailure("DEVELOPMENT_PROFILE_ONLY") }
        try selection.validateExistingRoot()
        let keychain = try selectedKeychain()
        for key in ["device-key.v1", PairingService.pairingKey, "engine-id.v1"] {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: LocalDeviceNamespace.service(selection), kSecAttrAccount as String: key,
                kSecMatchSearchList as String: [keychain]]
            let deleted = SecItemDelete(query as CFDictionary)
            guard deleted == errSecSuccess || deleted == errSecItemNotFound else { throw IdentityFailure("KEYCHAIN_CLEANUP_FAILED") }
            var found: CFTypeRef?
            var verification = query; verification[kSecReturnAttributes as String] = true; verification[kSecMatchLimit as String] = kSecMatchLimitOne
            guard SecItemCopyMatching(verification as CFDictionary, &found) == errSecItemNotFound else { throw IdentityFailure("KEYCHAIN_CLEANUP_FAILED") }
        }
        #endif
    }
}

public struct LocalDeviceKey: SigningKeyProvider {
    public let keyID = "nikui-mac-device-v1"
    public let protection: KeyProtection = .keychain
    let store: any KeyValueStore
    private func key() async throws -> P256.Signing.PrivateKey {
        guard let data = try await store.data(forKey: "device-key.v1") else { throw IdentityFailure("LOCAL_DEVICE_IDENTITY_UNAVAILABLE") }
        do { return try P256.Signing.PrivateKey(rawRepresentation: data) } catch { throw IdentityFailure("KEYCHAIN_CORRUPT") }
    }
    public func publicSPKI() async throws -> Data { try await key().publicKey.derRepresentation }
    public func sign(message: Data) async throws -> Data { try await key().signature(for: message).rawRepresentation }
    public func delete() async throws { try await store.removeValue(forKey: "device-key.v1") }
}
public struct LocalDeviceConnection: Sendable {
    public let key: LocalDeviceKey
    public let pairing: PairedConnection
    public let engineID: String
    public let generation: String
}
public actor LocalDeviceEnrollment {
    let root: String
    let transport: any ControlTransport
    let store: any KeyValueStore
    public init(root: String, transport: (any ControlTransport)? = nil, store: any KeyValueStore) {
        self.root = root; self.transport = transport ?? UnixControlTransport(root: root); self.store = store
    }
    /// Call only after explicit setup/connect, or for an already selected key.
    public func connect(allowCreation: Bool) async throws -> LocalDeviceConnection {
        let status = try JSONValue.decode(await transport.request(Data(#"{"op":"status"}"#.utf8)))
        guard status["ok"].boolValue == true, status["root"].stringValue == root, status["state"].stringValue == "running",
              let engineID = status["engine"]["id"].stringValue, let generation = status["generation"].stringValue else { throw IdentityFailure("LOCAL_ENGINE_UNAVAILABLE") }
        let existing = try await store.data(forKey: PairingService.pairingKey)
        let selectedEngine = try await store.data(forKey: "engine-id.v1")
        if let selectedEngine, selectedEngine != Data(engineID.utf8) { throw IdentityFailure("LOCAL_DEVICE_PIN_MISMATCH") }
        var savedPairing: PairedConnection?
        if let existing {
            guard let saved = try? JSONDecoder().decode(PairedConnection.self, from: existing),
                  selectedEngine != nil else { throw IdentityFailure("KEYCHAIN_CORRUPT") }
            savedPairing = saved
        }
        if try await store.data(forKey: "device-key.v1") == nil {
            guard allowCreation, existing == nil, try await store.data(forKey: "engine-id.v1") == nil else { throw IdentityFailure("LOCAL_DEVICE_IDENTITY_UNAVAILABLE") }
            try await store.set(P256.Signing.PrivateKey().rawRepresentation, forKey: "device-key.v1")
        }
        let key = LocalDeviceKey(store: store), spki = try await key.publicSPKI()
        if let savedPairing, savedPairing.publicSPKI != spki { throw IdentityFailure("LOCAL_DEVICE_PIN_MISMATCH") }
        let publicKey = NikCrypto.base64URL(spki)
        let binding = try JSONValue.array([.string(engineID), .string(generation), .string(publicKey)]).encoded()
        let signature = try await key.sign(message: Data("nikui-local-device-v1:".utf8) + binding)
        let request: JSONValue = .object(["op": .string("enroll"), "kind": .string("local"), "protocol": .number(2),
            "device": .object(["engineId": .string(engineID), "generation": .string(generation), "publicKey": .string(publicKey), "signature": .string(NikCrypto.base64URL(signature))])])
        let response = try JSONValue.decode(await transport.request(request.encoded()))
        guard response["ok"].boolValue == true else { throw IdentityFailure(response["code"].stringValue ?? "LOCAL_DEVICE_ENROLLMENT_FAILED") }
        let pairing = try Self.validate(response, engineID: engineID, generation: generation, publicSPKI: spki)
        if let saved = savedPairing {
            guard
                  saved.deviceID == pairing.deviceID, saved.publicSPKI == spki, saved.serverSPKI == pairing.serverSPKI,
                  saved.fingerprint == pairing.fingerprint else { throw IdentityFailure("LOCAL_DEVICE_PIN_MISMATCH") }
        }
        try await store.set(Data(engineID.utf8), forKey: "engine-id.v1")
        try await store.set(WireCoding.encode(pairing), forKey: PairingService.pairingKey)
        return LocalDeviceConnection(key: key, pairing: pairing, engineID: engineID, generation: generation)
    }
    public static func validate(_ value: JSONValue, engineID: String, generation: String, publicSPKI: Data) throws -> PairedConnection {
        guard value["engineId"].stringValue == engineID, value["generation"].stringValue == generation,
              value["protocol"].intValue == 2, value["kind"].stringValue == "local",
              let id = value["device"].stringValue, !id.isEmpty, id.utf8.count <= 128,
              value["seat"]["id"].stringValue == id, value["seat"]["local"].boolValue == true,
              value["seat"]["control"].boolValue == true, value["seat"]["editor"].boolValue == false,
              value["publicKey"].stringValue == NikCrypto.base64URL(publicSPKI),
              let endpoint = value["baseURL"].stringValue, let url = URL(string: endpoint), url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port, (1...65535).contains(port), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty,
              let encoded = value["serverKey"].stringValue else { throw IdentityFailure("LOCAL_DEVICE_ENROLLMENT_INVALID") }
        let server = try NikCrypto.decodeBase64URL(encoded); try NikCrypto.validateSPKI(server)
        guard value["fingerprint"].stringValue == NikCrypto.fingerprint(server) else { throw IdentityFailure("LOCAL_DEVICE_PIN_MISMATCH") }
        return PairedConnection(deviceID: id, baseURL: url, laptopName: "This Mac", serverSPKI: server,
            fingerprint: NikCrypto.fingerprint(server), keyID: "nikui-mac-device-v1", publicSPKI: publicSPKI, protection: .keychain)
    }
}
