import Foundation
import Observation
import NikCore
import NikMenuCore
import NikMacIdentity

public struct DesktopNotificationPreferences: Sendable {
    public var enabled = false
    public var approvals = true
    public var finished = true
    public var errors = true
    public var previews = false
    public var sound = true
    public init() {}
    public func allows(_ kind: String) -> Bool {
        enabled && (kind == "needs-you" && approvals || kind == "turn-finished" && finished || kind == "failed" && errors)
    }
}
@MainActor public protocol DesktopNotificationPresenter: AnyObject {
    func deliver(_ notice: DesktopNotice, previews: Bool, sound: Bool) async throws
}
/// One app-wide durable delivery claim, independent of windows and boot IDs.
@MainActor @Observable public final class MacDesktopNotifications {
    public private(set) var pendingApprovals: [DesktopApproval] = []
    public private(set) var problem: String?
    public private(set) var engineID: String?
    public var locked = true
    @ObservationIgnored private let store: any KeyValueStore
    @ObservationIgnored private var claims: [DesktopNotice] = []
    @ObservationIgnored private var loaded = false
    @ObservationIgnored private var lane: Task<Void, Never>?
    public init(store: any KeyValueStore) { self.store = store }
    private func restore() async throws {
        if loaded { return }
        if let data = try await store.data(forKey: "desktop-delivery.v1") {
            guard let saved = try? JSONDecoder().decode([DesktopNotice].self, from: data),
                  saved.count <= 512, saved.allSatisfy(\.valid), Set(saved.map(\.id)).count == saved.count else { throw IdentityFailure("NOTIFICATION_STORE_CORRUPT") }
            claims = saved
        }
        loaded = true
    }
    public func receive(_ snapshot: DesktopSnapshot, preferences: DesktopNotificationPreferences, presenter: any DesktopNotificationPresenter) async {
        let previous = lane
        let task = Task { [self] in
            await previous?.value
            do {
                guard snapshot.engineID.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                      snapshot.events.count <= 128, snapshot.pendingApprovals.count <= 4096,
                      snapshot.events.allSatisfy({ $0.valid && $0.engineID == snapshot.engineID }) else { throw IdentityFailure("NOTIFICATION_EVENT_INVALID") }
                engineID = snapshot.engineID; pendingApprovals = snapshot.pendingApprovals
                try await restore()
                for event in snapshot.events where !claims.contains(where: { $0.id == event.id }) {
                    // Remember disabled/old events too: enabling notifications
                    // does not replay an engine's retained event history.
                    let next = Array((claims + [event]).suffix(512))
                    try await store.set(JSONEncoder().encode(next), forKey: "desktop-delivery.v1")
                    claims = next
                    if preferences.allows(event.kind) {
                        try await presenter.deliver(event, previews: preferences.previews && !locked, sound: preferences.sound)
                    }
                }
                problem = snapshot.issue
            } catch { problem = MacAppSession.code(error) }
        }
        lane = task; await task.value
    }
    public func clicked(_ id: String) async -> DesktopNotice? {
        await lane?.value
        // A notification can launch the app before its first authenticated
        // management snapshot arrives. Wait for that identity, never start or
        // enroll an engine merely because a delivered notification was clicked.
        for _ in 0..<100 {
            if engineID != nil { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        do {
            try await restore()
            guard let event = claims.first(where: { $0.id == id }), event.engineID == engineID else { throw IdentityFailure("NOTIFICATION_ENGINE_MISMATCH") }
            return event
        } catch { problem = MacAppSession.code(error); return nil }
    }
}
