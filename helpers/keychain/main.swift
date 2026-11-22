import Foundation
import Security
import Darwin

// One bounded, length-prefixed JSON request and response per process. Nothing
// from the request (including errors) is ever written to stderr or argv.
let maxFrame = 2 * 1024 * 1024
struct Refusal: Error { let code: String; let status: OSStatus?; init(_ code: String, _ status: OSStatus? = nil) { self.code = code; self.status = status } }
func exact(_ count: Int) throws -> Data {
    var data = Data()
    while data.count < count {
        guard let part = try FileHandle.standardInput.read(upToCount: count - data.count), !part.isEmpty else { throw Refusal("KEYCHAIN_BAD_FRAME") }
        data.append(part)
    }
    return data
}
func respond(_ value: [String: Any], _ status: Int32) -> Never {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard data.count <= maxFrame else { exit(74) }
        var size = UInt32(data.count).bigEndian
        try FileHandle.standardOutput.write(contentsOf: withUnsafeBytes(of: &size) { Data($0) })
        try FileHandle.standardOutput.write(contentsOf: data)
    } catch { exit(74) }
    exit(status)
}
func codeFor(_ status: OSStatus) -> String {
    switch status {
    case errSecDuplicateItem: return "KEYCHAIN_DUPLICATE"
    case errSecItemNotFound: return "KEYCHAIN_NOT_FOUND"
    case errSecInteractionNotAllowed: return "KEYCHAIN_LOCKED"
    case errSecAuthFailed, errSecUserCanceled, errSecMissingEntitlement, 100001: return "KEYCHAIN_DENIED"
    case errSecDecode: return "KEYCHAIN_CORRUPT"
    default: return "KEYCHAIN_UNAVAILABLE"
    }
}
func check(_ status: OSStatus) throws { if status != errSecSuccess { throw Refusal(codeFor(status), status) } }
func text(_ value: Any?, _ pattern: String) -> String? {
    guard let s = value as? String, s.range(of: pattern, options: .regularExpression) == s.startIndex..<s.endIndex else { return nil }
    return s
}
var requestID = String(repeating: "0", count: 32)
do {
    guard CommandLine.arguments.count == 1 else { throw Refusal("KEYCHAIN_BAD_FRAME") }
    let header = try exact(4)
    let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    guard length > 0, length <= maxFrame else { throw Refusal("KEYCHAIN_BAD_FRAME") }
    let payload = try exact(Int(length))
    guard (try FileHandle.standardInput.read(upToCount: 1) ?? Data()).isEmpty,
          let request = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
          let id = text(request["id"], "^[a-f0-9]{32}$") else { throw Refusal("KEYCHAIN_BAD_FRAME") }
    requestID = id
    guard let version = request["version"] as? NSNumber, version == 1, CFGetTypeID(version) != CFBooleanGetTypeID(),
          let operation = request["op"] as? String, ["add", "update", "read", "delete"].contains(operation),
          let service = request["service"] as? String,
          let account = text(request["account"], "^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$") else { throw Refusal("KEYCHAIN_BAD_REQUEST") }
    let expected = Set(["version", "id", "op", "service", "account"] + (["add", "update"].contains(operation) ? ["data"] : []))
    guard Set(request.keys) == expected else { throw Refusal("KEYCHAIN_BAD_REQUEST") }
    var value: Data?
    if ["add", "update"].contains(operation) {
        guard let encoded = request["data"] as? String, let decoded = Data(base64Encoded: encoded),
              decoded.base64EncodedString() == encoded, decoded.count <= 1024 * 1024 else { throw Refusal("KEYCHAIN_BAD_REQUEST") }
        value = decoded
    }
    // D28: the signed prefix and default creating-helper ACL isolate a service
    // in the file-based login Keychain. No access group/provisioning is needed.
    guard let info = Bundle.main.infoDictionary,
          let prefix = info["NikKeychainServicePrefix"] as? String,
          info["NikBuildFlavour"] as? String == BuildFlavour.current.rawValue,
          info["NikKeychainBackend"] as? String == "login-file-keychain" else { throw Refusal("KEYCHAIN_NAMESPACE") }
    do { try BuildFlavour.current.validateKeychain(prefix: prefix, service: service) }
    catch { throw Refusal("KEYCHAIN_NAMESPACE") }
    // Resolve the account's real login Keychain, independent of the TEST HOME.
    // Never change the default/search list, unlock it, or enumerate other items.
    guard let user = getpwuid(getuid()), let directory = user.pointee.pw_dir else { throw Refusal("KEYCHAIN_UNAVAILABLE") }
    let login = String(cString: directory) + "/Library/Keychains/login.keychain-db"
    var keychain: SecKeychain?
    try check(SecKeychainOpen(login, &keychain))
    guard let keychain else { throw Refusal("KEYCHAIN_UNAVAILABLE") }
    // kSecUseAuthenticationUI alone does not suppress legacy-Keychain UI.
    // This switch affects only this short-lived helper process.
    try check(SecKeychainSetUserInteractionAllowed(false))
    var keychainStatus: SecKeychainStatus = 0
    try check(SecKeychainGetStatus(keychain, &keychainStatus))
    guard keychainStatus & kSecUnlockStateStatus != 0 else { throw Refusal("KEYCHAIN_LOCKED", errSecInteractionNotAllowed) }
    func checkItem(_ status: OSStatus) throws {
        if status == errSecInteractionNotAllowed || status == errSecInteractionRequired {
            var current: SecKeychainStatus = 0
            if SecKeychainGetStatus(keychain, &current) == errSecSuccess {
                throw Refusal(current & kSecUnlockStateStatus == 0 ? "KEYCHAIN_LOCKED" : "KEYCHAIN_DENIED", status)
            }
        }
        try check(status)
    }
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecMatchSearchList as String: [keychain]
    ]
    var result: [String: Any] = ["version": 1, "id": id, "ok": true, "backend": "login-file-keychain", "service": service]
    switch operation {
    case "add", "update":
        guard let data = value else { throw Refusal("KEYCHAIN_BAD_REQUEST") }
        var accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        func write(_ accessible: CFString) -> OSStatus {
            let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: accessible]
            if operation == "add" {
                var add = query
                add.removeValue(forKey: kSecMatchSearchList as String)
                add[kSecUseKeychain as String] = keychain
                add.merge(attributes) { _, new in new }
                // Omit kSecAttrAccess: retain the default ACL trusting this
                // signed helper, never an all-apps/allow-any ACL.
                return SecItemAdd(add as CFDictionary, nil)
            }
            // No delete-then-add/upsert. An error retains the old item/ACL.
            return SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        }
        var status = write(accessible)
        if status == errSecParam || status == errSecUnimplemented {
            accessible = kSecAttrAccessibleAfterFirstUnlock
            status = write(accessible)
        }
        try checkItem(status)
        result["accessible"] = accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly ? "AfterFirstUnlockThisDeviceOnly" : "AfterFirstUnlock"
        result["accessibilityReported"] = false // accepted write attribute; not an iOS protection-class guarantee
    case "read":
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecItemNotFound { result["found"] = false }
        else {
            try checkItem(status)
            guard let attributes = found as? [String: Any], let data = attributes[kSecValueData as String] as? Data,
                  attributes[kSecAttrService as String] as? String == service,
                  attributes[kSecAttrAccount as String] as? String == account else { throw Refusal("KEYCHAIN_CORRUPT") }
            result["found"] = true; result["data"] = data.base64EncodedString()
            if let accessible = attributes[kSecAttrAccessible as String] as? String {
                guard accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String || accessible == kSecAttrAccessibleAfterFirstUnlock as String else { throw Refusal("KEYCHAIN_CORRUPT") }
                result["accessible"] = accessible == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String ? "AfterFirstUnlockThisDeviceOnly" : "AfterFirstUnlock"
                result["accessibilityReported"] = true
            } else {
                // The file-based shim can accept but omit this attribute.
                // Protection is the login Keychain lock and the helper ACL.
                result["accessible"] = "not-reported-by-file-keychain"
                result["accessibilityReported"] = false
            }
        }
    case "delete":
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecItemNotFound { try checkItem(status) }
        result["found"] = status == errSecSuccess
    default: throw Refusal("KEYCHAIN_BAD_REQUEST")
    }
    respond(result, 0)
} catch let refusal as Refusal {
    var error: [String: Any] = ["code": refusal.code]
    if let status = refusal.status { error["status"] = Int(status) }
    respond(["version": 1, "id": requestID, "ok": false, "error": error], 1)
} catch {
    respond(["version": 1, "id": requestID, "ok": false, "error": ["code": "KEYCHAIN_BAD_FRAME"]], 1)
}
