import Foundation
import Capacitor
import Security
import LocalAuthentication
import CryptoKit

/// This device's key, made inside the Secure Enclave.
///
/// The private key has no software representation at all: it is generated in the
/// chip, `SecKeyCopyExternalRepresentation` refuses to return it, and no backup,
/// no filesystem copy and no jailbroken read produces it. What leaves this file
/// is a public key and signatures.
///
/// Two conversions are deliberately *not* done here. Apple hands back a bare
/// 65-byte point and a DER signature; both are converted in JavaScript, in one
/// place, where a test on a laptop can check them against the laptop's real
/// verifier. Native code that only a device can run is native code that can only
/// be wrong on a device.
@objc(SecureKeyPlugin)
public class SecureKeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureKeyPlugin"
    public let jsName = "SecureKey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publicKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    /// One context, reused for as long as the policy allows, so a phone that
    /// reconnects four times crossing a street is asked for a face once.
    private var context = LAContext()
    private var contextMadeAt = Date.distantPast
    private var reuseWindow: TimeInterval = 300

    private let service = "com.nikoloz.nikui.device"

    // MARK: - what this device can do

    @objc func isAvailable(_ call: CAPPluginCall) {
        let enclave = SecureEnclave.isAvailable
        var error: NSError?
        let biometrics = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        // Always available on iOS, and it has to be: WebKit cannot store a
        // CryptoKey in IndexedDB at all — a non-extractable key put there comes
        // back as "the object can not be cloned" — so the browser fallback that
        // works on Android does not exist here. The Keychain is the floor, the
        // Secure Enclave is the ceiling, and neither lets the key out.
        call.resolve([
            "available": true,
            "protection": enclave ? "secure-enclave" : "keychain",
            "biometrics": biometrics,
            "platform": "ios"
        ])
    }

    // MARK: - making one

    @objc func create(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "nikui.device"
        let biometric = call.getBool("biometric") ?? false
        reuseWindow = TimeInterval(call.getInt("validitySeconds") ?? 300)

        let enclave = SecureEnclave.isAvailable

        // Without biometrics: the key is usable while the phone is unlocked, and
        // never leaves this device — not to a backup, not to a new phone.
        // With them: the chip itself refuses to sign until a face or a finger has
        // been checked. `.biometryCurrentSet` means adding a new face or finger
        // invalidates the key, so enrolling an attacker's face does not inherit
        // the ability to sign; the device has to pair again, which needs the
        // laptop.
        var flags: SecAccessControlCreateFlags = [.privateKeyUsage]
        if biometric { flags.insert(.biometryCurrentSet) }

        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            flags,
            &accessError
        ) else {
            return call.reject("this device would not protect a key: \(describe(accessError))")
        }

        // Anything already under this name goes first, or the add is a duplicate.
        deleteKey(alias: alias)

        var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag(alias),
                kSecAttrLabel as String: service,
                kSecAttrAccessControl as String: access
            ]
        ]
        // Only when there is one. Asking for the Enclave where there is none —
        // a simulator, an older device — fails the whole creation rather than
        // degrading, and a phone with no key cannot pair at all.
        if enclave {
            attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
        }

        var createError: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &createError) else {
            return call.reject("the Secure Enclave refused: \(describe(createError))")
        }
        guard let exported = exportPublicKey(key) else {
            deleteKey(alias: alias)
            return call.reject("the key was made but its public half could not be read")
        }

        context = LAContext()
        contextMadeAt = .distantPast
        call.resolve([
            "publicKey": exported,
            "protection": enclave ? "secure-enclave" : "keychain",
            "biometric": biometric,
            "alias": alias
        ])
    }

    @objc func publicKey(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "nikui.device"
        let found = findKey(alias: alias)
        guard let key = found.key else {
            return reject(call, found.status, alias)
        }
        guard let exported = exportPublicKey(key) else {
            return call.reject("that key's public half could not be read", "UNREADABLE")
        }
        call.resolve(["publicKey": exported, "alias": alias])
    }

    // MARK: - using one

    @objc func sign(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "nikui.device"
        guard let message = call.getString("message") else {
            return call.reject("nothing to sign")
        }
        let reason = call.getString("reason") ?? "Prove this phone to your laptop"

        let found = findKey(alias: alias, reason: reason)
        guard let key = found.key else {
            return reject(call, found.status, alias)
        }
        guard let bytes = message.data(using: .utf8) else {
            return call.reject("that message is not text")
        }

        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
            key, .ecdsaSignatureMessageX962SHA256, bytes as CFData, &error
        ) as Data? else {
            // A cancelled face check is a person saying no, not a fault.
            let failure = error?.takeRetainedValue()
            let code = (failure as Error?).map { ($0 as NSError).code } ?? 0
            if code == errSecUserCanceled || code == LAError.userCancel.rawValue {
                return call.reject("cancelled", "CANCELLED")
            }
            return call.reject("the chip would not sign: \(String(describing: failure))")
        }

        contextMadeAt = Date()
        // DER, as the chip produces it. Converted in JavaScript.
        call.resolve(["signature": signature.base64EncodedString()])
    }

    // MARK: - housekeeping

    @objc func remove(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "nikui.device"
        deleteKey(alias: alias)
        call.resolve(["removed": true])
    }

    // MARK: - the keychain, kept in one place

    private func tag(_ alias: String) -> Data {
        return Data("\(service).\(alias)".utf8)
    }

    /**
     * Why a lookup failed, not merely that it did.
     *
     * These are three different worlds and only one of them means the identity
     * is gone. `errSecItemNotFound` is genuinely gone — most often because the
     * app was rebuilt under a different team, which changes the keychain access
     * group and hides everything the last build stored. `errSecInteractionNotAllowed`
     * is a locked phone: the key is right there and will be readable in a moment,
     * because it was made `WhenUnlockedThisDeviceOnly`. Anything else is a fault.
     *
     * Collapsing all three into one nil is what made a pairing failure say "no
     * key under that name" and leave nowhere to go. It would also, if the caller
     * reacted by making a fresh key, throw away a working identity for no better
     * reason than that the screen happened to be off.
     */
    private func reject(_ call: CAPPluginCall, _ status: OSStatus, _ alias: String) {
        switch status {
        case errSecItemNotFound:
            call.reject("this app holds no key called \(alias)", "NO_KEY")
        case errSecInteractionNotAllowed:
            call.reject("unlock this phone first", "LOCKED")
        case errSecMissingEntitlement:
            call.reject("this build cannot reach its keychain", "NO_ENTITLEMENT")
        default:
            call.reject("the keychain refused (\(status))", "KEYCHAIN_ERROR")
        }
    }

    private func findKey(alias: String, reason: String? = nil) -> (key: SecKey?, status: OSStatus) {
        var query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag(alias),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecReturnRef as String: true
        ]
        if let reason = reason {
            if Date().timeIntervalSince(contextMadeAt) > reuseWindow {
                context = LAContext()
            }
            context.localizedReason = reason
            context.touchIDAuthenticationAllowableReuseDuration = reuseWindow
            query[kSecUseAuthenticationContext as String] = context
        }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let found = item else { return (nil, status) }
        // swiftlint:disable:next force_cast
        return ((found as! SecKey), status)
    }

    private func exportPublicKey(_ privateKey: SecKey) -> String? {
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else { return nil }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else { return nil }
        // 0x04 ‖ X ‖ Y — 65 bytes, and not a key the laptop can read until
        // JavaScript puts the SPKI header back on it.
        return data.base64EncodedString()
    }

    @discardableResult
    private func deleteKey(alias: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag(alias),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom
        ]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }

    private func describe(_ error: Unmanaged<CFError>?) -> String {
        guard let error = error?.takeRetainedValue() else { return "no reason given" }
        return String(describing: error)
    }
}
