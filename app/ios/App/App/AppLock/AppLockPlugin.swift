import Foundation
import Capacitor
import LocalAuthentication

/// Proving it is you, in order to open the app.
///
/// Deliberately not part of SecureKeyPlugin, which is about a key: that one
/// answers "sign this" and the chip decides whether to, and the biometric check
/// is a property of the key. This one answers a different question — "is the
/// person holding the phone the person it belongs to" — and the answer is worth
/// nothing cryptographically. It gates a screen, not a signature.
///
/// Which is worth being plain about. Anyone who can take this phone apart can
/// read what is behind this lock; what stops them is the phone's own lock and
/// the key in the Enclave. This stops the person the phone is handed to.
@objc(AppLockPlugin)
public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "AppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prompt", returnType: CAPPluginReturnPromise)
    ]

    /// What this phone can offer, and what to call it on a screen.
    @objc func available(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let can = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)

        var kind = "none"
        switch context.biometryType {
        case .faceID: kind = "face"
        case .touchID: kind = "touch"
        default: kind = "none"
        }

        // Not enrolled is a different answer from not fitted, and the screen
        // says different things: one is "turn it on in Settings", the other is
        // "this phone cannot".
        let code = error.map { LAError.Code(rawValue: $0.code) } ?? nil
        call.resolve([
            "available": can,
            "kind": kind,
            "enrolled": can || code != .biometryNotEnrolled,
            "reason": can ? "" : (code == .biometryNotEnrolled
                ? "no face or finger is set up on this phone"
                : "this phone cannot check a face or a finger")
        ])
    }

    /// Ask, once. Every call is a fresh context: this is a door, not a session.
    @objc func prompt(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Unlock NikUI"
        let context = LAContext()
        // The app has a passcode screen of its own, and it is the one that knows
        // how many tries are left. Offering the *phone's* passcode here would be
        // a second, different way in, with none of that behind it.
        context.localizedFallbackTitle = ""

        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            let code = error.map { LAError.Code(rawValue: $0.code) } ?? nil
            return call.reject(
                code == .biometryLockout
                    ? "too many tries — use the passcode"
                    : "this phone cannot check a face or a finger right now",
                code == .biometryLockout ? "LOCKED_OUT" : "UNAVAILABLE")
        }

        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, err in
            if ok { return call.resolve(["ok": true]) }
            let code = (err as? LAError)?.code
            switch code {
            case .userCancel, .systemCancel, .appCancel:
                call.reject("cancelled", "CANCELLED")
            case .userFallback:
                call.reject("use the passcode", "FALLBACK")
            case .biometryLockout:
                call.reject("too many tries — use the passcode", "LOCKED_OUT")
            case .biometryNotAvailable, .biometryNotEnrolled:
                call.reject("this phone cannot check a face or a finger", "UNAVAILABLE")
            default:
                // A face that did not match. Not an error anybody needs the text
                // of: the screen counts these and says what happens next.
                call.reject("that was not recognised", "FAILED")
            }
        }
    }
}
