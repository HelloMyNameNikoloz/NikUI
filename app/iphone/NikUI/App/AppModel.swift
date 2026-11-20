import Foundation
import Observation
import SwiftUI
import UIKit
import UserNotifications
import NikCore

/// A short message at the top of the screen: a refusal, a send that may not
/// have arrived, a failure the person should know about.
struct Banner: Identifiable, Equatable {
    enum Style { case info, warning, error }
    let id = UUID()
    var text: String
    var style: Style
}

/// App-wide state the core does not own: which tab, which screens are pushed,
/// the lock, and the banner. The core (`NikClient`) owns everything the laptop says.
@MainActor @Observable final class AppModel {
    static private(set) var current: AppModel?

    let client: NikClient
    let navigation: NavigationCoordinator
    let lock: AppLock
    let notificationAccess = NotificationAccess.shared
    let power = PowerConfirmationCoordinator()
    let pairingAttempts = PairingAttempts()
    private let signingKey: DeviceSigningKey?
    private let cacheStore: FileStore?
    private var identityPreparation: Task<Bool, Never>?
    private let privacyShield = PrivacyShield()
    private(set) var privacyCovered = true { didSet { if privacyCovered != oldValue { updateNavigation() } } }
    private(set) var identityError: String?
    private(set) var preparingIdentity = false
    private var scene: AppLifecycle = .foreground
    private var sceneWork: Task<Void, Never>?
    private var starting = false
    private var pendingDestination: NotificationDestination?
    private var deferredConversation: String?
    private var deferredIntent: LocalIntent?
    var tab: AppTab = .chats { didSet { if tab != oldValue { updateNavigation() } } }
    var chatsPath: [Route] = [] { didSet { if chatsPath != oldValue { updateNavigation() } } }
    var banner: Banner?
    var pendingInvitation: PairingInvitation?
    var showPairing = false { didSet { if showPairing != oldValue { updateNavigation() } } }
    /// Request IDs of chats being started or resumed; the reply opens the chat.
    var creating: Set<String> = []
    var creationFailed: String?
    /// A command from a chat's code block, waiting in the Terminal's field.
    var terminalCommand: TerminalHandoff?
    private var voiceCompositions: [String: VoiceComposition] = [:]
    private var featureReading: [String: ReadingState] = [:]
    private struct CommandEditKey: Hashable { let conversationID: String; let name: String? }
    private var commandEdits: [CommandEditKey: CommandEditDraft] = [:]
    var askingPR: Set<String> = []
    private(set) var restored = false { didSet { if restored != oldValue { updateNavigation() } } }
    private var listening: Task<Void, Never>?
    private var bannerTimer: Task<Void, Never>?

    init(preview: Bool) {
        lock = preview ? AppLock(store: KeychainStore(service: "com.nikoloz.nikui.preview")) : AppLock()
        if preview {
            signingKey = nil
            cacheStore = nil
            client = .preview()
        } else {
            let key = DeviceSigningKey()
            signingKey = key
            let files = FileStore()
            cacheStore = files
            client = NikClient(signingKey: key, secureStore: KeychainStore(), cacheStore: files)
        }
        navigation = NavigationCoordinator(client: client)
        Self.current = self
        lock.onChange = { [weak self] in self?.lockChanged() }
    }

    var isPaired: Bool { client.isPreview || client.pairedConnection != nil }
    var laptopName: String { client.pairedConnection?.laptopName ?? (client.isPreview ? "Preview laptop" : "Laptop") }

    var mayPresentContent: Bool { restored && !lock.locked && !privacyCovered }
    var effectiveLifecycle: AppLifecycle { lock.locked || !lock.loaded ? .locked : scene }

    func voiceComposition(_ id: String) -> VoiceComposition {
        if let value = voiceCompositions[id] { return value }
        let value = VoiceComposition(); voiceCompositions[id] = value
        return value
    }
    func reading(_ key: String) -> ReadingState { featureReading[key] ?? ReadingState() }
    func saveReading(_ reading: ReadingState, key: String) { if featureReading[key] != reading { featureReading[key] = reading } }
    func commandEdit(conversationID: String, command: CommandDescription?) -> CommandEditDraft {
        let key = CommandEditKey(conversationID: conversationID, name: command?.name)
        if let saved = commandEdits[key] { return saved }
        let draft = CommandEditDraft(command: command); commandEdits[key] = draft
        return draft
    }
    func discardCommandEdit(conversationID: String, command: CommandDescription?) {
        commandEdits[CommandEditKey(conversationID: conversationID, name: command?.name)] = nil
    }

