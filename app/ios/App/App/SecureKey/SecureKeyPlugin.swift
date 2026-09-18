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
        call.resolve([
            "available": enclave,
            "protection": enclave ? "secure-enclave" : "none",
            "biometrics": biometrics,
            "platform": "ios"
        ])
    }

    // MARK: - making one

    @objc func create(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "nikui.device"
        let biometric = call.getBool("biometric") ?? false
        reuseWindow = TimeInterval(call.getInt("validitySeconds") ?? 300)

        guard SecureEnclave.isAvailable else {
            return call.reject("this device has no Secure Enclave")
        }

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

        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag(alias),
                kSecAttrLabel as String: service,
                kSecAttrAccessControl as String: access
            ]
        ]

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
            "protection": "secure-enclave",
            "biometric": biometric,
            "alias": alias
        ])
    }

    @objc func publicKey(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "nikui.device"
        guard let key = findKey(alias: alias), let exported = exportPublicKey(key) else {
            return call.reject("no key under that name")
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

        guard let key = findKey(alias: alias, reason: reason) else {
            return call.reject("no key under that name")
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

    private func findKey(alias: String, reason: String? = nil) -> SecKey? {
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
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
        // swiftlint:disable:next force_cast
        return (item as! SecKey)
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
