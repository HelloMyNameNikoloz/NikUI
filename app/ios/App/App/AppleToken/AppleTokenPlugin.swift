import Foundation
import Capacitor
import UIKit
import UserNotifications

/// Where Apple can find this phone when NikUI is not running.
///
/// iOS suspends an app the moment it leaves the screen, so the socket this app
/// holds while it is open is gone the moment it is not. The only way to reach a
/// closed app is Apple's own push network, and the only way to use that is a
/// device token, which is what this fetches.
///
/// Deliberately not @capacitor/push-notifications: that plugin brings Firebase
/// with it for Android, and Android needs none of this — it keeps the socket
/// open behind a foreground service instead. This is the twenty lines of it
/// that iOS actually needs.
///
/// Nothing here works without an Apple Developer account: registration fails
/// with an error when the app has no aps-environment entitlement, which is
/// exactly what happens on a free provisioning profile. That failure is
/// reported rather than swallowed, because "notifications do not arrive" is the
/// least debuggable sentence in this product.
@objc(AppleTokenPlugin)
public class AppleTokenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleTokenPlugin"
    public let jsName = "AppleToken"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise)
    ]

    private var waiting: CAPPluginCall?

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": true, "platform": "ios"])
    }

    /// Ask iOS for a token, which means asking the person first: a registration
    /// without permission produces a token that can never show anything.
    @objc func register(_ call: CAPPluginCall) {
        call.keepAlive = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                return call.reject("this phone would not allow notifications: \(error.localizedDescription)")
            }
            guard granted else { return call.reject("not allowed", "DENIED") }

            DispatchQueue.main.async {
                self.waiting = call
                NotificationCenter.default.addObserver(
                    self, selector: #selector(self.gotToken(_:)),
                    name: Notification.Name(CAPNotifications.DidRegisterForRemoteNotificationsWithDeviceToken.name()),
                    object: nil)
                NotificationCenter.default.addObserver(
                    self, selector: #selector(self.failedToken(_:)),
                    name: Notification.Name(CAPNotifications.DidFailToRegisterForRemoteNotificationsWithError.name()),
                    object: nil)
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    @objc func gotToken(_ notification: NSNotification) {
        guard let call = waiting else { return }
        waiting = nil
        guard let data = notification.object as? Data else {
            return call.reject("iOS gave something that is not a token")
        }
        // Hex, which is the form Apple's own API takes it back in.
        let token = data.map { String(format: "%02x", $0) }.joined()
        call.resolve(["token": token])
    }

    @objc func failedToken(_ notification: NSNotification) {
        guard let call = waiting else { return }
        waiting = nil
        let said = (notification.object as? Error)?.localizedDescription
            ?? "this build cannot receive notifications"
        // Almost always the same cause, so it is named: a free provisioning
        // profile has no aps-environment entitlement, and Apple will not issue
        // a token to a build that has none.
        call.reject("\(said). An Apple Developer account is needed for this.", "NO_ENTITLEMENT")
    }
}
