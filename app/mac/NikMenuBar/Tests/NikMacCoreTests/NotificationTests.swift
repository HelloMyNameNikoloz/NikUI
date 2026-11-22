import Foundation
import Testing
import NikCore
import NikMenuCore
@testable import NikMacCore

@MainActor private final class NoticePresenter: DesktopNotificationPresenter {
    var notices: [(DesktopNotice, Bool, Bool)] = []
    func deliver(_ notice: DesktopNotice, previews: Bool, sound: Bool) { notices.append((notice, previews, sound)) }
}
@Suite("App-owned durable notification claims") @MainActor struct DesktopNotificationTests {
    private func snapshot(id: String = "1", kind: String = "needs-you", engine: String = String(repeating: "a", count: 32)) throws -> DesktopSnapshot {
        let event = DesktopNotice(id: String(repeating: id, count: 64), engineID: engine, conversationID: "issuing-conversation", kind: kind, title: "Approval", body: "private text", createdAt: 42)
        let raw: JSONValue = .object(["engineID": .string(engine), "events": .array([try JSONValue.decode(JSONEncoder().encode(event))]),
            "pendingApprovals": .array([.object(["conversationID": .string("issuing-conversation"), "requestID": .string("request")])]), "issue": .null])
        return try JSONDecoder().decode(DesktopSnapshot.self, from: raw.encoded())
    }
    @Test func concurrentWindowsAndRestartClaimOnlyOnceAndRouteIssuingConversation() async throws {
        let store = MemoryKeyValueStore(), owner = MacDesktopNotifications(store: store), presenter = NoticePresenter(), state = try snapshot()
        var preferences = DesktopNotificationPreferences(); preferences.enabled = true; preferences.previews = true
        await owner.receive(state, preferences: preferences, presenter: presenter)
        await owner.receive(state, preferences: preferences, presenter: presenter)
        #expect(presenter.notices.count == 1 && owner.pendingApprovals.count == 1)
        #expect(presenter.notices[0].1 == false) // unknown initial lock state is private
        #expect(await owner.clicked(String(repeating: "1", count: 64))?.conversationID == "issuing-conversation")
        let restarted = MacDesktopNotifications(store: store)
        await restarted.receive(state, preferences: preferences, presenter: presenter)
        #expect(presenter.notices.count == 1)
        #expect(await restarted.clicked(String(repeating: "1", count: 64))?.engineID == state.engineID)
    }
    @Test func settingsLockAndDisabledHistoryAreRespected() async throws {
        let store = MemoryKeyValueStore(), owner = MacDesktopNotifications(store: store), presenter = NoticePresenter()
        var preferences = DesktopNotificationPreferences()
        await owner.receive(try snapshot(), preferences: preferences, presenter: presenter)
        preferences.enabled = true
        await owner.receive(try snapshot(), preferences: preferences, presenter: presenter)
        #expect(presenter.notices.isEmpty)
        owner.locked = true; preferences.previews = true; preferences.sound = false
        await owner.receive(try snapshot(id: "2", kind: "failed"), preferences: preferences, presenter: presenter)
        #expect(presenter.notices.count == 1 && presenter.notices[0].1 == false && presenter.notices[0].2 == false)
        preferences.finished = false
        await owner.receive(try snapshot(id: "3", kind: "turn-finished"), preferences: preferences, presenter: presenter)
        #expect(presenter.notices.count == 1)
    }
    @Test func oldEngineClickCannotRedirectCurrentWindow() async throws {
        let owner = MacDesktopNotifications(store: MemoryKeyValueStore()), presenter = NoticePresenter(), preferences = DesktopNotificationPreferences()
        await owner.receive(try snapshot(), preferences: preferences, presenter: presenter)
        await owner.receive(try snapshot(id: "2", engine: String(repeating: "b", count: 32)), preferences: preferences, presenter: presenter)
        #expect(await owner.clicked(String(repeating: "1", count: 64)) == nil)
        #expect(owner.problem == "NOTIFICATION_ENGINE_MISMATCH")
    }
}
