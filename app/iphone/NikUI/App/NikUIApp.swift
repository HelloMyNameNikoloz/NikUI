import SwiftUI
import UIKit
import UserNotifications
import NikCore

@main
struct NikUIApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel(preview: ProcessInfo.processInfo.arguments.contains("-preview"))
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.client)
                .task { await model.start() }
                .onOpenURL { model.open($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { model.open(url) }
                }
        }
        .onChange(of: scenePhase) { _, phase in model.scenePhase(phase) }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        MainActor.assumeIsolated {
            if let model = AppModel.current { model.registerAppleToken(token) }
            else { NotificationAccess.shared.registered(token) }
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        MainActor.assumeIsolated { NotificationAccess.shared.registrationFailed(error.localizedDescription) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let payload = NotificationPayload(content: notification.request.content)
        return await MainActor.run { AppModel.current?.foregroundNotification(payload) ?? [] }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let payload = NotificationPayload(content: response.notification.request.content)
        await MainActor.run {
            if let model = AppModel.current { model.notificationTapped(payload.event) }
            else { try? NotificationAccess.shared.saveDestination(NotificationCoordinator.destination(payload.event)) }
        }
    }
}

