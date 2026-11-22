import Foundation
import CryptoKit
import Testing
import WebKit
import NikCore
import NikMenuCore
import NikMacIdentity
@testable import NikMacCore

private let engineID = String(repeating: "a", count: 32)
private func run(_ turn: String = "turn-1") throws -> RunRef { try RunRef(id: String(repeating: "b", count: 32), turn: turn) }
private func controlState() throws -> ConversationState {
    var state = ConversationState(id: "a"); state.controlSnapshotFresh = true; state.connection = .live; state.run = try run(); state.status = .waiting
    state.items = [TranscriptItem(.object(["id": .string("p"), "kind": .string("permission"), "requestId": .string("approval"), "run": try run().raw]))]
    return state
}
private actor EnrollmentTransport: ControlTransport {
    let host = P256.Signing.PrivateKey()
    var refused: String?
    var statusEngineID = engineID
    var requests: [JSONValue] = []
    func refuse(_ code: String) { refused = code }
    func selectEngine(_ value: String) { statusEngineID = value }
    func count() -> Int { requests.count }
    func request(_ data: Data) throws -> Data {
        let request = try JSONValue.decode(data); requests.append(request)
        if request["op"].stringValue == "status" {
            return try JSONValue.object(["ok": .bool(true), "root": .string("/fixture"), "state": .string("running"), "generation": .string("generation"), "engine": .object(["id": .string(statusEngineID)])]).encoded()
        }
        if let refused { return try JSONValue.object(["ok": .bool(false), "code": .string(refused)]).encoded() }
        let d = request["device"], spki = try NikCrypto.decodeBase64URL(d["publicKey"].stringValue!)
        let text = "nikui-local-device-v1:" + JSONValue.array([.string(engineID), .string("generation"), d["publicKey"]]).text
        #expect(NikCrypto.verify(signature: try NikCrypto.decodeBase64URL(d["signature"].stringValue!), message: Data(text.utf8), publicSPKI: spki))
        return try JSONValue.object(["ok": .bool(true), "kind": .string("local"), "protocol": .number(2), "engineId": .string(engineID), "generation": .string("generation"),
            "device": .string("mac-device"), "publicKey": d["publicKey"], "serverKey": .string(NikCrypto.base64URL(host.publicKey.derRepresentation)),
            "fingerprint": .string(NikCrypto.fingerprint(host.publicKey.derRepresentation)), "baseURL": .string("http://127.0.0.1:4517"),
            "seat": .object(["id": .string("mac-device"), "local": .bool(true), "control": .bool(true), "editor": .bool(false)])]).encoded()
    }
    nonisolated func observe(_ data: Data) -> AsyncThrowingStream<Data, any Error> { AsyncThrowingStream { $0.finish() } }
}
private actor BrokenStore: KeyValueStore {
    let failure: IdentityFailure
    init(_ code: String) { failure = IdentityFailure(code) }
    func data(forKey key: String) throws -> Data? { throw failure }
    func set(_ data: Data, forKey key: String) throws { throw failure }
    func removeValue(forKey key: String) throws { throw failure }
}