    private func clearTransientContent() {
        for value in voiceCompositions.values { value.cancel() }
        voiceCompositions.removeAll()
        featureReading.removeAll(); askingPR.removeAll()
        commandEdits.removeAll()
        creating.removeAll(); creationFailed = nil
        terminalCommand = nil
        power.cancel()
        ImageStore.clear()
    }

    func start() async {
        guard !starting, !restored else { return }
        starting = true
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { AppModel.current?.client.handleMemoryPressure() }
        }
        listen()
        let previous = sceneWork
        let work = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            // Always gate the core before reading any saved pairing/cache.
            await self.client.setLifecycle(.locked)
            await self.lock.refreshStatus()
            await self.client.restore()
            self.restored = true
            if !self.client.isPreview {
                await self.notificationAccess.refresh(register: true)
                do { if self.pendingDestination == nil { self.pendingDestination = try self.notificationAccess.pendingDestination() } }
                catch { self.show("The pending notification could not be read. Tap the notification again after unlocking.", .warning) }
            }
            await self.synchronizeScene()
        }
        sceneWork = work
        await work.value
    }

    // MARK: Events from the core

    private func listen() {
        listening = Task { [weak self] in
            guard let events = self?.client.events else { return }
            for await event in events { self?.handle(event) }
        }
    }

    private func handle(_ event: CoreEvent) {
        switch event {
        case .intent(let intent):
            follow(intent)
        case .notification(let note):
            post(note)
        case .failure(let failure):
            show(failure.message, .error)
        case .server(_, .refused(let what, let reason, let id)):
            if let id, creating.remove(id) != nil { creationFailed = Self.refusal(what: what, reason: reason) }
            else { show(Self.refusal(what: what, reason: reason), .warning) }
        case .server(_, .created(let id, let instance)):
            if creating.remove(id) != nil { creationFailed = nil; openConversation(instance) }
        case .server(_, .navigate(let id)):
            openConversation(id)
        case .server(let role, .voiceText(let reply)):
            if case .conversation(let id) = role { receiveVoiceText(reply, conversationID: id) }
        case .server(_, .voiceFailed(let id, _, let reason)):
            if let composition = voiceCompositions.values.first(where: { $0.requestID == id }) {
                composition.requestID = nil
                composition.sendAfterTranscription = false
                show(reason.isEmpty ? "The laptop could not turn the recording into words. Your recording is kept." : reason, .warning)
            }
        case .connection(let role, .live):
            navigation.verifiedConnection(role)
            if role == .fleet { Task { await offerAppleToken() } }
        case .connection, .server:
            break
        }
    }

    /// The correlated action result and event share this idempotent completion path.
    func receiveVoiceText(_ reply: VoiceText, conversationID id: String) {
        if let composition = voiceCompositions[id], composition.requestID == reply.id {
            composition.requestID = nil
            let sendAfter = composition.sendAfterTranscription
            composition.sendAfterTranscription = false
            let words = reply.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if words.isEmpty { show("No words were heard. Your recording is kept.", .warning) }
            else {
                composition.clip = nil
                var draft = client.conversation(id).draft
                let end = draft.text.utf16.count
                let range = composition.selectionText == draft.text ? composition.selection ?? end..<end : end..<end
                let inserted = WAV.insert(words, into: draft.text, selection: range)
                draft.text = inserted.text
                client.setDraft(draft, conversationID: id)
                composition.insertedCaret = inserted.caret
                if sendAfter, mayPresentContent, currentConversationID == id, client.mayControlConversation(id) {
                    let scope = client.pairedConnection?.scope
                    let submitted = client.conversation(id).draft
                    Task {
                        guard self.mayPresentContent, self.currentConversationID == id, self.client.pairedConnection?.scope == scope,
                              self.client.conversation(id).draft == submitted else { return }
                        self.report(await self.client.send(conversationID: id))
                    }
                }
            }
        }
    }

    /// Something the core wants the app to show: a report page, Slack, another chat.
    func follow(_ intent: LocalIntent) {
        guard mayPresentContent else { deferredIntent = intent; return }
        let current = currentConversationID
        switch intent {
        case .report: if let current { push(.report(current)) } else { tab = .status }
        case .settings: if let current { push(.laptopSettings(current)) }
        case .commands: if let current { push(.commands(current)) }
        case .slack: push(.slack)
        case .navigate(let id): openConversation(id)
        case .focus: break
        case .externalURL(let url): UIApplication.shared.open(url)
        }
    }

    var currentConversationID: String? {
        navigationSelection.conversationID
    }

    private var navigationSelection: NavigationSelection {
        NavigationSelection(tab: tab, path: chatsPath,
                            contentVisible: mayPresentContent && isPaired && effectiveLifecycle == .foreground && !showPairing)
    }

    private func updateNavigation() {
        navigation.transition(to: navigationSelection)
    }

    func push(_ route: Route) {
        tab = .chats
        if chatsPath.last != route { chatsPath.append(route) }
    }

    func openConversation(_ id: String) {
        guard mayPresentContent else { deferredConversation = id; return }
        tab = .chats
        chatsPath = [.conversation(id)]
    }

    // MARK: Actions

    /// Starts or resumes a chat; it opens when the laptop answers `instance:created`.
    func create(_ action: ClientAction, id: String) async -> Bool {
        let scope = client.pairedConnection?.scope
        creating.insert(id); creationFailed = nil
        let result = await client.perform(action)
        guard client.pairedConnection?.scope == scope else { creating.remove(id); return false }
        switch result {
        case .accepted(let value):
            creating.remove(id)
            if let instance = value["instance"].stringValue { openConversation(instance) }
            return true
        case .submitted, .ambiguous:
            for _ in 0..<48 where creating.contains(id) { try? await Task.sleep(for: .milliseconds(250)) }
            if creating.remove(id) != nil { creationFailed = "The laptop did not answer. Check the chat list before trying again." }
            return creationFailed == nil
        case .notSent(let failure):
            creating.remove(id); creationFailed = failure.message
            return false
        case .local(let intent):
            creating.remove(id); follow(intent)
            return true
        }
    }

    /// Runs an action and tells the person when it did not go through. A send
    /// that may or may not have arrived is said so plainly and never retried.
    @discardableResult
    func run(_ action: ClientAction, on role: SocketRole = .fleet) async -> ActionResult {
        if action.requiresControl, !mayPresentContent {
            let result = ActionResult.notSent(CoreFailure(.locked, "Unlock and return to NikUI before making changes."))
            report(result)
            return result
        }
        if case .conversation(let id) = role, action.requiresControl, !client.mayControlConversation(id) {
            let failure = !client.connection.isLive || !client.conversation(id).connection.isLive
                ? CoreFailure(.offline, "This conversation is not connected. Try again when its connection is live.")
                : CoreFailure(.refused, "This iPhone can only watch. Allow control on the laptop.")
            let result = ActionResult.notSent(failure)
            report(result)
            return result
        }
        let result = await client.perform(action, on: role)
        report(result)
        return result
    }

    func report(_ result: ActionResult) {
        switch result {
        case .notSent(let failure): show(failure.message, .error)
        case .ambiguous: show("The connection dropped while sending. Check the chat before sending again.", .warning)
        case .local(let intent): follow(intent)
        case .submitted, .accepted: break
        }
    }

    func show(_ text: String, _ style: Banner.Style = .info) {
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .snappy) { banner = Banner(text: text, style: style) }
        bannerTimer?.cancel()
        bannerTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(style == .info ? 3 : 6))
            guard !Task.isCancelled else { return }
            withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .snappy) { self?.banner = nil }
        }
    }

    static func refusal(what: String, reason: String) -> String {
        switch reason {
        case "watch-only", "control": "This iPhone can watch but not control. Allow it from the laptop."
        case "busy": "The laptop is busy with that. Try again in a moment."
        default: reason.isEmpty ? "The laptop refused \(what)." : reason
        }
    }

    // MARK: Pairing links

    func open(_ url: URL) {
        if let invitation = PairingLink.parse(url.absoluteString) {
            pendingInvitation = invitation
            showPairing = true
        }
    }

    // MARK: Lifecycle

    func scenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active: scene = .foreground
        case .inactive: scene = .inactive
        case .background: scene = .background
        @unknown default: return
        }
        if scene != .foreground {
            client.suspendForPrivacy(effectiveLifecycle)
            for value in voiceCompositions.values { value.hold() }
            privacyCovered = true
            privacyShield.cover()
            banner = nil
            power.cancel()
        }
        lock.sceneLifecycle(scene) // Publishes into the same serialized scene queue.
    }

    private func lockChanged() {
        if lock.locked {
            client.suspendForPrivacy(.locked)
            for value in voiceCompositions.values { value.hold() }
            banner = nil; power.cancel()
        }
        if scene == .foreground {
            privacyCovered = false
            privacyShield.revealAfterUpdate()
        }
        updateNavigation()
        enqueueSceneSync()
    }

    private func enqueueSceneSync() {
        let previous = sceneWork
        sceneWork = Task { [weak self] in
            await previous?.value
            guard let self, self.restored else { return }
            await self.synchronizeScene()
        }
    }

    private func synchronizeScene() async {
        guard restored else { return }
        // Gate writes before waiting for subscription shutdown or network work.
        if effectiveLifecycle != .foreground { await client.setLifecycle(effectiveLifecycle) }
        updateNavigation()
        await navigation.settle()
        guard effectiveLifecycle == .foreground else { return }
        // A cold background launch may have found protected Keychain/cache
        // unavailable. Re-read an unrestored pairing after the unlock boundary.
        if !client.isPreview, client.pairedConnection == nil { await client.restore() }
        guard effectiveLifecycle == .foreground else { return }
        if let pairing = client.pairedConnection, let signingKey {
            do { try await signingKey.prepareExisting(pairing); identityError = nil }
            catch { identityError = error.localizedDescription; show(error.localizedDescription, .error); await client.disconnect(); return }
        }
        guard effectiveLifecycle == .foreground else { return }
        await client.setLifecycle(effectiveLifecycle)
        guard effectiveLifecycle == .foreground else { return }
        privacyCovered = false
        await navigation.settle()
        privacyShield.revealAfterUpdate()
        await offerAppleToken()
        if pendingDestination == nil, !client.isPreview {
            do { pendingDestination = try notificationAccess.pendingDestination() }
            catch { show("The pending notification is unavailable. Tap it again after unlocking.", .warning) }
        }
        applyPendingDestinations()
    }

    func retryConnection() async {
        await sceneWork?.value
        guard mayPresentContent else { return }
        if let pairing = client.pairedConnection, let signingKey {
            do { try await signingKey.prepareExisting(pairing); identityError = nil }
            catch { identityError = error.localizedDescription; show(error.localizedDescription, .error); return }
        }
        guard mayPresentContent else { return }
        await client.networkBecameAvailable()
    }

    func preparePairingIdentity() async -> Bool {
        await sceneWork?.value
        guard mayPresentContent else { return false }
        if let identityPreparation { return await identityPreparation.value && mayPresentContent }
        preparingIdentity = true
        let work = Task { [weak self] in
            guard let self else { return false }
            do { try await self.signingKey?.prepareNewPairing(); self.identityError = nil; return true }
            catch { self.identityError = error.localizedDescription; return false }
        }
        identityPreparation = work
        let ready = await work.value
        identityPreparation = nil; preparingIdentity = false
        return ready && mayPresentContent
    }

    func pairingCompleted() async {
        clearTransientContent()
        chatsPath = []; tab = .chats
        notificationAccess.resetSubmission()
        enqueueSceneSync()
        await sceneWork?.value
    }

    @discardableResult
    func forgetLocally() async -> ActionResult {
        _ = await identityPreparation?.value
        // Include orphan scopes left by an earlier failed laptop switch. The
        // core then serializes one final current-scope removal before key deletion.
        await client.disconnect()
        do { try await cacheStore?.removeScopedCaches() }
        catch {
            let failure = (error as? CoreFailure) ?? CoreFailure(.persistence, error.localizedDescription)
            show(failure.message, .error)
            return .notSent(failure)
        }
        let result = await client.forgetLaptop(deleteKey: true)
        if case .accepted = result {
            clearTransientContent()
            chatsPath = []; tab = .chats; pendingDestination = nil; deferredConversation = nil; deferredIntent = nil
            identityError = nil; notificationAccess.resetSubmission()
            do { try notificationAccess.clearDestination() }
            catch { show("The old notification destination could not be removed. Try again after unlocking.", .warning) }
        } else { report(result) }
        return result
    }

    // MARK: Notifications

    private func isVisible(_ destination: NotificationDestination) -> Bool {
        guard mayPresentContent, tab == .chats, !showPairing else { return false }
        switch destination {
        case .chats: return chatsPath.isEmpty
        case .conversation(let id): return chatsPath.last == .conversation(id)
        case .slack(let id):
            if case .slackThread(let thread) = chatsPath.last { return thread.conversation == id }
            return false
        }
    }

    private func post(_ note: NotificationEvent) {
        let prefs = client.preferences.notifications
        guard prefs.on, let kind = NotificationKind(rawValue: note.kind), prefs.enabledKinds.contains(kind), !lock.locked else { return }
        let destination = NotificationCoordinator.destination(note)
        guard !isVisible(destination) else { return }
        let content = UNMutableNotificationContent()
        content.title = privacyCovered ? "NikUI" : String(note.title.prefix(120))
        content.body = !privacyCovered && prefs.showPreviews ? String(note.body.prefix(300)) : "Open NikUI to view."
        let urgent = kind == .needsYou || kind == .slack
        content.sound = urgent && notificationAccess.soundAllowed ? .default : nil
        content.threadIdentifier = note.conversation ?? note.session ?? note.kind
        content.interruptionLevel = .active
        content.userInfo = ["nikuiLocal": true, "kind": note.kind]
        for (key, value) in [("session", note.session), ("conversation", note.conversation), ("tag", note.tag)] {
            if let value { content.userInfo[key] = value }
        }
        if let at = note.at { content.userInfo["at"] = at.timeIntervalSince1970 * 1000 }
        let request = UNNotificationRequest(identifier: note.tag ?? UUID().uuidString, content: content, trigger: nil)
        Task {
            do { try await UNUserNotificationCenter.current().add(request) }
            catch { show("A local notification could not be shown: \(error.localizedDescription)", .warning) }
        }
    }

    /// APNs goes through core filtering/redaction/dedup and the same local
    /// presentation path as socket events. Our local request is presented once.
    func foregroundNotification(_ payload: NotificationPayload) -> UNNotificationPresentationOptions {
        guard mayPresentContent else { return [] }
        if payload.isTest { return [.banner, .list] }
        if !payload.isLocal { _ = client.handleNotification(payload.event); return [] }
        let prefs = client.preferences.notifications
        guard prefs.on, let kind = NotificationKind(rawValue: payload.event.kind), prefs.enabledKinds.contains(kind),
              !isVisible(NotificationCoordinator.destination(payload.event)) else { return [] }
        if !prefs.showPreviews, payload.event.body != "Open NikUI to view." { return [] }
        var options: UNNotificationPresentationOptions = [.banner, .list]
        if (kind == .needsYou || kind == .slack), notificationAccess.soundAllowed { options.insert(.sound) }
        return options
    }

    func notificationTapped(_ event: NotificationEvent) {
        let destination = NotificationCoordinator.destination(event)
        pendingDestination = destination
        do { try notificationAccess.saveDestination(destination) }
        catch { show("The notification destination could not be saved. It will open after this unlock.", .warning) }
        applyPendingDestinations()
    }

    private func applyPendingDestinations() {
        guard mayPresentContent, isPaired else { return }
        if let id = deferredConversation { deferredConversation = nil; openConversation(id) }
        if let intent = deferredIntent { deferredIntent = nil; follow(intent) }
        guard let destination = pendingDestination else { return }
        pendingDestination = nil
        showPairing = false
        tab = .chats
        switch destination {
        case .chats: chatsPath = []
        case .conversation(let id): chatsPath = [.conversation(id)]
        case .slack(let id): chatsPath = [.slack, .slackThread(SlackThreadID(conversation: id))]
        }
        do { try notificationAccess.clearDestination() }
        catch { show("The notification opened, but its saved destination could not be cleared.", .warning) }
    }

    func registerAppleToken(_ token: Data) {
        notificationAccess.registered(token)
        Task { await offerAppleToken() }
    }

    func offerAppleToken() async {
        guard !client.isPreview, restored, client.preferences.notifications.on, notificationAccess.authorized,
              let token = notificationAccess.savedToken() else { return }
        notificationAccess.queued()
        guard effectiveLifecycle == .foreground, isPaired else { return }
        let result = await client.perform(.appleToken(token))
        notificationAccess.submitted(result, live: client.connection.isLive)
    }

    func requestPowerChange(_ action: ClientAction, on role: SocketRole = .fleet) {
        guard mayPresentContent else { return }
        power.request(action, on: role, laptop: laptopName, lidHeld: client.awake.lid?.held == true) { [weak self] action, role in
            guard let self else { return }
            let result = await self.run(action, on: role)
            if case .ambiguous = result { self.show("The power change is unconfirmed. Check the laptop's current state before trying again.", .warning) }
        }
    }

    func openReportPath(_ path: String, conversationID id: String) async {
        guard mayPresentContent, client.mayControl else { return }
        let scope = client.pairedConnection?.scope
        if currentConversationID != id { push(.report(id)) }
        await navigation.settle()
        let deadline = Date().addingTimeInterval(12)
        while mayPresentContent, client.pairedConnection?.scope == scope, currentConversationID == id, !client.conversation(id).connection.isLive, Date() < deadline {
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        }
        guard mayPresentContent, client.pairedConnection?.scope == scope, currentConversationID == id else { return }
        _ = await run(.openFile(path: path), on: .conversation(id))
    }
}

/// "Run in Terminal" from a chat: the command plus where it came from, so it
/// lands in a terminal beside that chat's folder rather than whichever was open.
struct TerminalHandoff: Equatable {
    let command: String
    let conversationID: String
    let provider: Provider
}
