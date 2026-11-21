import Foundation
import Observation
import UIKit
import UserNotifications
import NikCore

/// OS authorization/registration and durable adapter metadata. A token write
/// is never presented as proof of remote push delivery.
@MainActor @Observable final class NotificationAccess {
    static let shared = NotificationAccess()
    enum Registration: Equatable { case notRequested, registering, registered, failed(String) }
    enum Submission: Equatable { case notOffered, queued, written, failed(String) }
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var soundAllowed = false
    private(set) var registration: Registration = .notRequested
    private(set) var submission: Submission = .notOffered
    private(set) var storageError: String?
    private let store = KeychainStore()
    private var latestToken: Data?
    private var stagedDestination: NotificationDestination?
    private var destinationCleared = false
    private let tokenKey = "notifications.apns-token.v1"
    private let destinationKey = "notifications.destination.v1"

    var authorized: Bool { authorization == .authorized || authorization == .provisional || authorization == .ephemeral }
    var authorizationWords: String {
        switch authorization {
        case .authorized: "Allowed"
        case .provisional: "Quiet delivery allowed"
        case .ephemeral: "Temporarily allowed"
        case .denied: "Off in iPhone Settings"
        case .notDetermined: "Not set up"
        @unknown default: "Unknown"
        }
    }
    var registrationWords: String {
        switch registration {
        case .notRequested: "Not registered this launch"
        case .registering: "Registering with Apple…"
        case .registered: "OS token registered"
        case .failed(let reason): reason
        }
    }
    var submissionWords: String {
        switch submission {
        case .notOffered: "Token not offered"
        case .queued: "Token queued for a verified connection"
        case .written: "Token written over a sealed connection; no receipt"
        case .failed(let reason): reason
        }
    }

    func refresh(register: Bool = false) async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorization = settings.authorizationStatus
        soundAllowed = settings.soundSetting == .enabled
        if register, authorized {
            registration = .registering
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func request() async -> Bool {
        do { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
        catch { registration = .failed("Notification setup failed: \(error.localizedDescription)") }
        await refresh(register: true)
        return authorized
    }

    func registered(_ token: Data) {
        registration = .registered
        latestToken = token
        do {
            try store.write(token, tokenKey)
            storageError = nil
        } catch { storageError = "The OS token could not be saved. \(error.localizedDescription)" }
    }
    func registrationFailed(_ reason: String) {
        registration = .failed("Apple registration failed: \(reason) Retry setup. This build needs the Push Notifications entitlement and a signed provisioning profile.")
    }
    func savedToken() -> String? {
        if let latestToken { return latestToken.map { String(format: "%02x", $0) }.joined() }
        do {
            guard let token = try store.read(tokenKey) else { return nil }
            latestToken = token
            storageError = nil
            return token.map { String(format: "%02x", $0) }.joined()
        } catch { storageError = "The saved OS token is unavailable. \(error.localizedDescription)"; return nil }
    }
    func queued() { submission = .queued }
    func submitted(_ result: ActionResult, live: Bool) {
        switch result {
        case .submitted, .accepted: submission = .written
        case .notSent(let failure): submission = live ? .failed(failure.message) : .queued
        case .ambiguous: submission = .failed("Token submission was interrupted; delivery is unknown.")
        case .local: submission = .queued
        }
    }
    func resetSubmission() { submission = .notOffered }

    func saveDestination(_ destination: NotificationDestination) throws {
        stagedDestination = destination; destinationCleared = false
        try store.write(JSONEncoder().encode(StoredDestination(destination)), destinationKey)
    }
    func pendingDestination() throws -> NotificationDestination? {
        if destinationCleared { return nil }
        if let stagedDestination { return stagedDestination }
        guard let data = try store.read(destinationKey) else { return nil }
        let saved = try JSONDecoder().decode(StoredDestination.self, from: data)
        // Revalidate persisted values through the same core parser as new taps.
        switch saved.kind {
        case "conversation": return NotificationCoordinator.destination(NotificationEvent(.object(["session": .string(saved.id ?? "")])))
        case "slack": return NotificationCoordinator.destination(NotificationEvent(.object(["conversation": .string(saved.id ?? "")])))
        default: return .chats
        }
    }
    func clearDestination() throws {
        stagedDestination = nil; destinationCleared = true
        try store.remove(destinationKey)
    }

    func localTest() async throws {
        let content = UNMutableNotificationContent()
        content.title = "NikUI notification test"
        content.body = "Local notifications work on this iPhone. Laptop push delivery is still unverified."
        content.userInfo = ["nikuiLocal": true, "nikuiTest": true]
        content.sound = nil
        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "nikui.local-test", content: content, trigger: nil))
    }

    private struct StoredDestination: Codable {
        var kind: String
        var id: String?
        init(_ value: NotificationDestination) {
            switch value {
            case .chats: kind = "chats"
            case .conversation(let value): kind = "conversation"; id = value
            case .slack(let value): kind = "slack"; id = value
            }
        }
    }
}

/// Whitelisted payload values cross from the notification delegate to the main
/// actor. Never persist alert bodies or assume absent Slack IDs can be recovered.
struct NotificationPayload: Sendable {
    let event: NotificationEvent
    let isLocal: Bool
    let isTest: Bool

    init(content: UNNotificationContent) {
        let info = content.userInfo
        var raw: [String: JSONValue] = ["title": .string(content.title), "body": .string(content.body)]
        for key in ["kind", "session", "conversation", "tag", "url"] {
            if let value = info[key] as? String { raw[key] = .string(value) }
        }
        if let at = info["at"] as? NSNumber { raw["at"] = .number(at.doubleValue) }
        event = NotificationEvent(.object(raw))
        isLocal = info["nikuiLocal"] as? Bool == true
        isTest = info["nikuiTest"] as? Bool == true
    }
}