@Suite("Mac local device enrollment") struct LocalDeviceTests {
    @Test func enrollmentProvesKeyAndPersistsBeforeUse() async throws {
        let store = MemoryKeyValueStore(), transport = EnrollmentTransport()
        let service = LocalDeviceEnrollment(root: "/fixture", transport: transport, store: store)
        let first = try await service.connect(allowCreation: true), second = try await service.connect(allowCreation: false)
        #expect(first.pairing.publicSPKI == second.pairing.publicSPKI)
        #expect(first.pairing.deviceID == second.pairing.deviceID)
        #expect(first.pairing.serverSPKI == second.pairing.serverSPKI)
        #expect(await store.data(forKey: PairingService.pairingKey) != nil)
        #expect(await store.data(forKey: "engine-id.v1") == Data(engineID.utf8))
    }
    @Test func revokedKeyIsRetainedAndNeverReplaced() async throws {
        let store = MemoryKeyValueStore(), transport = EnrollmentTransport()
        let service = LocalDeviceEnrollment(root: "/fixture", transport: transport, store: store)
        _ = try await service.connect(allowCreation: true)
        let before = await store.data(forKey: "device-key.v1")
        await transport.refuse("LOCAL_DEVICE_REVOKED")
        await #expect(throws: IdentityFailure("LOCAL_DEVICE_REVOKED")) { _ = try await service.connect(allowCreation: true) }
        #expect(await store.data(forKey: "device-key.v1") == before)
    }
    @Test(arguments: ["KEYCHAIN_LOCKED", "KEYCHAIN_DENIED", "KEYCHAIN_CORRUPT"])
    func storeFailuresHaveNamedBlockers(code: String) async {
        let transport = EnrollmentTransport(), service = LocalDeviceEnrollment(root: "/fixture", transport: transport, store: BrokenStore(code))
        await #expect(throws: IdentityFailure(code)) { _ = try await service.connect(allowCreation: true) }
        #expect(await transport.count() == 1)
    }
    @Test func corruptPrivateKeyAndMissingSelectedKeyCannotBootstrap() async throws {
        let store = MemoryKeyValueStore(), transport = EnrollmentTransport()
        await store.set(Data([0, 1]), forKey: "device-key.v1")
        let service = LocalDeviceEnrollment(root: "/fixture", transport: transport, store: store)
        await #expect(throws: IdentityFailure("KEYCHAIN_CORRUPT")) { _ = try await service.connect(allowCreation: true) }
        await store.removeValue(forKey: "device-key.v1"); await store.set(Data(engineID.utf8), forKey: "engine-id.v1")
        await #expect(throws: IdentityFailure("LOCAL_DEVICE_IDENTITY_UNAVAILABLE")) { _ = try await service.connect(allowCreation: true) }
        #expect(await store.data(forKey: "device-key.v1") == nil)
    }
    @Test func freshLaunchCannotCreateIdentityWithoutExplicitConnect() async {
        let store = MemoryKeyValueStore(), service = LocalDeviceEnrollment(root: "/fixture", transport: EnrollmentTransport(), store: store)
        await #expect(throws: IdentityFailure("LOCAL_DEVICE_IDENTITY_UNAVAILABLE")) { _ = try await service.connect(allowCreation: false) }
        #expect(await store.data(forKey: "device-key.v1") == nil)
    }
    @Test func changedEngineAndCorruptPairingRefuseBeforeEnrollmentEffects() async throws {
        let store = MemoryKeyValueStore(), transport = EnrollmentTransport()
        let service = LocalDeviceEnrollment(root: "/fixture", transport: transport, store: store)
        _ = try await service.connect(allowCreation: true)
        let key = await store.data(forKey: "device-key.v1")
        await transport.selectEngine(String(repeating: "f", count: 32))
        await #expect(throws: IdentityFailure("LOCAL_DEVICE_PIN_MISMATCH")) { _ = try await service.connect(allowCreation: true) }
        #expect(await transport.count() == 3)
        await transport.selectEngine(engineID)
        await store.set(Data("corrupt pairing".utf8), forKey: PairingService.pairingKey)
        await #expect(throws: IdentityFailure("KEYCHAIN_CORRUPT")) { _ = try await service.connect(allowCreation: true) }
        #expect(await transport.count() == 4)
        #expect(await store.data(forKey: "device-key.v1") == key)
    }
    @Test func appNamespaceIsExactDisjointAndStable() throws {
        let home = BuildFlavour.testBase + "/p3/test", flavour = BuildFlavour.development
        let dev = try flavour.selection(info: ["CFBundleIdentifier": flavour.appID, "NikBuildFlavour": "dev", "NikEngineLabel": flavour.engineLabel,
            "NikEngineTestHome": home, "NikEngineTestRoot": home + "/profile"], accountHome: "/Users/fixture")
        let prod = try BuildFlavour.production.selection(info: ["CFBundleIdentifier": "com.nikui.app", "NikBuildFlavour": "prod", "NikEngineLabel": "com.nikui.engine"], accountHome: "/Users/fixture")
        #expect(LocalDeviceNamespace.service(prod) == "com.nikui.app.local-device.v1")
        #expect(LocalDeviceNamespace.service(dev).hasPrefix("com.nikui.app.test."))
        #expect(LocalDeviceNamespace.service(dev) == LocalDeviceNamespace.service(dev))
        #expect(!LocalDeviceNamespace.service(dev).hasPrefix("com.nikui.engine."))
    }
}

