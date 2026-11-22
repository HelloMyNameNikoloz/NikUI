import Foundation
import AppKit
import SwiftUI
import UserNotifications
import CoreGraphics
import NikMenuCore
import NikMacCore

@MainActor final class MacNotificationPresenter: NSObject, DesktopNotificationPresenter, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let session: MacAppSession
    private var lockObservers: [NSObjectProtocol] = []
    init(session: MacAppSession) {
        self.session = session; super.init(); center.delegate = self
        let notifications = session.desktopNotifications
        // Distributed notifications only describe future changes. Read the
        // current login session as well, including a launch while locked.
        let current = CGSessionCopyCurrentDictionary() as? [String: Any]
        let onConsole = current?[kCGSessionOnConsoleKey as String] as? Bool ?? false
        notifications.locked = !onConsole || (current?["CGSSessionScreenIsLocked"] as? Bool ?? false)
        for (name, locked) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            lockObservers.append(DistributedNotificationCenter.default().addObserver(forName: .init(name), object: nil, queue: .main) { _ in
                Task { @MainActor in notifications.locked = locked }
            })
        }
    }
    static func preferences(_ defaults: UserDefaults = .standard) -> DesktopNotificationPreferences {
        var value = DesktopNotificationPreferences()
        value.enabled = defaults.bool(forKey: "nikui.notifications.enabled")
        value.approvals = defaults.object(forKey: "nikui.notifications.approvals") as? Bool ?? true
        value.finished = defaults.object(forKey: "nikui.notifications.finished") as? Bool ?? true
        value.errors = defaults.object(forKey: "nikui.notifications.errors") as? Bool ?? true
        value.previews = defaults.bool(forKey: "nikui.notifications.previews")
        value.sound = defaults.object(forKey: "nikui.notifications.sound") as? Bool ?? true
        return value
    }
    func deliver(_ notice: DesktopNotice, previews: Bool, sound: Bool) async throws {
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
        let content = UNMutableNotificationContent()
        content.title = notice.title; content.body = previews ? notice.body : "Open NikUI to view."
        content.userInfo = ["eventID": notice.id, "engineID": notice.engineID, "conversationID": notice.conversationID]
        content.threadIdentifier = notice.engineID + ":" + notice.conversationID
        content.interruptionLevel = .active
        if sound { content.sound = .default }
        try await center.add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil))
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.identifier
        await clicked(id)
    }
    private func clicked(_ id: String) async {
        if let notice = await session.desktopNotifications.clicked(id) { await session.openNotification(notice) }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
}

struct NotificationWindowCapture: NSViewRepresentable {
    var received: (NSWindow) -> Void
    func makeNSView(context: Context) -> Capture { Capture(received: received) }
    func updateNSView(_ view: Capture, context: Context) { view.received = received }
    @MainActor final class Capture: NSView {
        var received: (NSWindow) -> Void
        init(received: @escaping (NSWindow) -> Void) { self.received = received; super.init(frame: .zero) }
        required init?(coder: NSCoder) { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window {
                Task { @MainActor [weak self] in
                    guard let self, self.window === window else { return }
                    self.received(window)
                }
            }
        }
    }
}
