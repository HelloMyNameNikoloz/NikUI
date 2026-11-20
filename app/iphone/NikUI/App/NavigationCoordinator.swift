import Foundation
import NikCore

enum AppTab: Hashable { case chats, terminal, status, settings }

/// Every pushed screen in the Chats stack. Only the top route is on screen.
enum Route: Hashable {
    case conversation(String)
    case report(String)
    case laptopSettings(String)
    case commands(String)
    case pr(String)
    case slack
    case slackThread(SlackThreadID)

    var conversationID: String? {
        switch self {
        case .conversation(let id), .report(let id), .laptopSettings(let id), .commands(let id), .pr(let id): id
        case .slack, .slackThread: nil
        }
    }
}

struct NavigationSelection: Equatable {
    var conversationID: String?
    var visibility = FeatureVisibility()
    var slackThread: SlackThreadID?

    init(tab: AppTab = .chats, path: [Route] = [], contentVisible: Bool = true) {
        guard contentVisible else { return }
        switch tab {
        case .terminal: visibility.terminal = true
        case .status: visibility.report = true
        case .settings: break
        case .chats:
            conversationID = path.last?.conversationID
            switch path.last {
            case .report: visibility.report = true
            case .laptopSettings: visibility.settings = true
            case .commands: visibility.commands = true
            case .pr: visibility.pr = true
            case .slack: visibility.slack = true
            case .slackThread(let thread): visibility.slack = true; slackThread = thread
            case .conversation, nil: break
            }
        }
    }
}

/// Serializes selection, presence and subscriptions from one navigation snapshot.
/// Views never acquire/release sockets or change FeatureVisibility themselves.
@MainActor final class NavigationCoordinator {
    private let client: NikClient
    private var desired = NavigationSelection()
    private var work: Task<Void, Never>?
    private var revision = 0

    init(client: NikClient) { self.client = client }

    func transition(to selection: NavigationSelection) {
        desired = selection
        enqueue { coordinator in await coordinator.apply(selection) }
    }

    /// Core restores FeatureVisibility after a verified welcome. Presence and a
    /// thread opened before fleet readiness also need their retained read intent.
    func verifiedConnection(_ role: SocketRole) {
        enqueue { coordinator in await coordinator.applyReadIntent(on: role) }
    }

    func settle() async {
        while true {
            let latest = revision
            await work?.value
            if latest == revision { return }
        }
    }

    private func enqueue(_ operation: @escaping @MainActor (NavigationCoordinator) async -> Void) {
        revision += 1
        let previous = work
        work = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            await operation(self)
        }
    }

    private func apply(_ selection: NavigationSelection) async {
        guard selection == desired else { return }
        if client.selectedConversationID != selection.conversationID {
            if let old = client.selectedConversationID {
                if client.conversation(old).connection.isLive {
                    _ = await client.perform(.visible(false), on: .conversation(old))
                }
                // Close old subscriptions before applying the new route's flags.
                await client.setVisibility(FeatureVisibility())
                await client.selectConversation(nil)
            }
            guard selection == desired else { return }
            // Retain first-load intent before starting the conversation socket.
            await client.setVisibility(selection.visibility)
            guard selection == desired else { return }
            await client.selectConversation(selection.conversationID)
        } else {
            await client.setVisibility(selection.visibility)
        }
        guard selection == desired else { return }
        if let id = selection.conversationID { await applyReadIntent(on: .conversation(id)) }
        await applyReadIntent(on: .fleet)
    }

    private func applyReadIntent(on role: SocketRole) async {
        switch role {
        case .conversation(let id):
            guard desired.conversationID == id, client.selectedConversationID == id,
                  client.conversation(id).connection.isLive else { return }
            _ = await client.perform(.visible(true), on: role)
        case .fleet:
            guard desired.visibility.slack, let thread = desired.slackThread, client.connection.isLive else { return }
            _ = await client.perform(.slackOpen(conversation: thread.conversation, thread: thread.thread))
        }
    }
}

extension NikClient {
    /// Fleet control alone does not authorize a write on a disconnected chat.
    func mayControlConversation(_ id: String) -> Bool {
        mayControl && conversation(id).connection.isLive
    }
}