@Suite("Mac captured controls and window reducers") @MainActor struct MacControlTests {
    @Test func queueShowsPendingAndUnknownWorkWithoutRunningOrFinishedPrompts() {
        var state = ConversationState(id: "queue")
        let phases = ["queued", "dispatching", "accepted", "completed", "rejected", "discarded", "unknown"]
        state.queue = phases.map { QueueEntry(.object(["id": .string($0), "state": .string($0)])) }
        #expect(state.visibleQueue.map(\.id) == ["queued", "unknown"])
        #expect(state.queue.count == phases.count)
    }
    @Test func staleStopCannotTargetTheNextTurn() throws {
        var state = try controlState()
        let control = CapturedControl(kind: .stop, conversationID: "a", origin: "left", boot: "boot", run: state.run)
        try control.validate(state: state, origin: "left", boot: "boot", consumed: [])
        state.run = try run("turn-2")
        #expect(throws: IdentityFailure("STALE_RUN")) { try control.validate(state: state, origin: "left", boot: "boot", consumed: []) }
    }
    @Test func approvalMembershipDuplicateOriginAndGenerationAreFenced() throws {
        var state = try controlState()
        let control = CapturedControl(kind: .approval, conversationID: "a", origin: "left", boot: "boot", run: state.run, requestID: "approval")
        try control.validate(state: state, origin: "left", boot: "boot", consumed: [])
        #expect(throws: IdentityFailure("DUPLICATE_CONTROL")) { try control.validate(state: state, origin: "left", boot: "boot", consumed: [control.identity]) }
        #expect(throws: IdentityFailure("STALE_CONTROL")) { try control.validate(state: state, origin: "right", boot: "boot", consumed: []) }
        #expect(throws: IdentityFailure("STALE_CONTROL")) { try control.validate(state: state, origin: "left", boot: "new-boot", consumed: []) }
        state.items.removeAll()
        #expect(throws: IdentityFailure("APPROVAL_RESOLVED")) { try control.validate(state: state, origin: "left", boot: "boot", consumed: []) }
    }
    @Test func questionIdentityMustStillBeActive() throws {
        var state = try controlState()
        let ref: JSONValue = .object(["requestId": .string("question"), "run": try run().raw])
        state.items.append(TranscriptItem(.object(["id": .string("q"), "kind": .string("text"), "text": .string("Choose"), "answerTo": ref])))
        let control = CapturedControl(kind: .question, conversationID: "a", origin: "left", boot: "boot", run: state.run, requestID: "question")
        try control.validate(state: state, origin: "left", boot: "boot", consumed: [])
        state.status = .working
        #expect(throws: IdentityFailure("QUESTION_RESOLVED")) { try control.validate(state: state, origin: "left", boot: "boot", consumed: []) }
    }
    @Test func queueActionsRequireAdvertisedCurrentRevision() throws {
        var state = try controlState()
        state.queue = [QueueEntry(.object(["id": .string("q"), "revision": .number(7), "actions": .array([.string("unqueue")])]))]
        let control = CapturedControl(kind: .unqueue, conversationID: "a", origin: "left", boot: "boot", queueID: "q", queueRevision: 7)
        try control.validate(state: state, origin: "left", boot: "boot", consumed: [])
        state.queue[0].raw["actions"] = .array([])
        #expect(throws: IdentityFailure("ACTION_UNADVERTISED")) { try control.validate(state: state, origin: "left", boot: "boot", consumed: []) }
        state.queue[0].raw["revision"] = .number(8)
        #expect(throws: IdentityFailure("STALE_QUEUE_ENTRY")) { try control.validate(state: state, origin: "left", boot: "boot", consumed: []) }
    }
    @Test func twoMacWindowModelsUseIndependentCompositions() async throws {
        let client = NikClient(), left = MacWindowModel(token: "left"), right = MacWindowModel(token: "right")
        await left.select("a", client: client); await right.select("a", client: client)
        left.edit("left draft", client: client); right.edit("right draft", client: client)
        #expect(left.text(client) == "left draft"); #expect(right.text(client) == "right draft")
        await left.close(client: client)
        #expect(client.viewSessions["right"]?.conversationID == "a")
        #expect(right.text(client) == "right draft")
    }
}

@Suite("Bundled transcript bridge validation") struct TranscriptBridgeTests {
    @Test func actualNavigationDecisionAdmitsOnlyBundledMainPageReload() {
        let page = URL(string: "nikui-bundle://transcript/mac-transcript.html")!
        #expect(TranscriptResources.allowsNavigation(page, type: .reload, mainFrame: true))
        #expect(TranscriptResources.allowsNavigation(page, type: .other, mainFrame: true))
        #expect(!TranscriptResources.allowsNavigation(page, type: .reload, mainFrame: false))
        #expect(!TranscriptResources.allowsNavigation(page, type: .linkActivated, mainFrame: true))
        for text in ["nikui-bundle://transcript/mac-transcript.js", "nikui-bundle://transcript/mac-transcript.html?x=1", "https://example.com/mac-transcript.html"] {
            #expect(!TranscriptResources.allowsNavigation(URL(string: text)!, type: .reload, mainFrame: true))
        }
    }
    @Test func terminatedOrReloadedDocumentRepaintsIdenticalSnapshot() {
        var paint = TranscriptPaintState()
        let snapshot = TranscriptResources.snapshot(ConversationState(id: "a"), reading: ReadingState())
        #expect(paint.begin(snapshot) == nil)
        paint.documentReady()
        let old = paint.begin(snapshot)!
        #expect(paint.begin(snapshot) == nil)
        paint.reset(); #expect(paint.begin(snapshot) == nil)
        paint.documentReady()
        #expect(paint.begin(snapshot) != nil)
        paint.failed(generation: old)
        #expect(paint.begin(snapshot) == nil)
        paint.documentReady() // A reload without a process-termination callback.
        #expect(paint.begin(snapshot) != nil)
    }
    @Test func bridgeHasNoMutationOrCredentialSurface() throws {
        #expect(try TranscriptBridgeMessage(.object(["type": .string("ready"), "version": .number(1)]), conversationID: "a", itemIDs: []) == .ready)
        for type in ["send", "permission", "interrupt", "runInTerminal", "keychain", "eval"] {
            #expect(throws: IdentityFailure("BRIDGE_ACTION_REFUSED")) { _ = try TranscriptBridgeMessage(.object(["type": .string(type)]), conversationID: "a", itemIDs: []) }
        }
    }
    @Test func readingIsBoundToConversationAndKnownStableItems() throws {
        var value: JSONValue = .object(["type": .string("reading"), "conversationID": .string("a"), "anchor": .string("one"), "offset": .number(400), "followsLatest": .bool(false)])
        #expect(try TranscriptBridgeMessage(value, conversationID: "a", itemIDs: ["one"]) == .reading(conversationID: "a", anchor: "one", offset: 400, followsLatest: false))
        #expect(throws: IdentityFailure("BRIDGE_STALE_READING")) { _ = try TranscriptBridgeMessage(value, conversationID: "b", itemIDs: ["one"]) }
        value["offset"] = .number(-1)
        #expect(throws: IdentityFailure("BRIDGE_STALE_READING")) { _ = try TranscriptBridgeMessage(value, conversationID: "a", itemIDs: ["one"]) }
    }
    @Test(arguments: ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "https://user:secret@example.com", "nikui-bundle://transcript/../secure.js"])
    func linksNeverGrantFileScriptOrCredentialAuthority(text: String) {
        #expect(throws: IdentityFailure("BRIDGE_URL_REFUSED")) { _ = try TranscriptBridgeMessage(.object(["type": .string("externalURL"), "url": .string(text)]), conversationID: "a", itemIDs: []) }
    }
    @Test func resourcesUseExactBundledAllowlist() {
        #expect(TranscriptResources.resourceName(URL(string: "nikui-bundle://transcript/mac-transcript.html")!) == "mac-transcript.html")
        for text in ["file:///tmp/mac-transcript.html", "nikui-bundle://other/mac-transcript.html", "nikui-bundle://transcript/secure.js", "nikui-bundle://transcript/mac-transcript.js?key=x", "https://example.com/mac-transcript.html"] {
            #expect(TranscriptResources.resourceName(URL(string: text)!) == nil)
        }
    }
    @Test func snapshotPassesOnlyPresentationFields() {
        var state = ConversationState(id: "a")
        state.items = [TranscriptItem(.object(["id": .string("one"), "kind": .string("text"), "text": .string("hello"), "privateKey": .string("secret"), "credential": .string("secret")]))]
        let value = TranscriptResources.snapshot(state, reading: ReadingState())
        #expect(value["items"].arrayValue[0]["text"].stringValue == "hello")
        #expect(!value.text.contains("secret"))
    }
}
